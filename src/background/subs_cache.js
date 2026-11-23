/* Pamięć napisów i tłumaczeń (IndexedDB rozszerzenia) — wpisy wygasają po 90 dniach od ostatniego użycia.
   videos: całe napisy odcinka { key, ts, site, lang, id, title, cues: [[startMs, endMs, src, pl], ...] }
           → po powrocie do filmu lektor nie pobiera ani nie tłumaczy napisów ponownie.
   texts:  pojedyncze tłumaczenia { k: 'pl|' + tekst, pl, ts } → każdy silnik sieciowy najpierw zagląda tutaj.
   Sprzątanie wygasłych wpisów: przy starcie service workera i przy zapisach, najwyżej co 12 h. */

const DB_NAME = 'lektorPamiec';
const DB_VER = 1;
const TTL_MS = 90 * 24 * 3600 * 1000;
const CLEANUP_EVERY_MS = 12 * 3600 * 1000;
const CLEANUP_KEY = 'pamiecCleanupAt';

let dbP = null;
function db() {
    if (!dbP) {
        dbP = new Promise((resolve, reject) => {
            const r = indexedDB.open(DB_NAME, DB_VER);
            r.onupgradeneeded = () => {
                const d = r.result;
                if (!d.objectStoreNames.contains('videos')) d.createObjectStore('videos', { keyPath: 'key' }).createIndex('ts', 'ts');
                if (!d.objectStoreNames.contains('texts')) d.createObjectStore('texts', { keyPath: 'k' }).createIndex('ts', 'ts');
            };
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => { dbP = null; reject(r.error); };
        });
    }
    return dbP;
}
const reqP = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const txDone = (tx) => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error); });
const textKey = (t) => 'pl|' + String(t || '').replace(/\s+/g, ' ').trim();
const fresh = (rec) => rec && Date.now() - (rec.ts || 0) < TTL_MS;

// ---- całe napisy odcinka ----
async function cacheGetVideo(key) {
    const d = await db();
    const tx = d.transaction('videos', 'readwrite');
    const st = tx.objectStore('videos');
    const rec = await reqP(st.get(String(key)));
    if (!rec) return null;
    if (!fresh(rec)) { st.delete(rec.key); await txDone(tx); return null; }
    rec.ts = Date.now(); // używany film zostaje w pamięci kolejne 90 dni
    st.put(rec);
    await txDone(tx);
    return rec;
}
async function cachePutVideo(key, data) {
    if (!key || !data || !Array.isArray(data.cues) || !data.cues.length) return;
    const d = await db();
    const tx = d.transaction('videos', 'readwrite');
    tx.objectStore('videos').put({
        key: String(key), ts: Date.now(),
        site: String(data.site || ''), lang: String(data.lang || ''), id: data.id == null ? '' : String(data.id),
        title: String(data.title || '').slice(0, 200),
        cues: data.cues.map((c) => [Number(c[0]) || 0, Number(c[1]) || 0, String(c[2] || ''), String(c[3] || '')])
    });
    await txDone(tx);
    cacheMaybeCleanup();
}

// ---- pojedyncze tłumaczenia ----
// Zwraca tablicę tłumaczeń (albo undefined dla brakujących), w kolejności `texts`.
async function cacheGetTexts(texts) {
    const out = new Array(texts.length);
    if (!texts.length) return out;
    const d = await db();
    const tx = d.transaction('texts', 'readwrite');
    const st = tx.objectStore('texts');
    const now = Date.now();
    await Promise.all(texts.map(async (t, i) => {
        const rec = await reqP(st.get(textKey(t)));
        if (fresh(rec) && rec.pl) {
            out[i] = rec.pl;
            if (now - rec.ts > 24 * 3600 * 1000) { rec.ts = now; st.put(rec); } // odśwież najwyżej raz dziennie
        }
    }));
    await txDone(tx);
    return out;
}
async function cachePutTexts(pairs) {
    const ok = (pairs || []).filter((p) => p && p[0] && p[1]);
    if (!ok.length) return;
    const d = await db();
    const tx = d.transaction('texts', 'readwrite');
    const st = tx.objectStore('texts');
    const now = Date.now();
    ok.forEach(([src, pl]) => st.put({ k: textKey(src), pl: String(pl), ts: now }));
    await txDone(tx);
    cacheMaybeCleanup();
}

// ---- sprzątanie / statystyki ----
async function cacheCleanup() {
    const d = await db();
    const limit = IDBKeyRange.upperBound(Date.now() - TTL_MS);
    let removed = 0;
    for (const name of ['videos', 'texts']) {
        const tx = d.transaction(name, 'readwrite');
        const idx = tx.objectStore(name).index('ts');
        await new Promise((resolve, reject) => {
            const cur = idx.openCursor(limit);
            cur.onsuccess = () => { const c = cur.result; if (c) { c.delete(); removed++; c.continue(); } else resolve(); };
            cur.onerror = () => reject(cur.error);
        });
        await txDone(tx);
    }
    try { await chrome.storage.local.set({ [CLEANUP_KEY]: Date.now() }); } catch (e) {}
    if (removed) console.log('[LiveDub SW] Pamięć napisów: usunięto wygasłe wpisy (starsze niż 90 dni): ' + removed);
    return removed;
}
let cleanupRunning = false;
async function cacheMaybeCleanup() {
    if (cleanupRunning) return;
    cleanupRunning = true;
    try {
        const r = await chrome.storage.local.get([CLEANUP_KEY]);
        if (Date.now() - (Number(r && r[CLEANUP_KEY]) || 0) >= CLEANUP_EVERY_MS) await cacheCleanup();
    } catch (e) { console.warn('[LiveDub SW] Pamięć napisów: sprzątanie nie powiodło się', e); }
    finally { cleanupRunning = false; }
}
async function cacheStats() {
    const d = await db();
    const tx = d.transaction(['videos', 'texts'], 'readonly');
    const [videos, texts] = await Promise.all([reqP(tx.objectStore('videos').count()), reqP(tx.objectStore('texts').count())]);
    return { videos, texts, days: TTL_MS / (24 * 3600 * 1000) };
}
async function cacheClear() {
    const d = await db();
    const tx = d.transaction(['videos', 'texts'], 'readwrite');
    tx.objectStore('videos').clear();
    tx.objectStore('texts').clear();
    await txDone(tx);
}

// Sprzątanie przy starcie service workera
cacheMaybeCleanup();

export { cacheGetVideo, cachePutVideo, cacheGetTexts, cachePutTexts, cacheStats, cacheClear };
