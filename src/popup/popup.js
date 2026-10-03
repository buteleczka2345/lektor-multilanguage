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
    subtitleOffsetMs: 0,       // przesunięcie lektora względem wideo (ms); ujemne = wcześniej
    censorEnabled: true,       // cenzura przekleństw (wszystkie języki naraz)
    censorMode: 'remove',      // 'remove' | 'beep' | 'replace'
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
        : 'Jedyny głos w paczce — oryginalny, wbudowany model Sherpa-onnx (VITS). Nie ma innych głosów do wyboru.';
    if (!detail) return;
    if (enabled) {
        detail.textContent = '✓ Aktywny własny głos: „' + (cv.name || 'model') + '” (' + fmtBytes(cv.sizeOnnx) + ').';
        detail.style.color = '#7effa0';
        if (btn) btn.textContent = '📂 Zamień pliki własnego głosu…';
    } else {
        detail.textContent = (cv && cv._failed)
            ? '⛔ Własny głos „' + (cv.name || '') + '” nie wystartował — działa wbudowany. Przyczyna: log silnika w sekcji „Test lektora”. Możesz wczytać pliki ponownie.'
            : 'Wskaż 3 pliki modelu Sherpa/Piper: model.onnx + tokens.txt + model.onnx.json (json opcjonalny). Głos zapisze się w rozszerzeniu i przeżyje restart przeglądarki.';
        detail.style.color = (cv && cv._failed) ? '#ff9090' : '';
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
        row.style.cssText = 'display:flex;align-items:center;gap:4px;margin-top:4px;font-size:10px;';
        const isAct = v.id === actId;
        const label = document.createElement('span');
        label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:' + (isAct ? '#7effa0' : '#ccc') + ';';
        label.textContent = (isAct ? '● ' : '○ ') + (v.name || v.id) + ' (' + fmtBytes(v.sizeOnnx) + ')';
        row.appendChild(label);
        if (!isAct) {
            const act = document.createElement('button');
            act.textContent = '▶';
            act.title = 'Aktywuj ten głos';
            act.style.cssText = 'width:22px;height:18px;background:#1a3a1a;color:#7effa0;border:1px solid #3a7a3a;cursor:pointer;border-radius:4px;font-size:9px;flex-shrink:0;';
            act.addEventListener('click', () => activateVoice(v));
            row.appendChild(act);
        }
        const del = document.createElement('button');
        del.textContent = '🗑';
        del.title = 'Usuń ten głos z pamięci';
        del.style.cssText = 'width:22px;height:18px;background:#331111;color:#ff9090;border:1px solid #933;cursor:pointer;border-radius:4px;font-size:9px;flex-shrink:0;';
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
    if (st) st.textContent = '🗑 Usunięto „' + (v.name || v.id) + '”' + (wasActive ? ' (był aktywny — wrócono na wbudowany głos).' : '.');
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
                if (customStatus) customStatus.textContent = 'Wrócono do wbudowanego głosu (własne głosy zostały w pamięci).';
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
    // ===== Cenzura przekleństw — wszystkie języki naraz =====
    const censorToggle = $('censorToggleBtn');
    const censorModeSel = $('censorModeSelect');
    const censorWords = $('censorCustomWords');
    if (censorToggle && censorModeSel && censorWords) {
        const censorStatus = $('censorStatus');
        const CENSOR_STATUS_FALLBACK = '✓ Aktywna: przekleństwa usuwane we wszystkich obsługiwanych językach + Twoje własne słowa.';
        let censorInfo = null; // { languages, words } — dociągane z censor.js (silnik)
        const censorActiveText = () => (censorInfo && censorInfo.languages)
            ? ('✓ Aktywna: ' + censorInfo.languages + ' języków, ' + censorInfo.words + ' słów + Twoje własne.')
            : CENSOR_STATUS_FALLBACK;
        const syncCensorUi = (on) => {
            censorToggle.dataset.on = on ? '1' : '0';
            censorToggle.textContent = on ? '🤬 Cenzura: WŁĄCZONA' : '🤬 Cenzura: WYŁĄCZONA';
            censorToggle.style.background = on ? '#0f2d1a' : '#331111';
            censorToggle.style.color = on ? '#7effa0' : '#ff9090';
            censorToggle.style.border = on ? '1px solid #3a7a3a' : '1px solid #933';
            censorModeSel.disabled = !on;
            censorWords.disabled = !on;
            if (censorStatus) {
                censorStatus.textContent = on
                    ? censorActiveText()
                    : 'Cenzura wyłączona — lektor czyta wszystko.';
            }
        };
        syncCensorUi(!!s.censorEnabled);
        censorModeSel.value = ['remove', 'beep', 'replace'].indexOf(s.censorMode) >= 0 ? s.censorMode : 'remove';
        censorWords.value = s.censorCustomWords || '';
        // Faktyczny zasięg cenzury liczy silnik (censor.js) — popup tylko pyta.
        try {
            chrome.runtime.sendMessage({ action: 'CENSOR_STATS' }, (resp) => {
                if (chrome.runtime.lastError) return;
                if (!resp || !resp.languages) return;
                censorInfo = { languages: resp.languages, words: resp.words || 0 };
                const scopeNote = $('censorScopeNote');
                if (scopeNote) {
                    scopeNote.textContent = 'Działa dla WSZYSTKICH języków naraz: '
                        + resp.languages + ' języków, ' + (resp.words || 0) + ' słów + Twoje własne.'
                        + ' Ustawienia zapisują się na stałe.';
                }
                if (censorToggle.dataset.on === '1'
                    && (!censorStatus || censorStatus.textContent === CENSOR_STATUS_FALLBACK)) {
                    syncCensorUi(true);
                }
            });
        } catch (e) { /* brak silnika — zostaje tekst ogólny */ }
        censorToggle.addEventListener('click', () => {
            const next = censorToggle.dataset.on !== '1';
            saveSettings({ censorEnabled: next });
            syncCensorUi(next);
        });
        censorModeSel.addEventListener('change', () => {
            saveSettings({ censorMode: censorModeSel.value });
            if (censorStatus) censorStatus.textContent = '✓ Tryb cenzury zapisany: ' + censorModeSel.options[censorModeSel.selectedIndex].text;
        });
        censorWords.addEventListener('input', debounce(() => {
            saveSettings({ censorCustomWords: censorWords.value });
            if (censorStatus) censorStatus.textContent = '✓ Własne słowa zapisane (działają od następnej kwestii).';
        }, 500));
    }
    // Sklep głosów: katalog 1100+ języków (MMS + Piper) z pobieraniem w aplikacji.
    initLangStore();

    // Źródło napisów na Prime Video (wbudowane / Immersive Translate / oba)
    const primeSource = $('primeSourceSelect');
    if (primeSource) {
        primeSource.value = s.primeSubtitleSource || 'both';
        primeSource.addEventListener('change', (e) => {
            saveSettings({ primeSubtitleSource: e.target.value });
        });
    }

    // === Test lektora: INIT_TTS → TTS_PLAY i pokaż odpowiedź serwera ===
    const testBtn = $('testBtn');
    const testStatus = $('testStatus');
    const testDetail = $('testDetail');
    if (testBtn) {
        testBtn.addEventListener('click', () => {
            testStatus.textContent = '…inicjalizuję Piper…';
            testDetail.style.display = 'none';
            testBtn.disabled = true;
            const showErr = (label, resp) => {
                testStatus.textContent = resp && resp.status ? resp.status : 'błąd';
                if (resp && resp.error) {
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
                    showErr('[INIT_TTS — błąd ładowania Piper]', resp1);
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

    // Suwak „Nagrywanie / zapas do przodu": 0 = na bieżąco (bez nagrywania),
    // >0 = nagrywanie czystego lektora włączone + zapas syntezy N minut do przodu.
    // Powrót suwaka na 0 kończy nagranie i AUTOMATYCZNIE zapisuje WAV.
    const lookaheadRange = $('lookaheadRange');
    const lookaheadVal = $('lookaheadVal');
    const recDetail = $('recDetail');
    const recLog = $('recLog');
    let lastTelemetry = null; // ostatnia telemetria z zakładki (platforma, zapas, wyrazy)
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
                if (recDetail) recDetail.textContent = 'Na bieżąco. Nagranie (' + cnt + ' kwestii) zbuforowane — zapisz je przyciskiem ⬇ na stronie.';
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
    const FILE_DETAIL_DEFAULT = 'Napisy z pliku nadpisują napisy strony na KAŻDEJ platformie. Odtwórz film — lektor czyta wg czasu z pliku, suwak nagrywa jak zawsze.';
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
    function parseSubsFile(raw) {
        const lines = String(raw || '').replace(/\r/g, '').split('\n');
        const cues = [];
        // 1) SRT / WebVTT / SBV — linia „start --> end”
        const arrow = /(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})/;
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(arrow);
            if (!m) continue;
            const startMs = fileTs(m[1]), endMs = fileTs(m[2]);
            if (startMs < 0 || endMs <= startMs) continue;
            const buf = [];
            for (let j = i + 1; j < lines.length && lines[j].trim(); j++) buf.push(lines[j].trim());
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
        cues.sort((a, b) => a.startMs - b.startMs);
        return cues;
    }
    function refreshFileSubsStatus() {
        chrome.storage.local.get('fileSubs', (r) => {
            const f = r && r.fileSubs;
            if (fileSubsStatus && fileSubsDetail) {
                if (f && Array.isArray(f.cues) && f.cues.length) {
                    fileSubsStatus.textContent = f.cues.length + ' kwestii';
                    fileSubsDetail.textContent = '📂 ' + f.name + ' — wczytane. Odtwórz film: lektor czyta wg czasu z pliku.';
                } else {
                    fileSubsStatus.textContent = 'brak';
                    fileSubsDetail.textContent = FILE_DETAIL_DEFAULT;
                }
            }
        });
    }
    if (fileSubsBtn && fileSubsInput) {
        fileSubsBtn.addEventListener('click', () => fileSubsInput.click());
        fileSubsInput.addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file || !fileSubsDetail) return;
            try {
                const buf = await file.arrayBuffer();
                let raw = new TextDecoder('utf-8').decode(buf);
                if (raw.includes('\uFFFD')) {
                    // Polskie napisy bywają w CP1250 — gdy UTF-8 daje krzaki, próbujemy tej strony kodowej.
                    try { raw = new TextDecoder('windows-1250').decode(buf); } catch (err) { /* ignore */ }
                }
                const cues = parseSubsFile(raw);
                if (!cues.length) {
                    fileSubsDetail.textContent = '✕ Nie znaleziono timestampów w pliku „' + file.name + '”. Wspierane: SRT, VTT, SBV, ASS/SSA.';
                    return;
                }
                chrome.storage.local.set({
                    fileSubs: { name: file.name, cues: cues, loadedAt: Date.now() }
                }, () => refreshFileSubsStatus());
            } catch (err) {
                fileSubsDetail.textContent = '✕ Błąd czytania pliku: ' + ((err && err.message) || err);
            }
            fileSubsInput.value = '';
        });
    }
    if (fileSubsClear) {
        fileSubsClear.addEventListener('click', () => {
            chrome.storage.local.remove('fileSubs', () => refreshFileSubsStatus());
        });
    }
    refreshFileSubsStatus();

    // Żywy wskaźnik statystyk — czyta telemetrię TEJ platformy, na której jest aktywna karta.
    // Netflix: pełne statystyki od aktualnej klatki. YouTube/Prime/iQ: na ile się da (bez „do przodu").
    const recPlatFromUrl = (url) => {
        if (!url) return null;
        if (/netflix\.com/i.test(url)) return 'netflix';
        if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
        if (/primevideo\.com|amazon\.com|iqiyi?\.com|iq\.com|dailymotion\.com|dai\.ly|rumble\.com/i.test(url)) return 'dom';
        return null;
    };
    setInterval(() => {
        const tEl = document.getElementById('recTelemetry');
        const logEl = document.getElementById('recLog');
        if (!tEl && !logEl) return;
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const plat = recPlatFromUrl(tabs && tabs[0] && tabs[0].url);
            if (!plat) {
                if (tEl) tEl.textContent = 'Otwórz film na Netflix / YouTube / Prime…, aby zobaczyć statystyki wyrazów.';
                if (logEl) logEl.textContent = '—';
                lastTelemetry = null;
                return;
            }
            chrome.storage.local.get('__recTelemetry_' + plat, (items) => {
                const t = items && items['__recTelemetry_' + plat];
                if (!t || Date.now() - (t.ts || 0) > 10000) {
                    if (tEl) tEl.textContent = plat === 'netflix'
                        ? 'Odtwórz film na Netflixie, aby zobaczyć statystyki wyrazów.'
                        : 'Odtwórz film, aby zobaczyć statystyki wyrazów.';
                    if (logEl) logEl.textContent = '—';
                    lastTelemetry = null;
                    return;
                }
                lastTelemetry = t;
                chrome.runtime.sendMessage({ action: 'REC_STATUS' }, (st) => {
                    const synthWords = (st && st.synthWords) || 0;
                    const synthCues = (st && st.synthCues) || 0;
                    const fmtTime = (ms) => {
                        const s = Math.max(0, Math.round(ms / 1000));
                        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
                        const p = (n) => String(n).padStart(2, '0');
                        return (h ? h + ':' + p(m) : String(m)) + ':' + p(ss);
                    };
                    if (tEl) {
                        if (plat === 'netflix') {
                            // Statystyki WZGLĘDEM AKTUALNEJ KLATKI: ile wyrazów zostało do końca
                            // od miejsca oglądania i ile z nich już przetłumaczono do przodu.
                            const limitMin = lookaheadRange ? (parseInt(lookaheadRange.value, 10) || 0) : 0;
                            tEl.textContent = 'Pozycja: ' + fmtTime(t.nowMs || 0)
                                + ' · do końca: ' + (t.remainingWords || 0) + ' wyrazów (' + (t.remainingCues || 0) + ' kwestii)'
                                + ' · przetłumaczone do przodu: ' + (t.aheadWords || 0) + ' wyrazów'
                                + ' (zapas ' + Math.max(0, Math.round((t.aheadMs || 0) / 1000)) + ' s'
                                + (limitMin > 0 ? ' / limit ' + limitMin + ' min' : ', na bieżąco') + ')';
                            // Skąd lektor bierze tekst: oś czasu (które źródło napisów) albo
                            // tryb na żywo — czytanie wprost tego, co widać na ekranie.
                            tEl.textContent += ' · napisy: ' + (t.live
                                ? 'NA ŻYWO z ekranu'
                                : ('źródło ' + (t.activeSource || '—') + ' / plików ' + (t.sources || 0)));
                            if (t.onScreen) tEl.textContent += ' · na ekranie: „' + String(t.onScreen).slice(0, 40) + '”';
                        } else {
                            tEl.textContent = 'Wypowiedziane: ' + (t.spokenWords || 0) + ' wyrazów (' + (t.total || 0) + ' kwestii)'
                                + ' · zsyntezowane łącznie: ' + synthWords + ' wyrazów (' + synthCues + ' kwestii)';
                        }
                    }
                    if (logEl) {
                        const rec = Array.isArray(t.recent) ? t.recent : [];
                        logEl.textContent = rec.length
                            ? rec.map((r) => '• „' + String(r.t || '').slice(0, 40) + '” — ' + (r.w || 0) + ' wyrazów').join('\n')
                            : '—';
                        // Czarna skrzynka silnika: błędy startu/syntezy/odtwarzania (offscreen).
                        chrome.storage.local.get(['__offscreenError', '__offscreenLog'], (d) => {
                            if (!logEl || !logEl.isConnected) return;
                            const lines = [];
                            if (d && d.__offscreenError) lines.push('⛔ SILNIK: ' + String(d.__offscreenError.msg || '').slice(0, 140));
                            const lg = (d && Array.isArray(d.__offscreenLog)) ? d.__offscreenLog.slice(-4) : [];
                            for (const e of lg) lines.push('⚙ ' + (e.tag || '?') + ': ' + String(e.msg || '').slice(0, 90));
                            if (lines.length) {
                                const base = rec.length
                                    ? rec.map((r) => '• „' + String(r.t || '').slice(0, 40) + '” — ' + (r.w || 0) + ' wyrazów').join('\n') + '\n'
                                    : '';
                                logEl.textContent = base + lines.join('\n');
                            }
                        });
                    }
                    // Na żywo: stan nagrywania — WYRAZY na pierwszym planie.
                    if (recDetail) {
                        if (st && st.recording && st.words === undefined) {
                            recDetail.textContent = '⚠ Nieaktualna wersja silnika nagrywania — kliknij ⟳ przy „Polski Lektor” w chrome://extensions i odśwież strony z filmami.';
                        } else if (st && st.recording) {
                            recDetail.textContent = '● Nagrywanie w locie: ' + (st.words || 0) + ' wyrazów (' + st.count
                                + ' kwestii zapisanych) · zsyntezowane łącznie: ' + synthWords + ' wyrazów. Wróć suwakiem na 0, aby zatrzymać nagrywanie.';
                        }
                    }
                });
            });
        });
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
        return (e.name + ' ' + e.iso + ' ' + e.country + ' ' + e.id).toLowerCase().indexOf(q) >= 0;
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
        row.style.cssText = 'display:flex;align-items:center;gap:5px;margin-top:3px;font-size:10px;';
        const label = document.createElement('span');
        label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ccc;';
        const tagMap = { mms: 'MMS', piper: 'PIPER', coqui: 'COQUI', cantonese: 'YUE', vits: 'VITS' };
        const tag = tagMap[e.type] || 'VITS';
        label.textContent = e.name + (e.country ? ' — ' + e.country : '') + (e.iso ? ' [' + e.iso + ']' : '') + ' · ' + tag;
        label.title = e.id + ' · ' + (e.sizeMb ? 'rozmiar spakowany: ' + e.sizeMb + ' MB' : '≈114 MB');
        row.appendChild(label);
        const btn = document.createElement('button');
        const isVitsExtra = !e.dl;
        const downloaded = !isVitsExtra && (LANG_STORE.customList || []).some((v) => v.id === e.id);
        if (downloaded) {
            btn.textContent = '🗑';
            btn.title = 'Już pobrany — jest na liście „Własny głos”. Kliknij, aby wykasować z pamięci rozszerzenia.';
            btn.style.cssText = 'width:24px;height:18px;background:#331111;color:#ff9090;border:1px solid #933;cursor:pointer;border-radius:4px;font-size:9px;flex-shrink:0;';
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
            btn.style.cssText = 'width:24px;height:18px;background:#112a33;color:' + (isVitsExtra ? '#555' : '#7ee0ff') + ';border:1px solid #2a6a7a;cursor:pointer;border-radius:4px;font-size:9px;flex-shrink:0;';
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
    langStatus('Katalog: ' + LANG_STORE.catalog.length + ' głosów (~1100 języków MMS + Piper). Wpisz język i kliknij ⬇.');
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
            LANG_STORE.catalog = langNormalizeCatalog(json);
            loadVoiceState().then(({ list }) => {
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
