import { cacheGetTexts, cachePutTexts } from './subs_cache.js';
import '../../assets/phrase_dict.js'; // [AGENT-EXP] 2026-10-15: słownik fraz (idiomy z Pipera) → globalThis.__LektorPhrase

/* EXT-TRANSLATE: adaptery silnikow sieciowych (osobny modul eksperymentu).
   Uzywane TYLKO gdy extTrOn === true. Format zapytan na podstawie TWP. */

const EXT_TR_ENGINES = ['google', 'bing', 'deepl', 'ai']; // [AGENT-EXP] 'ai' = silnik AI (OpenAI-compatible)

let extTrIdx = 0;                 // pozycja round-robin
let extTrCooldownUntil = {};      // { engine: timestamp } — padniety odpoczywa (20 s → 1 min → 5 min)
let extTrFailCount = {};          // [AGENT-EXP] ile razy z rzędu silnik padł (kasowane po udanym tłumaczeniu)
let extTrCache = new Map();       // "engine|src|pl|tekst" -> tlumaczenie (pamiec SW)
let bingAuthCache = { token: '', at: 0 };

function extTrCountWords(s) { return String(s || '').trim().split(/\s+/).filter(Boolean).length; }
// [AGENT-EXP] rosnąca przerwa 20 s → 1 min → 5 min (wcześniej od razu 5 min po jednej czkawce sieci)
function extTrCooldown(engine) {
    const n = (extTrFailCount[engine] || 0) + 1;
    extTrFailCount[engine] = n;
    extTrCooldownUntil[engine] = Date.now() + [20000, 60000, 300000][Math.min(n, 3) - 1];
}

// [AGENT-EXP] Kolejność prób: wybrany silnik NAJPIERW, potem pozostałe (round-robin), z pominięciem odpoczywających.
// Wcześniej przy jawnym wyborze (np. Bing) jego awaria = brak tłumaczenia; teraz idzie następny silnik.
// Silnik 'ai' wymaga klucza — bez klucza go pomijamy. 'gtab' (karta Google) tylko z ręcznego wyboru.
async function extTrEngineOrder(engineOpt) {
    const now = Date.now();
    const list = (await extTrAiOn()) ? EXT_TR_ENGINES : EXT_TR_ENGINES.filter((e) => e !== 'ai');
    const order = [];
    if (list.includes(engineOpt) || engineOpt === 'gtab') order.push(engineOpt);
    for (let i = 0; i < list.length; i++) {
        const e = list[(extTrIdx + i) % list.length];
        if (!order.includes(e)) order.push(e);
    }
    if (order[0] !== engineOpt) extTrIdx = (extTrIdx + 1) % list.length; // rotacja: następnym razem zaczyna kolejny
    const ready = order.filter((e) => (extTrCooldownUntil[e] || 0) <= now);
    return ready.length ? ready : order.slice(0, 1); // wszystkie odpoczywają — spróbuj chociaż pierwszego
}

async function extTrFetchText(url, reqInit) {
    // Wspolny fetch z naglowkami "jak przegladarka" + limit 60 s.
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 60000);
    try {
        const res = await fetch(url, {
            signal: ctrl.signal,
            credentials: 'omit',
            referrer: 'https://www.youtube.com/',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.6'
            },
            ...(reqInit || {})
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.text();
    } finally { clearTimeout(timer); }
}
/* EXT-TRANSLATE: silniki Google + Bing (formaty z TWP). */
// [FIX 2026-11-02] „Google RPC” (batchexecute) usunięte: adres odpowiadał 404, więc zawsze kończyło się na gtx.
// Ogranicznik żądań zostaje — chroni teraz zwykłe Google (gtx): max 4 żądania na 1350 ms (wzorzec Immersive Translate).
let extTrGgTokens = 4, extTrGgLast = Date.now();
async function extTrGoogleGate() {
    while (true) {
        const now = Date.now();
        extTrGgTokens = Math.min(4, extTrGgTokens + ((now - extTrGgLast) / 1350) * 4);
        extTrGgLast = now;
        if (extTrGgTokens >= 1) { extTrGgTokens -= 1; return; }
        await new Promise((r) => setTimeout(r, ((1 - extTrGgTokens) / 4) * 1350));
    }
}
// [FIX 2026-11-02] Odpowiedź sklejona separatorem ' /// ' → tablica 1:1 z kwestiami. Gdy tłumacz zgubił / przestawił /
// dodał separator, liczba części się nie zgadza — wcześniej tłumaczenia przesuwały się na SĄSIEDNIE kwestie (lektor czytał
// cudze zdanie), a ostatnie dostawały pusty tekst. Teraz błąd z sepMismatch → extTrGoogle dzieli paczkę na pół i ponawia.
function extTrSepParts(parts, texts, who) {
    if (texts.length === 1) return [parts.filter(Boolean).join(' ')];
    if (parts.length !== texts.length) {
        const e = new Error(who + ': separator zgubiony (' + parts.length + ' != ' + texts.length + ' czesci)');
        e.sepMismatch = true;
        throw e;
    }
    return parts;
}

// [AGENT-EXP] === Microsoft/Bing batch (styl Immersive Translate) ===
// Limiter tokenów: max 7 żądań na 1250 ms (wzorzec Immersive Translate dla Edge/Bing).
let extTrEdgeTokens = 7, extTrEdgeLast = Date.now();
async function extTrEdgeGate() {
    while (true) {
        const now = Date.now();
        extTrEdgeTokens = Math.min(7, extTrEdgeTokens + ((now - extTrEdgeLast) / 1250) * 7);
        extTrEdgeLast = now;
        if (extTrEdgeTokens >= 1) { extTrEdgeTokens -= 1; return; }
        await new Promise((r) => setTimeout(r, ((1 - extTrEdgeTokens) / 7) * 1250));
    }
}
// Czy włączony jest checkbox „Microsoft/Bing — tryb batch"? Świeży odczyt ze storage.
async function extTrMicrosoftBatchOn() {
    try {
        const r = await chrome.storage.local.get(['extTrMicrosoftBatch']);
        return r && r.extTrMicrosoftBatch === true;
    } catch (e) { return false; }
}
// Nowa metoda Microsoft: zamiast tagów <bN> wysyła CZYSTĄ TABLICĘ tekstów (jak Immersive)
// i czyta odpowiedź 1:1 — bez regexa, bez HTML-unescape, bez tagów. Ten sam interfejs.
async function extTrBingBatch(src, tgt, texts) {
    if (extTrCountWords(texts.join(' ')) === 0) return texts.map(() => '');
    await extTrEdgeGate();
    const auth = await extTrBingAuth();
    const from = (src && src !== 'auto') ? '&from=' + encodeURIComponent(src) : '';
    const url = 'https://edge.microsoft.com/translate/translatetext?isEnterpriseClient=false' + from + '&to=' + encodeURIComponent(tgt);
    const raw = await extTrFetchText(url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, auth ? { 'Authorization': 'Bearer ' + auth } : {}), // [AGENT-EXP] bez tokenu też działa
        body: JSON.stringify(texts) // ← tablica tekstów (Immersive), nie [body z tagami]
    });
    const data = JSON.parse(raw);
    // Odpowiedź: tablica w tej samej kolejności [{ translations: [{ text }] }, ...] (1:1).
    if (!Array.isArray(data) || data.length !== texts.length) {
        throw new Error('Bing batch: zla liczba wynikow (' + (Array.isArray(data) ? data.length : 'brak') + ' != ' + texts.length + ')');
    }
    const out = data.map((d) => {
        const t = d && d.translations && d.translations[0] && d.translations[0].text;
        return typeof t === 'string' ? t : '';
    });
    if (!out.some(Boolean)) throw new Error('Bing batch: pusta odpowiedz');
    return out;
}
// [AGENT-EXP] === koniec bloku Microsoft/Bing batch ===

// [AGENT-EXP] === Silnik AI (OpenAI-compatible): CometAPI / z.ai / dowolny inny ===
// Jedno uniwersalne ustawienie: URL endpointu + klucz + model. Działa z każdym
// dostawcą zgodnym z OpenAI (CometAPI domyślnie, z.ai przez zmianę URL w opcjach).
async function extTrAiOn() {
    try {
        const r = await chrome.storage.local.get(['aiOn', 'aiApiKey']);
        return r && r.aiOn === true && typeof r.aiApiKey === 'string' && r.aiApiKey.trim().length > 0;
    } catch (e) { return false; }
}
async function extTrAiCfg() {
    // Stały provider i model: CometAPI + darmowy gpt-oss-20b-free (w ustawieniach zostaje tylko klucz).
    const r = await chrome.storage.local.get(['aiApiKey']);
    return {
        url: 'https://api.cometapi.com/v1/chat/completions',
        key: (r.aiApiKey || '').trim(),
        model: 'gpt-oss-20b-free'
    };
}
// Tłumaczy porcję kwestii przez AI (chat completions). Ten sam interfejs co inne silniki.
// Teksty łączone separatorem ' /// ' (jak Google), odpowiedź rozdzielana po '///'.
async function extTrAi(src, tgt, texts) {
    const c = await extTrAiCfg();
    if (!c.key) throw new Error('AI: brak klucza API');
    if (extTrCountWords(texts.join(' ')) === 0) return texts.map(() => '');
    const langName = (l) => (l === 'pl' ? 'Polish' : l === 'en' ? 'English' : (l || 'unknown'));
    const sys = 'You are a translation engine. Translate the user\'s text from ' + langName(src) +
        ' to ' + langName(tgt) + '. Output ONLY the translation, no quotes, no commentary. ' +
        'The separator " /// " separates segments: translate each segment independently and KEEP the separator " /// " exactly unchanged in your output.';
    const res = await extTrFetchText(c.url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + c.key,
            'Accept': '*/*'
        },
        body: JSON.stringify({
            model: c.model,
            temperature: 0,
            messages: [
                { role: 'system', content: sys },
                { role: 'user', content: texts.join(' /// ') }
            ]
        })
    });
    let data;
    try { data = JSON.parse(res); } catch (e) { throw new Error('AI: zla odpowiedz JSON'); }
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof content !== 'string' || !content.trim()) {
        throw new Error('AI: ' + ((data && data.error && data.error.message) || 'pusta odpowiedz'));
    }
    // Modele AI czasem zawijają odpowiedź w ``` lub cudzysłowy — czyścimy delikatnie.
    let clean = content.trim();
    if (clean.startsWith('```')) {
        clean = clean.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
    }
    const parts = clean.split('///').map((s) => s.trim());
    if (parts.length !== texts.length) {
        throw new Error('AI: zla liczba czesci (' + parts.length + ' != ' + texts.length + ')');
    }
    if (!parts.some(Boolean)) throw new Error('AI: puste tlumaczenie');
    return parts;
}
// [AGENT-EXP] === koniec bloku AI ===

async function extTrGoogle(src, tgt, texts) {
    // [FIX 2026-11-02] separator zgubiony → paczka na pół i jeszcze raz (pojedyncza kwestia nie może się przesunąć)
    try { return await extTrGoogleOnce(src, tgt, texts); }
    catch (e) {
        if (!e || !e.sepMismatch || texts.length < 2) throw e;
        console.warn('[LiveDub SW] Google:', e.message, '— dzielę paczkę');
        const mid = Math.ceil(texts.length / 2);
        const a = await extTrGoogle(src, tgt, texts.slice(0, mid));
        const b = await extTrGoogle(src, tgt, texts.slice(mid));
        return a.concat(b);
    }
}
async function extTrGoogleOnce(src, tgt, texts) {
    await extTrGoogleGate();   // [FIX 2026-11-02] ogranicznik żądań (wcześniej tylko dla RPC)
    return extTrGoogleGtx(src, tgt, texts);
}
// Google „bezpośrednio”: publiczny adres translate_a/single?client=gtx (oryginalny kod extTrGoogle).
async function extTrGoogleGtx(src, tgt, texts) {
    const sep = ' /// ';
    const q = texts.join(sep);
    if (extTrCountWords(q) === 0) return texts.map(() => '');
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl='
        + encodeURIComponent(src) + '&tl=' + encodeURIComponent(tgt) + '&dt=t&q=' + encodeURIComponent(q);
    const raw = await extTrFetchText(url, { headers: { 'Accept': '*/*' } });
    const data = JSON.parse(raw);
    let flat = '';
    if (Array.isArray(data[0])) for (const part of data[0]) { if (Array.isArray(part) && part[0]) flat += part[0]; }
    const parts = String(flat).split('///').map((s) => s.trim());
    const out = extTrSepParts(parts, texts, 'Google');   // [FIX 2026-11-02] bez przesunięć kwestii
    if (!out.some(Boolean)) throw new Error('Google: puste tlumaczenie');
    return out;
}

async function extTrBingAuth() {
    const now = Date.now();
    // [AGENT-EXP] edge.microsoft.com/translate/auth odpowiada 404, a translatetext działa BEZ tokenu.
    // Wcześniej brak tokenu = wyjątek → Bing padał przy KAŻDEJ kwestii (i odpoczywał 5 min).
    // Teraz: token, jeśli jest; jeśli nie — puste (zapamiętane na 8 min, żeby nie pytać przy każdej kwestii).
    if (bingAuthCache.at && now - bingAuthCache.at < 8 * 60000) return bingAuthCache.token;
    let t = '';
    try { t = await extTrFetchText('https://edge.microsoft.com/translate/auth'); } catch (e) { t = ''; }
    bingAuthCache = { token: String(t || '').trim(), at: now };
    return bingAuthCache.token;
}
function extTrBingUnescape(s) {
    return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
async function extTrBing(src, tgt, texts) {
    const auth = await extTrBingAuth();
    let id = 10;
    const body = texts.map((t) => {
        // [AGENT-EXP] 2026-10-17: nowa linia (granica kwestii w bloku z kontekstem) → <br>, bo HTML skleja białe znaki
        const r = '<b' + id + '>' + String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\s*\n\s*/g, '<br>') + '</b' + id + '>';
        id++;
        return r;
    }).join('');
    const from = (src && src !== 'auto') ? '&from=' + encodeURIComponent(src) : '';
    const url = 'https://edge.microsoft.com/translate/translatetext?isEnterpriseClient=false' + from + '&to=' + encodeURIComponent(tgt);
    const raw = await extTrFetchText(url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, auth ? { 'Authorization': 'Bearer ' + auth } : {}), // [AGENT-EXP] bez tokenu też działa
        body: JSON.stringify([body])
    });
    const data = JSON.parse(raw);
    const html = String((data[0] && data[0].translations && data[0].translations[0] && data[0].translations[0].text) || '');
    if (!html) throw new Error('Bing: pusta odpowiedz');
    const byId = new Map();
    const re = /<b(\d+)>([\s\S]*?)<\/b\1>/g;
    let m;
    while ((m = re.exec(html)) !== null) byId.set(+m[1], extTrBingUnescape(m[2].replace(/\s*<br\s*\/?>\s*/gi, '\n')).trim());   // [AGENT-EXP] <br> → nowa linia
    // [FIX 2026-11-02] po NUMERZE znacznika (b10, b11…), nie po kolejności: gdy Bing zgubił jeden znacznik, wszystkie dalsze
    // tłumaczenia przesuwały się o jedną kwestię. Zgubione kwestie tłumaczymy jeszcze raz osobną (mniejszą) paczką.
    const out = texts.map((_, i) => (byId.has(10 + i) ? byId.get(10 + i) : ''));
    const miss = [];
    texts.forEach((t, i) => { if (!byId.has(10 + i) && String(t || '').trim()) miss.push(i); });
    if (miss.length && miss.length < texts.length) {
        try {
            const again = await extTrBing(src, tgt, miss.map((i) => texts[i]));
            miss.forEach((i, j) => { out[i] = again[j] || ''; });
        } catch (e) { /* zostają puste — lepiej niż cudze zdanie */ }
    }
    if (!out.some(Boolean)) throw new Error('Bing: puste tlumaczenie');
    return out;
}
/* EXT-TRANSLATE cz.3: DeepL + wywolanie silnika z cache + fallback. */

async function extTrDeepl(src, tgt, texts) {
    // [AGENT-EXP] target_lang WIELKIMI literami („PL”) → DeepL oddawał tekst po ANGIELSKU (bez błędu, więc
    // lektor czytał angielski); małe („pl”) → po polsku. Bez source_lang DeepL sam rozpoznaje język
    // (wcześniej „auto” = zawsze EN, co psuło inne języki).
    const tgtL = tgt === 'en' ? 'en-US' : String(tgt || 'pl').toLowerCase();
    const url = 'https://oneshot-free.www.deepl.com/v1/storefront/translate';
    const body = { language_model: 'next-gen', target_lang: tgtL, usage_type: 'Translate', text: texts };
    if (src && src !== 'auto') body.source_lang = String(src).toUpperCase();
    const raw = await extTrFetchText(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const data = JSON.parse(raw);
    const tr = data && data.translations;
    if (!Array.isArray(tr) || !tr.length || !tr[0].text) throw new Error('DeepL: pusta odpowiedz');
    // [FIX 2026-11-02] DeepL oddaje tłumaczenie dla KAŻDEGO tekstu z tablicy — wtedy 1:1. Wcześniej brane było tylko
    // pierwsze i rozkładane na wszystkie kwestie według liczby słów (zdania cięte w połowie, reszta tłumaczeń ginęła).
    if (tr.length === texts.length && tr.length > 1) {
        const all = tr.map((x) => String((x && x.text) || '').trim());
        if (all.some(Boolean)) return all;
    }
    const flat = String(tr[0].text);
    if (texts.length === 1) return [flat.trim()];
    const words = flat.split(/\s+/).filter(Boolean);
    const srcWords = texts.map(extTrCountWords);
    const total = srcWords.reduce((a, b) => a + b, 0) || 1;
    const out = [];
    let pos = 0;
    for (let i = 0; i < texts.length; i++) {
        const n = i === texts.length - 1 ? words.length - pos : Math.round(words.length * srcWords[i] / total);
        out.push(words.slice(pos, pos + n).join(' '));
        pos += n;
    }
    if (!out.some(Boolean)) throw new Error('DeepL: puste tlumaczenie');
    return out;
}

// ===== Silnik chrome-ai (Gemini Nano przez offscreen) + trwała pamięć tłumaczeń =====
// Pamięć aiTranslationMemory współdzielona z AI Subtitle Translatorem na stronie ustawień.
const AI_MEM_KEY = 'aiTranslationMemory';
const AI_MEM_MAX = 5000;
function aiHash(s) {
    s = String(s || '');
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
        h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619);
        h2 = Math.imul(h2 + s.charCodeAt(i), 2246822519);
    }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}
async function aiMemGet(src) {
    try {
        const r = await chrome.storage.local.get([AI_MEM_KEY]);
        const mem = (r && r[AI_MEM_KEY]) || {};
        const e = mem[aiHash(src)];
        return e && e.pl ? String(e.pl) : '';
    } catch (e) { return ''; }
}
async function aiMemSave(src, pl, engine) {
    if (!src || !pl) return;
    try {
        const r = await chrome.storage.local.get([AI_MEM_KEY]);
        const mem = (r && r[AI_MEM_KEY] && typeof r[AI_MEM_KEY] === 'object') ? r[AI_MEM_KEY] : {};
        mem[aiHash(src)] = { src: String(src).slice(0, 2000), pl: String(pl).slice(0, 2000), engine: engine || 'chrome-ai', ts: Date.now() };
        const keys = Object.keys(mem);
        if (keys.length > AI_MEM_MAX) {
            keys.sort((a, b) => (mem[a].ts || 0) - (mem[b].ts || 0));
            for (let i = 0; i < keys.length - AI_MEM_MAX; i++) delete mem[keys[i]];
        }
        await chrome.storage.local.set({ [AI_MEM_KEY]: mem });
    } catch (e) { /* quota / brak storage — tłumaczenie i tak wraca do lektora */ }
}
function aiOffscreen(payload) {
    return new Promise((resolve, reject) => {
        try {
            chrome.runtime.sendMessage({ target: 'offscreen', ...payload }, (resp) => {
                if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
                resolve(resp);
            });
        } catch (e) { reject(e); }
    });
}
async function aiChromeOpts() {
    try {
        const r = await chrome.storage.local.get(['aiChromeMode', 'aiChromeContext', 'aiChromeContextChars', 'aiChromePrompt']);
        return {
            mode: r.aiChromeMode === 'prompt' ? 'prompt' : 'translator',
            ctxN: Math.max(0, parseInt(r.aiChromeContext || '5', 10) || 0),
            ctxChars: Math.max(0, parseInt(r.aiChromeContextChars || '1000', 10) || 0),
            prompt: (typeof r.aiChromePrompt === 'string' && r.aiChromePrompt.trim())
                ? r.aiChromePrompt
                : 'Tłumacz na naturalny polski lektorski. Tylko tłumaczenie, bez dopisków.'
        };
    } catch (e) {
        return { mode: 'translator', ctxN: 5, ctxChars: 1000, prompt: 'Tłumacz na naturalny polski lektorski. Tylko tłumaczenie, bez dopisków.' };
    }
}
async function extTrChromeAi(src, tgt, texts) {
    const o = await aiChromeOpts();
    const out = new Array(texts.length);
    const todo = [];
    for (let i = 0; i < texts.length; i++) {
        const saved = await aiMemGet(texts[i]);
        if (saved) out[i] = saved;
        else todo.push(i);
    }
    if (!todo.length) return out;
    const items = todo.map((i) => ({
        idx: i,
        text: texts[i],
        // okienko kontekstowe: N poprzednich kwestii z TEJ porcji (tylko tryb prompt)
        context: o.mode === 'prompt' && o.ctxN > 0 ? texts.slice(Math.max(0, i - o.ctxN), i) : []
    }));
    const resp = await aiOffscreen({
        action: 'AI_CHROME_TRANSLATE',
        mode: o.mode, srcLang: src || 'en', contextChars: o.ctxChars, prompt: o.prompt, items
    });
    if (!resp || !resp.ok || !Array.isArray(resp.results)) throw new Error('AI Chrome: brak odpowiedzi');
    resp.results.forEach((r) => {
        out[r.idx] = r.text || '';
        if (r.text) aiMemSave(texts[r.idx], r.text).catch(() => {});
    });
    if (!out.some(Boolean)) throw new Error('AI Chrome: puste tłumaczenie (model niedostępny?)');
    return out;
}

// ===== Silnik 'gtab': Google Translate w karcie (to samo co skrypt Tampermonkey, ale automatycznie) =====
// SW trzyma przypiętą kartę translate.google.com (bez usypiania), wpisuje tam porcję
// (jedna kwestia = jedna linia), czyta wynik i oddaje lektorowi. Numery/czasy nigdy tam nie trafiają.
// Gdy karta zawiedzie — porcja idzie zwykłym Google API, żeby lektor nie został bez tekstu.
const GTAB_MAX_CHARS = 4800;
let gtabId = null;
let gtabLock = Promise.resolve(); // jedna porcja naraz w karcie
let gtabFailUntil = 0;            // po awarii karta odpoczywa 2 min (porcje idą przez API)

function gtabUrl(src, tgt) {
    return 'https://translate.google.com/?sl=' + encodeURIComponent(src) + '&tl=' + encodeURIComponent(tgt) + '&op=translate';
}
// Tylko strona Tłumacza (Google potrafi przepisać parametry w adresie — nie sprawdzamy ich).
function gtabIsTranslate(url) {
    return /^https:\/\/translate\.google\.[a-z.]+\//.test(String(url || ''));
}

function gtabWaitLoaded(tabId, ms = 15000) {
    return new Promise((resolve, reject) => {
        let finished = false;
        const finish = (err) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(onUpd);
            err ? reject(err) : resolve();
        };
        const check = (tab) => {
            if (!tab || tab.status !== 'complete') return;
            if (/consent\.google\./.test(tab.url || '')) finish(new Error('zaakceptuj/odrzuć cookies w karcie Tłumacza Google'));
            else if (gtabIsTranslate(tab.url)) finish();
        };
        const onUpd = (id, info, tab) => { if (id === tabId && info.status === 'complete') check(tab); };
        const timer = setTimeout(() => finish(new Error('timeout ładowania karty')), ms);
        chrome.tabs.onUpdated.addListener(onUpd);
        chrome.tabs.get(tabId).then(check).catch(finish);
    });
}

let gtabTabLang = null; // język, na który karta była ostatnio ustawiona
async function gtabEnsure(src, tgt) {
    let tab = null;
    if (gtabId == null) {
        // SW mógł zostać uśpiony — numer karty pamiętamy w storage.session
        try { const r = await chrome.storage.session.get(['gtabId', 'gtabTabLang']); gtabId = r.gtabId ?? null; gtabTabLang = r.gtabTabLang ?? null; } catch (e) {}
    }
    if (gtabId != null) { try { tab = await chrome.tabs.get(gtabId); } catch (e) { tab = null; } }
    if (!tab) {
        console.log('[LiveDub SW] Google karta: otwieram nową kartę (' + src + ' → ' + tgt + ')');
        tab = await chrome.tabs.create({ url: gtabUrl(src, tgt), active: false, pinned: true });
        gtabId = tab.id;
        gtabTabLang = src;
    } else if (tab.discarded || !gtabIsTranslate(tab.url) || gtabTabLang !== src) {
        console.log('[LiveDub SW] Google karta: przeładowuję (' + src + ' → ' + tgt + ')');
        await chrome.tabs.update(tab.id, { url: gtabUrl(src, tgt) });
        gtabTabLang = src;
    }
    try { await chrome.storage.session.set({ gtabId, gtabTabLang }); } catch (e) {}
    // Karta nie może zostać uśpiona/zrzucona przez oszczędzanie pamięci
    try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch (e) {}
    await gtabWaitLoaded(tab.id);
    return tab.id;
}

// Funkcja wstrzykiwana do karty Google (świat MAIN strony, musi być samowystarczalna).
// Karta w tle nie rysuje wyniku na ekranie (przeglądarka wstrzymuje renderowanie),
// ale zapytanie do Google i tak idzie — dlatego wynik czytamy z odpowiedzi sieciowej
// strony (batchexecute/MkEWBc), a nie z jej wyglądu. Bez pętli z timerami.
function gtabPageWorker(text, timeoutMs) {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const G = window.__lektorGtab || (window.__lektorGtab = { subs: new Set(), seen: new Map() });
    if (!G.hooked) {
        G.hooked = true;
        const parse = (raw) => {
            const body = String(raw || '').replace(/^\)\]\}'?\s*/, '');
            for (const line of body.split('\n')) {
                const t = line.trim();
                if (!t.startsWith('[')) continue;
                let arr;
                try { arr = JSON.parse(t); } catch (e) { continue; }
                const row = Array.isArray(arr) && arr.find((x) => Array.isArray(x) && x[0] === 'wrb.fr' && x[1] === 'MkEWBc');
                if (!row) continue;
                let inner;
                try { inner = JSON.parse(row[2]); } catch (e) { return null; }
                const src = (inner && inner[1] && inner[1][4] && inner[1][4][0]) || (inner && inner[0] && inner[0][6] && inner[0][6][0]) || '';
                const sents = inner && inner[1] && inner[1][0] && inner[1][0][0] && inner[1][0][0][5];
                if (!Array.isArray(sents)) return null;
                let out = '';
                for (const s of sents) {
                    const piece = String((s && s[0]) || '');
                    if (out && piece && !/\s$/.test(out) && !/^\s/.test(piece)) out += ' ';
                    out += piece;
                }
                return { src, out: out.trim() };
            }
            return null;
        };
        const deliver = (raw) => {
            const r = parse(raw);
            if (!r || !r.out) return;
            G.seen.set(norm(r.src), r.out);
            if (G.seen.size > 100) G.seen.delete(G.seen.keys().next().value);
            G.subs.forEach((fn) => fn(r));
        };
        const isRpc = (u) => /batchexecute/.test(u) && /MkEWBc/.test(u);
        const xOpen = XMLHttpRequest.prototype.open, xSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (m, u) { this.__lektorUrl = String(u || ''); return xOpen.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function () {
            if (isRpc(this.__lektorUrl)) this.addEventListener('load', () => { try { deliver(this.responseText); } catch (e) {} });
            return xSend.apply(this, arguments);
        };
        const oFetch = window.fetch;
        window.fetch = function (input) {
            const p = oFetch.apply(this, arguments);
            const u = String((input && input.url) || input || '');
            if (isRpc(u)) p.then((r) => r.clone().text()).then(deliver).catch(() => {});
            return p;
        };
    }
    const findTa = () => document.querySelector('textarea[aria-label="Tekst źródłowy"]')
        || document.querySelector('textarea[aria-label="Source text"]')
        || document.querySelector('textarea');
    // Pole Google może pojawić się chwilę po załadowaniu strony
    const waitTa = () => new Promise((res) => {
        const now = findTa();
        if (now) { res(now); return; }
        const obs = new MutationObserver(() => { const t = findTa(); if (t) { obs.disconnect(); clearTimeout(tm); res(t); } });
        obs.observe(document.documentElement, { subtree: true, childList: true });
        const tm = setTimeout(() => { obs.disconnect(); res(null); }, 8000);
    });
    return waitTa().then((ta) => new Promise((resolve) => {
        const want = norm(text);
        if (G.seen.has(want)) { resolve({ ok: true, text: G.seen.get(want) }); return; }
        if (!ta) { resolve({ ok: false, error: 'brak pola tekstowego Google' }); return; }
        let other = null, otherTm = null;
        const finish = (v) => { G.subs.delete(sub); clearTimeout(hard); clearTimeout(otherTm); resolve(v); };
        const sub = (r) => {
            if (norm(r.src) === want) { finish({ ok: true, text: r.out }); return; }
            // Google lekko zmienił tekst źródłowy (np. znaki/spacje) — przyjmij, jeśli długość się zgadza
            const ls = norm(r.src).length;
            if (ls > want.length * 0.8 && ls < want.length * 1.2) {
                other = r.out;
                clearTimeout(otherTm);
                otherTm = setTimeout(() => finish({ ok: true, text: other }), 1500);
            }
        };
        G.subs.add(sub);
        const hard = setTimeout(() => finish(other ? { ok: true, text: other } : { ok: false, error: 'brak odpowiedzi Google' }), timeoutMs);
        const setText = (t) => {
            ta.focus();
            if (ta.value) { ta.select(); document.execCommand('delete', false, null); }
            if (t) document.execCommand('insertText', false, t);
            if (ta.value !== t) ta.value = t;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
        };
        document.title = '⏳ Lektor tłumaczy…';
        setText('');
        setText(text);
    })).then((r) => { document.title = r.ok ? '✓ Lektor — Tłumacz Google' : '⚠ Lektor: ' + r.error; return r; });
}

async function gtabOnce(src, tgt, text) {
    // Zawsze „Wykryj język”: Google sam rozpozna każdy język napisów (też mieszane i nietypowe kody)
    const tabId = await gtabEnsure('auto', tgt);
    const run = chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: gtabPageWorker, args: [text, 15000] });
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Google karta: timeout')), 22000));
    const [r] = await Promise.race([run, timeout]);
    const res = r && r.result;
    if (!res || !res.ok) throw new Error('Google karta: ' + ((res && res.error) || 'brak odpowiedzi'));
    console.log('[LiveDub SW] Google karta: przetłumaczono ' + text.length + ' znaków');
    return res.text;
}

// Tłumaczy linie 1:1. Jeśli Google skleił/rozdzielił linie — dzieli porcję na pół i próbuje ponownie.
async function gtabLines(src, tgt, lines) {
    if (lines.length > 1 && lines.join('\n').length > GTAB_MAX_CHARS) {
        const mid = Math.ceil(lines.length / 2);
        return (await gtabLines(src, tgt, lines.slice(0, mid))).concat(await gtabLines(src, tgt, lines.slice(mid)));
    }
    const out = await gtabOnce(src, tgt, lines.join('\n'));
    const res = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (res.length === lines.length) return res;
    if (lines.length === 1) return [res.join(' ')];
    console.warn('[LiveDub SW] Google karta: ' + res.length + ' linii zamiast ' + lines.length + ' — dzielę porcję');
    const mid = Math.ceil(lines.length / 2);
    return (await gtabLines(src, tgt, lines.slice(0, mid))).concat(await gtabLines(src, tgt, lines.slice(mid)));
}

async function extTrGoogleTab(src, tgt, texts) {
    // Kwestia może mieć kilka linii — w karcie każda kwestia musi być jedną linią
    const flat = texts.map((t) => String(t || '').replace(/\s*\n\s*/g, ' ').trim());
    const pos = [], lines = [];
    flat.forEach((t, i) => { if (t) { pos.push(i); lines.push(t); } });
    const out = texts.map(() => '');
    if (!lines.length) return out;
    if (Date.now() < gtabFailUntil) return extTrGoogle(src, tgt, texts);

    const job = gtabLock.then(() => gtabLines(src, tgt, lines));
    gtabLock = job.catch(() => {});
    try {
        const res = await job;
        res.forEach((t, j) => { out[pos[j]] = t; });
        return out;
    } catch (e) {
        gtabFailUntil = Date.now() + 2 * 60000;
        console.warn('[LiveDub SW] Google karta zawiodła, porcja idzie przez Google API:', String((e && e.message) || e));
        return extTrGoogle(src, tgt, texts);
    }
}
// Cały tekst (paczka pliku SRT, jak w skrypcie 2.9) w karcie Google — dla tłumacza napisów w ustawieniach.
async function gtabTranslateText(src, text) {
    const job = gtabLock.then(() => gtabOnce(src, 'pl', String(text || '')));
    gtabLock = job.catch(() => {});
    return job;
}
// ===== koniec silnika 'gtab' =====

async function extTrEngineCall(engine, src, tgt, texts) {
    const key = (t) => engine + '|' + src + '|pl|' + t;
    const uncached = [];
    const uncachedPos = [];
    const out = new Array(texts.length);
    texts.forEach((t, i) => {
        const c = extTrCache.get(key(t));
        if (c !== undefined) out[i] = c;
        else { uncached.push(t); uncachedPos.push(i); }
    });
    if (uncached.length) {
        let res;
        if (engine === 'google') res = await extTrGoogle(src, tgt, uncached);
        else if (engine === 'gtab') res = await extTrGoogleTab(src, tgt, uncached);
        else if (engine === 'bing') {
            // [AGENT-EXP] Checkbox „Microsoft/Bing — tryb batch": OFF = stara metoda z tagami <bN>, ON = czysta tablica (styl Immersive).
            if (await extTrMicrosoftBatchOn()) res = await extTrBingBatch(src, tgt, uncached);
            else res = await extTrBing(src, tgt, uncached);
        }
        else if (engine === 'ai') res = await extTrAi(src, tgt, uncached); // [AGENT-EXP]
        else if (engine === 'chrome-ai') res = await extTrChromeAi(src, tgt, uncached); // AI Chrome na żądanie (Gemini Nano)
        else res = await extTrDeepl(src, tgt, uncached);
        uncached.forEach((t, j) => {
            const v = res[j] || '';
            out[uncachedPos[j]] = v;
            if (v) {
                extTrCache.set(key(t), v);
                if (extTrCache.size > 2000) { const fk = extTrCache.keys().next().value; extTrCache.delete(fk); }
                aiMemSave(t, v, engine === 'chrome-ai' ? undefined : engine).catch(() => {});
            }
        });
    }
    return out;
}

// [AGENT-EXP] 2026-10-15: gotowe tłumaczenie ze słownika fraz albo '' (słownik: assets/phrase_dict.js).
function extTrPhrase(text, src) {
    try { const P = globalThis.__LektorPhrase; return (P && P.lookup(text, src)) || ''; } catch (e) { return ''; }
}

// Najpierw pamięć tłumaczeń (90 dni, subs_cache.js) — do sieci idą tylko teksty, których tam nie ma.
// [AGENT-EXP] 2026-10-15: jeszcze wcześniej słownik fraz (idiomy, które tłumacze biorą dosłownie) — wygrywa też
// ze starym dosłownym tłumaczeniem z pamięci. Wspólne wejście EXT_TR_LIST, EXT_TR_LIVE i EXT_TR_PUSH (porcje).
// Trafień ze słownika nie zapisujemy w pamięci (słownik i tak jest pierwszy).
// [AGENT-EXP] 2026-10-15 (z userscriptu Piper 4.2.17): „ANGIELSKI LOKALNIE, INNE JĘZYKI W CHMURZE” — przy silniku
// „lokalny” angielski tłumaczy Translator Chrome (offscreen, akcja TR_LOCAL_EN; gdy niedostępny — Bing), a każdy
// inny język od razu Bing (gdy zawiedzie — Google / DeepL). Opcja extTrNonEnCloud (domyślnie WŁ.); wyłączona =
// jak dawniej (wszystko Bingiem). Język: ze ścieżki napisów, a przy „auto” — częste słowa (wykrywacz języka Chrome
// nie działa w service workerze, a w Chrome użytkownika w ogóle).
const EXT_TR_EN_WORDS = /(?<![\p{L}'])(the|and|you|your|i|it|is|are|was|were|be|been|have|has|had|do|does|did|not|no|yes|yeah|what|where|when|who|why|how|this|that|there|here|to|of|in|on|at|for|with|my|me|we|us|he|him|she|her|they|them|can|could|will|would|just|get|got|go|going|come|know|want|let|okay|ok|oh|hey|please|sorry|thank|thanks|right|well|now|so|but|if|all|up|out|about|from|stop|wait|look|man|god|good|fine|really)(?![\p{L}])/giu;
// częste słowa innych języków pisanych łacinką bez znaków diakrytycznych (es, fr, de, it, pt, nl)
const EXT_TR_NONEN_WORDS = /(?<![\p{L}'])(el|la|los|las|que|es|un|una|unos|y|en|por|para|con|del|al|lo|se|muy|pero|como|esto|eso|le|les|des|et|est|je|tu|il|elle|nous|vous|ils|pas|ce|sur|avec|dans|qui|der|die|das|und|ist|nicht|ich|du|ein|eine|mit|sie|wir|ihr|auch|aber|noch|het|een|ik|niet|ben|wat|maar|che|di|non|sono|ma|per|questo|anche|um|uma|eu|voce|nao|mas|isso|muito)(?![\p{L}])/giu;
function extTrLooksEnglish(t) {
    t = String(t || '');
    const words = t.match(/\p{L}+/gu) || [];
    if (!words.length) return false;
    const letters = words.join(''), foreign = (letters.match(/[^a-z]/gi) || []).length;
    if (foreign / letters.length > 0.04) return false;    // ą, é, ü, cyrylica, CJK… — to nie angielski
    const tt = t.replace(/[’‘]/g, "'");
    const hits = (tt.match(EXT_TR_EN_WORDS) || []).length, other = (tt.match(EXT_TR_NONEN_WORDS) || []).length;
    if (other > hits) return false;                       // „Me gusta la pizza”, „Ich bin hier”
    return words.length <= 3 ? hits * 2 >= words.length : hits / words.length >= 0.25;   // krótkie: „Was ist das?” to nie angielski
}
function extTrIsEnglish(sample, src) {
    const s = String(src || 'auto').toLowerCase().replace(/^a\./, '').split('-')[0];
    if (s && s !== 'auto' && s !== 'und') return s === 'en';
    return extTrLooksEnglish(sample);
}
async function extTrNonEnCloudOn() {
    try { const r = await chrome.storage.local.get('extTrNonEnCloud'); return r.extTrNonEnCloud !== false; } catch (e) { return true; }
}
// Silnik dla „lokalnego” (sieć wył.): 'lokalny-en' (angielski → Translator Chrome) albo 'bing'.
async function extTrLocalEngine(sample, src) {
    return ((await extTrNonEnCloudOn()) && extTrIsEnglish(sample, src)) ? 'lokalny-en' : 'bing';
}
// Translator Chrome en→pl w dokumencie offscreen (limit 20 s); '' tam, gdzie się nie udało.
function extTrLocalEn(texts) {
    return new Promise((resolve, reject) => {
        const tm = setTimeout(() => reject(new Error('Translator Chrome (offscreen) nie odpowiada')), 20000);
        try {
            chrome.runtime.sendMessage({ target: 'offscreen', action: 'TR_LOCAL_EN', texts }, (resp) => {
                clearTimeout(tm);
                if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
                if (!resp || !resp.ok || !Array.isArray(resp.texts)) { reject(new Error((resp && resp.error) || 'Translator Chrome: brak odpowiedzi')); return; }
                resolve(resp.texts);
            });
        } catch (e) { clearTimeout(tm); reject(e); }
    });
}
// 'lokalny-en': najpierw Translator Chrome, kwestie bez wyniku (albo całość przy awarii) — Bing i dalej.
async function extTrTranslateLocalEn(texts) {
    let out = [];
    try { out = await extTrLocalEn(texts); } catch (e) { console.warn('[LiveDub SW] Translator Chrome (angielski) niedostępny — Bing:', String((e && e.message) || e)); }
    const rest = [];
    texts.forEach((t, i) => { if (!out[i] && String(t || '').trim()) rest.push(i); });
    if (!rest.length) return { texts: out, engine: 'Translator Chrome' };
    const r = await extTrTranslateBatchNet('en', rest.map((i) => texts[i]), 'bing');
    rest.forEach((p, j) => { out[p] = r.texts[j] || ''; });
    return { texts: out, engine: rest.length === texts.length ? r.engine : 'Translator Chrome + ' + r.engine };
}

// [AGENT-EXP] 2026-10-17: TŁUMACZENIE Z KONTEKSTEM (opcja extTrContext, domyślnie WŁ.). Kolejne kwestie idą
// do tłumacza jednym tekstem (rozdzielone nową linią) — tłumacz widzi, co było przed i po (zaimki, rodzaj,
// „you” = ty / wy). Blok trwa do PAUZY W MOWIE: skrypt strony podaje brk[i] = true, gdy przed kwestią jest
// przerwa >= 2 s (albo kwestia nie jest następną w filmie); wtedy blok do EXT_TR_CTX_MAX kwestii / znaków.
// Bez brk (brak czasów) — bloki po EXT_TR_CTX_NOBRK. Wynik dzielimy po liniach; gdy liczba linii się nie zgadza
// (tłumacz skleił / rozbił), te kwestie idą jeszcze raz pojedynczo. Pamięć tłumaczeń trzyma pojedyncze kwestie.
const EXT_TR_CTX_MAX = 8, EXT_TR_CTX_CHARS = 800, EXT_TR_CTX_NOBRK = 3;
async function extTrContextOn() {
    try { const r = await chrome.storage.local.get('extTrContext'); return r.extTrContext !== false; } catch (e) { return true; }
}
function extTrOneLine(t) { return String(t || '').replace(/\s*[\r\n]+\s*/g, ' ').trim(); }
// bloki z pozycji (rosnąco) w texts; sąsiedztwo = kolejne pozycje i brak pauzy (brk)
function extTrContextGroups(pos, texts, brk) {
    const max = Array.isArray(brk) ? EXT_TR_CTX_MAX : EXT_TR_CTX_NOBRK;
    const groups = [];
    let cur = [], chars = 0;
    pos.forEach((p) => {
        const len = extTrOneLine(texts[p]).length + 1;
        const prev = cur.length ? cur[cur.length - 1] : -2;
        const pause = Array.isArray(brk) && brk[p] !== false;
        if (cur.length && (p !== prev + 1 || pause || cur.length >= max || chars + len > EXT_TR_CTX_CHARS)) { groups.push(cur); cur = []; chars = 0; }
        cur.push(p); chars += len;
    });
    if (cur.length) groups.push(cur);
    return groups;
}
// call(lista tekstów) → { texts, engine }; zwraca tłumaczenia dla pozycji pos (w tej kolejności)
async function extTrTranslateWithContext(pos, texts, brk, call) {
    const groups = extTrContextGroups(pos, texts, brk);
    const res = new Map();
    if (groups.every((g) => g.length === 1)) {
        const r = await call(pos.map((p) => texts[p]));
        pos.forEach((p, j) => res.set(p, (r.texts && r.texts[j]) || ''));
        return { texts: pos.map((p) => res.get(p)), engine: r.engine };
    }
    const r = await call(groups.map((g) => g.map((p) => extTrOneLine(texts[p])).join('\n')));
    const again = [];
    groups.forEach((g, k) => {
        const lines = String((r.texts && r.texts[k]) || '').split(/\s*\n+\s*/).map((l) => l.trim()).filter(Boolean);
        if (g.length === 1) res.set(g[0], lines.join(' '));
        else if (lines.length === g.length) g.forEach((p, j) => res.set(p, lines[j]));
        else g.forEach((p) => again.push(p));
    });
    if (again.length) {
        const r2 = await call(again.map((p) => texts[p]));
        again.forEach((p, j) => res.set(p, (r2.texts && r2.texts[j]) || ''));
    }
    return { texts: pos.map((p) => res.get(p) || ''), engine: r.engine };
}

async function extTrTranslateBatch(src, texts, engineOpt, brk) {
    const dict = texts.map((t) => extTrPhrase(t, src));
    let mem = [];
    if (texts.some((t, i) => !dict[i] && String(t || '').trim())) {
        try { mem = await cacheGetTexts(texts); } catch (e) { mem = []; }
    }
    const miss = [];
    texts.forEach((t, i) => { if (!dict[i] && !mem[i] && String(t || '').trim()) miss.push(i); });
    if (!miss.length) {
        const fromMem = texts.some((_, i) => !dict[i] && mem[i]);
        return { texts: texts.map((_, i) => dict[i] || mem[i] || ''), engine: (fromMem || !dict.some(Boolean)) ? 'pamięć' : 'słownik fraz' };
    }
    const call = (list) => engineOpt === 'lokalny-en'   // [AGENT-EXP] 2026-10-15: angielski → Translator Chrome
        ? extTrTranslateLocalEn(list)
        : extTrTranslateBatchNet(src, list, engineOpt);
    // [AGENT-EXP] 2026-10-17: z kontekstem (bloki do pauzy); gdy coś pójdzie źle — po staremu, pojedynczo
    const r = (miss.length > 1 && await extTrContextOn())
        ? await extTrTranslateWithContext(miss, texts, brk, call).catch(() => call(miss.map((i) => texts[i])))
        : await call(miss.map((i) => texts[i]));
    const out = texts.map((_, i) => dict[i] || mem[i] || '');
    miss.forEach((p, j) => { out[p] = r.texts[j] || ''; });
    cachePutTexts(miss.map((p, j) => [texts[p], r.texts[j]])).catch(() => {});
    return { texts: out, engine: r.engine };
}

async function extTrTranslateBatchNet(src, texts, engineOpt) {
    // [AGENT-EXP] wybrany silnik najpierw, potem pozostałe (extTrEngineOrder); sukces kasuje licznik awarii
    let lastErr = null;
    for (const engine of await extTrEngineOrder(engineOpt)) {
        try {
            const out = await extTrEngineCall(engine, src || 'en', 'pl', texts);
            extTrFailCount[engine] = 0;
            return { texts: out, engine };
        } catch (e) {
            lastErr = e;
            console.warn('[LiveDub SW] EXT-TRANSLATE silnik padl:', engine, String((e && e.message) || e));
            extTrCooldown(engine);
        }
    }
    throw new Error('Wszystkie silniki sieciowe niedostepne' + (lastErr ? ' (' + String((lastErr && lastErr.message) || lastErr) + ')' : ''));
}
/* EXT-TRANSLATE cz.4: kolejka porcji wyrazowych z odstepami.
   Content script wysyla kwestie, SW tnie na porcje 100/300/400 wyrazow
   (nigdy w srodku kwestii), tlumaczy JEDNA porcje na zapytanie i czeka
   interwal + jitter ±50% przed nastepna. Gotowa porcja wraca od razu
   (EXT_TR_PART), koniec = EXT_TR_DONE. */

const EXT_TR_CHUNK_WORDS = { '100': 100, '300': 300, '400': 400 };
// [AGENT-EXP] 2026-10-17: doszly 2/3/4 min; '10min' usuniete z Ustawien — stara zapisana wartosc liczy sie jak 5 min
const EXT_TR_INT_MS = { '20s': 20000, '30s': 30000, '1min': 60000, '2min': 120000, '3min': 180000, '4min': 240000, '5min': 300000, '10min': 300000 };

function extTrChunkWords(chunkOpt) {
    const base = EXT_TR_CHUNK_WORDS[chunkOpt];
    const pick = base || [100, 300, 400][Math.floor(Math.random() * 3)];
    return Math.max(20, Math.round(pick * (0.9 + Math.random() * 0.2)));
}
function extTrIntervalMs(intervalOpt) {
    const base = EXT_TR_INT_MS[intervalOpt] || 30000;
    return Math.round(base * (0.5 + Math.random())); // [AGENT-EXP] 2026-10-17: ±50% (bylo ±30%)
}

const extTrJobs = new Map(); // jobId -> { queue, busy, timer, tabId, lang, engineOpt, chunkOpt, intervalOpt }

async function extTrOpts() {
    try {
        const r = await chrome.storage.local.get(['extTrOn', 'extTrEngine', 'extTrChunk', 'extTrInterval']);
        return {
            on: r.extTrOn === true,
            engine: typeof r.extTrEngine === 'string' ? r.extTrEngine : 'rotacja',
            chunk: typeof r.extTrChunk === 'string' ? r.extTrChunk : 'mieszane',
            interval: typeof r.extTrInterval === 'string' ? r.extTrInterval : '30s'
        };
    } catch (e) { return { on: false, engine: 'rotacja', chunk: 'mieszane', interval: '30s' }; }
}

async function extTrJobPush(jobId, tabId, lang, items) {
    let job = extTrJobs.get(jobId);
    if (!job) {
        const o = await extTrOpts();
        job = {
            queue: [], busy: false, timer: null, tabId: tabId,
            lang: lang || 'en',
            engineOpt: o.engine, chunkOpt: o.chunk, intervalOpt: o.interval
        };
        extTrJobs.set(jobId, job);
    }
    (items || []).forEach((it) => {
        if (it && typeof it.idx === 'number' && typeof it.text === 'string' && it.text.trim()) {
            job.queue.push({ idx: it.idx, text: it.text });
        }
    });
    extTrJobPump(jobId);
}

function extTrJobTakeChunk(job) {
    const target = extTrChunkWords(job.chunkOpt);
    const chunk = [];
    let words = 0;
    while (job.queue.length) {
        const w = extTrCountWords(job.queue[0].text);
        if (chunk.length && words + w > target) break;
        if (w > 4000) { job.queue.shift(); continue; } // absurdalna kwestia — pomin
        chunk.push(job.queue.shift());
        words += w;
        if (words >= target) break;
    }
    return chunk;
}

async function extTrJobPump(jobId) {
    const job = extTrJobs.get(jobId);
    if (!job || job.busy || !job.queue.length) return;
    job.busy = true;
    const chunk = extTrJobTakeChunk(job);
    if (!chunk.length) { job.busy = false; return; }
    try {
        const r = await extTrTranslateBatch(job.lang, chunk.map((c) => c.text), job.engineOpt);
        chunk.forEach((c, i) => {
            try {
                chrome.tabs.sendMessage(job.tabId,
                    { action: 'EXT_TR_PART', jobId, idx: c.idx, text: r.texts[i] || '', engine: r.engine },
                    () => { void chrome.runtime.lastError; });
            } catch (e) {}
        });
    } catch (e) {
        chunk.forEach((c) => {
            try { chrome.tabs.sendMessage(job.tabId, { action: 'EXT_TR_PART', jobId, idx: c.idx, text: '' }, () => { void chrome.runtime.lastError; }); } catch (ee) {}
        });
    }
    const wait = extTrIntervalMs(job.intervalOpt);
    job.timer = setTimeout(() => {
        const j = extTrJobs.get(jobId);
        if (!j) return;
        j.busy = false;
        if (j.queue.length) { extTrJobPump(jobId); }
        else {
            try { chrome.tabs.sendMessage(j.tabId, { action: 'EXT_TR_DONE', jobId }, () => { void chrome.runtime.lastError; }); } catch (e) {}
            extTrJobs.delete(jobId);
        }
    }, wait);
}

// Lista kwestii z automatycznie pobranych napisów (auto_subs.js). Silnik z ustawień;
// gdy tłumaczenie sieciowe jest wyłączone (lokalny) — silnik sieciowy, bo lokalny Translator
// nie działa w service workerze. [AGENT-EXP] Bing zamiast Google: w 🏁 wyścigu ~0,2 s wobec ~1 s
// na nową kwestię; gdy Bing padnie, idą Google i DeepL (extTrEngineOrder).
async function extTrTranslateList(src, texts, preferLocal, brk) {   // [AGENT-EXP] brk: pauzy (kontekst)
    const o = await extTrOpts();
    const list = (texts || []).map((t) => String(t || ''));
    // [AGENT-EXP] 2026-10-15: „lokalny” — angielskie napisy Translatorem Chrome, inne Bingiem
    let engine = o.on ? o.engine : await extTrLocalEngine(list.slice(0, 40).join('\n'), src);
    // [AGENT-EXP] 2026-10-17: napisy Łowcy (preferLocal) — angielskie ZAWSZE lokalnym Translatorem Chrome,
    // także gdy w ustawieniach wybrano silnik sieciowy; inne języki — silnik z ustawień (lokalny umie tylko en→pl)
    if (preferLocal && extTrIsEnglish(list.slice(0, 40).join('\n'), src)) engine = 'lokalny-en';
    const r = await extTrTranslateBatch(src || 'auto', list, engine, Array.isArray(brk) && brk.length === list.length ? brk : null);
    return (r && r.texts) || [];
}

// Jedna kwestia na żywo (strony bez gotowego pliku napisów, np. iq.com, 🅾 OCR) — wybrany silnik, język wykrywany.
// [AGENT-EXP] engine: wymuszony silnik (OCR „Kto tłumaczy”: google / bing). Bez niego: silnik z ustawień,
// a przy „lokalnym” (sieć wył.) Bing — wcześniej rotacja z niedziałającym Bingiem i DeepL po angielsku.
// Zwraca { text, engine } — kto naprawdę przetłumaczył (pokazywane w okienku OCR).
async function extTrTranslateLive(text, engine) {
    // [AGENT-EXP] 2026-10-17: OCR „Tłumaczy: tylko lokalny” — Translator Chrome (offscreen, en→pl), BEZ zapasu w sieci
    if (engine === 'lokalny') {
        const out = await extTrLocalEn([String(text || '')]);
        return { text: (out && out[0]) || '', engine: 'Translator Chrome' };
    }
    const o = await extTrOpts();
    // [AGENT-EXP] 2026-10-15: „lokalny” — angielska kwestia Translatorem Chrome, inna Bingiem
    const eng = engine || (o.on ? o.engine : await extTrLocalEngine(String(text || ''), 'auto'));
    const r = await extTrTranslateBatch('auto', [String(text || '')], eng);
    return { text: (r && r.texts && r.texts[0]) || '', engine: (r && r.engine) || eng };
}

// [AGENT-EXP] 🏁 Wyścig tłumaczy: jedna linia jednym silnikiem, z pominięciem pamięci tłumaczeń
// (czysty czas usługi). Wywoływane z okienka OCR (EXT_TR_RACE_ONE).
async function extTrRaceOne(engine, text) {
    const t0 = Date.now();
    const q = [String(text || '')];
    let out;
    if (engine === 'google') out = await extTrGoogleGtx('auto', 'pl', q);
    else if (engine === 'bing') out = (await extTrMicrosoftBatchOn()) ? await extTrBingBatch('auto', 'pl', q) : await extTrBing('auto', 'pl', q);
    else if (engine === 'deepl') out = await extTrDeepl('auto', 'pl', q);
    else throw new Error('nieznany silnik: ' + engine);
    return { text: String((out && out[0]) || '').trim(), ms: Date.now() - t0 };
}

function extTrJobCancel(jobId) {
    const job = extTrJobs.get(jobId);
    if (job && job.timer) { try { clearTimeout(job.timer); } catch (e) {} }
    extTrJobs.delete(jobId);
}

export { extTrJobPush, extTrJobCancel, gtabTranslateText, extTrTranslateLive, extTrTranslateList, extTrRaceOne }; // [AGENT-EXP] extTrRaceOne
