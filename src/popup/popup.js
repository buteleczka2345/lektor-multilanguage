// popup.js — GUI dla Piper Lektor (Live-Dubbing).
// Klucze storage zgodne z silnikiem: enabled, engine, offlineVoice,
// piperSpeed, duckLevel.
// TYLKO Piper (offline) — bez chrome.tts / lektora systemowego.

// W paczce jest DOKŁADNIE JEDEN głos: model Sherpa VITS pl_PL-meski_wg_glos-medium.
// Dawna lista głosów Pipera (Gosia/Jarvis/Renata/Michał/Justyna) została usunięta —
// te modele nie istnieją w rozszerzeniu, a popup pokazywał 6 pozycji do wyboru.
const SHERPA_VOICE = 'pl_PL-meski_wg_glos-medium';

const DEFAULTS = {
    enabled: true,
    engine: 'offline',
    offlineVoice: SHERPA_VOICE,
    piperSpeed: 1.0,
    duckLevel: 20,
    ttsVolume: 100,
    lookaheadMin: 3,           // zapas syntezy do przodu (minuty) — Netflix
    primeSubtitleSource: 'both', // Prime Video: 'both' | 'immersive' | 'native'
    ytAuto: true,              // [AGENT-EXP] 2026-10-17: YouTube: automat pobierania całych napisów — domyślnie WŁ. (prośba użytkownika)
    ytAutoV2: false,           // [AGENT-EXP] znacznik jednorazowej migracji automatu YouTube (opcja usunięta z popupu 2026-11-14)
    ytSource: 'imt',           // YouTube: 'imt' (Immersive Translate) | 'auto' (własne SRT + Translator Chrome)
    subtitleOffsetMs: 0,       // przesunięcie lektora względem wideo (ms); ujemne = wcześniej
    censorEnabled: true,       // cenzura przekleństw (wszystkie języki naraz)
    censorMode: 'remove',      // 'remove' | 'beep' | 'replace' | 'dashes'
    censorCustomWords: '',       // własne słowa po przecinku
    builtinVoiceRemoved: false   // wbudowany głos męski wyłączony przez użytkownika (🗑)
};

// --- Wbudowany głos męski (plik w paczce rozszerzenia) ---
// Model męski leży w paczce jako plik .onnx. Chrome NIE daje rozszerzeniu
// prawa kasowania własnych plików z dysku (katalog paczki jest tylko do
// odczytu, brak API), więc dwie drogi dają pełną kontrolę:
//   📥 PRZENIESIENIE (bez internetu) — kopiujemy te same 3 pliki, które silnik
//      i tak czyta z paczki, do pamięci głosów (IndexedDB 'lektorVoices'), pod
//      standardowymi nazwami model.onnx / tokens.txt / model.onnx.json. Głos
//      staje się ZWYKŁYM wpisem listy „Własny głos” — z ▶ i 🗑 — i można go
//      skasować jednym kliknięciem, jak każdy pobrany głos.
//   🗑 WYŁĄCZENIE — wyłącza wbudowany głos bez kopiowania (flaga
//      builtinVoiceRemoved); silnik odmawia wtedy startu z modelu w paczce.
// W obu przypadkach 60 MB w paczce zwolnisz tylko ręcznie (kasując plik .onnx
// na dysku) — stąd podpowiedź ze ścieżką; folder z espeak-ng-data MUSI zostać.
// Folder modelu w paczce to 'vits-piper-<nazwa głosu>' (tak samo czyta go worker).
const BUILTIN_PKG_DIR = 'sherpa/vits-piper-' + SHERPA_VOICE;
const BUILTIN_MODEL_REL = BUILTIN_PKG_DIR + '/' + SHERPA_VOICE + '.onnx';
const BUILTIN_MODEL_PATH = BUILTIN_MODEL_REL.replace(/\//g, '\\');
// Wpis, pod którym przeniesiony (skopiowany) model męski zamieszka na liście
// własnych głosów — DOKŁADNIE tam, gdzie trafiają głosy z „Języków świata”.
const BUILTIN_VOICE_ID = 'builtin-pl-meski';
const BUILTIN_VOICE_NAME = 'Męski — Sherpa VITS (PL)';
let builtinRemoved = false;   // stan z storage (odświeżany razem z listą głosów)
let builtinConfirmTs = 0;     // 1. kliknięcie 🗑 bez innego głosu → prosi o potwierdzenie
const BUILTIN_CONFIRM_MS = 10000;

const OFFLINE_VOICES = [
    { value: SHERPA_VOICE, label: 'Męski — Sherpa VITS (PL)' }
];

// ===== Własny głos (Sherpa/Piper z plików użytkownika) =====
// Pliki modelu trzymamy w IndexedDB ('lektorVoices'/'files') — to samo pochodzenie
// co offscreen/worker, więc silnik czyta model stamtąd przy każdym starcie.
const VOICE_DB = 'lektorVoices';
const VOICE_STORE = 'files';
function voiceDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(VOICE_DB, 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(VOICE_STORE)) req.result.createObjectStore(VOICE_STORE);
        };
        req.onerror = () => reject(req.error || new Error('IndexedDB niedostępna'));
        req.onsuccess = () => resolve(req.result);
    });
}
function voicePut(key, blob) {
    return voiceDb().then((db) => new Promise((res, rej) => {
        const tx = db.transaction(VOICE_STORE, 'readwrite');
        tx.objectStore(VOICE_STORE).put(blob, key);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
    }));
}
function voiceDel(key) {
    return voiceDb().then((db) => new Promise((res) => {
        try {
            const tx = db.transaction(VOICE_STORE, 'readwrite');
            tx.objectStore(VOICE_STORE).delete(key);
            tx.oncomplete = () => res();
            tx.onerror = () => res();
        } catch (e) { res(); }
    }));
}
function voiceGet(key) {
    return voiceDb().then((db) => new Promise((res, rej) => {
        try {
            const get = db.transaction(VOICE_STORE, 'readonly').objectStore(VOICE_STORE).get(key);
            get.onsuccess = () => res(get.result || null);
            get.onerror = () => rej(get.error);
        } catch (e) { rej(e); }
    }));
}
// Klucze per-głos: '<id>/model.onnx'. 'default' / brak id = stare klucze bez
// prefiksu (kompatybilność z pierwszą wersją — jeden głos w pamięci).
function voiceIdKey(id, file) { return (id && id !== 'default' ? id + '/' : '') + file; }
function loadVoiceState() {
    return new Promise((resolve) => chrome.storage.local.get(['customVoice', 'customVoiceList'], (d) => resolve({
        active: (d && d.customVoice) || null,
        list: (d && Array.isArray(d.customVoiceList)) ? d.customVoiceList : []
    })));
}
function saveList(list) { chrome.storage.local.set({ customVoiceList: list }); }
// Klasyfikacja wskazanych plików: model (.onnx), tokens.txt (dowolny .txt), *.onnx.json
function classifyVoiceFiles(files) {
    const out = { onnx: null, tokens: null, json: null };
    for (const f of Array.from(files || [])) {
        const n = String(f.name || '').toLowerCase();
        if (n.endsWith('.onnx') && !out.onnx) out.onnx = f;
        else if (n.endsWith('.txt') && !out.tokens) out.tokens = f;
        else if (n.endsWith('.json') && !out.json) out.json = f;
    }
    return out;
}
function fmtBytes(n) {
    n = Number(n) || 0;
    return n > 1024 * 1024 ? (n / (1024 * 1024)).toFixed(0) + ' MB' : (n / 1024).toFixed(0) + ' kB';
}
// Kosz 🗑 przy wbudowanym głosie męskim: Chrome nie pozwala rozszerzeniu
// kasować własnych plików, więc kosz WYŁĄCZA ten głos w aplikacji (flaga
// builtinVoiceRemoved — silnik odmawia startu z wbudowanego modelu) i pokazuje
// ścieżkę pliku do ręcznego skasowania, jeśli chcesz zwolnić 60 MB na dysku.
function syncBuiltinVoiceUi(removed, otherName, onList) {
    builtinRemoved = !!removed;
    const sel = $('offlineVoiceSelect');
    const delBtn = $('builtinVoiceDeleteBtn');
    const restoreBtn = $('builtinVoiceRestoreBtn');
    const hint = $('builtinVoiceHint');
    const pathEl = $('builtinVoicePath');
    const status = $('builtinVoiceStatus');
    const migrateBtn = $('builtinVoiceMigrateBtn');
    if (sel) sel.disabled = builtinRemoved;
    if (delBtn) delBtn.style.display = builtinRemoved ? 'none' : '';
    if (restoreBtn) restoreBtn.style.display = builtinRemoved ? '' : 'none';
    if (hint) hint.style.display = (builtinRemoved || onList) ? '' : 'none';
    if (pathEl) pathEl.textContent = BUILTIN_MODEL_PATH;
    // Przycisk „przenieś na listę” znika, gdy głos już tam jest — wtedy
    // wystarczy ▶ (aktywuj) i 🗑 (skasuj) na liście własnych głosów.
    if (migrateBtn) {
        // Pokazujemy go tylko, gdy głosu NIE ma jeszcze na liście i nie jest
        // wyłączony — inaczej zastępuje go wpis na liście (▶ / 🗑) albo ↺.
        migrateBtn.style.display = (!onList && !builtinRemoved) ? '' : 'none';
        chrome.storage.local.get(['builtinVoiceMigratedOnce'], (d) => {
            migrateBtn.textContent = (d && d.builtinVoiceMigratedOnce)
                ? '↺ Przywróć wbudowany głos męski na listę głosów (bez pobierania)'
                : '⤵ Przenieś wbudowany głos męski na listę głosów (bez pobierania)';
        });
    }
    if (status) {
        status.style.display = '';
        status.textContent = builtinRemoved
            ? ('🗑 Wbudowany głos męski wyłączony'
                + (otherName ? ' — lektor używa teraz „' + otherName + '”.' : ' — lektor milczy do czasu dodania innego głosu.'))
            : (onList
                ? 'Wbudowany głos męski: na liście głosów poniżej (▶ aktywuj / 🗑 skasuj).'
                : 'Wbudowany głos męski: aktywny (awaryjny, w paczce rozszerzenia).');
    }
}

// Przeniesienie wbudowanego głosu męskiego DO PAMIĘCI GŁOSÓW (IndexedDB) —
// dokładnie tam, gdzie trafiają głosy z „Języków świata”. Pliki czytamy
// LOKALNIE z paczki rozszerzenia (chrome.runtime.getURL + fetch), więc to
// kopiowanie, nie pobieranie z internetu. Efekt: głos pojawia się na liście
// własnych głosów, gdzie ▶ go aktywuje, a zwykły 🗑 kasuje — a wróci zawsze
// tym samym przyciskiem (źródło w paczce zostaje nietknięte).
async function migrateBuiltinVoice(silent) {
    const st = $('customVoiceStatus');
    const say = (t) => { if (!silent && st) st.textContent = t; };
    try {
        const cur = await loadVoiceState();
        if (cur.list.some((v) => v.id === BUILTIN_VOICE_ID)) return true; // już przeniesiony
        say('⤵ Kopiuję wbudowany głos męski do pamięci głosów (lokalnie, bez internetu)…');
        const getBlob = async (rel) => {
            const r = await fetch(chrome.runtime.getURL(rel));
            if (!r.ok) throw new Error('brak pliku w paczce: ' + rel);
            return await r.blob();
        };
        const onnx = await getBlob(BUILTIN_PKG_DIR + '/' + SHERPA_VOICE + '.onnx');
        if (!(onnx && onnx.size > 1024 * 1024)) throw new Error('plik modelu wygląda na uszkodzony');
        const tokens = await getBlob(BUILTIN_PKG_DIR + '/tokens.txt');
        if (!(tokens && tokens.size > 0)) throw new Error('brak tokens.txt w paczce');
        let json = null;
        try { json = await getBlob(BUILTIN_PKG_DIR + '/' + SHERPA_VOICE + '.onnx.json'); } catch (e2) { /* opcjonalny */ }
        await voicePut(voiceIdKey(BUILTIN_VOICE_ID, 'model.onnx'), onnx);
        await voicePut(voiceIdKey(BUILTIN_VOICE_ID, 'tokens.txt'), tokens);
        if (json) await voicePut(voiceIdKey(BUILTIN_VOICE_ID, 'model.onnx.json'), json);
        else await voiceDel(voiceIdKey(BUILTIN_VOICE_ID, 'model.onnx.json'));
        const fresh = await loadVoiceState();
        saveList(fresh.list.filter((v) => v.id !== BUILTIN_VOICE_ID).concat([{
            id: BUILTIN_VOICE_ID, name: BUILTIN_VOICE_NAME, sizeOnnx: onnx.size,
            savedAt: Date.now(), type: 'piper', lang: 'pl'
        }]));
        // Od tej pory wiemy, że użytkownik miał ten głos na liście — po 🗑 nie
        // dodajemy go już sami (żeby nie „wracał” wbrew woli), tylko przycisk ↺.
        chrome.storage.local.set({ builtinVoiceMigratedOnce: true });
        say('✓ Wbudowany głos męski jest teraz na liście głosów — ▶ aktywuje, 🗑 kasuje. Wróci jednym kliknięciem, bez pobierania.');
        refreshCustomVoiceUi();
        return true;
    } catch (e) {
        say('⛔ Nie udało się przenieść wbudowanego głosu: ' + ((e && e.message) || e));
        return false;
    }
}

function updateCustomVoiceUi(cv) {
    const btn = $('customVoiceBtn');
    const disableBtn = $('customVoiceDisable');
    const detail = $('customVoiceDetail');
    const voiceSelect = $('offlineVoiceSelect');
    const foot = $('voiceOfflineFootnote');
    const enabled = !!(cv && cv.enabled);
    if (disableBtn) disableBtn.style.display = enabled ? '' : 'none';
    if (voiceSelect) voiceSelect.disabled = enabled;
    if (foot) foot.textContent = enabled
        ? 'Wbudowany głos wstrzymany — aktywny jest własny (poniżej).'
        : 'Sherpa nie ma wbudowanego głosu — aktywuj głos z listy poniżej.';   // [AGENT-EXP] 2026-10-24
    if (!detail) return;
    if (enabled) {
        detail.textContent = '✓ Aktywny własny głos: „' + (cv.name || 'model') + '” (' + fmtBytes(cv.sizeOnnx) + ').';
        detail.className = 'footnote ok';   // [VOX] kolory z popup.css
        if (btn) btn.textContent = '📂 Zamień pliki własnego głosu…';
    } else {
        detail.textContent = (cv && cv._failed)
            ? '⛔ Własny głos „' + (cv.name || '') + '” nie wystartował. Przyczyna: log silnika w sekcji „Test lektora”. Możesz wczytać pliki ponownie.'   // [AGENT-EXP] 2026-10-24
            : 'Wskaż 3 pliki modelu Sherpa/Piper: model.onnx + tokens.txt + model.onnx.json (json opcjonalny). Głos zapisze się w rozszerzeniu i przeżyje restart przeglądarki.';
        detail.className = (cv && cv._failed) ? 'footnote err' : 'footnote';
        if (btn) btn.textContent = '📂 Wskaż pliki własnego głosu (onnx + txt + json)';
    }
}

// ===== Lista własnych głosów w pamięci (aktywuj / usuń) =====
function renderVoiceList(list, active) {
    const el = $('customVoiceList');
    if (!el) return;
    el.innerHTML = '';
    if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'footnote';
        empty.textContent = 'Brak zapisanych własnych głosów — dodaj pierwszy przyciskiem powyżej.';
        el.appendChild(empty);
        return;
    }
    const actId = active && active.enabled ? active.id : null;
    list.forEach((v) => {
        const row = document.createElement('div');
        row.className = 'list-row';   // [VOX] wygląd w popup.css
        const isAct = v.id === actId;
        const label = document.createElement('span');
        label.className = 'name' + (isAct ? ' active' : '');
        label.textContent = (isAct ? '● ' : '○ ') + (v.name || v.id) + ' (' + fmtBytes(v.sizeOnnx) + ')';
        row.appendChild(label);
        if (!isAct) {
            const act = document.createElement('button');
            act.textContent = '▶';
            act.title = 'Aktywuj ten głos';
            act.className = 'mini ok';
            act.addEventListener('click', () => activateVoice(v));
            row.appendChild(act);
        }
        const del = document.createElement('button');
        del.textContent = '🗑';
        del.title = 'Usuń ten głos z pamięci';
        del.className = 'mini danger';
        del.addEventListener('click', () => deleteVoice(v));
        row.appendChild(del);
        el.appendChild(row);
    });
}
function activateVoice(v) {
    const meta = { enabled: true, id: v.id, name: v.name, sizeOnnx: v.sizeOnnx, savedAt: v.savedAt || Date.now(), type: v.type || '', lang: v.lang || '' };
    chrome.storage.local.set({ customVoice: meta }, () => {
        try { chrome.runtime.sendMessage({ action: 'TTS_RESTART_OFFSCREEN' }); } catch (e) {}
        refreshCustomVoiceUi();
        const st = $('customVoiceStatus');
        if (st) st.textContent = '✓ Aktywuję „' + (v.name || v.id) + '” — silnik przeładowuje się (kilka–kilkanaście s).';
    });
}
async function deleteVoice(v) {
    const st = $('customVoiceStatus');
    const isBuiltin = v.id === BUILTIN_VOICE_ID;
    try {
        await voiceDel(voiceIdKey(v.id, 'model.onnx'));
        await voiceDel(voiceIdKey(v.id, 'tokens.txt'));
        await voiceDel(voiceIdKey(v.id, 'model.onnx.json'));
        await voiceDel(voiceIdKey(v.id, 'lexicon.txt'));
        await voiceDel(voiceIdKey(v.id, 'rule.fst'));
    } catch (e) { /* kluczy może nie być — trudno */ }
    const { active, list } = await loadVoiceState();
    saveList(list.filter((x) => x.id !== v.id));
    const wasActive = !!(active && active.enabled && active.id === v.id);
    // Wbudowany głos męski: skasowanie kopii z pamięci to za mało — gdyby włączył
    // się awaryjny głos z paczki, brzmiałby dokładnie tak samo (użytkownik
    // „skasował, a mówi dalej”). Dlatego wyłączamy też wbudowany męski (flaga
    // builtinVoiceRemoved) i — jeśli jest inny głos — od razu go aktywujemy.
    if (isBuiltin) {
        const others = list.filter((x) => x.id !== BUILTIN_VOICE_ID);
        const nextV = others[0];
        const hasActiveCustom = !!(active && active.enabled && !wasActive && (active.sizeOnnx || 0) > 0);
        if (!nextV && !hasActiveCustom) {
            const now = Date.now();
            if (now - builtinConfirmTs > BUILTIN_CONFIRM_MS) {
                builtinConfirmTs = now;
                if (st) st.textContent = '⚠ To jedyny głos, jaki masz. Kliknij 🗑 ponownie w ciągu 10 s, żeby skasować — lektor będzie milczał, dopóki nie dodasz innego głosu. „↺ Przywróć” zawsze wróci jednym kliknięciem.';
                return;
            }
        }
        builtinConfirmTs = 0;
        chrome.storage.local.set({ builtinVoiceRemoved: true }, () => {
            if (nextV) activateVoice(nextV);
            else refreshCustomVoiceUi();
            if (st) st.textContent = '🗑 Wbudowany głos męski skasowany'
                + (nextV ? ' — aktywuję „' + (nextV.name || nextV.id) + '” (silnik przeładowuje się, kilka–kilkanaście s).'
                         : ' — lektor milczy do czasu dodania innego głosu.')
                + ' Wróci przyciskiem ↺ (kopiowanie z paczki, bez internetu).';
        });
        return;
    }
    if (wasActive) {
        chrome.storage.local.set({ customVoice: { enabled: false, id: '', name: '', sizeOnnx: 0, savedAt: Date.now() } }, () => {
            try { chrome.runtime.sendMessage({ action: 'TTS_RESTART_OFFSCREEN' }); } catch (e2) {}
        });
    }
    refreshCustomVoiceUi();
    if (st) st.textContent = '🗑 Usunięto „' + (v.name || v.id) + '”' + (wasActive ? ' (był aktywny — Sherpa nie ma teraz głosu).' : '.')   // [AGENT-EXP] 2026-10-24;
}
async function refreshCustomVoiceUi() {
    const { active, list } = await loadVoiceState();
    updateCustomVoiceUi(active);
    renderVoiceList(list, active);
    // Stan kosza/przenoszenia przy wbudowanym głosie (🗑 / ⤵) — zawsze zgodny ze storage.
    try {
        const items = await new Promise((res) => chrome.storage.local.get(['builtinVoiceRemoved'], res));
        const others = list.filter((v) => v.id !== SHERPA_VOICE && v.id !== BUILTIN_VOICE_ID);
        const name = (active && active.enabled && active.name) || (others[0] && others[0].name) || '';
        const onList = list.some((v) => v.id === BUILTIN_VOICE_ID);
        syncBuiltinVoiceUi(!!items.builtinVoiceRemoved, name, onList);
    } catch (e) { /* brak storage — zostaw stan jak jest */ }
}

const $ = (id) => document.getElementById(id);

function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}

function loadSettings() {
    return new Promise((resolve) => {
        chrome.storage.local.get(Object.keys(DEFAULTS), (items) => {
            resolve(Object.assign({}, DEFAULTS, items));
        });
    });
}

function saveSettings(patch) {
    chrome.storage.local.set(patch);
}

// --- Głosy Piper (offline) ---
function populateOfflineVoices(selectedVoice) {
    const select = $('offlineVoiceSelect');
    if (!select) return;
    select.innerHTML = '';
    OFFLINE_VOICES.forEach((v) => {
        const opt = document.createElement('option');
        opt.value = v.value;
        opt.textContent = v.label;
        select.appendChild(opt);
    });
    select.value = selectedVoice || OFFLINE_VOICES[0].value;
}

function debounce(fn, ms) {
    let t = null;
    return function (...args) {
        if (t) clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), ms || 200);
    };
}

async function init() {
    const s = await loadSettings();

    // Wyczyść stare wpisy diagnostyczne service workera (błędy silnika OFFSCREEN
    // zostają — są teraz wyświetlane w popupie przy „Ostatnie kwestie”).
    try { chrome.storage.local.remove(['__svcError', '__contentError']); } catch (e) {}

    // Jedyny wspierany silnik to Sherpa VITS (offline).
    saveSettings({ engine: 'offline' });

    // Głos lektora — TYLKO oryginalny, wbudowany głos Sherpa (lista ma jedną pozycję).
    // Sanityzacja: w storage mogła zostać nazwa głosu, którego nie ma w paczce
    // (stara lista Pipera) — silnik i tak grał oryginalny głos Sherpa, więc wracamy
    // do niego również w ustawieniach.
    if (s.offlineVoice !== SHERPA_VOICE) {
        saveSettings({ offlineVoice: SHERPA_VOICE, engine: 'offline' });
    }
    populateOfflineVoices(SHERPA_VOICE);
    const voiceSelect = $('offlineVoiceSelect');
    if (voiceSelect) {
        voiceSelect.addEventListener('change', () => {
            chrome.storage.local.set({ offlineVoice: SHERPA_VOICE, engine: 'offline' }, function () {
                try { chrome.runtime.sendMessage({ action: 'INIT_TTS' }); } catch (err) {}
            });
        });
    }

    // ===== Własne głosy (Sherpa/Piper z plików) — lista w pamięci =====
    const customInput = $('customVoiceInput');
    const customBtn = $('customVoiceBtn');
    const customDisable = $('customVoiceDisable');
    const customStatus = $('customVoiceStatus');
    // Migracja starego zapisu (jeden głos bez id) → wpis 'default' na liście.
    try {
        const legacy = await voiceGet('model.onnx');
        if (legacy) {
            const { active, list } = await loadVoiceState();
            if (!list.some((x) => x.id === 'default')) {
                saveList(list.concat([{ id: 'default', name: (active && active.name) || 'własny (wcześniejszy)', sizeOnnx: (active && active.sizeOnnx) || 0, savedAt: Date.now() }]));
                if (active && active.enabled && !active.id) {
                    chrome.storage.local.set({ customVoice: Object.assign({}, active, { id: 'default' }) });
                }
            }
        }
    } catch (e) { /* brak starych danych — nic nie rób */ }
    refreshCustomVoiceUi();
    if (customBtn && customInput) {
        customBtn.addEventListener('click', () => customInput.click());
        customInput.addEventListener('change', async () => {
            // [AGENT-EXP] 2026-11-02: folder Matchy rozpoznany sam (matchaImportFiles), reszta jak dotąd = Sherpa/Piper
            if (customStatus) customStatus.textContent = 'Sprawdzam pliki…';
            let mt = null;
            try { mt = await matchaImportFiles(customInput.files); } catch (e) { mt = '⛔ Nie udało się zapisać Matchy: ' + ((e && e.message) || e); }
            if (mt) {
                if (customStatus) customStatus.textContent = mt;
                customInput.value = '';
                return;
            }
            const { onnx, tokens, json } = classifyVoiceFiles(customInput.files);
            const err = !onnx ? 'Brak pliku .onnx (model głosu)'
                : !tokens ? 'Brak pliku tokens.txt — wybrałeś tylko model.onnx? Wybierz cały folder lub wskaż też tokens.txt.'
                : (onnx.size < 1024 * 1024) ? 'Plik .onnx wygląda na zbyt mały — to nie jest model głosu'
                : null;
            if (err) {
                if (customStatus) customStatus.textContent = '⛔ ' + err;
                customInput.value = '';
                return;
            }
            const base = String(onnx.name || 'wlasny-glos').replace(/\.onnx$/i, '');
            const id = 'v' + Date.now();
            if (customStatus) customStatus.textContent = 'Zapisuję model (' + fmtBytes(onnx.size) + ')…';
            try {
                const { list } = await loadVoiceState();
                await voicePut(voiceIdKey(id, 'model.onnx'), onnx);
                await voicePut(voiceIdKey(id, 'tokens.txt'), tokens);
                if (json) await voicePut(voiceIdKey(id, 'model.onnx.json'), json); else await voiceDel(voiceIdKey(id, 'model.onnx.json'));
                const meta = { enabled: true, id, name: base, sizeOnnx: onnx.size, savedAt: Date.now() };
                saveList(list.concat([{ id, name: base, sizeOnnx: onnx.size, savedAt: meta.savedAt }]));
                chrome.storage.local.set({ customVoice: meta }, () => {
                    try { chrome.runtime.sendMessage({ action: 'TTS_RESTART_OFFSCREEN' }); } catch (e2) {}
                    refreshCustomVoiceUi();
                    if (customStatus) customStatus.textContent = '✓ Dodano i aktywuję „' + base + '” (silnik przeładowuje się, kilka–kilkanaście s).';
                });
            } catch (e) {
                if (customStatus) customStatus.textContent = '⛔ Nie udało się zapisać: ' + ((e && e.message) || e);
            }
            customInput.value = '';
        });
    }
    if (customDisable) {
        customDisable.addEventListener('click', () => {
            chrome.storage.local.set({ customVoice: { enabled: false, id: '', name: '', sizeOnnx: 0, savedAt: Date.now() } }, () => {
                try { chrome.runtime.sendMessage({ action: 'TTS_RESTART_OFFSCREEN' }); } catch (e) {}
                refreshCustomVoiceUi();
                if (customStatus) customStatus.textContent = 'Własny głos wyłączony (głosy zostały w pamięci).'   // [AGENT-EXP] 2026-10-24;
            });
        });
    }
    // ===== Kosz 🗑 przy wbudowanym głosie męskim ==========================
    // Chrome nie daje rozszerzeniu kasować własnych plików z dysku (katalog
    // paczki jest tylko do odczytu, brak API), więc 🗑 robi wszystko, co jest
    // możliwe AUTOMATYCZNIE: wyłącza wbudowany głos w aplikacji i — jeśli masz
    // inny zapisany głos — od razu go aktywuje. 60 MB na dysku zwolnisz
    // kasując wskazany plik ręcznie (ścieżka pokazuje się pod spodem).
    const builtinDelBtn = $('builtinVoiceDeleteBtn');
    const builtinRestoreBtn = $('builtinVoiceRestoreBtn');
    const builtinPathBtn = $('builtinVoicePathBtn');

    // Czy plik modelu leży jeszcze w paczce? (po ręcznym skasowaniu → nie)
    // HEAD, żeby nie ciągnąć 60 MB; fallback na GET z natychmiastowym cancel.
    function builtinFileExists() {
        const url = chrome.runtime.getURL(BUILTIN_MODEL_REL);
        return fetch(url, { method: 'HEAD' })
            .then((r) => !!r.ok)
            .catch(() => fetch(url)
                .then((r) => {
                    try { if (r.body && r.body.cancel) r.body.cancel(); } catch (e) {}
                    return !!r.ok;
                })
                .catch(() => false));
    }

    function setBuiltinStatus(text) {
        const st = $('builtinVoiceStatus');
        if (st) { st.style.display = ''; st.textContent = text; }
    }

    if (builtinDelBtn) {
        builtinDelBtn.addEventListener('click', async () => {
            const { active, list } = await loadVoiceState();
            const others = list.filter((v) => v.id !== SHERPA_VOICE);
            const nextV = others[0];
            const hasActiveCustom = !!(active && active.enabled && (active.sizeOnnx || 0) > 0);
            // Gdy to JEDYNY głos, lektor zostałby niemy → wymagamy drugiego
            // kliknięcia (10 s). Gdy jest inny głos, działamy od razu.
            if (!nextV && !hasActiveCustom) {
                const now = Date.now();
                if (now - builtinConfirmTs > BUILTIN_CONFIRM_MS) {
                    builtinConfirmTs = now;
                    setBuiltinStatus('⚠ To jedyny głos, jaki masz. Kliknij 🗑 ponownie w ciągu 10 s, żeby go wyłączyć — lektor będzie milczał, dopóki nie dodasz innego głosu. „Przywróć” zawsze wróci jednym kliknięciem.');
                    return;
                }
            }
            builtinConfirmTs = 0;
            chrome.storage.local.set({ builtinVoiceRemoved: true }, async () => {
                try { chrome.runtime.sendMessage({ action: 'TTS_RESTART_OFFSCREEN' }); } catch (e) {}
                if (nextV) {
                    activateVoice(nextV); // automatyczne przełączenie na inny głos
                } else {
                    refreshCustomVoiceUi();
                }
                const st = $('customVoiceStatus');
                if (st) st.textContent = nextV
                    ? ('🗑 Wbudowany głos męski wyłączony. Aktywuję „' + (nextV.name || nextV.id) + '” — silnik przeładowuje się (kilka–kilkanaście s).')
                    : '🗑 Wbudowany głos męski wyłączony. Aby zwolnić 60 MB na dysku, skasuj plik podany niżej.';
            });
        });
    }

    if (builtinRestoreBtn) {
        builtinRestoreBtn.addEventListener('click', async () => {
            setBuiltinStatus('⏳ Sprawdzam, czy plik modelu jest w paczce…');
            const ok = await builtinFileExists();
            if (!ok) {
                setBuiltinStatus('⛔ Pliku modelu nie ma już w folderze rozszerzenia — nie ma czego przywracać. Wgraj go z powrotem (ten sam plik .onnx) albo dodaj inny głos własny.');
                return;
            }
            chrome.storage.local.set({ builtinVoiceRemoved: false }, () => {
                try { chrome.runtime.sendMessage({ action: 'TTS_RESTART_OFFSCREEN' }); } catch (e) {}
                refreshCustomVoiceUi();
                const st = $('customVoiceStatus');
                if (st) st.textContent = '↺ Wbudowany głos męski przywrócony — silnik przeładowuje się (kilka–kilkanaście s).';
            });
        });
    }

    if (builtinPathBtn) {
        builtinPathBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(BUILTIN_MODEL_PATH);
                builtinPathBtn.textContent = '✓ Skopiowano ścieżkę';
            } catch (e) {
                builtinPathBtn.textContent = '⛔ Skopiuj ścieżkę ręcznie (Ctrl+C)';
            }
            setTimeout(() => { builtinPathBtn.textContent = '📋 Kopiuj ścieżkę'; }, 2000);
        });
    }

    // ⤵ Przeniesienie wbudowanego głosu męskiego NA LISTĘ własnych głosów.
    // Kopiuje pliki LOKALNIE z paczki rozszerzenia (bez internetu) do pamięci
    // głosów — głos staje się zwykłym wpisem z ▶ (aktywuj) i 🗑 (skasuj),
    // dokładnie tam, gdzie trafiają głosy pobrane z „Języków świata”.
    const builtinMigrateBtn = $('builtinVoiceMigrateBtn');
    if (builtinMigrateBtn) {
        builtinMigrateBtn.addEventListener('click', async () => {
            builtinMigrateBtn.disabled = true;
            const oldLabel = builtinMigrateBtn.textContent;
            builtinMigrateBtn.textContent = '⏳ Kopiuję model (60 MB) do pamięci głosów…';
            try { await migrateBuiltinVoice(false); }
            finally {
                builtinMigrateBtn.disabled = false;
                // syncBuiltinVoiceUi ustawia właściwy tekst; gdyby coś poszło nie
                // tak, wracamy do poprzedniej etykiety, żeby przycisk nie zniknął.
                if (!builtinMigrateBtn.textContent || builtinMigrateBtn.textContent === oldLabel) {
                    builtinMigrateBtn.textContent = oldLabel;
                }
                refreshCustomVoiceUi();
            }
        });
    }

    // Kontrola spójności przy otwarciu popupu: jeśli plik modelu zniknął
    // z paczki (skasowany ręcznie na dysku), a flaga mówi „aktywny” — włączamy
    // ją automatycznie i mówimy wprost, co się stało (zamiast cichego HTTP 404).
    (async () => {
        try {
            const items = await new Promise((res) => chrome.storage.local.get(['builtinVoiceRemoved'], res));
            if (items.builtinVoiceRemoved) return;
            if (await builtinFileExists()) return;
            chrome.storage.local.set({ builtinVoiceRemoved: true }, () => {
                refreshCustomVoiceUi();
                setBuiltinStatus('⚠ Pliku wbudowanego modelu męskiego nie ma w folderze rozszerzenia, więc wbudowany głos został wyłączony automatycznie. Dodaj głos własny albo wgraj plik .onnx z powrotem i kliknij „Przywróć wbudowany głos męski”.');
            });
        } catch (e) { /* brak API — nic nie rób */ }
    })();
    // [DIAG 2026-11-26] dziennik wyciszeń cenzora (zapisuje cenzor_bridge.js) — najnowsze na górze
    (() => {
        const box = $('cenzorDiagLog'), clr = $('cenzorDiagClear');
        if (!box) return;
        const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
        const render = (log) => {
            if (!Array.isArray(log) || !log.length) { box.textContent = 'Brak wyciszeń.'; return; }
            box.textContent = log.slice().reverse().map((e) => {
                const why = (e.why || []).map((x) => '„' + x.w + '” [' + x.src + ']  ←  ' + x.t).join('\n   ');
                return fmt(e.at) + (e.len ? '  (cisza ' + String(e.len).replace('.', ',') + ' s)' : '') + '  ' + (why || '(brak danych o słowie)');
            }).join('\n');
        };
        chrome.storage.local.get('cenzorDiagLog', (r) => render(r && r.cenzorDiagLog));
        chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.cenzorDiagLog) render(ch.cenzorDiagLog.newValue); });
        if (clr) clr.addEventListener('click', () => chrome.storage.local.set({ cenzorDiagLog: [] }));
    })();
    // ===== Cenzura przekleństw — wszystkie języki naraz =====
    const censorSpeech = $('censorSpeechCheck');
    const censorModeSel = $('censorModeSelect');
    const censorWords = $('censorCustomWords');
censorWords.addEventListener('input', () => {
    saveSettings({ censorCustomWords: censorWords.value });
});
censorWords.addEventListener('change', () => {
    saveSettings({ censorCustomWords: censorWords.value });
});
    if (censorSpeech && censorModeSel && censorWords) {
        const censorStatus = $('censorStatus');
        const CENSOR_STATUS_FALLBACK = '✓ Aktywna: przekleństwa usuwane we wszystkich obsługiwanych językach + Twoje własne słowa.';
        let censorInfo = null; // { languages, words } — dociągane z censor.js (silnik)
        const censorActiveText = () => (censorInfo && censorInfo.languages)
            ? ('✓ Aktywna: ' + censorInfo.languages + ' języków, ' + censorInfo.words + ' słów + Twoje własne.')
            : CENSOR_STATUS_FALLBACK;
        const syncCensorUi = (on) => {
            censorSpeech.checked = !!on;
            censorModeSel.disabled = !on;   // tryb (usuń / beep / gwiazdki / kreski ----------) ma sens tylko przy włączonej cenzurze mowy
            if (censorStatus) {
                censorStatus.textContent = on
                    ? censorActiveText()
                    : 'W mowie lektora wyłączony — lektor czyta wszystko (wyciszanie dźwięku filmu działa osobno).';
            }
        };
        syncCensorUi(!!s.censorEnabled);
        censorModeSel.value = ['remove', 'beep', 'replace', 'dashes'].indexOf(s.censorMode) >= 0 ? s.censorMode : 'remove';   // [AGENT-EXP] 2026-11-17: + 'dashes'
        censorWords.value = s.censorCustomWords || '';
        // Faktyczny zasięg cenzury liczy silnik (censor.js) — popup tylko pyta.
        try {
            chrome.runtime.sendMessage({ action: 'CENSOR_STATS' }, (resp) => {
                if (chrome.runtime.lastError) return;
                if (!resp || !resp.languages) return;
                censorInfo = { languages: resp.languages, words: resp.words || 0 };
                const scopeNote = $('censorScopeNote');
                if (scopeNote) {
                    scopeNote.textContent = 'Jeden cenzor i jedna lista słów: '
                        + resp.languages + ' języków, ' + (resp.words || 0) + ' słów + Twoje własne'
                        + ' — w mowie lektora i/lub w dźwięku filmu. Czasy ciszy: Ustawienia → 🤬 Cenzor.';
                }
                if (censorSpeech.checked
                    && (!censorStatus || censorStatus.textContent === CENSOR_STATUS_FALLBACK
                        || (self.MLi18n && censorStatus.textContent === self.MLi18n.t(CENSOR_STATUS_FALLBACK)))) {   // [AGENT-EXP] 2026-10-21: tekst bywa już po angielsku
                    syncCensorUi(true);
                }
            });
        } catch (e) { /* brak silnika — zostaje tekst ogólny */ }
        censorSpeech.addEventListener('change', () => {
            const next = censorSpeech.checked;
            saveSettings({ censorEnabled: next });
            syncCensorUi(next);
        });
        censorModeSel.addEventListener('change', () => {
            saveSettings({ censorMode: censorModeSel.value });
            if (censorStatus) censorStatus.textContent = '✓ Tryb cenzury zapisany: ' + censorModeSel.options[censorModeSel.selectedIndex].text;
        });
        censorWords.addEventListener('input', debounce(() => {
            saveSettings({ censorCustomWords: censorWords.value });
            if (censorStatus) censorStatus.textContent = '✓ Własne słowa zapisane (lektor: od następnej kwestii, dźwięk filmu: od razu).';
        }, 500));
        // [FIX 2026-11-02] JEDEN cenzor: wyciszanie oryginalnego dźwięku filmu (dawniej osobny cenzor w Ustawieniach)
        [['cenzorOnCheck', 'cenzorOn'], ['cenzorLiveCheck', 'cenzorLive']].forEach(([id, key]) => {
            const box = $(id);
            if (!box) return;
            // [AGENT-EXP] 2026-11-16: brak wpisu = domyślnie WŁ. (tak jak silnik); wcześniej pusty storage = odhaczone.
            chrome.storage.local.get(key, (r) => { box.checked = !(r && r[key] === false); });
            box.addEventListener('change', () => {
                saveSettings({ [key]: box.checked });
                if (censorStatus) censorStatus.textContent = box.checked
                    ? '✓ Wyciszanie dźwięku filmu włączone (ta sama lista słów co lektor).'
                    : 'Wyciszanie dźwięku filmu wyłączone.';
            });
            chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch[key]) box.checked = !!ch[key].newValue; });
        });

        // [FIX 2026-11-16] priorytet źródeł cenzora: pobrane napisy / plik+live / live (ekran)
        (function () {
            const prio = $('cenzorPriority');
            if (!prio) return;
            const norm = (v) => (v === 'live' || v === 'hybrid') ? v : 'file';
            chrome.storage.local.get('cenzorPriority', (r) => { prio.value = norm(r && r.cenzorPriority); });
            prio.addEventListener('change', () => saveSettings({ cenzorPriority: norm(prio.value) }));
            chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.cenzorPriority) prio.value = norm(ch.cenzorPriority.newValue); });
        })();
    }

    // ===== [AGENT-EXP] 2026-11-28: cisza na całe zdanie (Wstecz/Przód = dodatkowo przed/po zdaniu) =====
    (function () {
        const box = $('czSentence');
        if (!box) return;
        try {
            chrome.storage.local.get('cenzorSentence', (r) => { box.checked = !!(r && r.cenzorSentence); });
            chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.cenzorSentence) box.checked = !!ch.cenzorSentence.newValue; });
        } catch (e) {}
        box.addEventListener('change', () => saveSettings({ cenzorSentence: box.checked }));
    })();

    // ===== [AGENT-EXP] 2026-11-14: czasy ciszy cenzora (same suwaki) =====
    (function () {
        const pairs = [
            { id: 'czBuffer', out: 'czBufferVal', key: 'cenzorBufferMs', def: 400, fmt: (v) => Math.round(v) + ' ms' },
            { id: 'czHold', out: 'czHoldVal', key: 'cenzorHoldMs', def: 200, fmt: (v) => Math.round(v) + ' ms' },
            { id: 'czRate', out: 'czRateVal', key: 'cenzorTextRate', def: 0.6, fmt: (v) => Number(v).toFixed(2).replace('.', ',') + '×' }
        ];
        pairs.forEach((p) => {
            const sl = $(p.id), out = $(p.out);
            if (!sl) return;
            const show = (v) => { if (out) out.textContent = p.fmt(Number(v)); };
            try {
                chrome.storage.local.get(p.key, (r) => {
                    const v = r && r[p.key] != null ? Number(r[p.key]) : p.def;
                    sl.value = v; show(v);
                });
                chrome.storage.onChanged.addListener((ch, area) => {
                    if (area !== 'local' || !ch[p.key]) return;
                    const v = Number(ch[p.key].newValue);
                    if (!isNaN(v)) { sl.value = v; show(v); }
                });
            } catch (e) {}
            const save = debounce(() => {
                const v = Number(sl.value);
                const patch = { [p.key]: v };
                if (p.key === 'cenzorBufferMs') patch.cenzorPrerollMs = v;
                if (p.key === 'cenzorHoldMs') patch.cenzorPostrollMs = v;
                if (p.key === 'cenzorTextRate') patch.cenzorTextAuto = false;   // suwak ma działać od razu
                saveSettings(patch);
            }, 120);
            sl.addEventListener('input', () => { show(sl.value); save(); });
        });
    })();


    // ===== [AGENT-EXP] 2026-11-14: pasek postępu — widoczny albo schowany (czytanie i pobieranie działa dalej) =====
    (function () {
        const box = $('lektorBarCheck');
        if (!box) return;
        try {
            chrome.storage.local.get('lektorBar', (r) => { box.checked = !r || r.lektorBar !== false; });
            chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.lektorBar) box.checked = ch.lektorBar.newValue !== false; });
        } catch (e) {}
        box.addEventListener('change', () => saveSettings({ lektorBar: box.checked }));
    })();
    // [AGENT-EXP] 2026-11-26: panel „🎤 Lektor — co mówię” widoczny albo niewidoczny (lektor czyta dalej) — ta sama opcja co w Ustawieniach
    (function () {
        const box = $('lektorPanelCheck');
        if (!box) return;
        try {
            chrome.storage.local.get('lektorPanelOn', (r) => { box.checked = !r || r.lektorPanelOn !== false; });
            chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.lektorPanelOn) box.checked = ch.lektorPanelOn.newValue !== false; });
        } catch (e) {}
        box.addEventListener('change', () => saveSettings({ lektorPanelOn: box.checked }));
    })();

    // Sklep głosów: katalog 1100+ języków (MMS + Piper) z pobieraniem w aplikacji.
    initLangStore();

    // [AGENT-EXP] 2026-11-21: karta „Napisy z ekranu” usunięta — źródło napisów lektora wynika z listy „Priorytet” w karcie cenzora
    // (cenzorPriority 'live' → primeSubtitleSource 'immersive', inaczej 'both'; synchronizuje background.js).

    // [AGENT-EXP] 2026-11-21: usunięto „Czytaj napisy na żywo z Immersive Translate” (imtrans_texttrack_reader.js) — tor martwy (MAIN world bez chrome.*), dublował dom_content/content/cenzor_main.

    // NA ŻĄDANIE: pobierz całe napisy filmu w BIEŻĄCEJ karcie — dowolna strona z filmem.
    // 1) strona ze wsparciem (YouTube, iQIYI, WeTV, Viki, Bilibili) odpowiada na LOAD_FULL_SUBS;
    // 2) inaczej wstrzykujemy uniwersalny pobieracz (ścieżki napisów odtwarzacza HTML5) — tylko po kliknięciu.
    // [FIX 2026-11-02] 💾 napisy PL → .srt (lektor_bar.js w ramce z filmem składa plik i go pobiera)
    const srtBtn = $('exportSrtBtn');
    // [FIX 2026-11-22] karta bez strony www: przyciski tej karty i tak nic nie zrobią — wyłączamy je z wyjaśnieniem
    function tabCanSubs(t) { return !!(t && t.id != null && /^https?:/.test(t.url || '')); }
    if (srtBtn) chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabCanSubs(tabs && tabs[0])) { srtBtn.disabled = true; const st = $('exportSrtStatus'); if (st) st.textContent = 'Otwórz stronę z filmem.'; }
    });
    if (srtBtn) srtBtn.addEventListener('click', () => {
        const st = $('exportSrtStatus');
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tab = tabs && tabs[0];
            if (!tab || tab.id == null) return;
            // [FIX 2026-11-22] ramki najpierw tylko liczą kwestie, plik pobiera JEDNA (najwięcej gotowych, remis → główna).
            // Nazwa pliku = tytuł karty (ramka z filmem ma zwykle tytuł „YouTube” itp.).
            const done = (r) => {
                if (!st) return;
                if (!(r && r.ok)) { st.textContent = '⛔ Brak całych napisów na tej karcie — najpierw „⬇ Pobierz całe napisy”, plik albo bazy napisów.'; return; }
                // [FIX 2026-11-22] tłumaczenie w toku: plik ma tylko gotowe kwestie — mówimy to wprost
                st.textContent = (r.total && r.total > r.count)
                    ? '⚠ Zapisano ' + r.count + ' z ' + r.total + ' kwestii — reszta jeszcze się tłumaczy. Kliknij ponownie, gdy tłumaczenie się skończy.'
                    : '✓ Zapisano ' + r.count + ' kwestii do pliku .srt (Pobrane).';
            };
            const viaMessage = () => chrome.tabs.sendMessage(tab.id, { action: 'LEKTOR_EXPORT_SRT', title: tab.title || '' }, { frameId: 0 }, (r) => {
                void chrome.runtime.lastError;
                done(r);
            });
            chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: true },
                func: () => (window.__lektorBarSrtInfo ? window.__lektorBarSrtInfo() : null)
            }).then((res) => {
                let best = null;
                (res || []).forEach((x) => {
                    const r = x && x.result;
                    if (!r || !r.count) return;
                    if (!best || r.count > best.r.count || (r.count === best.r.count && r.top)) best = { r, frameId: x.frameId };
                });
                if (!best) { done(null); return; }
                return chrome.scripting.executeScript({
                    target: { tabId: tab.id, frameIds: [best.frameId] },
                    func: (title) => (window.__lektorBarSrtExport ? window.__lektorBarSrtExport(title) : null),
                    args: [tab.title || '']
                }).then((res2) => done(res2 && res2[0] && res2[0].result));
            }).catch(() => viaMessage());   // brak dostępu do ramek → stara droga (tylko główna ramka)
        });
    });
    const fullBtn = $('fullSubsBtn');
    const fullStatus = $('fullSubsStatus');
    function fullSet(t) { if (fullStatus) fullStatus.textContent = t; }
    function fullPollMsg(tabId, left) {
        chrome.tabs.sendMessage(tabId, { action: 'FULL_SUBS_STATUS' }, { frameId: 0 }, (r) => {
            if (chrome.runtime.lastError || !r) return;
            if (r.onDemand || r.cues) fullSet(r.status || ('Napisy: ' + r.cues + ' kwestii'));
            if (left > 0 && (r.busy || (r.onDemand && !r.cues))) setTimeout(() => fullPollMsg(tabId, left - 1), 1000);
        });
    }
    function fullPollGeneric(tabId, left) {
        chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: () => (window.__lektorFullSubs ? window.__lektorFullSubs.status() : null)
        }).then((res) => {
            const r = (res || []).map((x) => x && x.result).find((x) => x && x.found);
            if (!r) return;
            fullSet(r.status);
            if (left > 0 && r.busy) setTimeout(() => fullPollGeneric(tabId, left - 1), 1000);
        }).catch(() => {});
    }
    // [AGENT-EXP] 2026-11-06: 🤐 cenzor na dowolnej stronie z filmem — „całe napisy na żądanie” ma od razu
    // wyciszać przekleństwa w dźwięku filmu (wcześniej cenzora na takiej stronie w ogóle nie było).
    // Dokładamy go tylko do ramek, w których jeszcze go nie ma (bez drugiego wczytywania list słów).
    async function ensureCenzor(tabId) {
        const res = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true }, world: 'MAIN', func: () => !!window.__lektorCenzor
        }).catch(() => []);
        const need = (res || []).filter((r) => r && r.result === false).map((r) => r.frameId);
        if (!need.length) return;
        await chrome.scripting.executeScript({ target: { tabId, frameIds: need }, world: 'MAIN', files: ['assets/censor.js', 'assets/pmt_mute_timer.js', 'assets/cenzor_main.js'] }).catch(() => {});   // [FIX 2026-11-21] + model PMT (kolejność jak w manifeście)
        await chrome.scripting.executeScript({ target: { tabId, frameIds: need }, files: ['assets/cenzor_bridge.js'] }).catch(() => {});
    }
    // [FIX 2026-11-22] gotowe pełne napisy z Łowcy (dawniej pytał o nie tylko przycisk 🔍, a „⬇ Pobierz” wcale).
    // Łowca odpowiada, gdy jest na karcie (do 3 s); brak Łowcy → od razu dalej.
    function fullFromLowca(tab) {
        return new Promise((res) => {
            chrome.tabs.sendMessage(tab.id, { action: 'LOWCA_TAKE_BEST' }, (r) => { void chrome.runtime.lastError; res(r && r.found ? r : null); });
        });
    }
    async function fullGeneric(tab) {
        fullSet('Szukam napisów w odtwarzaczu…');
        try {
            await ensureCenzor(tab.id);   // [AGENT-EXP] 2026-11-06
            await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['assets/lektor_bar.js', 'assets/lektor_scheduler.js', 'assets/full_subs_ondemand.js'] });   // [FIX 2026-11-02] + wspólny harmonogram   // [AGENT-EXP] lektor_bar: 📊 pasek
            const res = await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: true },
                func: () => (window.__lektorFullSubs ? window.__lektorFullSubs.start() : { found: false, reason: 'noscript' })
            });
            const results = (res || []).map((x) => x && x.result).filter(Boolean);
            const ok = results.find((x) => x.found);
            if (ok) {
                fullSet(ok.fromMemory
                    ? ('Z pamięci: ' + ok.cues + ' kwestii' + (ok.translating ? ' — tłumaczę na polski…' : ', lektor czyta, 🤐 cenzor wycisza przekleństwa.'))
                    : (ok.translating ? ('Pobrano ' + ok.cues + ' kwestii (' + ok.lang + ') — tłumaczę na polski…') : ('Gotowe — ' + ok.cues + ' kwestii: lektor czyta, 🤐 cenzor wycisza przekleństwa w filmie.')));   // [AGENT-EXP] 2026-11-06: fromMemory — wczytane z pamięci, bez pobierania
                if (ok.translating) fullPollGeneric(tab.id, 600);
                return;
            }
            const anyVideo = results.some((x) => x.reason === 'notracks');
            fullSet(anyVideo
                ? 'Ten odtwarzacz nie udostępnia pliku napisów — lektor czyta w locie (Immersive Translate).'
                : 'Nie widzę filmu na tej stronie. Włącz odtwarzanie i kliknij jeszcze raz.');
        } catch (e) {
            fullSet('Na tej stronie nie da się pobrać napisów (' + ((e && e.message) || e) + ').');
        }
    }
    if (fullBtn) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const t = tabs && tabs[0];
            if (!t || !/^https?:/.test(t.url || '')) { fullBtn.disabled = true; fullSet('Otwórz stronę z filmem.'); return; }
            if (/^https?:\/\/([^/]*\.)?netflix\.com\//.test(t.url)) { fullBtn.disabled = true; fullSet('Netflix: lektor bierze napisy z odtwarzacza Netflix — nic dodatkowo nie pobiera.'); return; }
            fullPollMsg(t.id, 0);
        });
        fullBtn.addEventListener('click', () => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const t = tabs && tabs[0];
                if (!t) return;
                chrome.storage.local.get('enabled', (st) => {
                    // lektor wyłączony = nic nie pobieramy (jakby rozszerzenia nie było)
                    if (st && st.enabled === false) { fullSet('Lektor jest wyłączony — włącz go, żeby pobrać napisy.'); return; }
                    fullSet('Pobieram napisy…');
                    chrome.tabs.sendMessage(t.id, { action: 'LOAD_FULL_SUBS' }, { frameId: 0 }, (r) => {
                        if (chrome.runtime.lastError || !r) {   // brak obsługi na tej stronie → Łowca, potem uniwersalnie
                            fullSet('Sprawdzam napisy złapane przez Łowcę…');
                            fullFromLowca(t).then((b) => {
                                if (b) { fullSet('✓ Z Łowcy: ' + b.cues + ' kwestii' + (b.lang ? ' [' + b.lang + ']' : '') + ' — lektor czyta, 🤐 cenzor wycisza przekleństwa.'); return; }
                                fullGeneric(t);
                            });
                            return;
                        }
                        if (!r.ok) { fullSet(r.error || 'Nie udało się.'); return; }
                        fullPollMsg(t.id, 600);
                    });
                });
            });
        });
    }

    // [FIX 2026-11-22] ↺ Szukaj miejsca napisów od nowa. Lektor (dom_content.js) szuka miejsca napisów SAM przy grającym
    // filmie — Immersive Translate / Kreator, potem wbudowane napisy serwisu. Przycisk zapomina zapamiętane miejsce
    // (mogło być złe albo nieaktualne po zmianie strony) i szuka od razu. Pytanie o Łowcę przeniesione do „⬇ Pobierz”.
    // YouTube i Netflix mają własne skrypty lektora (bez szukania na ekranie) — tam przycisk jest wyłączony.
    const findBtn = $('findSubsBtn');
    const findStatus = $('findSubsStatus');
    const NO_SCREEN_SEARCH = /^https?:\/\/([^/]*\.)?(youtube\.com|netflix\.com)\//;
    if (findBtn) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const t = tabs && tabs[0];
            if (!tabCanSubs(t)) { findBtn.disabled = true; if (findStatus) findStatus.textContent = 'Otwórz stronę z filmem.'; return; }
            if (NO_SCREEN_SEARCH.test(t.url)) { findBtn.disabled = true; if (findStatus) findStatus.textContent = 'Ten serwis ma własne źródło napisów lektora — szukanie na ekranie nie jest potrzebne.'; return; }
            if (findStatus) findStatus.textContent = 'Lektor sam szuka napisów na ekranie, gdy film gra. Kliknij, jeśli czyta nie to, co trzeba, albo milczy.';
        });
        findBtn.addEventListener('click', () => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const t = tabs && tabs[0];
                if (!tabCanSubs(t)) return;
                if (findStatus) findStatus.textContent = '↺ Zapominam stare miejsce i szukam napisów…';
                chrome.tabs.sendMessage(t.id, { action: 'FIND_SUB_CONTAINER', reset: true }, (r) => {
                    const err = chrome.runtime.lastError;
                    if (!findStatus) return;
                    if (r && r.found) { findStatus.textContent = '✓ Znaleziono (' + (r.where || '') + '). Lektor czyta z tego miejsca.'; return; }
                    if (err && /Receiving end/i.test(err.message || '')) {
                        findStatus.textContent = 'Na tej stronie lektor nie czyta napisów z ekranu — użyj „⬇ Pobierz całe napisy” albo 🎯 w Kreatorze napisów.';
                        return;
                    }
                    findStatus.textContent = 'Stare miejsce zapomniane, napisów teraz nie widać. Włącz film z widocznymi napisami — lektor znajdzie je sam (albo wskaż je 🎯 w Kreatorze).';
                });
            });
        });
    }

    // === AI Subtitle Translator: otwiera sekcję na stronie ustawień ===
    const aitOpenBtn = $('aitOpenBtn');
    if (aitOpenBtn) {
        aitOpenBtn.addEventListener('click', () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#ait') });
        });
    }

    // === Test lektora: INIT_TTS → TTS_PLAY i pokaż odpowiedź serwera ===
    const testBtn = $('testBtn');
    const testStatus = $('testStatus');
    const testDetail = $('testDetail');
    if (testBtn) {
        testBtn.addEventListener('click', () => {
            testStatus.textContent = '…uruchamiam silnik…';
            testDetail.style.display = 'none';
            testBtn.disabled = true;
            const showErr = (label, resp) => {
                testStatus.textContent = resp && resp.status ? resp.status : 'błąd';
                if (resp && resp.error) {
                    testDetail.className = 'footnote err pre';
                    testDetail.textContent = label + '\n' + resp.error;
                    testDetail.style.display = 'block';
                } else {
                    testDetail.style.display = 'none';
                }
            };
            // 1) INIT_TTS — buduje sesję Piper (może potrwać ~1-3 s)
            chrome.runtime.sendMessage({ action: 'INIT_TTS' }, (resp1) => {
                console.log('[Test] INIT_TTS ->', resp1);
                if (resp1 && (resp1.status === 'error' || resp1.error)) {
                    showErr('[INIT_TTS — błąd uruchamiania silnika]', resp1);
                    testBtn.disabled = false;
                    return;
                }
                if (!resp1) {
                    testStatus.textContent = 'brak odpowiedzi INIT_TTS';
                    testBtn.disabled = false;
                    return;
                }
                // 2) TTS_PLAY z tekstem testowym
                chrome.runtime.sendMessage({
                    action: 'TTS_PLAY',
                    id: 'test_' + Date.now(),
                    text: 'To jest test lektora.',
                    durationMs: 0
                }, (resp2) => {
                    console.log('[Test] TTS_PLAY ->', resp2);
                    if (!resp2) {
                        testStatus.textContent = 'brak odpowiedzi (SW uspiony?)';
                        return;
                    }
                    if (resp2.status === 'error' || resp2.error) {
                        showErr('[TTS_PLAY]', resp2);
                    } else {
                        testStatus.textContent = resp2.status || 'ok';
                        testDetail.className = 'footnote ok pre';
                        testDetail.textContent = 'Jeśli słyszysz głos — działa. Jeśli nie — sprawdź głośność / ustaw głos w popupie.';
                        testDetail.style.display = 'block';
                    }
                    testBtn.disabled = false;
                });
            });
        });
    }

    // Stop lektora — przycisk usunięty z popupu (zbitka: suwak + włącz/wyłącz na ekranie)

    // Przełącznik główny
    const toggle = $('enableToggle');
    toggle.checked = !!s.enabled;
    toggle.addEventListener('change', (e) => {
        saveSettings({ enabled: e.target.checked });
        if (!e.target.checked) {
            try { chrome.runtime.sendMessage({ action: 'TTS_CLEAR_BUFFER' }); } catch (err) {}
        }
    });

    // Prędkość (Piper)
    const speedRange = $('speedRange');
    const speedVal = $('speedVal');
    speedRange.value = s.piperSpeed;
    speedVal.textContent = s.piperSpeed.toFixed(1) + 'x';
    speedRange.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        speedVal.textContent = v.toFixed(1) + 'x';
        debouncedSaveSpeed(v);
    });
    const debouncedSaveSpeed = debounce((v) => {
        saveSettings({ piperSpeed: v });
    }, 150);

    // Ducking
    const duckRange = $('duckRange');
    const duckVal = $('duckVal');
    duckRange.value = s.duckLevel;
    duckVal.textContent = s.duckLevel + '%';
    duckRange.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        duckVal.textContent = v + '%';
        debouncedSaveDuck(v);
    });
    const debouncedSaveDuck = debounce((v) => {
        saveSettings({ duckLevel: v });
    }, 150);

    // Głośność lektora (natywna — player.volume w offscreen)
    const volumeRange = $('volumeRange');
    const volumeVal = $('volumeVal');
    if (volumeRange && volumeVal) {
        volumeRange.value = s.ttsVolume;
        volumeVal.textContent = s.ttsVolume + '%';
        volumeRange.addEventListener('input', (e) => {
            const v = parseInt(e.target.value, 10);
            volumeVal.textContent = v + '%';
            debouncedSaveVolume(v);
        });
    }
    const debouncedSaveVolume = debounce((v) => {
        saveSettings({ ttsVolume: v });
    }, 150);

    // Przesunięcie lektora względem wideo (subtitleOffsetMs — wspólny klucz z panelem ⚙ na stronie)
    const offsetRange = $('offsetRange');
    const offsetVal = $('offsetVal');
    const showOffset = (v) => {
        offsetVal.textContent = v === 0 ? '0 s' : (v < 0 ? '−' : '+') + (Math.abs(v) / 1000).toFixed(1) + ' s';
    };
    if (offsetRange && offsetVal) {
        offsetRange.value = typeof s.subtitleOffsetMs === 'number' ? s.subtitleOffsetMs : 0;
        showOffset(offsetRange.value);
        offsetRange.addEventListener('input', (e) => {
            const v = parseInt(e.target.value, 10);
            showOffset(v);
            debouncedSaveOffset(v);
        });
    }
    const debouncedSaveOffset = debounce((v) => {
        saveSettings({ subtitleOffsetMs: v });
    }, 150);
    // [FIX 2026-11-21] podgląd napisów cenzora na filmie (cenzor_main.js → previewTick) — do ustawiania przesunięcia
    const offsetPreview = $('offsetPreviewCheck');
    if (offsetPreview) {
        chrome.storage.local.get('cenzorPreview', (r) => { offsetPreview.checked = !!(r && r.cenzorPreview); });
        offsetPreview.addEventListener('change', () => saveSettings({ cenzorPreview: offsetPreview.checked }));
    }

    // Suwak „Nagrywanie / zapas do przodu": 0 = na bieżąco (bez nagrywania),
    // >0 = nagrywanie czystego lektora włączone + zapas syntezy N minut do przodu.
    // Powrót suwaka na 0 kończy nagranie i AUTOMATYCZNIE zapisuje WAV.
    const lookaheadRange = $('lookaheadRange');
    const lookaheadVal = $('lookaheadVal');
    const recDetail = $('recDetail');
    const recLog = $('recLog');
    let recLastView = null;   // [AGENT-EXP] 2026-11-16: ostatni odczyt karty — przeliczamy po ruchu suwaka
    const debouncedSaveLookahead = debounce((v) => {
        saveSettings({ lookaheadMin: v });
    }, 150);
    const showLookahead = (m) => {
        lookaheadVal.textContent = m > 0
            ? (m >= 60 ? (m / 60).toFixed(m % 60 ? 1 : 0) + ' h' : m + ' min') + ' · REC'
            : 'na bieżąco';
    };
    function recControl(m) {
        if (m > 0) {
            chrome.runtime.sendMessage({ action: 'REC_STATUS' }, (st) => {
                // Wykrywanie starego silnika (offscreen z przed wersji z licznikiem wyrazów).
                if (st && st.recording && st.words === undefined) {
                    if (recDetail) recDetail.textContent = '⚠ Nieaktualna wersja silnika — kliknij ⟳ przy „Polski Lektor” w chrome://extensions, potem odśwież strony z filmami.';
                    return;
                }
                if (st && st.recording) {
                    if (recDetail) recDetail.textContent = '● Nagrywanie trwa (' + st.count + ' kwestii, ' + (st.words || 0) + ' wyrazów). Wróć suwakiem na 0, aby zatrzymać (nagranie zostanie zbuforowane).';
                    return;
                }
                chrome.runtime.sendMessage({
                    action: 'REC_START',
                    sessionId: 'rec_' + Date.now(),
                    title: document.title || '',
                    url: 'popup'
                }, (r) => {
                    if (recDetail) {
                        recDetail.textContent = (r && r.ok)
                            ? '● Nagrywam w locie (zapas ' + m + ' min). Wróć suwakiem na 0, aby zatrzymać nagrywanie.'
                            : '✕ Nie udało się rozpocząć nagrywania: ' + ((r && r.error) || 'brak odpowiedzi');
                    }
                });
            });
        } else {
            chrome.runtime.sendMessage({ action: 'REC_STOP' }, (r) => {
                const cnt = (r && r.count) || 0;
                if (!cnt) {
                    if (recDetail) recDetail.textContent = 'Na bieżąco (bez nagrywania).';
                    return;
                }
                // Zatrzymanie NIE eksportuje (koniec z okienkiem „Zapisz plik") — nagranie
                // zostaje zbuforowane w IndexedDB. Zapis: przycisk „⬇ Zapisz nagranie" na
                // stronie. Bufor czyści się sam: nowe nagrywanie go zastępuje, a nagrania
                // starsze niż 72 h są usuwane automatycznie.
                if (recDetail) recDetail.textContent = 'Nagranie (' + cnt + ' kwestii) zbuforowane — zapisz przyciskiem ⬇ na stronie.';
            });
        }
    }
    if (lookaheadRange && lookaheadVal) {
        lookaheadRange.value = s.lookaheadMin;
        showLookahead(s.lookaheadMin);
        lookaheadRange.addEventListener('input', (e) => {
            const m = parseInt(e.target.value, 10);
            showLookahead(m);
            debouncedSaveLookahead(m);
            recRender(recLastView);   // [AGENT-EXP] 2026-11-16: nowy limit od razu na pasku zapasu (bez czekania 2 s)
        });
        // Nagrywanie startuje/kończy się na „puścieniu" suwaka (change), nie na każdym pikselu.
        lookaheadRange.addEventListener('change', (e) => recControl(parseInt(e.target.value, 10)));
        // Auto-wznowienie: suwak stoi w prawo, a nagrywanie nie trwa (np. po restarcie przeglądarki).
        if (s.lookaheadMin > 0) recControl(s.lookaheadMin);
        else recControl(0);
    }

    // === Napisy z pliku (SRT / WebVTT / SBV / ASS / SSA) ===
    const fileSubsInput = $('fileSubsInput');
    const fileSubsBtn = $('fileSubsBtn');
    const fileSubsClear = $('fileSubsClear');
    const fileSubsStatus = $('fileSubsStatus');
    const fileSubsDetail = $('fileSubsDetail');
    const FILE_DETAIL_DEFAULT = 'Napisy z pliku należą do filmu w tej karcie (inne strony ich nie czytają; po powrocie do filmu wracają). Odtwórz film — lektor czyta wg czasu z pliku, suwak nagrywa jak zawsze.';
    const fileTs = (s) => {
        s = String(s || '').trim().replace(',', '.');
        const p = s.split(':').map(Number);
        if (p.some((n) => isNaN(n))) return -1;
        if (p.length === 3) return Math.round((p[0] * 3600 + p[1] * 60 + p[2]) * 1000);
        if (p.length === 2) return Math.round((p[0] * 60 + p[1]) * 1000);
        return -1;
    };
    const fileClean = (t) => String(t || '')
        .replace(/\{[^}]*\}/g, ' ')   // tagi ASS {\...}
        .replace(/<[^>]+>/g, ' ')     // tagi HTML
        .replace(/\\N|\\n/gi, ' ')    // łamania linii ASS
        .replace(/\s+/g, ' ').trim();
    // Filtr SRT (jak w skrypcie 2.9): naprawia czasy zepsute przez tłumacza, odkleja numery
    // napisów od tekstu („przyszłość. 104”) i składa czysty SRT — lektor nie czyta numerów.
    const SRT_TS = '(\\d{1,2})\\s*:\\s*(\\d{2})\\s*:\\s*(\\d{2})\\s*[,.]\\s*(\\d{1,3})';
    const SRT_ARROW_FIX = new RegExp(SRT_TS + '\\s*(?:-+\\s*>|[–—]+\\s*>?|→|>)\\s*' + SRT_TS, 'g');
    const SRT_TIME_LINE = /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/;
    function srtFilter(text) {
        const fmt = (h, m, s, f) => String(h).padStart(2, '0') + ':' + m + ':' + s + ',' + String(f).padEnd(3, '0');
        const t = String(text || '').replace(/\r/g, '')
            .replace(SRT_ARROW_FIX, (_, h1, m1, s1, f1, h2, m2, s2, f2) => '\n' + fmt(h1, m1, s1, f1) + ' --> ' + fmt(h2, m2, s2, f2) + '\n')
            .replace(/[ \t]+(\d+)[ \t]*\n(?=\d{2}:\d{2}:\d{2},\d{3} --> )/g, '\n$1\n');
        const cues = [];
        let cur = null, lastNum = null;
        for (const raw of t.split('\n')) {
            const l = raw.trim();
            if (SRT_TIME_LINE.test(l)) { if (cur) cues.push(cur); cur = { time: l, text: [], num: lastNum }; lastNum = null; continue; }
            if (!l) continue;
            if (/^\d+$/.test(l)) { lastNum = +l; continue; }
            if (cur) cur.text.push(l);
        }
        if (cur) cues.push(cur);
        const out = [];
        cues.forEach((c, k) => {
            // Usuwa tylko liczbę równą numerowi tej/następnej kwestii — „Mam 25 lat” zostaje
            const own = c.num != null ? c.num : (cues[k - 1] && cues[k - 1].num != null ? cues[k - 1].num + 1 : null);
            let txt = c.text.join('\n');
            if (own != null) {
                txt = txt.replace(/[ \t]+(\d{1,5})$/, (m, n) => (+n === own + 1 ? '' : m))
                    .replace(/^(\d{1,5})[ \t]+/, (m, n) => (+n === own ? '' : m));
            }
            txt = txt.trim();
            if (txt) out.push((out.length + 1) + '\n' + c.time + '\n' + txt + '\n');
        });
        return out.join('\n');
    }
    function parseSubsFile(raw) {
        // SRT (z godzinami w czasie, bez nagłówka WEBVTT) najpierw przez filtr; gdy nic nie zostanie — oryginał.
        if (/\d{1,2}\s*:\s*\d{2}\s*:\s*\d{2}\s*[,.]\s*\d{1,3}/.test(raw) && !/^﻿?\s*WEBVTT/.test(raw)) {
            const f = srtFilter(raw);
            if (f.trim()) raw = f;
        }
        const lines = String(raw || '').replace(/\r/g, '').split('\n');
        const cues = [];
        // 1) SRT / WebVTT / SBV / SUB (MicroDVD) / SMI / LRC / DFXP-TTML — linia „start --> end”
        const arrow = /(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})/;
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(arrow);
            if (!m) continue;
            const startMs = fileTs(m[1]), endMs = fileTs(m[2]);
            if (startMs < 0 || endMs <= startMs) continue;
            // Kwestia kończy się na pustej linii ALBO na czasie następnej kwestii (pliki bez pustych
            // linii, np. po tłumaczeniu) — wtedy numer tuż przed czasem też nie należy do tekstu.
            const buf = [];
            for (let j = i + 1; j < lines.length && lines[j].trim() && !arrow.test(lines[j]); j++) buf.push(lines[j].trim());
            if (buf.length && /^\d+$/.test(buf[buf.length - 1]) && i + buf.length + 1 < lines.length && arrow.test(lines[i + buf.length + 1])) buf.pop();
            const t = fileClean(buf.join(' '));
            if (t) cues.push({ startMs, endMs, text: t });
        }
        // 2) ASS / SSA — linie „Dialogue:”
        if (!cues.length) {
            for (const line of lines) {
                if (!/^Dialogue:/i.test(line)) continue;
                const f = line.split(',');
                if (f.length < 10) continue;
                const startMs = fileTs(f[1]), endMs = fileTs(f[2]);
                if (startMs < 0 || endMs <= startMs) continue;
                const t = fileClean(f.slice(9).join(','));
                if (t) cues.push({ startMs, endMs, text: t });
            }
        }
        // 3) SUB MicroDVD „{start}{end}tekst” (klatki → ms przy 23.976 fps)
        if (!cues.length) {
            const fps = 23.976;
            for (const line of lines) {
                const m = line.match(/^\{(\d+)\}\{(\d+)\}(.*)$/);
                if (!m) continue;
                const startMs = Math.round((+m[1] / fps) * 1000), endMs = Math.round((+m[2] / fps) * 1000);
                if (!(endMs > startMs)) continue;
                const t = fileClean(m[3].replace(/\|/g, ' '));
                if (t) cues.push({ startMs, endMs, text: t });
            }
        }
        // 4) Zwykły TXT bez czasów — jedna kwestia na linię, 3 s każda po kolei
        if (!cues.length) {
            const txtLines = lines.map((l) => fileClean(l)).filter(Boolean);
            if (txtLines.length >= 2) {
                let t = 0;
                for (const l of txtLines) {
                    cues.push({ startMs: t, endMs: t + 3000, text: l });
                    t += 3000;
                }
            }
        }
        cues.sort((a, b) => a.startMs - b.startMs);
        return cues;
    }
    async function readSubsFile(file) {
        const buf = await file.arrayBuffer();
        let raw = new TextDecoder('utf-8').decode(buf);
        if (raw.includes('\uFFFD')) {
            // Polskie napisy bywają w CP1250 — gdy UTF-8 daje krzaki, próbujemy tej strony kodowej.
            try { raw = new TextDecoder('windows-1250').decode(buf); } catch (err) { /* ignore */ }
        }
        return parseSubsFile(raw);
    }
    // [AGENT-EXP] 2026-10-17: plik należy do filmu w aktywnej karcie (page) — na innej stronie lektor go nie czyta,
    // po powrocie do filmu wraca (pamięć fileSubsMem w background).
    function fileSubsSet(data, cb) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const t = tabs && tabs[0];
            chrome.storage.local.set({ fileSubs: Object.assign({}, data, { tabId: t ? t.id : null, page: t ? t.url || '' : '' }) }, cb);
        });
    }
    function refreshFileSubsStatus() {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => { const t = tabs && tabs[0];
          chrome.runtime.sendMessage({ action: 'LEKTOR_FILE_FOR_TAB', tabId: t ? t.id : -1 }, (r) => { void chrome.runtime.lastError;
            const f = r && r.file;
            if (fileSubsStatus && fileSubsDetail) {
                if (f && Array.isArray(f.cues) && f.cues.length) {
                    fileSubsStatus.textContent = f.cues.length + ' kwestii';
                    fileSubsDetail.textContent = '📂 ' + f.name + ' — wczytane dla tego filmu (wrócą, gdy tu wrócisz). Odtwórz film: lektor czyta wg czasu z pliku.';
                } else {
                    fileSubsStatus.textContent = 'brak';
                    fileSubsDetail.textContent = FILE_DETAIL_DEFAULT;
                }
            }
          });
        });
    }
    if (fileSubsBtn && fileSubsInput) {
        fileSubsBtn.addEventListener('click', () => fileSubsInput.click());
        fileSubsInput.addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file || !fileSubsDetail) return;
            try {
                const cues = await readSubsFile(file);
                if (!cues.length) {
                    fileSubsDetail.textContent = '✕ Nie znaleziono kwestii w pliku „' + file.name + '”. Wspierane: SRT, VTT, SBV, ASS/SSA, SUB, SMI, LRC, TTML/DFXP, TXT (linia = kwestia).';
                    return;
                }
                fileSubsSet({ name: file.name, cues: cues, loadedAt: Date.now() }, () => refreshFileSubsStatus());   // [AGENT-EXP] karta
            } catch (err) {
                fileSubsDetail.textContent = '✕ Błąd czytania pliku: ' + ((err && err.message) || err);
            }
            fileSubsInput.value = '';
        });
    }
    // Wczytywanie całego folderu: lista plików z napisami → select → klik wczytuje wybrany.
    const fileSubsFolderInput = $('fileSubsFolderInput');
    const fileSubsFolderBtn = $('fileSubsFolderBtn');
    const fileSubsFileSelect = $('fileSubsFileSelect');
    const SUBS_EXT = /\.(srt|vtt|sbv|ass|ssa|sub|smi|lrc|dfxp|ttml|txt)$/i;
    let folderFiles = [];
    if (fileSubsFolderBtn && fileSubsFolderInput) {
        fileSubsFolderBtn.addEventListener('click', () => fileSubsFolderInput.click());
        fileSubsFolderInput.addEventListener('change', (e) => {
            folderFiles = Array.from(e.target.files || []).filter((f) => SUBS_EXT.test(f.name || ''));
            folderFiles.sort((a, b) => String(a.name).localeCompare(String(b.name)));
            if (!folderFiles.length) {
                if (fileSubsDetail) fileSubsDetail.textContent = '✕ W folderze nie ma plików napisów (SRT/VTT/ASS/SUB/TXT…).';
                if (fileSubsFileSelect) fileSubsFileSelect.style.display = 'none';
                return;
            }
            if (fileSubsFileSelect) {
                fileSubsFileSelect.textContent = '';
                folderFiles.forEach((f, i) => {
                    const o = document.createElement('option');
                    o.value = String(i);
                    o.textContent = (f.webkitRelativePath || f.name) + ' (' + (f.size / 1024).toFixed(1) + ' kB)';
                    fileSubsFileSelect.appendChild(o);
                });
                fileSubsFileSelect.style.display = '';
            }
            if (fileSubsDetail) fileSubsDetail.textContent = '📁 Folder: ' + folderFiles.length + ' plików z napisami — wybierz z listy, kliknij, a lektor wczyta.';
            fileSubsFolderInput.value = '';
        });
    }
    if (fileSubsFileSelect) {
        fileSubsFileSelect.addEventListener('change', async () => {
            const f = folderFiles[+fileSubsFileSelect.value];
            if (!f || !fileSubsDetail) return;
            try {
                fileSubsDetail.textContent = '⏳ Czytam „' + f.name + '”…';
                const cues = await readSubsFile(f);
                if (!cues.length) {
                    fileSubsDetail.textContent = '✕ Nie znaleziono kwestii w pliku „' + f.name + '”.';
                    return;
                }
                fileSubsSet({ name: f.name, cues: cues, loadedAt: Date.now() }, () => refreshFileSubsStatus());   // [AGENT-EXP] karta
            } catch (err) {
                fileSubsDetail.textContent = '✕ Błąd czytania pliku: ' + ((err && err.message) || err);
            }
        });
    }
    if (fileSubsClear) {
        fileSubsClear.addEventListener('click', () => {   // [AGENT-EXP] plik + jego pamięć dla tego filmu
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const t = tabs && tabs[0];
                chrome.runtime.sendMessage({ action: 'LEKTOR_FILE_CLEAR', tabId: t ? t.id : null }, () => { void chrome.runtime.lastError; refreshFileSubsStatus(); });
            });
        });
    }
    refreshFileSubsStatus();

    // === 🌐 Bazy napisów (OpenSubtitles.org/.com, SubDL — src/background/subs_db.js) ===
    // Tytuł zgadywany z karty (og:title / h1 / tytuł strony, SxxEyy). Klik w wynik: polskie → fileSubs od razu,
    // inne → background tłumaczy w tle (od miejsca filmu) i sam wpisuje fileSubs.
    const dbQuery = $('dbQuery'), dbSeason = $('dbSeason'), dbEpisode = $('dbEpisode'), dbLang = $('dbLang');
    const dbSearchBtn = $('dbSearchBtn'), dbResults = $('dbResults'), dbDetail = $('dbDetail'), dbStatus = $('dbStatus');
    let dbTabId = null;
    let dbSearchJob = 0;
    const dbVerifiedCues = new WeakMap();
    function dbGuessTitle(info, url) {
        const raw = [info.og, info.h1, info.title].map((s) => String(s || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
        let all = raw.join(' | ');
        try { all += ' ' + decodeURIComponent(String(url || '')); } catch (e) { /* zły URL */ }
        let season = 0, episode = 0, m;
        if ((m = /\bS(\d{1,2})\s*[ .-]?\s*E(\d{1,3})\b/i.exec(all))) { season = +m[1]; episode = +m[2]; }
        else if ((m = /(?:season|sezon|сезон)\s*(\d{1,2})[^0-9]{1,25}?(?:episode|odcinek|ep\.?|серия)\s*(\d{1,3})/i.exec(all))) { season = +m[1]; episode = +m[2]; }
        else if ((m = /(\d{1,2})\s*(?:season|sezon|сезон)[^0-9]{1,25}?(\d{1,3})\s*(?:episode|odcinek|серия)/i.exec(all))) { season = +m[1]; episode = +m[2]; }
        let t = (raw[0] || '').split(/\s+[|•·]\s+/)[0].split(/\s+[-–—]\s+/)[0];
        t = t.replace(/\bS\d{1,2}\s*E\d{1,3}\b.*$/i, '').replace(/(?:season|sezon|сезон)\s*\d+.*$/i, '')
            .replace(/\((?:19|20)\d{2}\)|\b(?:19|20)\d{2}\b/g, '')
            .replace(/\b(?:watch|online|free|full movie|hd|1080p|720p|oglądaj|ogladaj|za darmo|lektor|napisy|cda)\b/gi, '')
            .replace(/смотреть|онлайн|бесплатно|в хорошем качестве/gi, '')
            .replace(/[[\]()]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s:–-]+|[\s:–-]+$/g, '').trim();
        return { title: t.slice(0, 80), season, episode };
    }
    function dbGuessFromTab() {
        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
            const tab = tabs && tabs[0];
            if (!tab || !dbQuery) return;
            dbTabId = tab.id;
            if (dbQuery.value) return;
            let info = { title: tab.title || '', og: '', h1: '' };
            try {
                const [r] = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => {
                        const m = document.querySelector('meta[property="og:title"]');
                        const h = document.querySelector('h1');
                        return { title: document.title, og: m ? m.content : '', h1: h ? h.textContent : '' };
                    }
                });
                if (r && r.result) info = r.result;
            } catch (e) { /* strona systemowa — zostaje tytuł karty */ }
            const g = dbGuessTitle(info, tab.url);
            dbQuery.value = g.title;
            if (g.season) dbSeason.value = g.season;
            if (g.episode) dbEpisode.value = g.episode;
        });
    }
    function dbUseCues(it, cues) {
        const name = (it.title || it.release) + ' [' + (it.lang || '?') + ']';
        chrome.runtime.sendMessage({ action: 'SUBSDB_PREPARE', tabId: dbTabId }, () => { void chrome.runtime.lastError; });
        if (/^pl/.test(it.lang || '')) {
            fileSubsSet({ name: '🌐 ' + name, cues, loadedAt: Date.now() }, () => refreshFileSubsStatus());   // [AGENT-EXP] karta
            dbDetail.textContent = '✅ Wczytano ' + cues.length + ' kwestii (' + it.providerName + '). Gdy lektor się spieszy lub spóźnia — użyj „Przesunięcie napisów”, albo wybierz inne wydanie.';
        } else {
            chrome.runtime.sendMessage({ action: 'SUBSDB_TRANSLATE', tabId: dbTabId, name, lang: it.lang || 'auto', cues }, () => { void chrome.runtime.lastError; });
            dbDetail.textContent = '🌐 Tłumaczę ' + cues.length + ' kwestii na polski (od miejsca filmu) — lektor zacznie czytać po pierwszej paczce. Popup można zamknąć.';
        }
    }
    function dbLoad(it) {
        const verified = dbVerifiedCues.get(it);
        if (verified) { dbUseCues(it, verified); return; }
        dbDetail.textContent = '⏳ Pobieram: ' + (it.release || it.title);
        chrome.runtime.sendMessage({ action: 'SUBSDB_GET', item: it }, (r) => {
            const runtimeError = chrome.runtime.lastError;
            if (runtimeError || !r || !r.ok) { dbDetail.textContent = '✕ ' + ((r && r.error) || (runtimeError && runtimeError.message) || 'błąd pobierania'); return; }
            const cues = parseSubsFile(r.text);
            if (!cues.length) { dbDetail.textContent = '✕ Nie odczytałem kwestii z tego pliku — wybierz inny wynik.'; return; }
            dbUseCues(it, cues);
        });
    }
    function dbRender(r) {
        dbResults.textContent = '';
        r.items.forEach((it) => {
            const row = document.createElement('div');
            row.className = 'db-row';   // [VOX] wygląd i podświetlenie w popup.css
            const lang = document.createElement('b');
            lang.textContent = '[' + (it.lang || '?').toUpperCase() + '] ';
            lang.className = /^pl/.test(it.lang || '') ? 'lang-pl' : 'lang-x';
            row.appendChild(lang);
            row.appendChild(document.createTextNode(it.title || '?'));
            const sub = document.createElement('div');
            sub.className = 'meta';
            sub.textContent = it.providerName + (it.downloads ? ' · ⬇ ' + it.downloads : '') + (it.hi ? ' · dla niesłyszących' : '') + ' · ' + (it.release || '');
            row.appendChild(sub);
            row.title = it.release || '';
            row.addEventListener('click', () => dbLoad(it));
            dbResults.appendChild(row);
        });
        dbResults.style.display = r.items.length ? '' : 'none';
    }
    function dbSearch() {
        const job = ++dbSearchJob;
        const query = dbQuery.value.trim();
        if (!query) { dbDetail.textContent = 'Wpisz tytuł filmu lub serialu.'; return; }
        dbDetail.textContent = '⏳ Szukam w bazach…';
        dbStatus.textContent = '';
        dbResults.style.display = 'none';
        chrome.runtime.sendMessage({
            action: 'SUBSDB_SEARCH',
            query: { query, season: +dbSeason.value || 0, episode: +dbEpisode.value || 0, langs: dbLang.value.split(',') }
        }, (r) => {
            const runtimeError = chrome.runtime.lastError;
            if (job !== dbSearchJob) return;
            if (runtimeError || !r || !r.ok) { dbDetail.textContent = '✕ ' + ((r && r.error) || (runtimeError && runtimeError.message) || 'brak odpowiedzi'); return; }
            const err = r.errors && r.errors.length ? ' Błędy: ' + r.errors.join('; ') + '.' : '';
            if (!r.items.length) { dbDetail.textContent = 'Nic nie znaleziono. Spróbuj tytułu oryginalnego (angielskiego) albo bez sezonu/odcinka.' + err; return; }
            const bestByProvider = new Map();
            r.items.forEach((it) => { if (!bestByProvider.has(it.provider)) bestByProvider.set(it.provider, it); });
            const candidates = Array.from(bestByProvider.values());
            dbStatus.textContent = 'sprawdzam 0/' + candidates.length;
            dbDetail.textContent = '⏳ Sprawdzam pliki napisów — wyniki pojawią się dopiero po odczytaniu kwestii…';
            let checkedCount = 0;
            Promise.all(candidates.map((it) => new Promise((resolve) => {
                const finish = (result) => {
                    checkedCount++;
                    if (job === dbSearchJob) dbStatus.textContent = 'sprawdzam ' + checkedCount + '/' + candidates.length;
                    resolve(result);
                };
                chrome.runtime.sendMessage({ action: 'SUBSDB_GET', item: it }, (result) => {
                    const getError = chrome.runtime.lastError;
                    if (getError || !result || !result.ok) {
                        finish({ item: it, error: (result && result.error) || (getError && getError.message) || 'błąd pobierania' });
                        return;
                    }
                    try {
                        const cues = parseSubsFile(result.text);
                        if (!cues.length) { finish({ item: it, error: 'nie znaleziono czytelnych kwestii' }); return; }
                        dbVerifiedCues.set(it, cues);
                        finish({ item: it, cues });
                    } catch (e) {
                        finish({ item: it, error: (e && e.message) || 'nie udało się odczytać pliku' });
                    }
                });
            }))).then((checked) => {
                if (job !== dbSearchJob) return;
                const found = checked.filter((x) => x.cues);
                const failed = checked.length - found.length;
                dbStatus.textContent = found.length ? found.length + ' odnalezion.' : 'brak czytelnych napisów';
                if (found.length) dbRender({ items: found.map((x) => x.item) });
                dbDetail.textContent = found.length
                    ? 'Odnaleziono ' + found.length + ' działając' + (found.length === 1 ? 'y plik napisów' : 'e pliki napisów') + ' (sprawdzono po jednym najlepszym wyniku z ' + candidates.length + ' baz)' + (failed ? '; pominięto ' + failed + ' niedziałając' + (failed === 1 ? 'y plik' : 'e pliki') : '') + '. Kliknij wynik, żeby wczytać napisy do lektora.' + err
                    : 'Nie znaleziono czytelnego pliku napisów w sprawdzonych bazach (' + candidates.length + ').' + (failed ? ' Pliki pobrane, ale niedostępne lub bez rozpoznawalnych kwestii: ' + checked.map((x) => x.error).join('; ') + '.' : '') + err;
            }).catch((e) => {
                if (job !== dbSearchJob) return;
                dbStatus.textContent = 'błąd sprawdzania';
                dbDetail.textContent = '✕ Nie udało się sprawdzić plików napisów: ' + ((e && e.message) || e);
            });
        });
    }
    if (dbSearchBtn && dbQuery) {
        dbSearchBtn.addEventListener('click', dbSearch);
        dbQuery.addEventListener('keydown', (e) => { if (e.key === 'Enter') dbSearch(); });
        dbGuessFromTab();
        // Postęp tłumaczenia w tle
        const dbShowState = (s) => { if (s && s.total && dbStatus) dbStatus.textContent = s.done >= s.total ? '✅ przetłumaczone' : 'tłumaczę ' + Math.round((s.done / s.total) * 100) + '%'; };
        chrome.storage.session.get('subsDbState').then((r) => dbShowState(r && r.subsDbState)).catch(() => {});
        chrome.storage.onChanged.addListener((ch, area) => {
            if (area === 'session' && ch.subsDbState) dbShowState(ch.subsDbState.newValue);
            if (area === 'local' && ch.fileSubs) refreshFileSubsStatus();
        });
    }

    // Żywy wskaźnik statystyk — czyta telemetrię TEJ platformy, na której jest aktywna karta.
    // Netflix: pełne statystyki od aktualnej klatki. YouTube/Prime/iQ: na ile się da (bez „do przodu").
    const recPlatFromUrl = (url) => {
        if (!url) return null;
        if (/netflix\.com/i.test(url)) return 'netflix';
        if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
        if (/primevideo\.com|amazon\.com|iqiyi?\.com|iq\.com|dailymotion\.com|dai\.ly|rumble\.com|viki\.com|wetv\.vip|bilibili\.(?:com|tv)|hbomax\.com|max\.com/i.test(url)) return 'dom';
        return null;
    };
    // [AGENT-EXP] 2026-11-16: karta „Nagrywanie / zapas do przodu” — TRZY liczby zamiast ściany tekstu:
    //   GDZIE JESTEM (07:54) · ILE MAM ZAPASU (2:31 z 7:00) · ILE BRAKUJE (4:29), pod spodem same zdania z bufora.
    // Dane: pasek lektora na stronie (`LEKTOR_BAR_SNAP` — klucze NAGRANEGO dźwięku z pamięci lektora), a gdy
    // strona nie odpowiada (brak paska / brak kwestii) — telemetria `__recTelemetry_*` (co lektor zamówił do przodu).
    const recPos = document.getElementById('recPos');
    const recPosCap = document.getElementById('recPosCap');
    const recBuf = document.getElementById('recBuf');
    const recBufCap = document.getElementById('recBufCap');
    const recMeter = document.getElementById('recMeter');
    const recMeterFill = document.getElementById('recMeterFill');
    const recGap = document.getElementById('recGap');
    const recListCap = document.getElementById('recListCap');
    const recAhead = document.getElementById('recAhead');
    const recDiag = document.getElementById('recDiag');
    const recClock = (ms) => {
        const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), q = s % 60;
        const p = (n) => String(n).padStart(2, '0');
        return (h ? h + ':' + p(m) : String(m)) + ':' + p(q);
    };
    const recText = (el, txt) => { if (el && el.textContent !== txt) el.textContent = txt; };
    const recEscape = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    // [FIX 2026-11-22] najpierw główna ramka; gdy milczy — każda ramka z listą kwestii (film w iframe)
    const recAskFrame = (tabId, msg, opts) => new Promise((resolve) => {
        try {
            const cb = (r) => { void chrome.runtime.lastError; resolve(r && r.nowMs != null ? r : null); };
            if (opts) chrome.tabs.sendMessage(tabId, msg, opts, cb); else chrome.tabs.sendMessage(tabId, msg, cb);
        } catch (e) { resolve(null); }
    });
    const recAskPage = async (tabId) => (await recAskFrame(tabId, { action: 'LEKTOR_BAR_SNAP' }, { frameId: 0 }))
        || recAskFrame(tabId, { action: 'LEKTOR_BAR_SNAP', anyFrame: true });
    const recReadSession = (key) => new Promise((resolve) => {
        try { chrome.storage.session.get(key, (x) => resolve((x && x[key]) || null)); } catch (e) { resolve(null); }
    });
    const recReadStatus = () => new Promise((resolve) => {
        try { chrome.runtime.sendMessage({ action: 'REC_STATUS' }, (r) => { void chrome.runtime.lastError; resolve(r || null); }); } catch (e) { resolve(null); }
    });

    // Jedno miejsce rysowania karty. view = {nowMs, durMs, bufMs, aheadN, ready, total, noTranslate, live, source, cues[]}
    function recRender(view) {
        const limitMin = lookaheadRange ? (parseInt(lookaheadRange.value, 10) || 0) : 0;
        const limitMs = limitMin * 60000;
        const now = view ? Math.max(0, Number(view.nowMs) || 0) : 0;
        const dur = view ? Math.max(0, Number(view.durMs) || 0) : 0;
        const buf = view ? Math.max(0, Number(view.bufMs) || 0) : 0;
        recText(recPos, view && view.nowMs != null ? recClock(now) : '—');
        recText(recPosCap, dur > 0 ? 'z ' + recClock(dur) : 'pozycja w filmie');
        if (limitMin > 0) {
            recText(recBuf, view ? recClock(Math.min(buf, limitMs)) : '—');
            recText(recBufCap, 'zapas · limit ' + limitMin + ' min');
            const pct = Math.round(Math.min(1, buf / limitMs) * 100);
            if (recMeterFill) recMeterFill.style.width = pct + '%';
            if (recMeter) recMeter.className = 'rec-meter' + (pct >= 90 ? '' : (pct >= 40 ? ' low' : ' empty'));
            if (!view) recText(recGap, '—');
            else {
                const b = [buf >= limitMs - 1000 ? 'zapas pełny ✓' : 'brakuje ' + recClock(limitMs - buf) + ' do pełnego zapasu'];
                if (dur > 0) b.push('do końca ' + recClock(Math.max(0, dur - now)));
                recText(recGap, b.join(' · '));
            }
        } else {
            recText(recBuf, '—');
            recText(recBufCap, 'na bieżąco');
            if (recMeterFill) recMeterFill.style.width = '0%';
            if (recMeter) recMeter.className = 'rec-meter empty';
            recText(recGap, 'Na bieżąco — bez zapasu. Suwak w prawo = nagrywanie do przodu.');
        }
        // Same zdania z bufora — bez „⚙ matcha-web-czas”, bez liczenia wyrazów.
        const cues = (view && Array.isArray(view.cues)) ? view.cues : [];
        recText(recListCap, view && view.noTranslate ? 'W buforze — napisy gotowe' : 'W buforze — przetłumaczone zdania');
        if (recAhead) {
            if (!cues.length) {
                recAhead.innerHTML = '<li class="rec-empty">'
                    + (view && view.live ? 'czytam z ekranu — dalszych zdań nie znam'
                        : (limitMin > 0 ? 'silnik nie ma jeszcze nic do przodu' : 'brak zapasu'))
                    + '</li>';
            } else {
                recAhead.innerHTML = cues.map((c) => '<li><time>' + recClock(c.atMs) + '</time><span>' + recEscape(c.text) + '</span></li>').join('');
            }
        }
    }

    let recBusy = false;
    setInterval(async () => {
        const tEl = document.getElementById('recTelemetry');
        const logEl = document.getElementById('recLog');
        if ((!recPos && !tEl && !logEl) || recBusy) return;
        recBusy = true;
        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            const tab = tabs && tabs[0];
            const plat = recPlatFromUrl(tab && tab.url);
            if (!plat) {
                recLastView = null;
                recRender(null);
                recText(tEl, 'Otwórz film na Netflix / YouTube / Prime…, aby zobaczyć zapas.');
                recText(logEl, '—');
                return;
            }
            let view = await recAskPage(tab.id);
            let tel = null;
            if (!view) {   // strona nie ma paska (albo nie zna jeszcze kwestii) — bierzemy telemetrię
                tel = await recReadSession('__recTelemetry_' + plat);
                if (tel && Date.now() - (tel.ts || 0) > 10000) tel = null;
                if (tel && tel.nowMs != null) {
                    view = {
                        nowMs: tel.nowMs, durMs: tel.durMs, bufMs: tel.aheadMs, aheadN: 0,
                        ready: tel.aheadWords, total: tel.total, noTranslate: false,
                        live: !!tel.live, source: tel.activeSource || '', cues: Array.isArray(tel.ahead) ? tel.ahead : []
                    };
                }
            }
            recLastView = view;
            recRender(view);
            if (tEl) {
                if (!view) recText(tEl, 'Odtwórz film — wtedy policzę pozycję i zapas.');
                else {
                    const b = [];
                    b.push(view.live ? 'czytam z ekranu (na żywo)' : 'źródło: ' + (view.source || '—'));
                    b.push('kwestie: ' + (view.total || 0));
                    if (view.total) b.push('z tekstem: ' + (view.ready || 0));
                    if (tel && tel.onScreen) b.push('na ekranie: „' + String(tel.onScreen).slice(0, 40) + '”');
                    recText(tEl, b.join(' · '));
                }
            }
            // Logi silnika tylko po rozwinięciu „Diagnostyka” — wcześniej zaśmiecały kartę.
            if (logEl && recDiag && recDiag.open) {
                const rec = Array.isArray(tel && tel.recent) ? tel.recent : [];
                const base = rec.length ? rec.map((r) => '• „' + String(r.t || '').slice(0, 40) + '” — ' + (r.w || 0) + ' wyrazów').join('\n') : '';
                let extra = '';
                try {
                    const [d1, d2] = await Promise.all([chrome.storage.local.get('__offscreenError'), chrome.storage.session.get('__offscreenLog')]);
                    const d = Object.assign({}, d1, d2);
                    const lg = [];
                    if (d && d.__offscreenError) lg.push('⛔ SILNIK: ' + String(d.__offscreenError.msg || '').slice(0, 140));
                    for (const e of ((d && Array.isArray(d.__offscreenLog)) ? d.__offscreenLog.slice(-4) : [])) lg.push('⚙ ' + (e.tag || '?') + ': ' + String(e.msg || '').slice(0, 90));
                    extra = lg.join('\n');
                } catch (e) {}
                recText(logEl, [base, extra].filter(Boolean).join('\n') || '—');
            }
            // Stan nagrywania — jedna krótka linia (szczegóły i błędy silnika siedzą wyżej).
            const st = await recReadStatus();
            if (recDetail && st && st.recording) {
                recText(recDetail, st.words === undefined
                    ? '⚠ Nieaktualna wersja silnika nagrywania — ⟳ przy „Polski Lektor” w chrome://extensions i odśwież stronę.'
                    : '● nagrywam · ' + (st.words || 0) + ' wyrazów · ' + (st.count || 0) + ' kwestii');
            }
        } catch (e) {
        } finally {
            recBusy = false;
        }
    }, 2000);
}

// ===== 🌐 Języki świata — katalog + pobieranie głosów (MMS + Piper) =====
// Katalog: sherpa/merged_models.json (w paczce rozszerzenia). Pobieranie z
// HuggingFace (host_permissions w manifest.json):
//  - MMS (Meta MMS-TTS, ~1100 języków): <url>/model.onnx + <url>/tokens.txt,
//  - Piper: lustrzane repo https://huggingface.co/csukuangfj/<id> →
//    <skrót>.onnx + tokens.txt + .onnx.json (bez rozpakowywania tar.bz2).
// Pliki trafiają do IndexedDB ('lektorVoices') pod kluczami '<id>/…' — ten sam
// format co mechanizm „Własny głos”, więc worker czyta je bez zmian.
const LANG_STORE = {
    catalogPath: 'sherpa/merged_models.json',
    piperMirror: 'https://huggingface.co/csukuangfj/',
    catalog: null,
    customList: [],            // głosy już zapisane w IndexedDB (lista „Własny głos”)
    filter: { q: '', region: 'all', type: 'all' },
    busy: {}
};

// Normalizacja merged_models.json → lista { id, type, name, iso, country, region, sizeMb, url }
function langNormalizeCatalog(json) {
    const out = [];
    for (const key of Object.keys(json || {})) {
        const m = json[key] || {};
        const lang = (Array.isArray(m.language) && m.language[0]) || {};
        const id = String(m.id || key);
        const url = String(m.url || '');
        const isMms = /huggingface\.co/.test(url) && /mms/i.test(key);
        const isPiper = /\/vits-piper-/.test(url) || /^piper-/.test(id) || /^vits-piper-/.test(id);
        // Coqui (sherpa: model.onnx + tokens.txt + config.json = *.onnx.json) i
        // kantoński (vits-cantonese-hf-…): lustra csukuangfj z luźnymi plikami.
        // Pozostałe VITS (mimic3/melo/icefall/zh-fs/ljs/vctk) — repo gated (401).
        const isCoqui = /^coqui-/.test(id);
        const isCantonese = id === 'cantonese-fs-xiaomaiiwn';
        let type = String(m.model_type || 'vits');
        let dl = false;
        if (isMms) { type = 'mms'; dl = true; }
        else if (isPiper) { type = 'piper'; dl = true; }
        else if (isCoqui) { type = 'coqui'; dl = true; }
        else if (isCantonese) { type = 'cantonese'; dl = true; }
        const entry = {
            id: id,
            type: type,
            dl: dl,
            voice: langVoiceName(m, url, type),   // [AGENT-EXP] 2026-10-24: nazwa lektora (np. meski_wg_glos, mai_female)
            name: String(lang['Language Name'] || lang.language_name || key),
            iso: String(lang['Iso Code'] || lang.lang_code || ''),
            country: String(lang['Country'] || lang.country || ''),
            region: String(m.Region || '—'),
            sizeMb: Number(m.filesize_mb) || 0,
            url: url
        };
        if (entry.dl) out.push(entry);
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'pl'));
    return out;
}
// [AGENT-EXP] 2026-10-24: nazwa lektora z katalogu. Piper: z nazwy paczki (vits-piper-pl_PL-meski_wg_glos-medium →
// „meski_wg_glos (medium)”), bo pole name bywa samą jakością („medium”). Coqui: name (mai_female). MMS: brak.
function langVoiceName(m, url, type) {
    const q = String(m.quality || '');
    if (type === 'piper') {
        const r = /\/vits-piper-[a-z]{2,3}(?:_[A-Za-z]{2})?-(.+?)\.tar\.bz2$/.exec(url);
        let v = r ? r[1] : String(m.name || '');
        if (q && v.endsWith('-' + q)) v = v.slice(0, -q.length - 1);
        return v + (q && q !== 'unknown' ? ' (' + q + ')' : '');
    }
    if (type === 'mms') return '';
    const n = String(m.name || '');
    return n && n !== q ? n : '';
}
// [AGENT-EXP] 2026-10-24: 🌐 Matcha-TTS-PL-Edge-v2 (liczony w przeglądarce, matcha_web/) — pobieranie z HuggingFace do
// pamięci rozszerzenia (klucze 'matcha/<głos>/<plik>'); worker czyta stamtąd, gdy modelu nie ma w paczce.
const MATCHA_REPO = 'https://huggingface.co/machinekind/Matcha-TTS-PL-Edge-v2/resolve/main/';
const MATCHA_REPO_V1 = 'https://huggingface.co/machinekind/Matcha-TTS-PL-Edge/resolve/main/';   // [AGENT-EXP] 2026-11-25: głosy _3
const MATCHA_REPO_PL = 'https://huggingface.co/machinekind/Matcha-TTS-PL/resolve/main/';   // [AGENT-EXP] 2026-11-25: głosy _1 (jeden plik)
const matchaRepoName = (e) => e.full ? 'Matcha-TTS-PL' : e.det ? 'Matcha-TTS-PL-Edge' : 'Matcha-TTS-PL-Edge-v2';
const MATCHA_FILES = ['voices.json', 'encoder_sdp_int8.onnx', 'decoder_t4_int8.onnx', 'vocoder.onnx'];   // [AGENT-EXP] 2026-10-24: INT8 osobno od F32 (~27 MB)
const MATCHA_STORE = [
    { id: 'matcha-male_voxcpm_2', mv: 'male_voxcpm_2', voice: 'Matcha 🌐 męski — INT8 (male_voxcpm_2)' },   // [AGENT-EXP] 2026-10-24: + INT8 w nazwie
    { id: 'matcha-female_voxcpm_2', mv: 'female_voxcpm_2', voice: 'Matcha 🌐 żeński — INT8 (female_voxcpm_2)' },
    // [AGENT-EXP] 2026-11-25: głosy _3 (repo Matcha-TTS-PL-Edge, 2026-11-23) — zwykły koder (det), bez stochastycznego rytmu
    { id: 'matcha-female_voxcpm_3', mv: 'female_voxcpm_3', voice: 'Matcha 🌐 żeński 3 — INT8 (female_voxcpm_3)', det: true, sizeMb: 28, url: MATCHA_REPO_V1 + 'female_voxcpm_3/' },
    { id: 'matcha-male_voxcpm_3', mv: 'male_voxcpm_3', voice: 'Matcha 🌐 męski 3 — INT8 (male_voxcpm_3)', det: true, sizeMb: 28, url: MATCHA_REPO_V1 + 'male_voxcpm_3/' },
    // [AGENT-EXP] 2026-11-25: głosy _1 (repo Matcha-TTS-PL, onnx/) — jeden plik matcha_pl_t4.onnx (koder + dekoder + duży wokoder
    // HiFi-GAN V1), ~140 MB, liczony na procesorze; bez wariantów INT8/F32
    { id: 'matcha-male_voxcpm_1', mv: 'male_voxcpm_1', voice: 'Matcha 🌐 męski 1 — jeden plik (male_voxcpm_1)', full: true, sizeMb: 140, url: MATCHA_REPO_PL + 'onnx/' },
    { id: 'matcha-female_voxcpm_1', mv: 'female_voxcpm_1', voice: 'Matcha 🌐 żeński 1 — jeden plik (female_voxcpm_1)', full: true, sizeMb: 140, url: MATCHA_REPO_PL + 'onnx/female_voxcpm_1/' },
    // [AGENT-EXP] 2026-11-25: _3 w pełnej wersji z Matcha-TTS-PL (jeden plik, ~88 MB) — osobna pamięć '<głos>_pelny', obok lekkiej Edge
    { id: 'matcha-male_voxcpm_3_pelny', mv: 'male_voxcpm_3_pelny', voice: 'Matcha 🌐 męski 3 pełny — jeden plik (male_voxcpm_3, Matcha-TTS-PL)', full: true, sizeMb: 88, url: MATCHA_REPO_PL + 'onnx/male_voxcpm_3/' },
    { id: 'matcha-female_voxcpm_3_pelny', mv: 'female_voxcpm_3_pelny', voice: 'Matcha 🌐 żeński 3 pełny — jeden plik (female_voxcpm_3, Matcha-TTS-PL)', full: true, sizeMb: 88, url: MATCHA_REPO_PL + 'onnx/female_voxcpm_3/' }
].map((e) => Object.assign({ type: 'matcha', dl: true, name: 'Polish', iso: 'pl', country: 'PL', region: 'Europe', sizeMb: 27, url: MATCHA_REPO + e.mv + '/' }, e));
// [AGENT-EXP] 2026-10-24: w „Językach świata” dwie pozycje na głos: INT8 (wariant 'kombi') i F32 (wariant 'cpu_fp32',
// wszystko na procesorze), ok. 85 MB. Pliki obok INT8 ('matcha/<głos>/encoder_sdp.onnx' itd.), znacznik '_ok32'.
// voices.json i wokoder są wspólne: F32 dociąga je, gdy ich brak (działa bez INT8), kasowanie zostawia je drugiemu.
// Pobranie wariantu od razu go włącza; przy dwóch dostępnych przełącza „Włącz” (lista w popupie usunięta 2026-11-02).
const MATCHA_SHARED = ['voices.json', 'vocoder.onnx'];
const MATCHA_F32_FILES = ['voices.json', 'vocoder.onnx', 'encoder_sdp.onnx', 'decoder_t4.onnx'];
const MATCHA_F32_STORE = MATCHA_STORE.filter((e) => !e.full).map((e) => Object.assign({}, e, { id: e.id + '-f32', f32: true, sizeMb: e.det ? 88 : 89,
    voice: e.voice.replace(' — INT8 (', ' — F32 (') }));
// [AGENT-EXP] 2026-11-25: zwykły koder (det) — ten sam układ plików, encoder_int8.onnx / encoder.onnx zamiast encoder_sdp*
const MATCHA_DET_FILES = ['voices.json', 'encoder_int8.onnx', 'decoder_t4_int8.onnx', 'vocoder.onnx'];
const MATCHA_DET_F32_FILES = ['voices.json', 'vocoder.onnx', 'encoder.onnx', 'decoder_t4.onnx'];
const MATCHA_FULL_FILES = ['voices.json', 'matcha_pl_t4.onnx'];   // [AGENT-EXP] 2026-11-25
const matchaFiles = (entry) => entry.full ? MATCHA_FULL_FILES : entry.det ? (entry.f32 ? MATCHA_DET_F32_FILES : MATCHA_DET_FILES) : (entry.f32 ? MATCHA_F32_FILES : MATCHA_FILES);
// [AGENT-EXP] 2026-11-25: głosy Matcha spoza katalogu, wczytane z folderu — zapamiętane w 'matchaImported' [{ mv, det }],
// dopisywane do katalogu (🗑 / Włącz w „Języki świata”) i do listy głosów lektora.
function matchaAddExtra(mv, det, full) {
    if (!mv || MATCHA_STORE.some((e) => e.mv === mv)) return;
    const e = { type: 'matcha', dl: true, name: 'Polish', iso: 'pl', country: 'PL', region: 'Europe', sizeMb: full ? 140 : 28, url: (det ? MATCHA_REPO_V1 : MATCHA_REPO) + mv + '/',
        id: 'matcha-' + mv, mv, det: !!det, full: !!full, extra: true, voice: 'Matcha 🌐 ' + mv + (full ? ' — jeden plik (z folderu)' : ' — INT8 (z folderu)') };
    MATCHA_STORE.push(e);
    if (!full) MATCHA_F32_STORE.push(Object.assign({}, e, { id: e.id + '-f32', f32: true, sizeMb: 88, voice: e.voice.replace(' — INT8 (', ' — F32 (') }));
}
try { chrome.storage.local.get('matchaImported', (r) => { for (const x of (r && r.matchaImported) || []) matchaAddExtra(x.mv, x.det, x.full); }); } catch (e) {}
const matchaOkKey = (entry) => 'matcha/' + entry.mv + '/' + (entry.f32 ? '_ok32' : '_ok');
const matchaOtherOkKey = (entry) => 'matcha/' + entry.mv + '/' + (entry.f32 ? '_ok' : '_ok32');
function matchaSetTryb(t) {
    LANG_STORE.matchaTryb = t;
    return new Promise((res) => chrome.storage.local.set({ matchaWebTryb: t }, () => res()));
}
// stan głosu Matcha: 'idb' (pobrany), '' (brak). [AGENT-EXP] 2026-11-02: modeli nie ma już w paczce (bez stanu 'pkg')
async function matchaStoreState(mv) {
    try { if (await voiceGet('matcha/' + mv + '/_ok')) return 'idb'; } catch (e) {}
    return '';
}
async function matchaRefreshState() {
    LANG_STORE.matchaTryb = await new Promise((res) => chrome.storage.local.get('matchaWebTryb', (d) => res(d && d.matchaWebTryb === 'cpu_fp32' ? 'cpu_fp32' : 'kombi')));
    LANG_STORE.matcha = {};
    for (const e of MATCHA_STORE) LANG_STORE.matcha[e.mv] = await matchaStoreState(e.mv);
    for (const e of MATCHA_F32_STORE) {   // [AGENT-EXP] 2026-10-24: stan F32 (klucz = id wpisu): pobrany / brak
        let st = '';
        try {   // bez voices.json/wokodera — ⬇ dociąga brakujące
            if (await voiceGet(matchaOkKey(e)) && await voiceGet('matcha/' + e.mv + '/voices.json') && await voiceGet('matcha/' + e.mv + '/vocoder.onnx')) st = 'idb';
        } catch (err) {}
        LANG_STORE.matcha[e.id] = st;
    }
}
async function matchaDownload(entry) {
    LANG_STORE.busy[entry.id] = true;
    langRender();
    try {
        const got = [];
        const files = [];   // [AGENT-EXP] 2026-10-24: INT8 albo F32; wspólnych plików, które już są, nie ciągnie drugi raz
        for (const f of matchaFiles(entry)) {
            let have = false;
            if (MATCHA_SHARED.includes(f)) try { have = !!(await voiceGet('matcha/' + entry.mv + '/' + f)); } catch (err) {}
            if (!have) files.push(f);
        }
        for (const f of files) {
            const data = await langFetchProgress(entry.url + f, (n, total) => {
                langStatus('⬇ „' + entry.voice + '”: ' + f + ' ' + fmtBytes(n) + (total ? ' / ' + fmtBytes(total) : '') + ' (' + (got.length + 1) + '/' + files.length + ')…');
            });
            if (/\.onnx$/.test(f) && !(data && data.length > 1024 * 1024 && data[0] === 0x08)) throw new Error(f + ' nie wygląda na model ONNX');
            got.push([f, data]);
        }
        langStatus('💾 Zapisuję „' + entry.voice + '” w pamięci rozszerzenia…');
        for (const [f, data] of got) await voicePut('matcha/' + entry.mv + '/' + f, data);
        await voicePut(matchaOkKey(entry), Date.now());
        if (!entry.full) await matchaSetTryb(entry.f32 ? 'cpu_fp32' : 'kombi');   // [AGENT-EXP] 2026-10-24: pobrany wariant od razu w użyciu (2026-11-25: nie dla jednego pliku)
        langStatus('✓ „' + entry.voice + '” pobrany i włączony (' + (entry.full ? 'jeden plik, na procesorze' : entry.f32 ? 'F32, wszystko na procesorze' : 'INT8') + '). Wybierz silnik Matcha i głos 🌐 w ustawieniach lektora.');
    } catch (e) {
        langStatus('⛔ Pobieranie nieudane: ' + ((e && e.message) || e));
    } finally {
        delete LANG_STORE.busy[entry.id];
        await matchaRefreshState();
        langRender();
    }
}
// [AGENT-EXP] 2026-11-02: 📂 „Wskaż pliki własnego głosu” przyjmuje też folder Matchy (encoder_sdp*/decoder_t4*).
// Głos = "default" z voices.json, wariant INT8/F32 = po nazwach plików; zapis jak przy pobieraniu z serwera.
// Zwraca tekst statusu albo null, gdy to nie Matcha (wtedy folder idzie jako Sherpa/Piper).
async function matchaImportFiles(files) {
    const byName = {};
    for (const f of Array.from(files || [])) byName[String(f.name || '').toLowerCase()] = f;
    if (!Object.keys(byName).some((n) => /^(encoder_sdp|encoder|decoder_t4|matcha_pl_t[24])/.test(n) && /\.onnx$/.test(n))) return null;   // [AGENT-EXP] 2026-11-25: + zwykły koder
    if (!byName['voices.json']) return '⛔ Folder Matchy bez voices.json — nie wiem, który to głos.';
    let mv = '';
    try { mv = String(JSON.parse(await byName['voices.json'].text()).default || ''); } catch (e) {}
    if (!mv) {   // [AGENT-EXP] 2026-11-25: bez „default” w voices.json — nazwa folderu
        const rel = String(byName['voices.json'].webkitRelativePath || '').split('/');
        mv = rel.length > 1 ? rel[rel.length - 2] : '';
    }
    if (byName['matcha_pl_t4.onnx'] && !byName['decoder_t4_int8.onnx'] && !byName['decoder_t4.onnx']) {   // [AGENT-EXP] 2026-11-25
        const e0 = MATCHA_STORE.find((e) => e.mv === mv);
        if (e0 && !e0.full && MATCHA_STORE.some((e) => e.mv === mv + '_pelny')) mv = mv + '_pelny';   // pełna wersja _3 obok lekkiej
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(mv)) return '⛔ Matcha: nie rozpoznaję nazwy głosu („' + (mv || '?') + '”). Wskaż folder głosu, np. female_voxcpm_3.';
    // [AGENT-EXP] 2026-11-25: głos spoza katalogu — dopisz (rodzaj kodera po plikach), zapamiętaj na później
    if (!MATCHA_STORE.some((e) => e.mv === mv)) {
        const full = !!byName['matcha_pl_t4.onnx'] && !byName['decoder_t4_int8.onnx'] && !byName['decoder_t4.onnx'];   // [AGENT-EXP] 2026-11-25
        const det = !full && !byName['encoder_sdp_int8.onnx'] && !byName['encoder_sdp.onnx'];
        matchaAddExtra(mv, det, full);
        await new Promise((res) => chrome.storage.local.get('matchaImported', (r) => {
            const list = ((r && r.matchaImported) || []).filter((x) => x && x.mv !== mv).concat([{ mv, det, full }]);
            chrome.storage.local.set({ matchaImported: list }, () => res());
        }));
    }
    const entries = MATCHA_STORE.concat(MATCHA_F32_STORE).filter((e) => e.mv === mv && matchaFiles(e).every((f) => byName[f]));
    if (!entries.length) {
        const e0 = MATCHA_STORE.find((e) => e.mv === mv);
        if (e0 && e0.full) return '⛔ Matcha „' + mv + '”: brak kompletu plików. Potrzebne: voices.json i matcha_pl_t4.onnx.';   // [AGENT-EXP] 2026-11-25
        return '⛔ Matcha „' + mv + '”: brak kompletu plików. Potrzebne: voices.json, vocoder.onnx, decoder_t4_int8.onnx (albo decoder_t4.onnx) i '
            + (e0 && e0.det ? 'encoder_int8.onnx (albo encoder.onnx)' : 'encoder_sdp_int8.onnx (albo encoder_sdp.onnx)') + '.';
    }
    for (const e of entries) for (const f of matchaFiles(e)) {
        const head = new Uint8Array(await byName[f].slice(0, 1).arrayBuffer());
        if (/\.onnx$/.test(f) && !(byName[f].size > 1024 * 1024 && head[0] === 0x08)) return '⛔ ' + f + ' nie wygląda na model ONNX.';
    }
    for (const e of entries) {
        for (const f of matchaFiles(e)) await voicePut('matcha/' + e.mv + '/' + f, byName[f]);
        await voicePut(matchaOkKey(e), Date.now());
    }
    if (!entries.some((e) => e.full)) await matchaSetTryb(entries.some((e) => !e.f32) ? 'kombi' : 'cpu_fp32');   // [AGENT-EXP] 2026-11-25: jeden plik — wariant bez zmian
    try { await matchaRefreshState(); langRender(); } catch (e) {}
    return '✓ Matcha „' + mv + '” wczytana z folderu (' + entries.map((e) => e.full ? 'jeden plik' : e.f32 ? 'F32' : 'INT8').join(' + ')
        + '). Wybierz silnik Matcha i głos 🌐 w ustawieniach lektora.';
}
async function matchaDelete(entry) {
    let other = false;   // [AGENT-EXP] 2026-10-24: INT8 i F32 osobno; wspólne pliki zostają, gdy drugi wariant jest pobrany
    try { other = !!(await voiceGet(matchaOtherOkKey(entry))); } catch (err) {}
    if (entry.full) {   // [AGENT-EXP] 2026-11-25: jeden plik — skasuj wszystko głosu
        for (const f of MATCHA_FULL_FILES.concat(['matcha_pl_t2.onnx'])) await voiceDel('matcha/' + entry.mv + '/' + f);
        await voiceDel(matchaOkKey(entry));
        await matchaRefreshState();
        langRender();
        return;
    }
    const files = matchaFiles(entry).concat(entry.f32 || other ? [] : entry.det ? ['encoder.onnx', 'decoder_t4.onnx'] : ['encoder_sdp.onnx', 'decoder_t4.onnx']);   // + F32 ze starego pobierania „wszystko naraz”
    for (const f of files) if (!(other && MATCHA_SHARED.includes(f))) await voiceDel('matcha/' + entry.mv + '/' + f);
    await voiceDel(matchaOkKey(entry));
    await matchaRefreshState();
    const M = LANG_STORE.matcha || {};   // skasowany wariant był w użyciu → włącz pozostały
    const hasF32 = MATCHA_F32_STORE.some((x) => M[x.id]), hasInt8 = MATCHA_STORE.some((x) => M[x.mv]);
    if (entry.f32 && LANG_STORE.matchaTryb === 'cpu_fp32' && !hasF32 && hasInt8) await matchaSetTryb('kombi');
    if (!entry.f32 && LANG_STORE.matchaTryb === 'kombi' && !hasInt8 && hasF32) await matchaSetTryb('cpu_fp32');
    langRender();
}

// [AGENT-EXP] 2026-10-24: 🌐 Supertonic 3 (liczony w przeglądarce, supertonic/) — silnik sam pobiera model przy pierwszym
// użyciu do Cache Storage; tu pobieramy zawczasu DOKŁADNIE te same adresy do tej samej pamięci podręcznej (muszą się
// zgadzać z supertonic/engine.js: CACHE_NAME, MODEL_PATHS, downloadUrl, voice_styles/<głos>.json).
const SUPERTONIC_CACHE = 'supertonic-assets-supertonic-3';
const SUPERTONIC_BASE = 'https://huggingface.co/Supertone/supertonic-3/resolve/main/';
const SUPERTONIC_FILES = ['onnx/tts.json', 'onnx/unicode_indexer.json', 'onnx/duration_predictor.onnx', 'onnx/text_encoder.onnx',
    'onnx/vocoder.onnx', 'onnx/vector_estimator.onnx', 'voice_styles/M1.json', 'voice_styles/M2.json', 'voice_styles/F1.json', 'voice_styles/F2.json'];
const SUPERTONIC_STORE = [{ id: 'supertonic-3', type: 'supertonic', dl: true, voice: 'Supertonic 3 🌐 (męski 1, 2 · żeński 1, 2)',
    name: 'Polish', iso: 'pl', country: 'PL', region: 'Europe', sizeMb: 380, url: SUPERTONIC_BASE }];
const supertonicUrl = (f) => SUPERTONIC_BASE + f + '?download=1';
// stan: 'ok' (wszystkie pliki w pamięci), 'part' (część), '' (brak)
async function supertonicRefreshState() {
    let n = 0;
    try {
        if (!(await caches.has(SUPERTONIC_CACHE))) throw 0;   // [AGENT-EXP] 2026-10-24: samo sprawdzanie nie zakłada pustej pamięci
        const cache = await caches.open(SUPERTONIC_CACHE);
        for (const f of SUPERTONIC_FILES) if (await cache.match(supertonicUrl(f))) n++;
    } catch (e) { /* brak Cache Storage */ }
    LANG_STORE.supertonic = n === SUPERTONIC_FILES.length ? 'ok' : (n ? 'part' : '');
    LANG_STORE.supertonicN = n;
}
async function supertonicDownload(entry) {
    LANG_STORE.busy[entry.id] = true;
    langRender();
    try {
        const cache = await caches.open(SUPERTONIC_CACHE);
        let i = 0;
        for (const f of SUPERTONIC_FILES) {
            i++;
            const url = supertonicUrl(f);
            if (await cache.match(url)) continue;   // już jest (np. przerwane wcześniej pobieranie) — dokańczamy resztę
            const resp = await fetch(url);
            if (!resp.ok) throw new Error('HTTP ' + resp.status + ' — ' + f);
            const total = Number(resp.headers.get('content-length')) || 0;
            const chunks = [];
            let got = 0;
            const reader = resp.body.getReader();
            for (;;) {
                const c = await reader.read();
                if (c.done) break;
                chunks.push(c.value);
                got += c.value.length;
                langStatus('⬇ Supertonic 3: ' + f.replace(/^.*\//, '') + ' ' + fmtBytes(got) + (total ? ' / ' + fmtBytes(total) : '') + ' (' + i + '/' + SUPERTONIC_FILES.length + ')…');
            }
            const type = /\.json$/.test(f) ? 'application/json' : 'application/octet-stream';
            await cache.put(url, new Response(new Blob(chunks, { type }), { headers: { 'Content-Type': type } }));
        }
        langStatus('✓ Supertonic 3 pobrany (działa bez internetu). Wybierz silnik Supertonic w ustawieniach lektora.');
    } catch (e) {
        langStatus('⛔ Pobieranie nieudane: ' + ((e && e.message) || e) + ' — kliknij ⬇ jeszcze raz, pobrane pliki zostają.');
    } finally {
        delete LANG_STORE.busy[entry.id];
        await supertonicRefreshState();
        langRender();
    }
}
async function supertonicDelete() {
    try { await caches.delete(SUPERTONIC_CACHE); } catch (e) {}
    await supertonicRefreshState();
    langRender();
}

// Adresy plików w lustrze csukuangfj dla głosu Piper. Nazwę repo bierzemy z URL
// tarballa (…/vits-piper-<język>-<głos>.tar.bz2 → repo csukuangfj/vits-piper-…),
// więc mapa działa niezależnie od formatu id w katalogu (piper-… / vits-piper-…).
function langPiperUrl(entry) {
    const m = /\/([^\/]+)\.tar\.bz2$/.exec(String(entry.url || ''));
    const repo = m ? m[1] : String(entry.id);
    const short = repo.replace(/^vits-piper-/, '');
    const base = LANG_STORE.piperMirror + repo + '/resolve/main/';
    return { base: base, onnx: base + short + '.onnx', json: base + short + '.onnx.json', tokens: base + 'tokens.txt' };
}
// Adresy plików dla Coqui i kantońskiego (lustro csukuangfj, pliki luźno — bez tar.bz2).
// Coqui: model.onnx + tokens.txt + config.json (config.json = treść *.onnx.json —
// eksporter sherpa-onnx kopiuje config do metadanych, format zgodny). Kantoński:
// vits-cantonese-hf-xiaomaiiwn.onnx + tokens.txt + lexicon.txt + rule.fst (BEZ .json).
function langVitsUrl(entry) {
    // Nazwę repo bierzemy z URL tarballa (…/vits-coqui-bg-cv.tar.bz2 → repo
    // csukuangfj/vits-coqui-bg-cv), bo id w katalogu bywa inny (np. kantoński
    // 'cantonese-fs-xiaomaiiwn' → repo 'vits-cantonese-hf-xiaomaiiwn').
    const m = /\/([^\/]+)\.tar\.bz2$/.exec(String(entry.url || ''));
    const repo = m ? m[1] : ('vits-' + String(entry.id).replace(/^vits-/, ''));
    const base = LANG_STORE.piperMirror + repo + '/resolve/main/';
    const out = { base: base, onnx: base + 'model.onnx', tokens: base + 'tokens.txt', json: base + 'config.json' };
    if (entry.type === 'cantonese') {
        out.onnx = base + repo + '.onnx';
        out.json = null;
    }
    return out;
}
function langStatus(msg) {
    const el = $('langStoreStatus');
    if (el) el.textContent = msg;
}
function langRender() {
    const listEl = $('langStoreList');
    if (!listEl || !LANG_STORE.catalog) return;
    const f = LANG_STORE.filter;
    const q = f.q.trim().toLowerCase();
    const items = LANG_STORE.catalog.filter((e) => {
        if (f.type !== 'all' && e.type !== f.type) return false;
        if (f.region !== 'all' && e.region !== f.region) return false;
        if (!q) return true;
        return (e.name + ' ' + e.iso + ' ' + e.country + ' ' + e.id + ' ' + (e.voice || '')).toLowerCase().indexOf(q) >= 0;
    });
    // Jednorazowe uzupełnienie listy regionów w filtrze.
    const regionSel = $('langRegionFilter');
    if (regionSel && regionSel.options.length <= 1) {
        const regions = Array.from(new Set(LANG_STORE.catalog.map((e) => e.region)))
            .filter((r) => r && r !== '—').sort();
        for (const r of regions) {
            const opt = document.createElement('option');
            opt.value = r;
            opt.textContent = r;
            regionSel.appendChild(opt);
        }
    }
    listEl.innerHTML = '';
    const MAX = 80;
    for (const e of items.slice(0, MAX)) {
        const row = document.createElement('div');
        row.className = 'list-row';   // [VOX] wygląd w popup.css
        const label = document.createElement('span');
        label.className = 'name';
        const tagMap = { mms: 'MMS', piper: 'PIPER', coqui: 'COQUI', cantonese: 'YUE', vits: 'VITS', matcha: 'MATCHA 🌐', supertonic: 'SUPERTONIC 🌐' };
        const tag = tagMap[e.type] || 'VITS';
        // [AGENT-EXP] 2026-10-24: najpierw nazwa lektora, potem język (wcześniej same „Polish — PL [pl] · PIPER”)
        label.textContent = (e.voice ? e.voice + ' · ' : '') + e.name + (e.country ? ' — ' + e.country : '') + (e.iso ? ' [' + e.iso + ']' : '') + ' · ' + tag;
        label.title = e.id + ' · ' + (e.sizeMb ? 'rozmiar spakowany: ' + e.sizeMb + ' MB' : '≈114 MB');
        row.appendChild(label);
        const btn = document.createElement('button');
        if (e.type === 'supertonic') {   // [AGENT-EXP] 2026-10-24: Supertonic 🌐 — Cache Storage silnika
            const st = LANG_STORE.supertonic || '';
            btn.className = 'mini' + (st === 'ok' ? ' danger' : '');
            if (st === 'ok') {
                btn.textContent = '🗑';
                btn.title = 'Pobrany (' + SUPERTONIC_FILES.length + ' plików, ok. ' + e.sizeMb + ' MB). Kliknij, aby wykasować — silnik pobierze go znowu przy użyciu.';
                btn.addEventListener('click', () => supertonicDelete());
            } else {
                btn.textContent = LANG_STORE.busy[e.id] ? '⏳' : '⬇';
                btn.disabled = !!LANG_STORE.busy[e.id];
                btn.title = (st === 'part' ? 'Pobrany częściowo (' + LANG_STORE.supertonicN + '/' + SUPERTONIC_FILES.length + ') — dokończ. ' : '')
                    + 'Pobierz z HuggingFace (Supertone/supertonic-3), ok. ' + e.sizeMb + ' MB. Nie zamykaj popupu w trakcie.';
                btn.addEventListener('click', () => supertonicDownload(e));
            }
            row.appendChild(btn);
            listEl.appendChild(row);
            continue;
        }
        if (e.type === 'matcha') {   // [AGENT-EXP] 2026-10-24: Matcha 🌐 — osobna pamięć, nie lista „Własny głos”
            const st = (LANG_STORE.matcha || {})[e.f32 ? e.id : e.mv] || '';   // [AGENT-EXP] 2026-10-24: F32 ma własny stan
            if (st && !e.full) {   // [AGENT-EXP] 2026-10-24: wariant dostępnego pliku: w użyciu albo „Włącz” (2026-11-25: jeden plik — bez wariantu)
                const on = (e.f32 ? 'cpu_fp32' : 'kombi') === LANG_STORE.matchaTryb;
                const tb = document.createElement('button');
                tb.className = 'mini' + (on ? ' ok' : '');
                tb.style.cssText = 'width:auto;padding:0 6px;';
                tb.textContent = on ? '✓ w użyciu' : 'Włącz';
                tb.disabled = on;
                tb.title = e.f32 ? 'Wariant F32 — wszystko na procesorze, naturalny rytm' : 'Wariant INT8 — koder i dekoder na procesorze, wokoder na karcie (najszybszy)';
                if (on) label.classList.add('active');
                else tb.addEventListener('click', async () => { await matchaSetTryb(e.f32 ? 'cpu_fp32' : 'kombi'); langRender(); });
                row.appendChild(tb);
            }
            btn.className = 'mini' + (st === 'idb' ? ' danger' : '');
            if (st === 'idb') {   // [AGENT-EXP] 2026-11-02: bez stanu „wbudowany w paczkę”
                btn.textContent = '🗑';
                btn.title = 'Pobrany do pamięci rozszerzenia. Kliknij, aby wykasować.';
                btn.addEventListener('click', () => matchaDelete(e));
            } else {
                btn.textContent = LANG_STORE.busy[e.id] ? '⏳' : '⬇';
                btn.disabled = !!LANG_STORE.busy[e.id];
                btn.title = 'Pobierz z HuggingFace (machinekind/' + matchaRepoName(e) + '), ok. ' + e.sizeMb + ' MB'
                    + (e.full ? ' — jeden plik, liczony na procesorze (wolniej niż głosy _2)' : '')
                    + (e.f32 ? ' — wariant F32, wszystko na procesorze (działa też bez INT8)' : '') + '; po pobraniu włącza się sam'   // [AGENT-EXP] 2026-10-24
                    + (e.f32 ? '' : '. Lektor pobierze go też sam przy pierwszym czytaniu');   // [AGENT-EXP] 2026-11-02
                btn.addEventListener('click', () => matchaDownload(e));
            }
            row.appendChild(btn);
            listEl.appendChild(row);
            continue;
        }
        const isVitsExtra = !e.dl;
        const downloaded = !isVitsExtra && (LANG_STORE.customList || []).some((v) => v.id === e.id);
        if (downloaded) {
            btn.textContent = '🗑';
            btn.title = 'Już pobrany — jest na liście „Własny głos”. Kliknij, aby wykasować z pamięci rozszerzenia.';
            btn.className = 'mini danger';
            btn.addEventListener('click', async () => {
                const { list } = await loadVoiceState();
                const v = list.find((x) => x.id === e.id) || { id: e.id, name: e.name };
                await deleteVoice(v);
                LANG_STORE.customList = (await loadVoiceState()).list || [];
                langRender();
            });
        } else {
            btn.textContent = LANG_STORE.busy[e.id] ? '⏳' : '⬇';
            btn.title = isVitsExtra
                ? 'Repozytorium tego modelu jest chwilowo niedostępne (zaloguj się na HuggingFace) — użyj sekcji „Własny głos”'
                : 'Pobierz i zapisz ten głos w rozszerzeniu';
            btn.disabled = !!LANG_STORE.busy[e.id] || isVitsExtra;
            btn.className = 'mini';
            btn.addEventListener('click', () => langDownload(e));
        }
        row.appendChild(btn);
        listEl.appendChild(row);
    }
    if (items.length > MAX) {
        const more = document.createElement('div');
        more.className = 'footnote';
        more.textContent = '…i ' + (items.length - MAX) + ' więcej — doprecyzuj wyszukiwanie.';
        listEl.appendChild(more);
    }
    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'footnote';
        empty.textContent = 'Brak wyników — zmień frazę lub filtry.';
        listEl.appendChild(empty);
    }
    langStatus('Katalog: ' + LANG_STORE.catalog.length + ' głosów (~1100 języków MMS + Piper + Matcha 🌐 + Supertonic 🌐). Wpisz język i kliknij ⬇.');
}

// fetch z paskiem postępu (onProg(pobrane, łącznie))
async function langFetchProgress(url, onProg) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' — ' + url);
    const total = Number(resp.headers.get('content-length')) || 0;
    if (!resp.body || !total) {
        const buf = new Uint8Array(await resp.arrayBuffer());
        if (onProg) onProg(buf.length, buf.length);
        return buf;
    }
    const reader = resp.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        chunks.push(chunk.value);
        got += chunk.value.length;
        if (onProg) onProg(got, total);
    }
    const out = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
}

// Pobranie języka → zapis w IndexedDB → dodanie na listę głosów → aktywacja.
async function langDownload(entry) {
    const label = entry.name + (entry.country ? ' (' + entry.country + ')' : '');
    LANG_STORE.busy[entry.id] = true;
    langRender();
    try {
        langStatus('⬇ Pobieram „' + label + '”…');
        let onnxPath, tokensPath, jsonPath = null;
        const extra = []; // dodatkowe pliki (lexicon.txt, rule.fst — kantoński)
        if (entry.type === 'mms') {
            const base = entry.url.replace(/\/+$/, '');
            onnxPath = base + '/model.onnx';
            tokensPath = base + '/tokens.txt';
        } else if (entry.type === 'piper') {
            const u = langPiperUrl(entry);
            onnxPath = u.onnx;
            tokensPath = u.tokens;
        } else {
            // coqui + cantonese (lustro csukuangfj, pliki luźno)
            const u = langVitsUrl(entry);
            onnxPath = u.onnx;
            tokensPath = u.tokens;
            if (u.json) jsonPath = u.json;
            if (entry.type === 'cantonese') {
                extra.push({ key: 'lexicon.txt', url: u.base + 'lexicon.txt' });
                extra.push({ key: 'rule.fst', url: u.base + 'rule.fst' });
            }
        }
        const onnx = await langFetchProgress(onnxPath, (got, total) => {
            langStatus('⬇ „' + label + '”: ' + fmtBytes(got) + (total ? ' / ' + fmtBytes(total) : '') + '…');
        });
        // ONNX = protobuf: pierwszy bajt 0x08; odrzucamy pomyłkowe pobrania (strony błędów).
        if (!(onnx && onnx.length > 1024 * 1024 && onnx[0] === 0x08)) {
            throw new Error('Pobrany plik nie wygląda na model ONNX (za mały lub zły format)');
        }
        const tokens = await langFetchProgress(tokensPath);
        if (!tokens || !tokens.length) throw new Error('Nie udało się pobrać tokens.txt');
        let json = null;
        if (jsonPath) {
            try { json = await langFetchProgress(jsonPath); } catch (e2) { /* opcjonalny */ }
        }
        // Pliki dodatkowe (lexicon.txt / rule.fst — kantoński); opcjonalne.
        const extraData = [];
        for (const ex of extra) {
            try { extraData.push({ key: ex.key, data: await langFetchProgress(ex.url) }); }
            catch (e3) { /* brak = lektor bez tego pliku reguł */ }
        }
        langStatus('💾 Zapisuję „' + label + '” w pamięci rozszerzenia…');
        await voicePut(voiceIdKey(entry.id, 'model.onnx'), onnx);
        await voicePut(voiceIdKey(entry.id, 'tokens.txt'), tokens);
        if (json) await voicePut(voiceIdKey(entry.id, 'model.onnx.json'), json); else await voiceDel(voiceIdKey(entry.id, 'model.onnx.json'));
        for (const ex of extraData) await voicePut(voiceIdKey(entry.id, ex.key), ex.data);
        const { list } = await loadVoiceState();
        const li = { id: entry.id, name: label, sizeOnnx: onnx.length, savedAt: Date.now(), type: entry.type, lang: entry.iso };
        saveList(list.filter((v) => v.id !== entry.id).concat([li]));
        activateVoice(li);
        langStatus('✓ „' + label + '” pobrany — aktywuję (silnik przeładowuje się, kilka–kilkanaście s).');
    } catch (e) {
        langStatus('⛔ Pobieranie nieudane: ' + ((e && e.message) || e));
    } finally {
        delete LANG_STORE.busy[entry.id];
        langRender();
        refreshCustomVoiceUi();
        loadVoiceState().then(({ list }) => { LANG_STORE.customList = list || []; langRender(); });
    }
}

function initLangStore() {
    const search = $('langSearch');
    const regionSel = $('langRegionFilter');
    const typeSel = $('langTypeFilter');
    if (!search || !regionSel || !typeSel) return;
    search.addEventListener('input', debounce(() => {
        LANG_STORE.filter.q = search.value || '';
        langRender();
    }, 250));
    regionSel.addEventListener('change', () => { LANG_STORE.filter.region = regionSel.value; langRender(); });
    typeSel.addEventListener('change', () => { LANG_STORE.filter.type = typeSel.value; langRender(); });
    // fetch nie istnieje w starym harnessie testowym (Node vm) — tam sklep pomijamy.
    if (typeof fetch !== 'function') {
        langStatus('Sklep wymaga nowszej przeglądarki (brak fetch).');
        return;
    }
    fetch(chrome.runtime.getURL(LANG_STORE.catalogPath))
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then((json) => {
            LANG_STORE.catalog = MATCHA_STORE.concat(MATCHA_F32_STORE, SUPERTONIC_STORE, langNormalizeCatalog(json));   // [AGENT-EXP] 2026-10-24: + F32   // [AGENT-EXP] 2026-10-24: głosy 🌐 na górze
            Promise.all([loadVoiceState(), matchaRefreshState().catch(() => {}), supertonicRefreshState().catch(() => {})]).then(([{ list }]) => {
                LANG_STORE.customList = list || [];
                langRender();
            });
        })
        .catch((e) => {
            langStatus('⛔ Nie udało się wczytać katalogu: ' + ((e && e.message) || e));
        });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}


// OPTIONS-PAGE: ikona ⚙️ otwiera stronę ustawień (src/options/options.html) w nowej karcie
document.addEventListener('DOMContentLoaded', () => {
    const b = document.getElementById('openOptionsBtn');
    if (b) b.addEventListener('click', () => { try { chrome.runtime.openOptionsPage(); } catch (e) { chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html') }); } });
});

// ===== Lowca Napisow (szukanie na zadanie) =====
// Przyciski #lowcaStartBtn/#lowcaStopBtn/#lowcaFreshBtn (popup.html) -> background LOWCA_*.
// [FIX 2026-11-22] Stan jest OSOBNO dla każdej karty (popup pyta o kartę, którą widzi). Po LOWCA_VERDICT_MS od startu
// popup mówi wprost: znalazł (plik / napisy na ekranie) albo nie — i podsuwa „↻ od startu” albo 🎯 Kreatora.
// Łowca szuka kilka sekund (ECO_HUNT_MS w lowca_napisow.js) — napisy łapią się od razu albo wcale.
const LOWCA_VERDICT_MS = 6000;
let lowcaTabId = null, lowcaLast = null, lowcaVerdictTimer = 0;
function plForm(n, one, few, many) {
    if (n === 1) return one;
    const r = n % 10, h = n % 100;
    return (r >= 2 && r <= 4 && (h < 12 || h > 14)) ? few : many;
}
function lowcaRender(state) {
    const startBtn = document.getElementById('lowcaStartBtn');
    const stopBtn = document.getElementById('lowcaStopBtn');
    const freshBtn = document.getElementById('lowcaFreshBtn');
    const status = document.getElementById('lowcaStatus');
    const box = document.getElementById('lowcaItems');
    if (!startBtn || !stopBtn || !status) return;
    if (state && state.tabId != null && lowcaTabId != null && state.tabId !== lowcaTabId) return;   // cudza karta
    lowcaLast = state || null;
    status.style.whiteSpace = 'pre-wrap';
    const st = state || {};
    const on = !!st.on;
    const started = st.startedAt || 0;
    const age = started ? Date.now() - started : Infinity;
    startBtn.style.display = '';
    stopBtn.style.display = on && age < LOWCA_VERDICT_MS ? '' : 'none';
    const items = Array.isArray(st.items) ? st.items : [];
    const n = st.containers || 0;
    const auto = st.auto && st.auto.n ? st.auto : null;
    const lines = [];
    // najważniejsze: PLIK napisów (z kwestiami) → potem pliki bez liczby kwestii → potem napisy na ekranie
    if (auto) {
        lines.push('✅ Znaleziono plik napisów (' + auto.n + ' ' + plForm(auto.n, 'kwestia', 'kwestie', 'kwestii') + (auto.lang ? ', ' + auto.lang : '') + ') — lektor czyta, 🤐 cenzor wycisza.');
        if (st.saved || auto.host) lines.push('📌 ' + (st.saved || auto.host) + ' zapamiętana — przy kolejnych filmach napisy złapią się same.');
    } else if (items.length) {
        lines.push('✅ Znaleziono ' + items.length + ' ' + plForm(items.length, 'plik', 'pliki', 'plików') + ' napisów (lista niżej) — lektor dostanie najlepszy.');
    }
    if (n) lines.push((auto || items.length ? '➕ ' : '✅ ') + 'Napisy na ekranie: ' + n + ' ' + plForm(n, 'miejsce', 'miejsca', 'miejsc') + ' zapisane w Kreatorze — lektor czyta z nich.');
    const found = !!(auto || items.length || n);
    if (!started && !found) {
        lines.push('Wstrzykuje skrypt do karty dopiero po kliknięciu — bez ciągłego nasłuchu.');
    } else if (!found && age < LOWCA_VERDICT_MS) {
        lines.push('🔍 ' + (st.fresh ? 'Szukam od startu strony…' : 'Szukam napisów…') + ' (kilka sekund)');
    } else if (!found) {
        lines.push(st.fresh
            ? '✕ Nic nie znaleziono, także od startu strony. Włącz napisy w odtwarzaczu i kliknij jeszcze raz — albo wskaż je 🎯 w Kreatorze napisów.'
            : '✕ Nic nie znaleziono. Spróbuj ↻ Szukaj od startu strony albo wskaż napisy 🎯 w Kreatorze napisów.');
    }
    status.textContent = lines.join('\n');
    // „↻ od startu” — gdy zwykłe szukanie nic nie dało (albo dało tylko napisy na ekranie bez pliku)
    if (freshBtn) freshBtn.style.display = (started && age >= LOWCA_VERDICT_MS && !auto && !items.length) ? '' : 'none';
    if (box) {
        if (items.length) {
            box.style.display = '';
            box.textContent = items.slice(-5).map((it) => {
                const lang = it.lang ? ' [' + it.lang + ']' : '';
                return '• ' + (it.label || 'napisy') + lang + (it.url ? ' · ' + it.url.slice(0, 80) : '');
            }).join('\n');
        } else {
            box.style.display = 'none';
            box.textContent = '';
        }
    }
    // werdykt bez czekania na kolejną wiadomość z tła
    clearTimeout(lowcaVerdictTimer);
    if (started && !found && age < LOWCA_VERDICT_MS) lowcaVerdictTimer = setTimeout(() => lowcaRender(lowcaLast), LOWCA_VERDICT_MS - age + 50);
}
function lowcaSend(action, busyMsg, extra) {
    const status = document.getElementById('lowcaStatus');
    if (status && busyMsg) status.textContent = busyMsg;
    try {
        chrome.runtime.sendMessage(Object.assign({ action, tabId: lowcaTabId }, extra || {}), (resp) => {
            void chrome.runtime.lastError;
            if (resp && resp.state) {
                lowcaRender(resp.state);
                if (resp.listed && status) status.textContent = '📋 ' + resp.listed + ' — dopisana do białej listy domen.\n' + status.textContent;   // [FIX 2026-11-02]
            } else if (resp && resp.ok === false && status) {
                status.textContent = '⛔ ' + (resp.error || 'nie udało się uruchomić (strona systemowa?)');
            }
        });
    } catch (e) {
        if (status) status.textContent = '⛔ ' + (e && e.message ? e.message : e);
    }
}
document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('lowcaStartBtn');
    const stopBtn = document.getElementById('lowcaStopBtn');
    const freshBtn = document.getElementById('lowcaFreshBtn');
    if (startBtn) startBtn.addEventListener('click', () => lowcaSend('LOWCA_START', '🔍 Wstrzykuję Łowcę do karty…'));
    if (stopBtn) stopBtn.addEventListener('click', () => lowcaSend('LOWCA_STOP', '⏹ Zatrzymuję…'));
    if (freshBtn) freshBtn.addEventListener('click', () => {
        freshBtn.style.display = 'none';
        lowcaSend('LOWCA_START_FRESH', '↻ Przeładowuję kartę z Łowcą od startu strony… (wynik zobaczysz po ponownym otwarciu popupu)');
    });
    // [CC] „Pokazuj GUI Łowcy” — ten sam klucz co na stronie ustawień (lowcaGui), działa od razu
    const guiChk = document.getElementById('lowcaGuiCheck');
    if (guiChk) {
        chrome.storage.local.get('lowcaGui', (r) => { guiChk.checked = !!(r && r.lowcaGui); });
        guiChk.addEventListener('change', () => chrome.storage.local.set({ lowcaGui: guiChk.checked }));
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const t = tabs && tabs[0];
        lowcaTabId = t && t.id != null ? t.id : null;
        if (startBtn && (!t || !/^https?:/.test(t.url || ''))) {
            startBtn.disabled = true;
            const status = document.getElementById('lowcaStatus');
            if (status) status.textContent = 'Otwórz stronę z filmem.';
            return;
        }
        lowcaSend('LOWCA_STATE');
    });
});
try {
    chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || msg.action !== 'LOWCA_STATUS' || !msg.state) return;
        lowcaRender(msg.state);
    });
} catch (e) { /* ignore */ }

// [AGENT-EXP] 2026-10-17: 🗣 Silnik mowy w popupie — ten sam klucz ttsEngine co na stronie Ustawienia
// (background dołącza go do każdej kwestii, więc zmiana działa od następnej kwestii). Kropka: czy serwer
// WebSocket odpowiada (próbne połączenie, zamykane od razu; sprawdzane co 4 s, póki popup jest otwarty).
(function () {
    const sel = document.getElementById('ttsEngineSelect');
    const dot = document.getElementById('ttsEngineDot');
    const txt = document.getElementById('ttsEngineText');
    if (!sel || !dot || !txt) return;
    const WS = { matcha: 'ws://127.0.0.1:9000', xtts: 'ws://127.0.0.1:8000', audio8: 'ws://127.0.0.1:9300', f5: 'ws://127.0.0.1:9400', pocket: 'ws://127.0.0.1:9200', omnivoice: 'ws://127.0.0.1:9100', kokoro: 'ws://127.0.0.1:9500', server: 'ws://127.0.0.1:9000' };   // [AGENT-EXP] f5: lektor Marek; 2026-10-27: kokoro; [FIX 2026-11-02] server = adres z pola
    // [FIX 2026-11-02] „Serwer lokalny — własny adres”: pole adresu (widoczne przy tym silniku) + kropka sprawdza wpisany adres
    const srvRow = document.getElementById('srvRow'), srvUrl = document.getElementById('serverUrlInput');
    const srvShow = () => { if (srvRow) srvRow.style.display = sel.value === 'server' ? '' : 'none'; };
    chrome.storage.local.get('serverUrl', (r) => { WS.server = (r && r.serverUrl) || 'ws://127.0.0.1:9000'; if (srvUrl) srvUrl.value = WS.server; });
    if (srvUrl) srvUrl.addEventListener('change', () => {
        const v = srvUrl.value.trim();
        if (!/^wss?:\/\/[^\s]+$/i.test(v)) { srvUrl.value = WS.server; return; }   // tylko ws:// albo wss://
        WS.server = v;
        chrome.storage.local.set({ serverUrl: v });
        probe();
    });
    let probeNo = 0;
    // [AGENT-EXP] 2026-10-24: Matcha z głosem 🌐 'web:…' liczy w rozszerzeniu — nie sprawdzaj serwera :9000.
    let matchaWeb = true;
    chrome.storage.local.get('matchaVoice', (r) => { matchaWeb = !(r && typeof r.matchaVoice === 'string' && r.matchaVoice) || /^web:/.test(r.matchaVoice); probe(true); });
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.matchaVoice) { matchaWeb = /^web:/.test(String(ch.matchaVoice.newValue || 'web:')); probe(); } });
    function show(color, label) { dot.style.background = color; txt.textContent = label; }
    function probe(quiet) {   // quiet: odświeżenie w tle — bez migania „sprawdzam…”
        const eng = sel.value;
        const my = ++probeNo;
        if (eng === 'supertonic') { if (!quiet) show('#9aa0c8', 'sprawdzam…'); return; }   // [VOX] kropkę ustawia blok Supertonic (na dole)
        if (eng === 'browser') { show('#34d399', 'bez serwera'); return; }   // [AGENT-EXP] 🗣
        if (eng === 'matcha' && matchaWeb) { show('#34d399', 'w przeglądarce — bez serwera'); return; }   // [AGENT-EXP] 2026-10-24
        if (!WS[eng]) { show('#34d399', 'wbudowany'); return; }
        if (!quiet) show('#fcd34d', 'sprawdzam…');
        let ws = null, done = false;
        const finish = (ok) => {
            if (done || my !== probeNo) return;
            done = true;
            clearTimeout(tm);
            try { if (ws) ws.close(); } catch (e) { /* ignore */ }
            show(ok ? '#34d399' : '#f87171', ok ? 'serwer działa' : 'serwer nie odpowiada');
        };
        const tm = setTimeout(() => finish(false), 2000);
        try {
            ws = new WebSocket(WS[eng]);
            ws.onopen = () => finish(true);
            ws.onerror = () => finish(false);
            ws.onclose = () => finish(false);
        } catch (e) { finish(false); }
    }
    chrome.storage.local.get('ttsEngine', (r) => {
        const v = r && r.ttsEngine;
        sel.value = ['sherpa', 'matcha', 'xtts', 'audio8', 'f5', 'pocket', 'omnivoice', 'kokoro', 'server', 'supertonic', 'browser'].indexOf(v) >= 0 ? v : 'matcha';   // [AGENT-EXP] 2026-10-24
        srvShow();
        probe();
    });
    sel.addEventListener('change', () => { chrome.storage.local.set({ ttsEngine: sel.value }); srvShow(); probe(); });
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch.ttsEngine && ch.ttsEngine.newValue && ch.ttsEngine.newValue !== sel.value) { sel.value = ch.ttsEngine.newValue; srvShow(); probe(); }
    });
    setInterval(() => { if (WS[sel.value] && !(sel.value === 'matcha' && matchaWeb)) probe(true); }, 4000);   // [AGENT-EXP] 2026-10-24
})();

// [AGENT-EXP] 2026-10-17: Głos dla wybranego silnika — przeniesione ze strony Ustawienia (sekcja „🎙 Silnik lektora”
// usunięta). Te same klucze storage (tts2Voice, pocketVoice, omnivoiceVoice, audio8Voice) — background/offscreen bez zmian.
// Nowy głos: dopisz go tutaj (i w VOICES serwera).
(function () {
    const eng = document.getElementById('ttsEngineSelect');
    const row = document.getElementById('ttsVoiceRow');
    const lab = document.getElementById('ttsVoiceLabel');
    const sel = document.getElementById('ttsVoiceSelect');
    const txt = document.getElementById('ttsVoiceText');
    if (!eng || !row || !lab || !sel || !txt) return;
    const TTS2 = [["", "Głos wybrany przy starcie serwera"], ["1_2026-09-08 09-04-34_(Vocals)_przyciety.wav", "Vocals — próbka 1"], ["2._Alek_Pawlikowski_prezentacja_przyciety.wav", "Alek Pawlikowski — prezentacja"], ["2._Jacek_-_prezentacja_przyciety.wav", "Jacek — prezentacja"], ["4._JACEK_BRZOSTYŃSKI_interpretacje_tekstu_przyciety.wav", "Jacek Brzostyński — interpretacje"], ["5._JACEK_BRZOSTYŃSKI_lektor_do_video_przyciety.wav", "Jacek Brzostyński — lektor do wideo"], ["Ferenc_1_przyciety.wav", "Ferenc"], ["lukasz-3_przyciety.wav", "Łukasz"], ["Marcin_demo1_przyciety.wav", "Marcin"], ["Piotr_2_1-1_przyciety.wav", "Piotr"], ["pl_LU.KO_._male_lektoring_przyciety.wav", "Męski lektoring PL"], ["zapowiedź_Jacek_Brzostynski-1_przyciety.wav", "Jacek Brzostyński — zapowiedź"]];
    const POCKET = [["ref", "Głos referencyjny (z repozytorium)"], ["mojglos", "Mój własny głos"], ["brzustynski", "Jacek Brzostyński"], ["brzustynski4", "Jacek Brzostyński (próbka 4)"], ["brzustynski5", "Jacek Brzostyński (próbka 5)"], ["jacek2", "Jacek (próbka 2)"], ["alekpawlikowski", "Alek Pawlikowski"], ["marcin", "Marcin"], ["piotr", "Piotr"], ["lukasz", "Łukasz"], ["ferenc", "Ferenc"], ["luko", "Lektor LU.KO"], ["probka2026", "Próbka 2026"], ["probka202609", "Próbka 2026-09"]];
    const OMNI = [["glos:moj_glos", "Mój głos (klon z nagrania)"], ["male, young adult, moderate pitch", "Męski · młody · neutralny"], ["male, middle-aged, low pitch", "Męski · dojrzały · niski"], ["male, middle-aged, moderate pitch", "Męski · dojrzały · neutralny"], ["male, elderly, moderate pitch", "Męski · starszy · neutralny"], ["female, young adult, moderate pitch", "Żeński · młody · neutralny"], ["female, middle-aged, moderate pitch", "Żeński · dojrzały · neutralny"], ["female, middle-aged, low pitch", "Żeński · dojrzały · niski"], ["female, young adult, high pitch", "Żeński · młody · wysoki"], ["female, elderly, moderate pitch", "Żeński · starszy · neutralny"], ["child, moderate pitch", "Dziecko"], ["teenager, moderate pitch", "Nastolatek"], ["male, young adult, moderate pitch, whisper", "Męski · szept"], ["male, young adult, moderate pitch, british accent", "Męski · brytyjski akcent"], ["female, young adult, moderate pitch, american accent", "Żeński · amerykański akcent"], ["male, young adult, very high pitch", "Męski · bardzo wysoki (test)"], ["", "Losowy (dobiera model)"]];
    // [AGENT-EXP] 2026-10-27: głosy Kokoro = silnik.VOICES (tts maja\kokoro). Po polsku czyta tylko pm_mateusz.
    const KOKORO = [["pm_mateusz", "Mateusz — polski (męski)"], ["af_heart", "af_heart · angielski US · kobieta"], ["af_alloy", "af_alloy · angielski US · kobieta"], ["af_aoede", "af_aoede · angielski US · kobieta"], ["af_bella", "af_bella · angielski US · kobieta"], ["af_jessica", "af_jessica · angielski US · kobieta"], ["af_kore", "af_kore · angielski US · kobieta"], ["af_nicole", "af_nicole · angielski US · kobieta"], ["af_nova", "af_nova · angielski US · kobieta"], ["af_river", "af_river · angielski US · kobieta"], ["af_sarah", "af_sarah · angielski US · kobieta"], ["af_sky", "af_sky · angielski US · kobieta"], ["am_adam", "am_adam · angielski US · mężczyzna"], ["am_echo", "am_echo · angielski US · mężczyzna"], ["am_eric", "am_eric · angielski US · mężczyzna"], ["am_fenrir", "am_fenrir · angielski US · mężczyzna"], ["am_liam", "am_liam · angielski US · mężczyzna"], ["am_michael", "am_michael · angielski US · mężczyzna"], ["am_onyx", "am_onyx · angielski US · mężczyzna"], ["am_puck", "am_puck · angielski US · mężczyzna"], ["am_santa", "am_santa · angielski US · mężczyzna"], ["bf_alice", "bf_alice · angielski UK · kobieta"], ["bf_emma", "bf_emma · angielski UK · kobieta"], ["bf_isabella", "bf_isabella · angielski UK · kobieta"], ["bf_lily", "bf_lily · angielski UK · kobieta"], ["bm_daniel", "bm_daniel · angielski UK · mężczyzna"], ["bm_fable", "bm_fable · angielski UK · mężczyzna"], ["bm_george", "bm_george · angielski UK · mężczyzna"], ["bm_lewis", "bm_lewis · angielski UK · mężczyzna"], ["ef_dora", "ef_dora · hiszpański · kobieta"], ["em_alex", "em_alex · hiszpański · mężczyzna"], ["em_santa", "em_santa · hiszpański · mężczyzna"], ["ff_siwis", "ff_siwis · francuski · kobieta"], ["hf_alpha", "hf_alpha · hindi · kobieta"], ["hf_beta", "hf_beta · hindi · kobieta"], ["hm_omega", "hm_omega · hindi · mężczyzna"], ["hm_psi", "hm_psi · hindi · mężczyzna"], ["if_sara", "if_sara · włoski · kobieta"], ["im_nicola", "im_nicola · włoski · mężczyzna"], ["pf_dora", "pf_dora · portugalski · kobieta"], ["pm_alex", "pm_alex · portugalski · mężczyzna"], ["pm_santa", "pm_santa · portugalski · mężczyzna"]];
    // [AGENT-EXP] 2026-10-17: głosy Matcha = VOICES w serwer_matcha.py (★ = nowe, naturalne; „Stary” = poprzedni, robotyczny model).
    // [AGENT-EXP] 2026-10-24: ⚡ Matcha-TTS-PL-Edge-v2 (glosy_edge_v2 w serwerze) — te same głosy, ~3× szybciej na CPU.
    // [AGENT-EXP] 2026-10-24: 🌐 'web:…' = Matcha-TTS-PL-Edge-v2 w samym rozszerzeniu (matcha_web/), bez serwera.
    const MATCHA = [["web:male_voxcpm_2:elegancki", "🌐 Elegancki męski — w przeglądarce"], ["web:female_voxcpm_2:elegancki", "🌐 Elegancka żeńska — w przeglądarce"], ["web:male_voxcpm_2", "🌐 Męski — naturalny, w przeglądarce"], ["web:female_voxcpm_2", "🌐 Żeński — naturalny, w przeglądarce"], ["web:female_voxcpm_3", "🌐 Żeński 3 — ciepły, w przeglądarce (nowy)"], ["web:male_voxcpm_3", "🌐 Męski 3 — niższy, w przeglądarce (nowy)"], ["web:female_voxcpm_3:elegancki", "🌐 Elegancka żeńska 3 — w przeglądarce (nowa)"], ["web:male_voxcpm_3:elegancki", "🌐 Elegancki męski 3 — w przeglądarce (nowy)"], ["web:male_voxcpm_3_pelny", "🌐 Męski 3 pełny — 88 MB, w przeglądarce"], ["web:female_voxcpm_3_pelny", "🌐 Żeński 3 pełny — 88 MB, w przeglądarce"], ["web:male_voxcpm_3_pelny:elegancki", "🌐 Elegancki męski 3 pełny — 88 MB"], ["web:female_voxcpm_3_pelny:elegancki", "🌐 Elegancka żeńska 3 pełna — 88 MB"], ["web:male_voxcpm_1", "🌐 Męski 1 — duży model, w przeglądarce (wolniejszy)"], ["web:female_voxcpm_1", "🌐 Żeński 1 — duży model, w przeglądarce (wolniejszy)"], ["web:male_voxcpm_1:elegancki", "🌐 Elegancki męski 1 — duży model (wolniejszy)"], ["web:female_voxcpm_1:elegancki", "🌐 Elegancka żeńska 1 — duży model (wolniejsza)"], ["edge:male_voxcpm_2:elegancki", "⚡ Elegancki męski 2 Edge (szybki)"], ["edge:female_voxcpm_2:elegancki", "⚡ Elegancka żeńska 2 Edge (szybka)"], ["edge:male_voxcpm_2", "⚡ Męski 2 Edge — naturalny (szybki)"], ["edge:female_voxcpm_2", "⚡ Żeński 2 Edge — naturalny (szybki)"], ["v2:male_voxcpm_1:elegancki", "★ Elegancki męski (spokojnie)"],["v2:male_voxcpm_2:elegancki", "★ Elegancki męski 2 (spokojnie)"], ["v2:female_voxcpm_2:elegancki", "★ Elegancka żeńska (spokojnie)"], ["v2:male_voxcpm_2", "★ Męski 2 — naturalny (żywy)"], ["v2:female_voxcpm_2", "★ Żeński 2 — naturalny (żywy)"], ["v2:male_voxcpm_1", "★ Męski 1 — naturalny (żywy)"], ["v2:female_voxcpm_1", "★ Żeński 1 — naturalny (żywy)"], ["synthetic", "Stary — Mieszanka 1"], ["synthetic2", "Stary — Mieszanka 2"], ["synthetic3", "Stary — Mieszanka 3"], ["synthetic4", "Stary — Mieszanka 4 (żeńska)"], ["synthetic5", "Stary — Mieszanka 5"], ["0", "Stary — Bartosz Bielenia (M)"], ["1", "Stary — Katarzyna Faszczewska (Ż)"], ["3", "Stary — Bartosz Głogowski (M)"], ["6", "Stary — Piotr Kopa (M)"], ["8", "Stary — Andrzej Seweryn (M)"], ["0.5*6+0.5*3", "Stary — Mieszanka własna (Kopa+Głogowski)"]];
    const CFG = {
        matcha: { k: 'matchaVoice', def: 'web:male_voxcpm_2:elegancki', label: 'Głos Matcha-TTS-PL', list: MATCHA },
        xtts: { k: 'tts2Voice', def: '', label: 'Próbka głosu (folder tts2\\probki glosu)', list: TTS2 },
        f5: { k: 'tts2Voice', def: '', label: 'Próbka głosu (lektormarekf5tts\\probki)', list: TTS2 },
        pocket: { k: 'pocketVoice', def: 'ref', label: 'Głos Pocket-TTS-PL', list: POCKET },
        omnivoice: { k: 'omnivoiceVoice', def: 'male, young adult, moderate pitch', label: 'Głos OmniVoice', list: OMNI },
        kokoro: { k: 'kokoroVoice', def: 'pm_mateusz', label: 'Głos Kokoro', list: KOKORO },   // [AGENT-EXP] 2026-10-27
        audio8: { k: 'audio8Voice', def: 'default', label: 'Głos Audio8 (ID katalogu w voices\\)', text: true },
        server: { k: 'serverVoice', def: '', label: 'Głos na serwerze (ID; puste = domyślny serwera)', text: true, allowEmpty: true },   // [FIX 2026-11-02]
        // [VOX] 2026-10-20: Supertonic 3 — 4 głosy wbudowane w model (VoxNemesis)
        supertonic: { k: 'supertonicVoice', def: 'Supertonic M1', label: 'Głos Supertonic', list: [['Supertonic M1', 'Męski 1'], ['Supertonic M2', 'Męski 2'], ['Supertonic F1', 'Żeński 1'], ['Supertonic F2', 'Żeński 2']] },
        // [AGENT-EXP] 2026-10-21: 🗣 głosy przeglądarki — lista z dokumentu lektora (BROWSER_TTS_VOICES), '' = automatycznie
        browser: { k: 'browserVoice', def: '', label: 'Głos przeglądarki', dyn: true, list: null }
    };
    let cur = null;
    function render() {
        cur = CFG[eng.value] || null;
        if (!cur) { row.style.display = 'none'; return; }
        row.style.display = '';
        lab.textContent = cur.label;
        sel.style.display = cur.text ? 'none' : '';
        txt.style.display = cur.text ? '' : 'none';
        const c = cur;
        if (c.dyn && !c.list) {   // [AGENT-EXP] 🗣 lista głosów przychodzi z offscreen
            c.list = [['', 'Automatycznie — wczytuję głosy…']];
            chrome.runtime.sendMessage({ action: 'BROWSER_TTS_VOICES' }, (r) => {
                void chrome.runtime.lastError;
                const vs = (r && r.voices) || [];
                c.list = [['', 'Automatycznie' + (r && r.selected ? ' (' + r.selected + ')' : ' (najlepszy)')]]
                    .concat(vs.map((v) => [v.name, v.name + (v.local ? ' · lokalny' : ' · sieciowy')]));
                if (cur === c) render();
            });
        }
        chrome.storage.local.get([c.k, 'matchaImported'], (r) => {
            if (cur !== c) return;
            const v = r && typeof r[c.k] === 'string' ? r[c.k] : c.def;
            if (c.text) { txt.value = v || c.def; return; }
            sel.innerHTML = '';
            let items = c.list;
            if (c === CFG.matcha) {   // [AGENT-EXP] 2026-11-25: + głosy Matcha wczytane z folderu (spoza listy)
                const extra = ((r && r.matchaImported) || []).map((x) => x && x.mv).filter((mv) => mv && !items.some(([val]) => val === 'web:' + mv));
                if (extra.length) items = items.slice(0, 1).concat(extra.map((mv) => ['web:' + mv, '🌐 ' + mv + ' — z folderu, w przeglądarce']), items.slice(1));
            }
            items.forEach(([val, t]) => { const o = document.createElement('option'); o.value = val; o.textContent = t; sel.appendChild(o); });
            if (!items.some(([val]) => val === v)) {   // głos spoza listy (np. dopisany ręcznie) — pokaż, nie gub
                const o = document.createElement('option'); o.value = v; o.textContent = v || '(pusty)'; sel.appendChild(o);
            }
            sel.value = v;
        });
    }
    sel.addEventListener('change', () => { if (cur && !cur.text) chrome.storage.local.set({ [cur.k]: sel.value }); });
    txt.addEventListener('change', () => { if (cur && cur.text) chrome.storage.local.set({ [cur.k]: cur.allowEmpty ? txt.value.trim() : (txt.value.trim() || cur.def) }); });   // [FIX 2026-11-02] allowEmpty
    eng.addEventListener('change', render);
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && (ch.ttsEngine || ch.matchaImported || (cur && ch[cur.k]))) setTimeout(render, 0);   // [AGENT-EXP] 2026-11-25: + matchaImported
    });
    chrome.storage.local.get('ttsEngine', () => setTimeout(render, 0));   // po ustawieniu eng.value przez blok wyżej
})();

// [AGENT-EXP] 2026-10-17: checkbox „Buforuj przy zatrzymanym filmie” (preloadWhilePaused, domyślnie włączony).
(function () {
    const chk = document.getElementById('bufPauzaCheck');
    if (!chk) return;
    chrome.storage.local.get('preloadWhilePaused', (r) => { chk.checked = !(r && r.preloadWhilePaused === false); });
    chk.addEventListener('change', () => chrome.storage.local.set({ preloadWhilePaused: chk.checked }));
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch.preloadWhilePaused) chk.checked = ch.preloadWhilePaused.newValue !== false;
    });
})();

// [FIX 2026-11-02] 🔉 checkbox „Ściszaj film tylko, gdy lektor mówi” (duckWhileSpeaking, od 3.7.1 domyślnie wł.)
(function () {
    const chk = document.getElementById('duckWhileCheck');
    if (!chk) return;
    chrome.storage.local.get('duckWhileSpeaking', (r) => { chk.checked = !r || r.duckWhileSpeaking !== false; });   // [FIX 2026-11-22] domyślnie wł.
    chk.addEventListener('change', () => {
        const o = { duckWhileSpeaking: chk.checked };
        if (chk.checked) o.duckInstant = false;   // [FIX 2026-11-22b] tryby się wykluczają
        chrome.storage.local.set(o);
    });
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.duckWhileSpeaking) chk.checked = !!ch.duckWhileSpeaking.newValue; });
})();

// [FIX 2026-11-22] 🔉 checkbox „Ściszaj i przywracaj natychmiast” (duckInstant, domyślnie wył.) — film cichnie od razu, gdy lektor
// zaczyna mówić, i wraca od razu, gdy skończy (bez płynnego przejścia ~0,25 s).
(function () {
    const chk = document.getElementById('duckInstantCheck');
    if (!chk) return;
    chrome.storage.local.get('duckInstant', (r) => { chk.checked = !!(r && r.duckInstant); });
    chk.addEventListener('change', () => {
        // [FIX 2026-11-22b] dwa tryby się wykluczają: „natychmiast” odznacza „płynnie” (i odwrotnie)
        const o = { duckInstant: chk.checked };
        if (chk.checked) o.duckWhileSpeaking = false;
        chrome.storage.local.set(o);
    });
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.duckInstant) chk.checked = !!ch.duckInstant.newValue; });
})();

// [AGENT-EXP] 2026-10-26: checkbox „Auto-nadrabianie” (autoCatchup, domyślnie włączony — jak w Ustawieniach).
(function () {
    const chk = document.getElementById('autoCatchupCheck');
    if (!chk) return;
    chrome.storage.local.get('autoCatchup', (r) => { chk.checked = !(r && r.autoCatchup === false); });
    chk.addEventListener('change', () => chrome.storage.local.set({ autoCatchup: chk.checked }));
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch.autoCatchup) chk.checked = ch.autoCatchup.newValue !== false;
    });
})();

// [AGENT-EXP] 2026-10-17: „💾 Zapisz bufor filmu” — kwestie z RAM aktywnej karty → ZIP w Pobranych.
(function () {
    const btn = document.getElementById('saveBufferBtn');
    const info = document.getElementById('saveBufferInfo');
    if (!btn || !info) return;
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        info.textContent = 'zapisuję…';
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const r = await chrome.runtime.sendMessage({ action: 'TTS_SAVE_BUFFER', tabId: tab && tab.id, title: tab && tab.title });
            info.textContent = r && r.ok
                ? '✔ ' + r.count + ' kwestii, ' + (r.sizeBytes / 1048576).toFixed(1) + ' MB → Pobrane'
                : '✖ ' + ((r && r.error) || 'nie udało się');
        } catch (e) {
            info.textContent = '✖ ' + ((e && e.message) || e);
        }
        btn.disabled = false;
    });
})();

// [AGENT-EXP] 2026-10-17: checkbox „Buforuj w tle (inna karta)” (bufferInBackground, domyślnie włączony).
// Włączony: karta z filmem dostaje autoDiscardable=false — Chrome (Oszczędzanie pamięci) jej nie usypia.
(function () {
    const chk = document.getElementById('bufTloCheck');
    if (!chk) return;
    async function chronKarte(on) {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab && tab.id != null && /^https?:/.test(tab.url || tab.pendingUrl || 'https:')) {
                await chrome.tabs.update(tab.id, { autoDiscardable: !on });
            }
        } catch (e) { /* np. strona chrome:// — pomijamy */ }
    }
    chrome.storage.local.get('bufferInBackground', (r) => {
        chk.checked = !(r && r.bufferInBackground === false);
        if (chk.checked) chronKarte(true);
    });
    chk.addEventListener('change', () => {
        chrome.storage.local.set({ bufferInBackground: chk.checked });
        chronKarte(chk.checked);
    });
})();

// [VOX] 2026-10-20: zakładki popupu (jak w VoxNemesis). Ostatnio otwarta zakładka wraca przy następnym otwarciu.
(function () {
    const tabs = Array.from(document.querySelectorAll('.tabs .tab'));
    const panes = Array.from(document.querySelectorAll('.pane[data-pane]'));
    if (!tabs.length || !panes.length) return;
    function show(name) {
        if (!panes.some((p) => p.dataset.pane === name)) name = 'lektor';
        // [AGENT-EXP] 2026-10-26: 🧩 zakładka schowana przez układ modułów (pusta) → pierwsza widoczna
        const want = tabs.find((t) => t.dataset.tab === name);
        if (!want || want.hidden) { const first = tabs.find((t) => !t.hidden); if (first) name = first.dataset.tab; }
        tabs.forEach((t) => {
            const on = t.dataset.tab === name;
            t.classList.toggle('active', on);
            t.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        panes.forEach((p) => { p.hidden = p.dataset.pane !== name; });
        try { localStorage.setItem('lektorTab', name); } catch (e) { /* ignore */ }
    }
    tabs.forEach((t) => t.addEventListener('click', () => { show(t.dataset.tab); window.scrollTo(0, 0); }));
    let last = 'lektor';
    try { last = localStorage.getItem('lektorTab') || 'lektor'; } catch (e) { /* ignore */ }
    show(last);
    window.__mlTabShow = show;   // [AGENT-EXP] 2026-10-26: popup_layout.js (zakładka zniknęła / przeciąganie nad zakładką)
    // dodatkowe przyciski „⚙️ Wszystkie opcje”
    document.querySelectorAll('[data-open-options]').forEach((b) => b.addEventListener('click', () => {
        try { chrome.runtime.openOptionsPage(); } catch (e) { chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html') }); }
    }));
})();

// [VOX] 2026-10-20: Supertonic (silnik z VoxNemesis) — sprzęt CPU / GPU, jakość i stan silnika.
// Te same klucze co na stronie Ustawień (engineBackend, supertonicSteps); background przekazuje je do offscreen.
(function () {
    const eng = document.getElementById('ttsEngineSelect');
    const rows = document.getElementById('stRows');
    const backendSel = document.getElementById('stBackend');
    const stepsSel = document.getElementById('stSteps');
    const statusEl = document.getElementById('stStatus');
    const dot = document.getElementById('ttsEngineDot');
    const dotTxt = document.getElementById('ttsEngineText');
    const hint = document.getElementById('ttsEngineHint');
    if (!eng || !rows || !backendSel || !stepsSel || !statusEl) return;
    const hintDefault = hint ? hint.textContent : '';
    const HINT_ST = 'Głos liczony na tym komputerze — bez serwera. Za pierwszym razem model pobiera się z Hugging Face (kilkaset MB), potem działa offline. GPU jest kilka–kilkanaście razy szybsze niż CPU.';
    const BACKEND_NAME = { cpu: 'CPU', igpu: 'GPU zintegrowana', gpu: 'GPU dedykowana' };
    let timer = null;

    function setDot(color, label) {
        if (eng.value !== 'supertonic' || !dot || !dotTxt) return;
        dot.style.background = color;
        dotTxt.textContent = label;
    }
    function setStatus(text, cls) {
        statusEl.textContent = text;
        statusEl.className = 'st-status' + (cls ? ' ' + cls : '');
    }
    function render(r) {
        const want = BACKEND_NAME[backendSel.value] || 'CPU';
        if (!r || !r.running || !r.loaded) {
            setDot('#9aa0c8', 'czeka');
            setStatus('Silnik: ' + want + ' · uruchomi się przy pierwszej kwestii (albo kliknij ▶ Test w tej zakładce).'
                + (r && r.running && r.isolated === false ? '\n⚠ Brak izolacji (COOP/COEP) — CPU liczy na 1 wątku.' : ''));
            return;
        }
        const d = r.download || {};
        if (d.phase === 'error' || (r.lastError && !r.slotsReady)) {
            setDot('#f87171', 'błąd');
            setStatus('⛔ ' + (d.error || r.lastError), 'err');
            return;
        }
        if (d.phase === 'download' || d.phase === 'check') {
            setDot('#fcd34d', 'model ' + (d.done || 0) + '/' + (d.total || 6));
            setStatus('⬇ Pobieram model Supertonic 3 z Hugging Face: ' + (d.done || 0) + '/' + (d.total || 6) + ' plików'
                + (d.file ? ' (' + d.file + ')' : '') + '. Tylko za pierwszym razem.', 'warn');
            return;
        }
        if (!r.slotsReady) {
            setDot('#fcd34d', r.starting ? 'start…' : 'czeka');
            setStatus(r.starting ? '⏳ Uruchamiam silnik (' + want + ')…' : 'Silnik: ' + want + ' · czeka na pierwszą kwestię.', r.starting ? 'warn' : '');
            return;
        }
        let line;
        if (r.provider === 'webgpu') {
            line = '✓ GPU (WebGPU)' + (r.gpuName ? ' · ' + r.gpuName : '');
            setDot('#34d399', 'GPU' + (r.gpuName ? ' · ' + String(r.gpuName).split(' ')[0] : ''));
        } else {
            line = '✓ CPU · ' + r.slotsReady + '/' + r.slotsMax + ' worker(y) × ' + r.threads + ' wątki';
            setDot('#34d399', 'CPU ×' + r.slotsReady);
        }
        if (r.queued) line += ' · w kolejce: ' + r.queued;
        if (r.gpuFellBack && r.gpuError) line += '\n⚠ GPU niedostępne → CPU: ' + r.gpuError;
        else if (r.backend === 'gpu' && r.provider === 'webgpu' && r.gpuName && !/nvidia/i.test(r.gpuName)) {
            line += '\n🛈 Masz NVIDIA, a Chrome dał inną kartę? Instrukcja „NVIDIA na stałe” na stronie Ustawień.';
        }
        if (r.isolated === false && r.provider !== 'webgpu') line += '\n⚠ Brak izolacji (COOP/COEP) — CPU liczy na 1 wątku.';
        setStatus(line, (r.gpuFellBack ? 'warn' : 'ok'));
    }
    function poll() {
        if (eng.value !== 'supertonic') return;
        try {
            chrome.runtime.sendMessage({ action: 'SUPERTONIC_STATUS' }, (r) => { void chrome.runtime.lastError; render(r); });
        } catch (e) { render(null); }
    }
    function sync() {
        const on = eng.value === 'supertonic';
        rows.style.display = on ? '' : 'none';
        if (hint) hint.textContent = on ? HINT_ST : hintDefault;
        clearInterval(timer);
        timer = null;
        if (on) { poll(); timer = setInterval(poll, 2000); }
    }
    chrome.storage.local.get(['engineBackend', 'supertonicSteps'], (r) => {
        const b = r && r.engineBackend;
        backendSel.value = (b === 'gpu' || b === 'igpu') ? b : 'cpu';
        const st = String((r && r.supertonicSteps) || 4);
        stepsSel.value = Array.from(stepsSel.options).some((o) => o.value === st) ? st : '4';
    });
    backendSel.addEventListener('change', () => { chrome.storage.local.set({ engineBackend: backendSel.value }); setTimeout(poll, 300); });
    stepsSel.addEventListener('change', () => chrome.storage.local.set({ supertonicSteps: Number(stepsSel.value) }));
    eng.addEventListener('change', () => setTimeout(sync, 0));
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area !== 'local') return;
        if (ch.engineBackend) backendSel.value = ch.engineBackend.newValue || 'cpu';
        if (ch.supertonicSteps) stepsSel.value = String(ch.supertonicSteps.newValue || 4);
        if (ch.ttsEngine) setTimeout(sync, 0);
    });
    chrome.storage.local.get('ttsEngine', () => setTimeout(sync, 0));   // po ustawieniu eng.value przez blok „Silnik mowy”
})();

// [FIX 2026-11-02] „Czytam z: …” — skąd lektor bierze tekst na aktywnej karcie (odpowiada ramka, która ma źródło:
// wspólny harmonogram assets/lektor_scheduler.js, czytanie na żywo, OCR). Odświeżane co 2 s, póki popup jest otwarty.
(function () {
    const line = document.getElementById('lektorSourceLine');
    if (!line) return;
    const ask = () => chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab || tab.id == null) return;
        chrome.tabs.sendMessage(tab.id, { action: 'LEKTOR_SOURCE' }, (r) => {
            void chrome.runtime.lastError;
            if (!r || !r.source) { line.style.display = 'none'; return; }
            line.textContent = '📍 Czytam z: ' + r.source + (r.cues ? ' (' + r.cues + ' kwestii)' : '');
            line.style.display = '';
        });
    });
    ask();
    setInterval(ask, 2000);
})();

// [FIX 2026-11-02] 📋 „Tylko domeny z listy” (domainListsOn, domyślnie WŁ.) — przełącznik, stan aktywnej karty
// i „➕ Dodaj tę stronę”. Zasady list: assets/domain_lists.js (ten sam kod co w skryptach stron i w tle).
(function () {
    const DL = window.__LektorDomains;
    const chk = document.getElementById('domainListsCheck'), line = document.getElementById('domainStateLine');
    const addBtn = document.getElementById('domainAddBtn'), editBtn = document.getElementById('domainEditBtn');
    if (!DL || !chk || !line || !addBtn) return;
    let host = '';
    function render(o) {
        o = o || {};
        chk.checked = o.domainListsOn !== false;
        addBtn.style.display = 'none';
        const st = DL.state(host, '', o);
        if (st.why === 'off') line.textContent = '🌍 Wyłączone — lektor działa na każdej stronie, na której się uruchomi (listy czekają nieużywane).';
        else if (st.why === 'empty') line.textContent = '🌍 Biała lista jest pusta — lektor działa wszędzie.';
        else if (!host) line.textContent = 'Lektor działa tylko na stronach z białej listy.';
        else if (st.why === 'black') line.textContent = '⛔ ' + host + ' — na czarnej liście: lektor tu milczy.';
        else if (st.why === 'white') line.textContent = '✅ ' + host + ' — na białej liście: lektor działa.';
        else { line.textContent = '💤 ' + host + ' — nie ma na białej liście: lektor tu śpi i nie zużywa procesora.'; addBtn.style.display = ''; }
    }
    const refresh = () => chrome.storage.local.get(DL.LIST_KEYS, render);
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => { host = DL.hostOf(tabs && tabs[0] && tabs[0].url); refresh(); });
    chk.addEventListener('change', () => chrome.storage.local.set({ domainListsOn: chk.checked }));
    addBtn.addEventListener('click', () => chrome.storage.local.get('domainWhitelist', (r) => {
        const text = DL.addHost(r && r.domainWhitelist, host);
        if (text) chrome.storage.local.set({ domainWhitelist: text });   // otwarta karta budzi lektora sama (options_hooks.js)
    }));
    if (editBtn) editBtn.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#domeny') }));
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && DL.LIST_KEYS.some((k) => ch[k])) refresh(); });
})();

// [AGENT-EXP] 2026-11-02: lista „Matcha 🌐 — wariant” usunięta — wariant (matchaWebTryb) przełącza „Włącz” w „Języki świata”.

// [FIX 2026-11-10] 🧪 Kreator napisów W POPUPIE — „wskaż napisy na ekranie” bez wchodzenia w Ustawienia.
// [FIX 2026-11-22] Karta odchudzona do tego, czego nie ma gdzie indziej:
//   • 🎯 Wskaż napisy myszką — uruchamia wskazywanie na karcie z filmem (tło: KREATOR_PICK_SAVE). Wybór zapisuje
//     TŁO, bo popup zamyka się w chwili kliknięcia w stronę — stąd potwierdzenie na stronie (toast KREATOR_SAVED).
//   • lista zapisanych selektorów tej strony: klik w selektor = test (podświetla trafienia), ✕ = usuń.
//     Napisy z RAMKI odtwarzacza są zapisane pod domeną ramki (tam czytają lektor i cenzor) — tło zapamiętuje,
//     z jakich ramek była dana strona (kreatorFrameHosts[top]), a popup pokazuje je razem ze stroną.
//     Dawniej tło kopiowało selektor ramki pod domenę strony — tam nikt go nie sprawdzał, więc mógł łapać
//     przypadkowe teksty. Stare kopie popup pokazuje raz (przy ramce), a ✕ usuwa obie.
//   • przełącznik „używaj własnych źródeł” — widoczny dopiero, gdy jest co przełączać,
//   • ⚙ ręczny selektor i wszystkie domeny — w Ustawieniach (usunięty zdublowany „🔍 automat”: jest w „Całe napisy”).
(function () {
    const pickBtn = $('kreatorPickBtn'), statusEl = $('kreatorStatus'), pill = $('kreatorPill');
    const chk = $('kreatorOn'), chkRow = $('kreatorOnRow'), listBox = $('kreatorList'), moreBtn = $('kreatorMoreBtn');
    if (!pickBtn || !statusEl || !listBox) return;   // starszy HTML — modułu nie ma, nic nie robimy

    const KREATOR_FILES = ['assets/i18n_en.js', 'assets/i18n.js', 'assets/domain_lists.js', 'assets/options_hooks.js'];
    const LAST_MS = 12 * 3600 * 1000;   // „ostatnio zapisano” pokazujemy przez pół dnia
    let host = '';        // domena strony z paska adresu (ta, którą widzi użytkownik)
    let tabId = null;
    let src = {}, on = {}, frames = {};   // customSources / customSourcesOn / kreatorFrameHosts
    let lastPick = null;     // { host, selector, at, tabId, ok? } — zapis z tła (KREATOR_PICK_SAVE)

    const hostOf = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '').toLowerCase() : ''; } catch (e) { return ''; } };
    const obj = (v) => (v && typeof v === 'object') ? v : {};
    const listOf = (h) => (Array.isArray(src[h]) ? src[h] : []);
    function setStatus(t) { statusEl.textContent = t; }
    function plSources(n) {
        if (n === 1) return '1 źródło';
        const r = n % 10, h = n % 100;
        return n + ((r >= 2 && r <= 4 && (h < 12 || h > 14)) ? ' źródła' : ' źródeł');
    }
    // domeny ramek odtwarzacza tej strony (zapisane przez tło przy wskazywaniu w ramce)
    function frameHosts() {
        const l = (host && Array.isArray(frames[host])) ? frames[host] : [];
        return l.filter((h) => h && h !== host && listOf(h).length);
    }
    // wpisy do pokazania: { sel, hosts: [gdzie leży] } — selektor ramki skopiowany dawniej pod stronę pokazujemy raz
    function entries() {
        const out = [];
        const fh = frameHosts();
        fh.forEach((h) => listOf(h).forEach((sel) => {
            const hosts = [h];
            if (listOf(host).indexOf(sel) !== -1) hosts.push(host);   // stara kopia pod domeną strony
            out.push({ sel, frame: h, hosts });
        }));
        listOf(host).forEach((sel) => { if (!out.some((e) => e.sel === sel)) out.push({ sel, frame: '', hosts: [host] }); });
        return out;
    }

    // ---- rysowanie listy źródeł tej strony ----
    function chip(e) {
        const row = document.createElement('div');
        row.className = 'kreator-chip';
        const code = document.createElement('code');
        code.textContent = (e.frame ? '🖼 ' + e.frame + ' · ' : '') + e.sel;
        code.title = (e.frame ? 'Napisy w ramce odtwarzacza (' + e.frame + '). ' : '') + 'Kliknij — sprawdzę, ile elementów łapie na tej karcie';
        code.addEventListener('click', () => testSelector(e.sel));
        const x = document.createElement('span');
        x.className = 'x';
        x.textContent = '✕';
        x.title = 'Usuń to źródło';
        x.addEventListener('click', () => removeSelector(e));
        row.appendChild(code);
        row.appendChild(x);
        return row;
    }
    function render() {
        const list = host ? entries() : [];
        const hostsShown = [host].concat(frameHosts());
        if (pill) {
            pill.textContent = host ? String(list.length) : '—';
            pill.title = host ? plSources(list.length) + ' dla ' + host : '';
        }
        if (chkRow) chkRow.style.display = list.length ? '' : 'none';
        if (chk) {
            chk.checked = !!host && hostsShown.some((h) => listOf(h).length && on[h] !== false);
            chk.disabled = !host || !list.length;
        }
        listBox.textContent = '';
        list.forEach((e) => listBox.appendChild(chip(e)));
        if (host && !list.length) {
            const n = document.createElement('div');
            n.className = 'footnote';
            n.textContent = 'Brak własnych źródeł na tej stronie. Gdy lektor nie widzi napisów, kliknij 🎯 i wskaż je na ekranie.';
            listBox.appendChild(n);
        }
        if (!host) {
            const n = document.createElement('div');
            n.className = 'footnote';
            n.textContent = 'Ta karta nie jest stroną www — otwórz film w zwykłej karcie.';
            listBox.appendChild(n);
        }
    }

    // ---- zmiany w źródłach ----
    function removeSelector(e) {
        e.hosts.forEach((h) => {
            const list = listOf(h);
            const i = list.indexOf(e.sel);
            if (i >= 0) list.splice(i, 1);
            if (!list.length) delete src[h];
        });
        chrome.storage.local.set({ customSources: src }, () => { render(); setStatus('Usunięto: ' + e.sel); });
    }
    if (chk) chk.addEventListener('change', () => {
        if (!host) return;
        // strona i jej ramki odtwarzacza razem — dla użytkownika to jedno miejsce
        [host].concat(frameHosts()).forEach((h) => { if (listOf(h).length) on[h] = chk.checked; });
        chrome.storage.local.set({ customSourcesOn: on }, () => setStatus(chk.checked
            ? '✅ Własne źródła na ' + host + ' włączone.'
            : '⏸ Własne źródła na ' + host + ' wyłączone (selektory zostają w pamięci).'));
    });

    // ---- wskazywanie myszką (zapis w tle!) ----
    pickBtn.addEventListener('click', () => {
        if (tabId == null || !host) { setStatus('Otwórz kartę ze stroną z filmem (http/https) i spróbuj jeszcze raz.'); return; }
        pickBtn.disabled = true;
        setStatus('🎯 Uruchamiam wskazywanie na tej karcie…');
        chrome.runtime.sendMessage({ action: 'KREATOR_PICK_SAVE', tabId: tabId }, (r) => {
            void chrome.runtime.lastError;
            pickBtn.disabled = false;
            if (!r || !r.ok) {
                const err = (r && r.error) || 'brak odpowiedzi tła';
                setStatus('⛔ ' + err + (/pozwala|odpowiada/i.test(err) ? ' — odśwież kartę (F5) i spróbuj jeszcze raz.' : '.'));
                return;
            }
            setStatus('🎯 Wskazuję na karcie — kliknij napis na ekranie, zapiszę od razu (Esc anuluje).');
            // popup zasłania stronę i przechwytuje pierwszy klik — zamykamy go, żeby wskazywanie działało od razu
            setTimeout(() => { try { window.close(); } catch (e) {} }, 1200);
        });
    });

    // ---- test selektora: podświetlenie trafień na karcie (jak „🧪 Testuj selektor” w Ustawieniach) ----
    function sendToTab(msg, done) {
        if (tabId == null) { done(null); return; }
        chrome.tabs.sendMessage(tabId, msg, (r) => {
            if (!chrome.runtime.lastError && r) { done(r); return; }
            // strona bez narzędzi Kreatora — dokładamy je i pytamy jeszcze raz (jak strona Ustawień)
            chrome.scripting.executeScript({ target: { tabId: tabId, allFrames: true }, files: KREATOR_FILES })
                .then(() => chrome.tabs.sendMessage(tabId, msg, (r2) => { void chrome.runtime.lastError; done(r2 || null); }),
                    () => done(null));
        });
    }
    function testSelector(sel) {
        if (!sel) return;
        setStatus('⏳ Sprawdzam selektor…');
        sendToTab({ action: 'KREATOR_TEST', selector: sel }, (r) => {
            if (!r) { setStatus('Ta karta nie odpowiada — odśwież ją (F5) i spróbuj jeszcze raz.'); return; }
            if (r.ok) setStatus('✓ Selektor łapie ' + r.count + ' element(ów) w głównej ramce — trafienia podświetlone na stronie.'
                + (r.count ? '' : ' (napisy w ramce odtwarzacza sprawdzisz, gdy są widoczne na ekranie)'));
            else setStatus('⛔ Błędny selektor: ' + sel);
        });
    }

    // ---- ręczny selektor i wszystkie domeny: Ustawienia (z domeną tej karty) ----
    if (moreBtn) moreBtn.addEventListener('click', () => chrome.tabs.create({
        url: chrome.runtime.getURL('src/options/options.html#kreator' + (host ? '=' + encodeURIComponent(host) : ''))
    }));

    // ---- start: domena i pamięć ----
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const t = tabs && tabs[0];
        tabId = t && t.id != null ? t.id : null;
        host = t ? hostOf(t.url) : '';
        chrome.storage.local.get(['customSources', 'customSourcesOn', 'kreatorFrameHosts', 'kreatorLastPick'], (r) => {
            src = obj(r && r.customSources);
            on = obj(r && r.customSourcesOn);
            frames = obj(r && r.kreatorFrameHosts);
            lastPick = (r && r.kreatorLastPick && typeof r.kreatorLastPick === 'object') ? r.kreatorLastPick : null;
            render();
            // ostatni wynik 🎯: pokazujemy, gdy jest świeży (także nieudany — np. wybór po czasie)
            if (lastPick && (Date.now() - (lastPick.at || 0) < LAST_MS)) {
                if (lastPick.ok === false) setStatus('⚠ Ostatni wybór NIE został zapisany: ' + (lastPick.error || 'nieznany błąd') + ' Kliknij 🎯 jeszcze raz.');
                else if (lastPick.selector && lastPick.host && lastPick.host !== host) setStatus('💾 Ostatnio zapisano dla ' + lastPick.host + ': ' + lastPick.selector + ' (napisy w ramce odtwarzacza — tam lektor czyta).');
                else if (lastPick.selector) setStatus('💾 Zapisano: ' + lastPick.selector);
            }
        });
    });
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area !== 'local') return;
        if (ch.customSources) src = obj(ch.customSources.newValue);
        if (ch.customSourcesOn) on = obj(ch.customSourcesOn.newValue);
        if (ch.kreatorFrameHosts) frames = obj(ch.kreatorFrameHosts.newValue);
        if (ch.customSources || ch.customSourcesOn || ch.kreatorFrameHosts) render();
    });
})();

/* ===== [AGENT-EXP] 2026-11-14: karta „Status” — realne źródło lektora i tryb cenzora (każda platforma) ===== */
(function () {
    const pill = $('statusPill'), lines = $('statusLines');
    if (!lines) return;
    const esc = (x) => String(x == null ? '' : x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const t = (s) => {   // [FIX 2026-11-21] g:mm:ss od godziny (było 104:50)
        const n = Math.max(0, Math.round(Number(s) || 0)), h = Math.floor(n / 3600), m = Math.floor(n % 3600 / 60), sec = String(n % 60).padStart(2, '0');
        return h ? h + ':' + String(m).padStart(2, '0') + ':' + sec : m + ':' + sec;
    };
    const PRIO = { file: 'priorytet: plik', hybrid: 'priorytet: plik + live', live: 'priorytet: ekran' };
    let lektorOn = true;   // stan przełącznika lektora (chrome.storage — s w tym pliku jest lokalne w innym bloku)
    try {
        chrome.storage.local.get('enabled', (r) => { lektorOn = !r || r.enabled !== false; refresh(); });
        chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.enabled) { lektorOn = ch.enabled.newValue !== false; refresh(); } });
    } catch (e) {}
    function render(st) {
        const en = lektorOn;
        const L = st && st.lektor, C = st && st.cenzor;
        const rows = [];
        if (!st) rows.push('⚪ LEKTOR — brak danych z tej karty (odśwież stronę)');
        else if (!en) rows.push('⚪ LEKTOR — wyłączony w popupie' + (L && L.source ? ' (ostatnio: ' + esc(L.source) + ')' : ''));
        else if (L && L.source) rows.push('🟢 LEKTOR — ' + esc(L.source) + (L.cues ? ' · ' + L.cues + ' kwestii' : ''));
        else rows.push('🔴 LEKTOR — brak napisów (nic nie widzi)');
        if (!C) rows.push('⚪ CENZOR — brak danych (strona bez cenzora)');
        else {
            const on = !!(C.on || C.live);
            const parts = [];
            // [FIX 2026-11-21] zakres pliku jest w wierszu NAPISY; tu: co rządzi i od kiedy live (zgodnie z priorytetem)
            const fileOk = !!(C.on && C.cueMode);
            if (fileOk) parts.push(PRIO[C.priority] || PRIO.file);
            if (C.live) {
                if (!C.cueMode || !C.on) parts.push('live: cały film');
                else if (C.priority === 'live' || !(C.liveFrom > 0)) parts.push('live: cały film');
                else parts.push('live ' + (C.coveredFrom > 5 ? 'do ' + t(C.coveredFrom - 5) + ' i ' : '') + 'od ' + t(C.liveFrom));
            }
            if (C.on && !C.cueMode && !C.live) parts.push('czekam na plik napisów');
            if (C.muting) parts.push('🔇 TERAZ CISZA');
            rows.push((on ? '🟢' : '⚪') + ' CENZOR — ' + (on ? 'WŁ.' : 'wyłączony') + (parts.length ? ' · ' + parts.join(' · ') : ''));
        }
        if (C && C.cueMode) rows.push('📄 NAPISY — plik: ' + C.cues + ' kwestii · ' + t(C.coveredFrom) + '–' + t(C.coveredUntil)
            + (C.subOffsetMs ? ' · przesunięcie ' + (C.subOffsetMs > 0 ? '+' : '') + (C.subOffsetMs / 1000).toFixed(1) + ' s' : ''));
        else if (L && L.source) rows.push('📄 NAPISY — ekran: ' + esc(L.source));
        else rows.push('📄 NAPISY — brak');
        lines.innerHTML = rows.join('<br>');
        const lOk = !!(en && L && L.source), cOk = !!(C && (C.on || C.live));
        if (pill) pill.textContent = (lOk ? '🟢 lektor' : '⚪ lektor') + ' · ' + (cOk ? '🟢 cenzor' : '⚪ cenzor');
    }
    function refresh() {
        try {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const tab = tabs && tabs[0];
                if (!tab || tab.id == null) return render(null);
                chrome.runtime.sendMessage({ action: 'GET_TAB_STATUS', tabId: tab.id }, (r) => { void chrome.runtime.lastError; render(r && r.status); });
            });
        } catch (e) { render(null); }
    }
    // [AGENT-EXP] 2026-11-26: 🔄 Odśwież napisy — pamięć cenzora (Map w stronie) i napisy lektora z Netflix/HBO znikają
    // z przeładowaniem karty; YouTube trzyma napisy filmu 90 dni (subs_cache, klucz yt|<v>) — ten wpis kasujemy.
    const rb = $('statusRefresh');
    if (rb) rb.addEventListener('click', () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tab = tabs && tabs[0];
            if (!tab || tab.id == null) return;
            lines.textContent = '⏳ Odświeżam napisy — strona się przeładuje…';
            let v = '';
            try { const u = new URL(tab.url || ''); if (/(^|\.)youtube\.com$/.test(u.hostname)) v = u.searchParams.get('v') || (u.pathname.match(/^\/(?:shorts|live)\/([\w-]+)/) || [])[1] || ''; } catch (e) {}
            const reload = () => { try { chrome.tabs.reload(tab.id); } catch (e) {} };
            if (!v) return reload();
            chrome.runtime.sendMessage({ action: 'PAMIEC_VIDEO_DEL', key: 'yt|' + v }, () => { void chrome.runtime.lastError; reload(); });
        });
    });
    render(null);
    refresh();
    setInterval(refresh, 2000);
    try { chrome.tabs.onActivated.addListener(refresh); } catch (e) {}
})();
