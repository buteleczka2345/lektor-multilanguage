import { extTrJobPush, extTrJobCancel, gtabTranslateText, extTrTranslateLive, extTrTranslateList, extTrRaceOne } from './ext_net.js'; // [AGENT-EXP] extTrRaceOne
import { cacheGetVideo, cachePutVideo, cacheDelVideo, cacheStats, cacheClear } from './subs_cache.js';   // [AGENT-EXP] 2026-11-26: cacheDelVideo
import { subsDbSearch, subsDbGet } from './subs_db.js';
import '../../assets/domain_lists.js'; // [FIX 2026-11-02] 📋 wspólne listy domen → globalThis.__LektorDomains
const DL = globalThis.__LektorDomains;

const OFFSCREEN_PATH = chrome.runtime.getURL('src/offscreen/offscreen.html');

// W paczce jest DOKŁADNIE jeden głos (Sherpa VITS). Nazwy z dawnych list Pipera
// (pl_PL-gosia-medium, pl_PL-jarvis… ) nie istnieją — każde ustawienie sprowadzamy
// do oryginalnego głosu, żeby popup i silnik nie rozjeżdżały się nazwami.
const SHERPA_VOICE = 'pl_PL-meski_wg_glos-medium';
// [AGENT-EXP] 2026-10-24: wbudowany głos Sherpa usunięty z paczki (plik .onnx; espeak-ng-data zostaje dla pobranych
// głosów Piper). Kto miał Sherpę bez aktywnego własnego głosu — przechodzi na Matchę 🌐 (głos domyślny matchaVoice).
chrome.storage.local.get(['ttsEngine', 'customVoice', 'builtinVoiceRemoved'], (it) => {
    const own = !!(it && it.customVoice && it.customVoice.enabled);
    const patch = {};
    if ((!it || !it.ttsEngine || it.ttsEngine === 'sherpa') && !own) patch.ttsEngine = 'matcha';
    if (!(it && it.builtinVoiceRemoved)) patch.builtinVoiceRemoved = true;
    if (Object.keys(patch).length) chrome.storage.local.set(patch);
});

// [FIX 2026-11-02] JEDEN cenzor: dawna osobna lista cenzora dźwięku filmu (cenzorWords, „puste = wbudowana”) trafia raz
// do wspólnych własnych słów (censorCustomWords) — oba wyjścia cenzora (mowa lektora, dźwięk filmu) mają teraz jedną listę.
chrome.storage.local.get(['cenzorWords', 'censorCustomWords', 'censorOneListV1'], (it) => {
    if (!it || it.censorOneListV1) return;
    // każda lista swoim formatem: własne słowa lektora po przecinku (frazy ze spacją zostają całe), dawna lista dźwięku — też po spacji
    const have = String(it.censorCustomWords || '').split(/[,;\n]+/).map((w) => w.trim()).filter(Boolean);
    const seen = new Set(have.map((w) => w.toLowerCase()));
    String(it.cenzorWords || '').split(/[\s,;\n]+/).map((w) => w.trim()).filter((w) => w.replace(/\*+$/, '').length >= 2)
        .forEach((w) => { if (!seen.has(w.toLowerCase())) { seen.add(w.toLowerCase()); have.push(w); } });
    const patch = { censorOneListV1: true };
    if (String(it.cenzorWords || '').trim()) patch.censorCustomWords = have.join(', ');
    chrome.storage.local.set(patch, () => { chrome.storage.local.remove('cenzorWords'); });
});

// [FIX 2026-11-02] 📋 Domyślnie lektor działa TYLKO na domenach z białej listy (przełącznik domainListsOn, domyślnie WŁ.;
// popup → „📋 Tylko domeny z listy”). Jednorazowo wpisujemy na listę wszystkie domeny lektora: serwisy z manifestu,
// strony Łowcy (z odtwarzaczami), Kreator napisów, strony z napisami z pliku / baz, OCR i układ popupu.
// Niczego nie usuwamy — do listy wpisanej wcześniej ręcznie brakujące domeny są dopisywane na końcu.
chrome.storage.local.get('domainWhitelistFillV1', (f) => {
    if (f && f.domainWhitelistFillV1) return;
    chrome.storage.local.get(DL.SOURCE_KEYS, (all) => {
        const r = DL.fill(all && all.domainWhitelist, all || {});
        const patch = { domainWhitelistFillV1: true };
        if (r.added.length) patch.domainWhitelist = r.text;
        chrome.storage.local.set(patch);
    });
});
// Użycie lektora z popupu na nowej stronie („🔍 Szukaj napisów”, „🌐 bazy napisów”) = zgoda na lektora tutaj: przy
// włączonym „Tylko domeny z listy” domena strony trafia na białą listę (czarnej listy nie ruszamy). Zwraca dopisaną domenę.
async function domainListsAllow(url) {
    const h = DL.hostOf(url);
    if (!h) return '';
    const o = await chrome.storage.local.get(['domainListsOn', 'domainWhitelist', 'domainBlacklist']);
    if (DL.state(h, '', o).why !== 'notwhite') return '';
    const text = DL.addHost(o.domainWhitelist, h);
    if (!text) return '';
    await chrome.storage.local.set({ domainWhitelist: text });
    return h;
}

// [FIX 2026-11-02] przełącznik „Google RPC” usunięty (adres 404) — sprzątamy jego zapis
try { chrome.storage.local.remove('extTrGoogleRpc'); } catch (e) {}

// ===== Blokowane frazy — lektor NIGDY ich nie czyta =====
// Centralny filtr: ostateczna kontrola odbywa się tutaj, przed TTS_PLAY → callOffscreen.
const BLOCKED_PHRASES = [
    'only the translation',
    'only the translation ,,'
];
// [FIX 2026-11-02] blokada pasuje do CAŁYCH słów (granice liter/cyfr): „tak” nie wycisza już zdań z „także”, „takiego”.
// Brzeg wpisu, który sam nie jest literą (np. „only the translation ,,”), sprawdzany jest jak dawniej (podciąg).
function phraseHit(text, phrase) {
    if (!phrase) return false;
    var w = /[\p{L}\p{N}]/u, i = text.indexOf(phrase);
    var needL = w.test(phrase.charAt(0)), needR = w.test(phrase.charAt(phrase.length - 1));
    while (i !== -1) {
        var okL = !needL || i === 0 || !w.test(text.charAt(i - 1));
        var okR = !needR || i + phrase.length >= text.length || !w.test(text.charAt(i + phrase.length));
        if (okL && okR) return true;
        i = text.indexOf(phrase, i + 1);
    }
    return false;
}
function isBlockedPhrase(text) {
    if (!text || typeof text !== 'string') return false;
    // [AGENT-EXP] ta sama normalizacja co przy zapisie blokady (lektor-settings.js): niewidoczne znaki i wielokrotne spacje
    const t = text.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, ' ').replace(/[\s\u00A0]+/g, ' ').trim().toLowerCase();
    for (let i = 0; i < BLOCKED_PHRASES.length; i++) {
        if (phraseHit(t, BLOCKED_PHRASES[i])) return true;
    }
    for (let i = 0; i < userBlockedPhrases.length; i++) {
        if (phraseHit(t, String(userBlockedPhrases[i] || '').toLowerCase())) return true;
    }
    return false;
}

// ===== Użytkownicze blokady z panelu (zapisane w chrome.storage.local) =====
// Ładuje się automatycznie przy starcie service workera i aktualizuje przy zmianach.
let userBlockedPhrases = [];
// [FIX 2026-11-02] obietnica wczytania blokad — TTS_PLAY / TTS_PRELOAD czekają na nią. Pierwsza kwestia po wybudzeniu
// service workera przychodzi zwykle, zanim storage odpowie, więc wcześniej mogła przejść mimo blokady.
let userBlockedReady = Promise.resolve();

function loadUserBlockedPhrases() {
    // [AGENT-EXP] chrome.storage.local.get zwraca w MV3 OBIETNICĘ — wcześniej czytane bez await, więc po każdym
    // uśpieniu service workera (≈30 s bezczynności) lista Blokad była PUSTA, dopóki użytkownik czegoś nie zmienił.
    try {
        userBlockedReady = chrome.storage.local.get('userBlockedPhrases').then((result) => {
            userBlockedPhrases = Array.isArray(result && result.userBlockedPhrases) ? result.userBlockedPhrases : [];
        }).catch(() => { userBlockedPhrases = []; });
    } catch (e) {
        userBlockedPhrases = [];
    }
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.userBlockedPhrases) {
        userBlockedPhrases = Array.isArray(changes.userBlockedPhrases.newValue) ? changes.userBlockedPhrases.newValue : [];
    }
});

// Ładowanie na starcie
loadUserBlockedPhrases();

// [AGENT-EXP] 2026-11-21: JEDNO ustawienie źródła napisów. Lista „Priorytet” cenzora (cenzorPriority) steruje też lektorem:
// 'live' → lektor czyta tylko ekran (primeSubtitleSource 'immersive'), 'file'/'hybrid' → plik najpierw ('both').
// Karta „Napisy z ekranu” w popupie została usunięta; synchronizacja tutaj działa i z popupu, i ze strony ustawień.
function syncSubSourceFromPriority(prio) {
    const want = prio === 'live' ? 'immersive' : 'both';
    chrome.storage.local.get('primeSubtitleSource').then((r) => {
        if ((r && r.primeSubtitleSource) !== want) chrome.storage.local.set({ primeSubtitleSource: want });
    }).catch(() => {});
}
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.cenzorPriority) syncSubSourceFromPriority(changes.cenzorPriority.newValue);
});
try { chrome.storage.local.get('cenzorPriority').then((r) => syncSubSourceFromPriority(r && r.cenzorPriority)).catch(() => {}); } catch (e) {}

let creating = null;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function hasOffscreen() {
    try {
        const ctx = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT']
        });
        return Array.isArray(ctx) && ctx.length > 0;
    } catch {
        return false;
    }
}

async function createOffscreenDocument() {
    const url = OFFSCREEN_PATH;
    const justification = 'Multilektor: odtwarzanie mowy lektora i silniki ONNX/WASM';   // [AGENT-EXP] 2026-10-21
    await chrome.offscreen.createDocument({
        url,
        reasons: ['AUDIO_PLAYBACK'],
        justification
    });
}

async function ensureOffscreen() {
    if (await hasOffscreen()) return;
    if (creating) {
        await creating;
        return;
    }
    creating = (async () => {
        if (await hasOffscreen()) return;
        await createOffscreenDocument();
    })();
    try {
        await creating;
    } finally {
        creating = null;
    }
}

async function sendOffscreen(payload) {
    try {
        return await chrome.runtime.sendMessage({ target: 'offscreen', ...payload });
    } catch (err) {
        const msg = String((err && err.message) || err);
        if (!msg.includes('Receiving end does not exist')) {
            console.warn('[Multilektor SW] offscreen:', msg);
        }
        return null;
    }
}

async function pingOffscreen() {
    const resp = await sendOffscreen({ action: 'PING' });
    return !!(resp && (resp.status === 'ok' || resp.isReady !== undefined));
}

async function waitForOffscreen(tries = 50, allowKill = true) {
    await ensureOffscreen();
    for (let i = 0; i < tries; i++) {
        if (await pingOffscreen()) return true;
        // Reanimacja: martwy dokument zamykamy i tworzymy od nowa — ALE NIGDY gdy silnik
        // może być w trakcie budowy modelu (INIT/PRELOAD/PLAY): budowa blokuje pętlę
        // zdarzeń na kilka sekund, więc brak odpowiedzi na PING jest wtedy NORMALNY,
        // a zamknięcie dokumentu przerywa build w połowie (pętla restartów = „nie odpowiada").
        if (allowKill && (i === 4 || i === 16 || i === 32)) {
            try { await chrome.offscreen.closeDocument(); } catch (_) { /* ignore */ }
            await sleep(150);
            await ensureOffscreen();
        } else {
            await ensureOffscreen(); // tylko dogeneruj, jeśli dokument nie istnieje
        }
        await sleep(200);
    }
    return false;
}

async function callOffscreen(payload, tries = 50) {
    // Budowa modelu blokuje offscreen — nie wolno go wtedy reanimować siłowo
    const allowKill = !(payload && (payload.action === 'INIT_TTS'
        || payload.action === 'TTS_PRELOAD'
        || payload.action === 'TTS_PLAY'));
    const ready = await waitForOffscreen(tries, allowKill);
    if (!ready) {
        const docThere = await hasOffscreen();
        const extra = docThere
            ? 'Dokument TTS istnieje, ale nie reaguje — otwórz popup po szczegóły (sekcja błędów).'
            : 'Dokument TTS nie został utworzony — przeładuj rozszerzenie (chrome://extensions).';
        return { status: 'error', error: 'Offscreen nie odpowiada (dokument TTS nie wystartował). ' + extra };
    }
    let last = null;
    for (let i = 0; i < 8; i++) {
        last = await sendOffscreen(payload);
        if (last) return last;
        await sleep(250);
        await ensureOffscreen();
    }
    return last || { status: 'error', error: 'Offscreen nie odpowiada' };
}

// OPTIONS-PAGE: offscreen zgłasza pustą kolejkę lektora → przekazujemy do kart (wznowienie filmu po pauzie z lektorem)
// [FIX 2026-11-02] tylko do kart, z których lektor czytał w ostatnich 15 min (wcześniej do WSZYSTKICH kart po każdej
// kwestii). Lista w storage.session przeżywa uśpienie service workera.
const NARRATOR_TAB_MS = 15 * 60000;
const narratorTabs = new Map();   // karta → chwila ostatniego TTS_PLAY
try {
    chrome.storage.session.get('narratorTabs').then((r) => {
        (Array.isArray(r && r.narratorTabs) ? r.narratorTabs : []).forEach((e) => { if (Array.isArray(e) && !narratorTabs.has(e[0])) narratorTabs.set(e[0], e[1]); });
    }).catch(() => {});
} catch (e) {}
function narratorTabNote(tabId) {
    if (tabId == null) return;
    const now = Date.now(), prev = narratorTabs.get(tabId) || 0;
    narratorTabs.set(tabId, now);
    if (now - prev < 60000) return;   // zapis najwyżej raz na minutę na kartę
    for (const [t, at] of narratorTabs) if (now - at > NARRATOR_TAB_MS) narratorTabs.delete(t);
    try { chrome.storage.session.set({ narratorTabs: [...narratorTabs] }).catch(() => {}); } catch (e) {}
}
chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.action !== 'TTS_QUEUE_IDLE' || (sender && sender.tab)) return;
    const now = Date.now();
    // [FIX 2026-11-22] karta, która ostatnio mówiła, dostaje sygnał zawsze — nawet gdy lista kart lektora przepadła
    // (np. uśpienie service workera). Bez tego film zostawał ściszony aż do 20 s „bezpiecznika”.
    const direct = Number(msg.tab);
    if (Number.isInteger(direct) && !narratorTabs.has(direct)) {
        try { chrome.tabs.sendMessage(direct, { action: 'TTS_QUEUE_IDLE' }, () => { void chrome.runtime.lastError; }); } catch (e) {}
    }
    for (const [t, at] of narratorTabs) {
        if (now - at > NARRATOR_TAB_MS) continue;
        try { chrome.tabs.sendMessage(t, { action: 'TTS_QUEUE_IDLE' }, () => { void chrome.runtime.lastError; }); } catch (e) {}
    }
});
chrome.tabs.onRemoved.addListener((tabId) => { narratorTabs.delete(tabId); });
// [FIX 2026-11-02] 🔉 lektor zaczął mówić → karta tej kwestii (ściszanie filmu tylko na czas mowy)
chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.action !== 'TTS_SPEAK' || (sender && sender.tab)) return;
    const tab = Number(msg.tab);
    if (!Number.isInteger(tab)) return;
    try { chrome.tabs.sendMessage(tab, { action: 'TTS_SPEAK' }, () => { void chrome.runtime.lastError; }); } catch (e) {}
});

// ENERGIA: dokument lektora (offscreen) NIE startuje razem z przeglądarką — tworzy go dopiero
// pierwsza kwestia do przeczytania (callOffscreen → ensureOffscreen). Bez lektora nic nie działa w tle.

// [VOX] 2026-10-20: Supertonic (silnik z VoxNemesis) — wartości ze storage z domyślnymi i walidacją.
const SUPERTONIC_VOICES = ['Supertonic M1', 'Supertonic M2', 'Supertonic F1', 'Supertonic F2'];
function supertonicSettings(items) {
    const steps = Math.round(Number(items.supertonicSteps));
    return {
        supertonicVoice: SUPERTONIC_VOICES.indexOf(items.supertonicVoice) >= 0 ? items.supertonicVoice : 'Supertonic M1',
        supertonicSteps: Number.isFinite(steps) && steps >= 1 && steps <= 20 ? steps : 4,
        engineBackend: (items.engineBackend === 'gpu' || items.engineBackend === 'igpu') ? items.engineBackend : 'cpu'
    };
}

// [VOX] Stan / restart silnika Supertonic dla popupu i strony Ustawień.
// Status NIE tworzy dokumentu lektora (popup pyta co 2 s) — brak dokumentu = silnik nie działa.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target === 'offscreen') return;
    if (msg.action !== 'SUPERTONIC_STATUS' && msg.action !== 'SUPERTONIC_RESTART' && msg.action !== 'BROWSER_TTS_VOICES') return;
    (async () => {
        try {
            if (msg.action === 'BROWSER_TTS_VOICES') {   // [AGENT-EXP] 2026-10-21: 🗣 głosy przeglądarki dla popupu
                const r = await callOffscreen({ action: 'BROWSER_TTS_VOICES' }, 20);
                sendResponse(r || { ok: false, voices: [] });
                return;
            }
            if (msg.action === 'SUPERTONIC_STATUS') {
                if (!(await hasOffscreen())) { sendResponse({ running: false }); return; }
                const r = await sendOffscreen({ action: 'SUPERTONIC_STATUS' });
                sendResponse(r ? Object.assign({ running: true }, r) : { running: false });
                return;
            }
            const r = await callOffscreen({ action: 'SUPERTONIC_RESTART' });
            sendResponse(r || { ok: false, error: 'brak odpowiedzi' });
        } catch (e) {
            sendResponse({ ok: false, running: false, error: (e && e.message) || String(e) });
        }
    })();
    return true;
});


// Offscreen nie ma dostępu do chrome.storage (nowsze Chrome ograniczyły API offscreen),
// więc diagnostykę (__offscreenError/__offscreenLog) zapisuje za nie service worker.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target === 'offscreen') return;
    if (msg.action === 'OFFSCREEN_DIAG') {
        try {
            if (msg.kind === 'error') {
                chrome.storage.local.set({ __offscreenError: { msg: msg.msg, ts: msg.ts || Date.now() } });
            } else if (msg.kind === 'clear-error') {
                chrome.storage.local.remove('__offscreenError');
            } else if (msg.kind === 'log') {
                chrome.storage.session.set({ __offscreenLog: Array.isArray(msg.entries) ? msg.entries : [] }).catch(() => {});   // [FIX 2026-11-02] session — patrz telemetria
            }
        } catch (e) { /* ignore */ }
        sendResponse({ status: 'diag_ok' });
        return true;
    }
    if (msg.action === 'CUSTOM_VOICE_FALLBACK') {
        // Własny głos nie wystartował w offscreen → oznacz w storage,
        // żeby popup pokazał informację o powrocie na głos wbudowany.
        chrome.storage.local.get('customVoice', (d) => {
            const cv = (d && d.customVoice && typeof d.customVoice === 'object') ? d.customVoice : {};
            chrome.storage.local.set({ customVoice: Object.assign({}, cv, { enabled: false, _failed: true }) });
        });
        sendResponse({ status: 'ok' });
        return true;
    }
    if (msg.action === 'GET_TTS_SETTINGS') {
        // [AGENT-EXP] 2026-10-16 — przekazuje wybór Sherpa/Matcha do dokumentu offscreen.
        // [AGENT-EXP] Przekaż wybór silnika i lokalnych głosów także przy starcie dokumentu offscreen.
        chrome.storage.local.get(['tempoMode', 'autoCatchup', 'readToEnd', 'compressor', 'liveBufTTLDays', 'ttsVolume', 'piperSpeed', 'offlineVoice', 'customVoice', 'builtinVoiceRemoved', 'censorEnabled', 'censorMode', 'censorCustomWords', 'ttsEngine', 'tts2Voice', 'audio8Voice', 'pocketVoice', 'omnivoiceVoice', 'kokoroVoice', 'matchaVoice', 'supertonicVoice', 'supertonicSteps', 'engineBackend', 'browserVoice', 'serverUrl', 'serverVoice', 'pronDict', 'shortenLong'], (items) => {
            sendResponse({
                settings: {
                    tempoMode: ['A', 'B', 'C'].indexOf(items.tempoMode) >= 0 ? items.tempoMode : 'A', // OPTIONS-PAGE
                    autoCatchup: items.autoCatchup === undefined ? true : !!items.autoCatchup,
                    readToEnd: !!items.readToEnd,   // [AGENT-EXP] 2026-10-22: czytaj zawsze do końca
                    compressor: !!items.compressor,
                    liveBufTTLDays: Number(items.liveBufTTLDays) || 0,
                    ttsVolume: items.ttsVolume === undefined ? 100 : items.ttsVolume,
                    piperSpeed: Number(items.piperSpeed) || 1,
                    ttsEngine: ['sherpa', 'matcha', 'xtts', 'audio8', 'f5', 'pocket', 'omnivoice', 'kokoro', 'server', 'supertonic', 'browser'].indexOf(items.ttsEngine) >= 0 ? items.ttsEngine : 'matcha',   // [AGENT-EXP] 2026-10-24: domyślnie Matcha 🌐
                    tts2Voice: typeof items.tts2Voice === 'string' ? items.tts2Voice : '',
                    audio8Voice: typeof items.audio8Voice === 'string' ? items.audio8Voice : 'default',
                    pocketVoice: typeof items.pocketVoice === 'string' && items.pocketVoice ? items.pocketVoice : 'ref',   // [AGENT-EXP]
                    omnivoiceVoice: typeof items.omnivoiceVoice === 'string' ? items.omnivoiceVoice : 'male, young adult, moderate pitch',   // [AGENT-EXP] OmniVoice ('' = losowy)
                    kokoroVoice: typeof items.kokoroVoice === 'string' && items.kokoroVoice ? items.kokoroVoice : 'pm_mateusz',   // [AGENT-EXP] 2026-10-27 Kokoro
                    serverUrl: typeof items.serverUrl === 'string' && items.serverUrl ? items.serverUrl : 'ws://127.0.0.1:9000',   // [FIX 2026-11-02] Serwer lokalny — własny adres
                    serverVoice: typeof items.serverVoice === 'string' ? items.serverVoice : '',
                    pronDict: typeof items.pronDict === 'string' ? items.pronDict : '',   // [FIX 2026-11-02] 🗣 słownik wymowy
                    shortenLong: items.shortenLong === true,   // [FIX 2026-11-02] ✂ skracanie za długich kwestii (AI)
                    matchaVoice: typeof items.matchaVoice === 'string' && items.matchaVoice ? items.matchaVoice : 'web:male_voxcpm_2:elegancki',   // [AGENT-EXP] 2026-10-17 Matcha: głos z VOICES serwer_matcha.py; 2026-10-24: domyślnie w przeglądarce (matcha_web)
                    ...supertonicSettings(items),   // [VOX] Supertonic: głos, jakość, CPU/GPU
                    browserVoice: typeof items.browserVoice === 'string' ? items.browserVoice : '',   // [AGENT-EXP] 2026-10-21: 🗣 głos przeglądarki
                    offlineVoice: SHERPA_VOICE,
                    customVoice: (items.customVoice && typeof items.customVoice === 'object') ? items.customVoice : null,
                    builtinVoiceRemoved: !!items.builtinVoiceRemoved,
                    censorEnabled: items.censorEnabled === undefined ? true : !!items.censorEnabled,
                    censorMode: ['remove', 'beep', 'replace', 'dashes'].indexOf(items.censorMode) >= 0 ? items.censorMode : 'remove',   // [AGENT-EXP] 2026-11-17: + 'dashes' (przekleństwo → ----------)
                    censorCustomWords: String(items.censorCustomWords || '')
                }
            });
        });
        return true;
    }
    return;
});

// Zmiany ustawień z popupu → push do offscreen (SETTINGS_PATCH), bo offscreen
// nie słyszy chrome.storage.onChanged.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const patch = {};
    if (changes.tempoMode) patch.tempoMode = changes.tempoMode.newValue; // OPTIONS-PAGE
    if (changes.autoCatchup) patch.autoCatchup = changes.autoCatchup.newValue;
    if (changes.readToEnd) patch.readToEnd = changes.readToEnd.newValue;   // [AGENT-EXP] 2026-10-22
    if (changes.compressor) patch.compressor = changes.compressor.newValue;
    if (changes.liveBufTTLDays) patch.liveBufTTLDays = changes.liveBufTTLDays.newValue;
    if (changes.ttsVolume) patch.ttsVolume = changes.ttsVolume.newValue;
    if (changes.piperSpeed) patch.piperSpeed = changes.piperSpeed.newValue;
    if (changes.ttsEngine) patch.ttsEngine = changes.ttsEngine.newValue;
    // [AGENT-EXP] Aktualizuj próbkę TTS2 bez restartu rozszerzenia.
    if (changes.tts2Voice) patch.tts2Voice = changes.tts2Voice.newValue;
    // [AGENT-EXP] Aktualizuj profil Audio8 bez restartu rozszerzenia.
    if (changes.audio8Voice) patch.audio8Voice = changes.audio8Voice.newValue;
    if (changes.pocketVoice) patch.pocketVoice = changes.pocketVoice.newValue;   // [AGENT-EXP] Pocket-TTS-PL
    if (changes.omnivoiceVoice) patch.omnivoiceVoice = changes.omnivoiceVoice.newValue;   // [AGENT-EXP] OmniVoice
    if (changes.kokoroVoice) patch.kokoroVoice = changes.kokoroVoice.newValue;   // [AGENT-EXP] 2026-10-27 Kokoro
    if (changes.serverUrl) patch.serverUrl = changes.serverUrl.newValue;   // [FIX 2026-11-02] Serwer lokalny — własny adres
    if (changes.serverVoice) patch.serverVoice = changes.serverVoice.newValue;
    if (changes.pronDict) patch.pronDict = changes.pronDict.newValue || '';   // [FIX 2026-11-02]
    if (changes.shortenLong) patch.shortenLong = changes.shortenLong.newValue === true;
    if (changes.matchaVoice) patch.matchaVoice = changes.matchaVoice.newValue;   // [AGENT-EXP] Matcha-TTS-PL
    if (changes.matchaWebTryb) patch.matchaWebTryb = changes.matchaWebTryb.newValue;   // [AGENT-EXP] 2026-10-24: wariant Matcha 🌐
    if (changes.supertonicVoice) patch.supertonicVoice = changes.supertonicVoice.newValue;   // [VOX] Supertonic
    if (changes.supertonicSteps) patch.supertonicSteps = changes.supertonicSteps.newValue;
    if (changes.engineBackend) patch.engineBackend = changes.engineBackend.newValue;
    if (changes.browserVoice) patch.browserVoice = changes.browserVoice.newValue;   // [AGENT-EXP] 🗣 głos przeglądarki
    if (changes.offlineVoice) patch.offlineVoice = changes.offlineVoice.newValue;
    if (changes.customVoice) patch.customVoice = changes.customVoice.newValue;
    if (changes.builtinVoiceRemoved) patch.builtinVoiceRemoved = changes.builtinVoiceRemoved.newValue;
    if (changes.censorEnabled) patch.censorEnabled = changes.censorEnabled.newValue;
    if (changes.censorMode) patch.censorMode = changes.censorMode.newValue;
    if (changes.censorCustomWords) patch.censorCustomWords = changes.censorCustomWords.newValue;
    if (!Object.keys(patch).length) return;
    // ENERGIA: nie tworzymy dokumentu lektora tylko po to, żeby przekazać ustawienia —
    // gdy go nie ma, przeczyta je sam z storage przy starcie.
    hasOffscreen()
        .then((has) => { if (has) return sendOffscreen({ action: 'SETTINGS_PATCH', settings: patch }); })
        .catch(() => {});
});

// [AGENT-EXP] 2026-10-17: napisy z pliku należą do FILMU: fileSubs = { name, cues, loadedAt, page }.
// Każdy wczytany plik trafia też do pamięci fileSubsMem { klucz filmu: wpis } (FILE_MEM_MAX ostatnich filmów),
// więc po powrocie do filmu napisy wracają. Skrypty stron pytają LEKTOR_FILE_FOR_ME (klucz z adresu karty —
// także w ramce odtwarzacza). Zmiana adresu karty → LEKTOR_FILE_RECHECK do karty. „✕ Usuń” (LEKTOR_FILE_CLEAR)
// kasuje plik i jego wpis w pamięci. Stary wpis bez strony (sprzed tej zmiany) — usuwany od razu.
const FILE_MEM_MAX = 20;   // [AGENT-EXP] 2026-11-06: 10 → 20 filmów w pamięci napisów
function fileSubsPageKey(url) {
    try {
        const u = new URL(url); const keep = [];
        ['v', 'id', 'video', 'vid', 'video_id', 'episode', 'ep', 'watch', 'movie', 'film', 'p'].forEach((k) => { const x = u.searchParams.get(k); if (x) keep.push(k + '=' + x); });
        return u.origin + u.pathname + '?' + keep.join('&');
    } catch (e) { return String(url || ''); }
}
async function fileSubsDropIf(test) {
    try {
        const f = (await chrome.storage.local.get('fileSubs')).fileSubs;
        if (f && test(f)) await chrome.storage.local.remove('fileSubs');
    } catch (e) {}
}
fileSubsDropIf((f) => !f.page);
async function fileSubsFor(url) {
    if (!url) return null;
    const key = fileSubsPageKey(url);
    const r = await chrome.storage.local.get(['fileSubs', 'fileSubsMem']);
    const f = r.fileSubs;
    if (f && f.page && fileSubsPageKey(f.page) === key) return f;
    const mem = r.fileSubsMem && typeof r.fileSubsMem === 'object' ? r.fileSubsMem : {};
    return mem[key] || null;
}
// nowy plik → do pamięci filmów (najstarsze wypadają)
chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !ch.fileSubs) return;
    const f = ch.fileSubs.newValue;
    if (!f || !f.page || !Array.isArray(f.cues) || !f.cues.length) return;
    chrome.storage.local.get('fileSubsMem').then((r) => {
        const mem = r.fileSubsMem && typeof r.fileSubsMem === 'object' ? r.fileSubsMem : {};
        mem[fileSubsPageKey(f.page)] = { name: f.name, cues: f.cues, loadedAt: f.loadedAt || Date.now(), page: f.page, dur: f.dur || 0 };   // [AGENT-EXP] 2026-11-06: dur — długość filmu (kontrola przy wczytywaniu z pamięci)
        const keys = Object.keys(mem).sort((a, b) => (mem[b].loadedAt || 0) - (mem[a].loadedAt || 0));
        keys.slice(FILE_MEM_MAX).forEach((k) => { delete mem[k]; });
        return chrome.storage.local.set({ fileSubsMem: mem });
    }).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (!info.url) return;
    chrome.tabs.sendMessage(tabId, { action: 'LEKTOR_FILE_RECHECK' }, () => { void chrome.runtime.lastError; });
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.action === 'LEKTOR_FILE_FOR_ME') {
        fileSubsFor(sender && sender.tab ? sender.tab.url : '').then((file) => sendResponse({ file }), () => sendResponse({ file: null }));
        return true;
    }
    if (msg.action === 'LEKTOR_AUDIO_KEYS') {     // [AGENT-EXP] 📊 pasek lektora: nagrane kwestie tej karty
        (async () => {
            const tab = sender && sender.tab ? sender.tab.id : null;
            if (tab == null || !(await hasOffscreen())) return [];
            const r = await sendOffscreen({ action: 'TTS_CACHE_KEYS' });
            const pre = tab + '|';
            return ((r && r.keys) || []).filter((k) => typeof k === 'string' && k.indexOf(pre) === 0)
                .map((k) => k.slice(pre.length).split('#')[0]);
        })().then((keys) => sendResponse({ keys }), () => sendResponse({ keys: [] }));
        return true;
    }
    if (msg.action === 'LEKTOR_STATS') {   // [FIX 2026-11-02] 📊 pasek lektora: pominięte kwestie i opóźnienie tej karty
        (async () => {
            const tab = sender && sender.tab ? sender.tab.id : null;
            if (tab == null || !(await hasOffscreen())) return null;
            return sendOffscreen({ action: 'TTS_STATS', tab: String(tab) });
        })().then((r) => sendResponse(r || null), () => sendResponse(null));
        return true;
    }
    if (msg.action === 'LEKTOR_FILE_FOR_TAB') {   // popup: status dla aktywnej karty
        chrome.tabs.get(msg.tabId).then((t) => fileSubsFor(t && t.url)).then((file) => sendResponse({ file }), () => sendResponse({ file: null }));
        return true;
    }
    // [AGENT-EXP] 2026-11-06: „⬇ Pobierz całe napisy” na dowolnej stronie → strona zapamiętana (lowcaSites).
    // Następny film na tej stronie startuje sam: lektor + cenzor + Łowca (kontenery napisów) bez klikania.
    if (msg.action === 'FULL_SUBS_REMEMBER') {
        (async () => {
            const tab = sender && sender.tab;
            if (!tab || tab.id == null) { sendResponse({ ok: false }); return; }
            const saved = await lowcaRemember(tab.url, sender.url).catch(() => '');
            await lowcaEnsureLektor(tab.id, tab.url).catch(() => {});
            sendResponse({ ok: true, saved: !!saved });
        })();
        return true;
    }
    if (msg.action === 'LEKTOR_FILE_CLEAR') {     // popup „✕ Usuń wczytane napisy”: plik + pamięć tego filmu
        (async () => {
            const t = msg.tabId != null ? await chrome.tabs.get(msg.tabId).catch(() => null) : null;
            const r = await chrome.storage.local.get('fileSubsMem');
            const mem = r.fileSubsMem && typeof r.fileSubsMem === 'object' ? r.fileSubsMem : {};
            if (t && t.url) delete mem[fileSubsPageKey(t.url)];
            await chrome.storage.local.set({ fileSubsMem: mem });
            await chrome.storage.local.remove('fileSubs');
        })().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
        return true;
    }
});

// [AGENT-EXP] 2026-10-17: klucz bufora lektora = karta + id + skrót tekstu. Skrypty stron numerują kwestie
// od zera (np. YouTube 'tt_0', 'tt_1'…) w każdej karcie i każdym filmie, a offscreen trzymał nagranie pod samym id —
// druga karta / następny film odtwarzały gotowe nagranie kwestii z POPRZEDNIEGO filmu.
function ttsCacheId(msg, sender) {
    const t = String(msg.text || '');
    let h = 5381;
    for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
    const tab = sender && sender.tab && sender.tab.id != null ? sender.tab.id : 'x';
    return tab + '|' + msg.id + '|' + (h >>> 0).toString(36);
}

// [AGENT-EXP] 2026-10-17 🎯 Tryb „tylko OCR” — włącza się sam razem z OCR (bez przełącznika).
// Póki OCR działa na jakiejś karcie: lektor czyta TYLKO kwestie OCR (id 'ocrt_…'), reszta TTS_PLAY / TTS_PRELOAD
// jest pomijana, globalne TTS_PAUSE / TTS_CLEAR_BUFFER innych skryptów nie przerywają OCR, paczki EXT_TR_LIST /
// EXT_TR_PUSH (buforowanie całych napisów) CZEKAJĄ do końca OCR, a EXT_TR_LIVE bez znacznika ocr dostaje odmowę.
// Karty z włączonym OCR: chrome.storage.session 'ocrOnlyTabs' (przeżywa uśpienie service workera).
const OCR_ONLY = { tabs: new Set(), waiters: [] };
try {
    chrome.storage.session.get('ocrOnlyTabs').then((s) => {
        (Array.isArray(s && s.ocrOnlyTabs) ? s.ocrOnlyTabs : []).forEach((t) => OCR_ONLY.tabs.add(t));
    }).catch(() => {});
    chrome.tabs.onRemoved.addListener((id) => { if (OCR_ONLY.tabs.has(id)) ocrOnlySet(id, false); });
} catch (e) {}
function ocrOnly() { return OCR_ONLY.tabs.size > 0; }
function ocrOnlySet(tabId, on) {
    if (tabId == null) return;
    const was = ocrOnly();
    if (on) OCR_ONLY.tabs.add(tabId); else OCR_ONLY.tabs.delete(tabId);
    try { chrome.storage.session.set({ ocrOnlyTabs: [...OCR_ONLY.tabs] }); } catch (e) {}
    const now = ocrOnly();
    if (now === was) return;
    console.log('[LiveDub SW] tryb „tylko OCR”: ' + (now ? 'WŁ.' : 'wył.'));
    if (now) { hasOffscreen().then((ok) => { if (ok) sendOffscreen({ action: 'TTS_CLEAR_BUFFER' }).catch(() => {}); }).catch(() => {}); } // ucisz to, co lektor czytał przed OCR
    else { const w = OCR_ONLY.waiters.splice(0); w.forEach((r) => r()); } // wstrzymane paczki tłumaczenia ruszają
}
function ocrOnlyWait() { return ocrOnly() ? new Promise((r) => OCR_ONLY.waiters.push(r)) : Promise.resolve(); }
function ocrOnlyBlocksTts(msg) {
    if (!ocrOnly()) return false;
    if (msg.action === 'TTS_PLAY' || msg.action === 'TTS_PRELOAD') return String(msg.id == null ? '' : msg.id).indexOf('ocrt_') !== 0;
    return msg.action === 'TTS_PAUSE' || msg.action === 'TTS_CLEAR_BUFFER';
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.action) return;
    if (msg.target === 'offscreen') return;
    if (ocrOnlyBlocksTts(msg)) { sendResponse({ status: 'ocr-only' }); return; }   // [AGENT-EXP] tryb „tylko OCR”
    if ((msg.action === 'TTS_PRELOAD' || msg.action === 'TTS_PLAY') && msg.id != null) msg = { ...msg, id: ttsCacheId(msg, _sender) };   // [AGENT-EXP]
    if (msg.action === 'TTS_PLAY' && _sender && _sender.tab) narratorTabNote(_sender.tab.id);   // [FIX 2026-11-02] adresaci TTS_QUEUE_IDLE
    // [FIX 2026-11-02] pauza / czyszczenie ze strony niosą kartę — offscreen pomija je, gdy czyta inna karta
    if ((msg.action === 'TTS_PAUSE' || msg.action === 'TTS_CLEAR_BUFFER') && _sender && _sender.tab && _sender.tab.id != null) msg = { ...msg, tab: String(_sender.tab.id) };
    if (msg.action === 'OFFSCREEN_READY') {
        sendResponse({ status: 'ok' });
        return true;
    }

    const route = Object.hasOwn(TTS_ROUTES, msg.action) ? TTS_ROUTES[msg.action] : null;   // nie metody Object.prototype
    if (!route) return;
    route(msg).then(sendResponse, (err) => {
        console.error('[Multilektor SW] mowa:', err);
        sendResponse({ status: 'error', error: (err && err.message) || String(err) });
    });
    return true;
});

// [AGENT-EXP] 2026-10-21: router mowy napisany od nowa (Multilektor). Każde zlecenie dla dokumentu lektora dostaje
// aktualny silnik i głosy ze storage — pierwsza kwestia po zmianie ustawienia trafia od razu do właściwego silnika.
const TTS_KEYS = ['engine', 'piperSpeed', 'ttsEngine', 'tts2Voice', 'audio8Voice', 'pocketVoice', 'omnivoiceVoice', 'kokoroVoice', 'matchaVoice', 'serverUrl', 'serverVoice',
    'supertonicVoice', 'supertonicSteps', 'engineBackend', 'browserVoice', 'matchaWebTryb', 'lookaheadMin'];   // [AGENT-EXP] 2026-10-25: lookaheadMin → bramka zapasu   // [AGENT-EXP] 2026-10-24: matchaWebTryb
const TTS_ENGINES = ['sherpa', 'matcha', 'xtts', 'audio8', 'f5', 'pocket', 'omnivoice', 'kokoro', 'server', 'supertonic', 'browser'];
const str = (v, dflt, allowEmpty) => (typeof v === 'string' && (allowEmpty || v) ? v : dflt);
async function ttsEngineFields(withSpeed) {
    const s = await chrome.storage.local.get(TTS_KEYS);
    const f = {
        voiceId: SHERPA_VOICE,
        ttsEngine: TTS_ENGINES.includes(s.ttsEngine) ? s.ttsEngine : 'matcha',   // [AGENT-EXP] 2026-10-24
        tts2Voice: str(s.tts2Voice, '', true),
        audio8Voice: str(s.audio8Voice, 'default', true),
        pocketVoice: str(s.pocketVoice, 'ref'),
        omnivoiceVoice: str(s.omnivoiceVoice, 'male, young adult, moderate pitch', true),   // '' = losowy
        kokoroVoice: str(s.kokoroVoice, 'pm_mateusz'),   // [AGENT-EXP] 2026-10-27 Kokoro
        serverUrl: str(s.serverUrl, 'ws://127.0.0.1:9000'),   // [FIX 2026-11-02] Serwer lokalny — własny adres
        serverVoice: str(s.serverVoice, '', true),
        matchaVoice: str(s.matchaVoice, 'web:male_voxcpm_2:elegancki'),   // [AGENT-EXP] 2026-10-24
        ...supertonicSettings(s),   // [VOX] Supertonic: głos, jakość, CPU/GPU
        browserVoice: str(s.browserVoice, '', true),   // 🗣 głos przeglądarki ('' = automatycznie)
        matchaWebTryb: s.matchaWebTryb === 'cpu_fp32' ? 'cpu_fp32' : 'kombi',   // [AGENT-EXP] 2026-10-24: wariant Matcha 🌐
        lookaheadMin: Number.isFinite(Number(s.lookaheadMin)) && s.lookaheadMin !== undefined ? Number(s.lookaheadMin) : 3   // [AGENT-EXP] 2026-10-25: suwak zapasu dla bramki w offscreen
    };
    if (withSpeed) f.piperSpeed = Number(s.piperSpeed) || 1;
    return f;
}
const TTS_ROUTES = {
    async TTS_RESTART_OFFSCREEN() {
        try { await chrome.offscreen.closeDocument(); } catch (_) { /* dokumentu nie było */ }
        await ensureOffscreen();
        return { status: 'restarted' };
    },
    async INIT_TTS(msg) { return callOffscreen({ ...msg, ...(await ttsEngineFields()) }); },
    async CLEAR_CACHE(msg) { return callOffscreen({ ...msg, ...(await ttsEngineFields()) }); },
    async TTS_PRELOAD(msg) {
        await userBlockedReady;   // [FIX 2026-11-02]
        if (isBlockedPhrase(msg.text)) return { status: 'blocked' };   // fraza na czarnej liście — bez syntezy
        const fields = await ttsEngineFields();
        callOffscreen({ ...msg, ...fields }, 20).catch(() => {});   // nie czekamy: nagrywanie do przodu idzie w tle
        return { status: 'queued' };
    },
    async TTS_PLAY(msg) {
        await userBlockedReady;   // [FIX 2026-11-02]
        if (isBlockedPhrase(msg.text)) return { status: 'blocked' };
        return callOffscreen({ ...msg, ...(await ttsEngineFields(true)) });
    },
    // [AGENT-EXP] 2026-10-17: pauza / czyszczenie NIE tworzą i NIE zamykają dokumentu lektora. Wcześniej
    // callOffscreen(…, allowKill) zamykał dokument, gdy ten (świeżo tworzony) nie odpowiedział na PING
    // w ~1 s — YouTube wysyła je często, więc dokument był zabijany w kółko (serwery TTS widziały
    // zerwane połączenie 1001, nagrania do przodu przepadały). Nie ma dokumentu = nie ma czego czyścić.
    async TTS_PAUSE(msg) { if (await hasOffscreen()) sendOffscreen(msg).catch(() => {}); return { status: 'stopped' }; },
    async TTS_CLEAR_BUFFER(msg) { if (await hasOffscreen()) sendOffscreen(msg).catch(() => {}); return { status: 'stopped' }; }
};

// [FIX 2026-11-02] zamknięta karta, z której lektor właśnie czytał — kolejka tej karty przestaje grać
// (wcześniej po zamknięciu karty lektor dokańczał jeszcze kilka zaległych kwestii). Inne karty: offscreen pomija.
chrome.tabs.onRemoved.addListener((tabId) => {
    hasOffscreen().then((ok) => { if (ok) return sendOffscreen({ action: 'TTS_CLEAR_BUFFER', tab: String(tabId) }); }).catch(() => {});
});

// ===== Nagrywanie lektora (REC) — orkiestracja sesji + pobieranie WAV =====
// Przycisk REC na stronie (assets/rec_button.js) → tu → offscreen (zapis kwestii do IndexedDB).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.action) return;
    if (msg.action !== 'CENSOR_STATS'
        && msg.action !== 'REC_START' && msg.action !== 'REC_STOP'
        && msg.action !== 'REC_STATUS' && msg.action !== 'REC_EXPORT'
        && msg.action !== 'REC_TELEMETRY') return;

    (async () => {
        try {
            // Telemetria NIE tworzy offscreena (leci co 2 s z zakładki).
            // Klucz PER PLATFORMA — zakładki nie nadpisują swoich statystyk nawzajem.
            if (msg.action === 'REC_TELEMETRY') {
                try {
                    const plat = (msg.platform === 'youtube' || msg.platform === 'dom') ? msg.platform : 'netflix';
                    // [FIX 2026-11-02] storage.session (pamięć przeglądarki): zapis co 2 s z każdej karty z filmem nie budzi już
                    // nasłuchów chrome.storage.onChanged we wszystkich kartach (skrypty stron nie widzą obszaru „session”)
                    await chrome.storage.session.set({
                        ['__recTelemetry_' + plat]: {
                            platform: plat,
                            nowMs: msg.nowMs == null ? null : msg.nowMs,   // [AGENT-EXP] 2026-11-16: null = brak wideo (nie „00:00”)
                            durMs: msg.durMs || 0,
                            aheadMs: msg.aheadMs || 0,
                            preloaded: msg.preloaded || 0,
                            total: msg.total || 0,
                            aheadWords: msg.aheadWords || 0,
                            remainingWords: msg.remainingWords || 0,
                            remainingCues: msg.remainingCues || 0,
                            spokenWords: msg.spokenWords || 0,
                            totalWords: msg.totalWords || 0,
                            // [AGENT-EXP] 2026-11-16: popup pokazywał „źródło — / plików 0”, bo te pola nie były zapisywane.
                            live: msg.live ? 1 : 0,
                            activeSource: msg.activeSource || '',
                            sources: msg.sources || 0,
                            onScreen: msg.onScreen || '',
                            recent: Array.isArray(msg.recent) ? msg.recent : [],
                            ts: Date.now()
                        }
                    });
                } catch (e) { /* ignore */ }
                sendResponse({ ok: true });
                return;
            }

            await ensureOffscreen();

            // Statystyki cenzury dla popupu — ile języków i słów jest aktywnych
            // (popup pokazuje faktyczny zasięg list, nie liczbę na sztywno).
            if (msg.action === 'CENSOR_STATS') {
                const resp = await sendOffscreen({ target: 'offscreen', action: 'GET_STATUS' });
                sendResponse({
                    ok: !!(resp && resp.status === 'ok'),
                    languages: (resp && resp.censorLanguages) || 0,
                    words: (resp && resp.censorWords) || 0
                });
                return;
            }


            if (msg.action === 'REC_START') {
                const sessionId = msg.sessionId || ('rec_' + Date.now());
                // Metadane sesji przetrwają restart service workera.
                try {
                    await chrome.storage.local.set({
                        __recSession: { sessionId, title: msg.title || '', url: msg.url || '', startedAt: Date.now() }
                    });
                } catch (e) { /* ignore */ }
                const resp = await sendOffscreen({ target: 'offscreen', action: 'REC_START', sessionId });
                sendResponse({ ok: !!(resp && resp.ok), error: resp && resp.error, sessionId });
                return;
            }

            if (msg.action === 'REC_STOP') {
                const resp = await sendOffscreen({ target: 'offscreen', action: 'REC_STOP' });
                sendResponse({ ok: !!(resp && resp.ok), count: resp && resp.count, error: resp && resp.error });
                return;
            }

            if (msg.action === 'REC_STATUS') {
                const resp = await sendOffscreen({ target: 'offscreen', action: 'REC_STATUS' });
                sendResponse({
                    recording: !!(resp && resp.recording),
                    count: (resp && resp.count) || 0,
                    sessionId: resp && resp.sessionId
                });
                return;
            }

            // REC_EXPORT — offscreen skleja kwestie w jeden WAV i zwraca blob URL.
            let session = null;
            try { session = (await chrome.storage.local.get('__recSession')).__recSession; } catch (e) { /* ignore */ }
            const sessionId = (session && session.sessionId) || msg.sessionId;
            const resp = await sendOffscreen({
                target: 'offscreen', action: 'REC_EXPORT',
                sessionId, title: msg.title || (session && session.title) || 'nagranie'
            });
            if (!resp || !resp.ok) {
                sendResponse({ ok: false, error: (resp && resp.error) || 'Offscreen nie odpowiedział' });
                return;
            }
            const filename = recFilename(msg.title || (session && session.title) || 'nagranie');
            try {
                const dlId = await chrome.downloads.download({
                    url: resp.url,
                    filename: filename,
                    saveAs: false, // bez okna „Zapisz jako" — plik od razu trafia do Pobranych
                    conflictAction: 'uniquify'
                });
                // Auto-czyszczenie: po eksporcie bufor (IndexedDB) usuwa się sam,
                // a metadane sesji wygasają.
                try { chrome.storage.local.remove('__recSession'); } catch (e2) {}
                try { sendOffscreen({ target: 'offscreen', action: 'REC_DELETE', sessionId }).catch(() => {}); } catch (e2) {}
                sendResponse({
                    ok: true, downloadId: dlId, filename,
                    count: resp.count, durationMs: resp.durationMs, sizeBytes: resp.sizeBytes
                });
            } catch (dlErr) {
                sendResponse({ ok: false, error: 'Pobieranie nie powiodło się: ' + ((dlErr && dlErr.message) || dlErr) });
            }
        } catch (err) {
            console.error('[LiveDub SW] REC:', err);
            sendResponse({ ok: false, error: (err && err.message) || String(err) });
        }
    })();
    return true;
});
// ===== [AGENT-EXP] 2026-10-17: „💾 Zapisz bufor filmu” (popup) =====
// Offscreen składa ZIP z kwestii w RAM dla podanej karty → zapis do Pobranych.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.action !== 'TTS_SAVE_BUFFER' || msg.target === 'offscreen') return;
    (async () => {
        try {
            if (!(await hasOffscreen())) { sendResponse({ ok: false, error: 'Lektor jeszcze nic nie nagrał (bufor pusty).' }); return; }
            const resp = await sendOffscreen({ target: 'offscreen', action: 'TTS_SAVE_BUFFER', tabId: msg.tabId });
            if (!resp || !resp.ok) { sendResponse({ ok: false, error: (resp && resp.error) || 'Offscreen nie odpowiedział' }); return; }
            const filename = recFilename(msg.title || 'film').replace(/\.wav$/, ' - kwestie.zip');
            const dlId = await chrome.downloads.download({ url: resp.url, filename, saveAs: false, conflictAction: 'uniquify' });
            sendResponse({ ok: true, downloadId: dlId, filename, count: resp.count, sizeBytes: resp.sizeBytes });
        } catch (err) {
            sendResponse({ ok: false, error: (err && err.message) || String(err) });
        }
    })();
    return true;
});

// ===== Lowca Napisow (szukanie na zadanie) =====
// Popup "Szukaj napisow" -> LOWCA_START -> executeScript: najpierw mostek
// (assets/lowca_bridge.js, ISOLATED), potem hunter (assets/lowca_napisow.js, MAIN).
// Hunter emituje ush:container/ush:found -> bridge agreguje -> LOWCA_RESULTS
// -> merge selektorow do customSources[host] (Kreator napisow).
// [FIX 2026-11-22] Stan Łowcy OSOBNO dla każdej karty (dawniej jeden na całą przeglądarkę: popup na innej karcie
// pokazywał cudze „Szukam…”, Stop szedł do aktywnej karty, a ładowanie DOWOLNEJ karty kasowało stan).
// lowcaTabs = { [tabId]: { on, host, sels, containers, items, auto, saved, startedAt, fresh, ts } } w storage.session.
const LOWCA_TABS_KEY = 'lowcaTabs';
function lowcaEmpty() { return { on: false, host: '', sels: [], containers: 0, items: [], auto: null, saved: '', startedAt: 0, fresh: false, ts: 0 }; }
function lowcaTabsAll() {
    return chrome.storage.session.get(LOWCA_TABS_KEY).then(
        (d) => (d && d[LOWCA_TABS_KEY] && typeof d[LOWCA_TABS_KEY] === 'object') ? d[LOWCA_TABS_KEY] : {}
    ).catch(() => ({}));
}
function lowcaStateGet(tabId) {
    return lowcaTabsAll().then((m) => Object.assign(lowcaEmpty(), (tabId != null && m[tabId]) || {}, { tabId: tabId != null ? tabId : null }));
}
// zapisy po kolei (wyniki przychodzą z wielu ramek naraz); patch może być funkcją (stary stan → zmiany)
let lowcaStateChain = Promise.resolve();
function lowcaStateSet(tabId, patch) {
    const run = async () => {
        if (tabId == null) return Object.assign(lowcaEmpty(), typeof patch === 'function' ? {} : patch);
        const m = await lowcaTabsAll();
        const prev = Object.assign(lowcaEmpty(), m[tabId] || {});
        const next = Object.assign(prev, typeof patch === 'function' ? patch(prev) : patch, { ts: Date.now(), tabId });
        m[tabId] = next;
        await chrome.storage.session.set({ [LOWCA_TABS_KEY]: m }).catch(() => {});
        return next;
    };
    lowcaStateChain = lowcaStateChain.then(run, run);
    return lowcaStateChain;
}
function lowcaStateClear(tabId) {
    const run = async () => {
        const m = await lowcaTabsAll();
        if (!m[tabId]) return;
        delete m[tabId];
        await chrome.storage.session.set({ [LOWCA_TABS_KEY]: m }).catch(() => {});
    };
    lowcaStateChain = lowcaStateChain.then(run, run);
    return lowcaStateChain;
}
chrome.storage.session.remove('lowcaState').catch(() => {});   // stary, wspólny stan (sprzed 2026-11-22)
function lowcaBroadcast(state) {
    try { chrome.runtime.sendMessage({ action: 'LOWCA_STATUS', state }).catch(() => {}); }
    catch (e) { /* popup zamkniety */ }
}
async function lowcaInject(tabId) {
    await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: LOWCA_ISOLATED
    });
    await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        files: ['assets/i18n_en.js', 'assets/i18n.js', 'assets/lowca_napisow.js']   // [AGENT-EXP] 2026-10-21: język interfejsu (PL / EN)
    });
    // GUI (checkbox „Pokazuj GUI Łowcy”) ustawiamy bezpośrednio w MAIN — nie zależy od mostka,
    // który po przeładowaniu rozszerzenia może zostać osierocony (flaga __LOWCA_BRIDGE__ w karcie).
    const { lowcaGui } = await chrome.storage.local.get('lowcaGui');
    await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        args: [!!lowcaGui],
        func: (gui) => { try { if (window.__USH__ && typeof window.__USH__.gui === 'function') window.__USH__.gui(gui); } catch (e) {} }
    }).catch(() => {});
    chrome.tabs.sendMessage(tabId, { action: 'LOWCA_CMD', cmd: 'start' }, () => { void chrome.runtime.lastError; });
}

// ===== Łowca: pamięć domen (lowcaSites) =====
// Gdy Łowca znajdzie napisy z kwestiami, zapamiętujemy domenę karty (i domenę ramki odtwarzacza).
// Na zapamiętanych domenach Łowca + lektor startują same (registerContentScripts), a znalezione
// napisy idą prosto do lektora (lowca_auto.js → LOWCA_AUTO_CUES → LOWCA_AUTO_APPLY).
// Lista do podglądu/usuwania: strona opcji, sekcja „Łowca napisów”.
const LOWCA_ISOLATED = ['assets/i18n_en.js', 'assets/i18n.js', 'assets/lowca_bridge.js', 'assets/lowca_auto.js'];   // [AGENT-EXP] 2026-10-21: i18n ustawia data-ml-lang dla Łowcy (MAIN)

// [OCR-TOOL] OCR niezależny od Łowcy: menu przycisku CC → OCR_TOOL_CMD (wstrzyknij assets/ocr_tool.js do ramek
// karty i przekaż komendę); strona → OCR_TOOL_RECOGNIZE / OCR_TOOL_STOP → silnik w dokumencie lektora (ocr_engine.js).
const OCR_TOOL_ACTIONS = ['OCR_TOOL_CMD', 'OCR_TOOL_RECOGNIZE', 'OCR_TOOL_STOP', 'OCR_TOOL_STATE', 'OCR_TOOL_SCREEN', 'OCR_TOOL_FIND'];   // [AGENT-EXP] OCR_TOOL_FIND = 🎯 auto-ramka (samo wykrywanie tekstu)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target === 'offscreen' || !OCR_TOOL_ACTIONS.includes(msg.action)) return;
    (async () => {
        try {
            if (msg.action === 'OCR_TOOL_CMD') {
                const tabId = sender && sender.tab && sender.tab.id;
                if (tabId == null) { sendResponse({ ok: false }); return; }
                await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['assets/i18n_en.js', 'assets/i18n.js', 'assets/lektor_scheduler.js', 'assets/ocr_tool.js'] }).catch(() => {});   // [FIX 2026-11-02] + harmonogram (wskaźnik źródła)   // [AGENT-EXP] 2026-10-21: język interfejsu (PL / EN)
                chrome.tabs.sendMessage(tabId, { action: 'OCR_TOOL', cmd: msg.cmd }, (r) => {
                    void chrome.runtime.lastError;
                    sendResponse(r || { ok: false, novideo: true });
                });
                return;
            }
            if (msg.action === 'OCR_TOOL_SCREEN') { // [EKRAN] zrzut widocznej części karty (ramka OCR poza obrazem filmu)
                const tab = sender && sender.tab;
                if (!tab || sender.frameId !== 0) { sendResponse({ ok: false, error: 'tylko główna ramka' }); return; }
                try {
                    const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 92 });
                    sendResponse({ ok: true, image });
                } catch (e) {
                    let err = String((e && e.message) || e);
                    if (/all_urls|activeTab/.test(err)) err = 'brak dostępu do tej strony — w chrome://extensions → Lektor → Szczegóły → „Dostęp do witryn” ustaw „We wszystkich witrynach”';
                    sendResponse({ ok: false, error: err });
                }
                return;
            }
            if (msg.action === 'OCR_TOOL_STATE') { // narzędzie (dowolna ramka) → przycisk CC w głównej ramce
                const tabId = sender && sender.tab && sender.tab.id;
                ocrOnlySet(tabId, !!msg.on);   // [AGENT-EXP] tryb „tylko OCR”
                if (tabId != null) chrome.tabs.sendMessage(tabId, { action: 'OCR_TOOL_STATE_PUSH', on: !!msg.on, status: msg.status || '' }, { frameId: 0 }, () => { void chrome.runtime.lastError; });
                sendResponse({ ok: true });
                return;
            }
            if (msg.action === 'OCR_TOOL_STOP') ocrOnlySet(sender && sender.tab && sender.tab.id, false);   // [AGENT-EXP]
            if (msg.action === 'OCR_TOOL_STOP' && !(await hasOffscreen())) { sendResponse({ ok: true }); return; }
            const r = await callOffscreen({ action: msg.action, image: msg.image, langs: msg.langs, engine: msg.engine, model: msg.model }, 30);
            sendResponse(r || { ok: false, error: 'brak odpowiedzi silnika' });
        } catch (e) {
            sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
    })();
    return true;
});

// [CC] Lekki przycisk CC Łowcy na każdej stronie z filmem — TYLKO gdy zaznaczony „Pokazuj GUI Łowcy”.
// Zaznaczony → rejestrujemy assets/lowca_cc_stub.js (nowe strony) i wstrzykujemy go do otwartych kart;
// odznaczony → wyrejestrowujemy, a przyciski na otwartych stronach same znikają (słuchają storage).
// [FIX 2026-11-02] 📋 przy „Tylko domeny z listy” przycisk jest tylko na domenach z białej listy (bez czarnej) —
// na pozostałych stronach nie ma żadnego skryptu lektora (dawniej przycisk sprawdzał każdą stronę co 2 s).
const CC_STUB_ID = 'lektor-cc-stub';
const CC_STUB_JS = ['assets/i18n_en.js', 'assets/i18n.js', 'assets/lowca_cc_stub.js'];   // [AGENT-EXP] 2026-10-21: język interfejsu (PL / EN)
let ccStubChain = Promise.resolve();
function ccStubSync(on, injectOpen) {
    ccStubChain = ccStubChain.then(() => ccStubSyncNow(on, injectOpen), () => ccStubSyncNow(on, injectOpen));
    return ccStubChain;
}
async function ccStubSyncNow(on, injectOpen) {
    try {
        const reg = (await chrome.scripting.getRegisteredContentScripts({ ids: [CC_STUB_ID] }).catch(() => []))[0] || null;
        if (!on) { if (reg) await chrome.scripting.unregisterContentScripts({ ids: [CC_STUB_ID] }).catch(() => {}); return; }
        const lists = await chrome.storage.local.get(['domainListsOn', 'domainWhitelist', 'domainBlacklist']);
        const listsOn = lists.domainListsOn !== false;
        const white = listsOn ? DL.patterns(DL.parse(lists.domainWhitelist)) : [];
        const black = listsOn ? DL.patterns(DL.parse(lists.domainBlacklist)) : [];
        const script = { id: CC_STUB_ID, js: CC_STUB_JS, matches: white.length ? white : ['http://*/*', 'https://*/*'], allFrames: false, runAt: 'document_idle' };
        if (black.length) script.excludeMatches = black;
        const key = (r) => JSON.stringify([r.matches || [], r.excludeMatches || []]);
        if (!reg || key(reg) !== key(script)) {   // przy każdym starcie tła — tylko gdy coś się zmieniło
            if (reg) await chrome.scripting.unregisterContentScripts({ ids: [CC_STUB_ID] }).catch(() => {});
            await chrome.scripting.registerContentScripts([script]);
        }
        if (injectOpen) {
            const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
            for (const t of tabs) {
                if (DL.state(DL.hostOf(t.url), '', lists).asleep) continue;
                chrome.scripting.executeScript({ target: { tabId: t.id }, files: CC_STUB_JS }).catch(() => {});
            }
        }
    } catch (e) { console.warn('[LiveDub SW] przycisk CC:', e); }
}
chrome.storage.local.get('lowcaGui').then((r) => ccStubSync(!!(r && r.lowcaGui), false)).catch(() => {});
chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.lowcaGui) ccStubSync(!!ch.lowcaGui.newValue, true);
    else if (ch.domainWhitelist || ch.domainBlacklist || ch.domainListsOn) {   // [FIX 2026-11-02] 📋 nowe listy = nowe strony przycisku
        chrome.storage.local.get('lowcaGui').then((r) => { if (r && r.lowcaGui) ccStubSync(true, false); }).catch(() => {});
    }
});
const LOWCA_LEKTOR_FRAMES = ['assets/i18n_en.js', 'assets/i18n.js', 'assets/domain_lists.js', 'assets/options_hooks.js', 'assets/lektor_bar.js', 'assets/lektor_scheduler.js', 'assets/dom_content.js'];   // [FIX 2026-11-02] + wspólny harmonogram   // [AGENT-EXP] 2026-10-21: i18n — język paneli   // [AGENT-EXP] lektor_bar: 📊 pasek postępu
const LOWCA_LEKTOR_TOP = ['assets/i18n_en.js', 'assets/i18n.js', 'assets/lektor-controls.js', 'assets/lektor-settings.js'];   // [AGENT-EXP] 2026-10-21
// Serwisy z wbudowanym lektorem (manifest) — tam nic nie dokładamy.
const LOWCA_BUILTIN = /(^|\.)(netflix\.com|youtube\.com|youtube-nocookie\.com|primevideo\.com|amazon\.com|iq\.com|iqiyi\.com|dailymotion\.com|dai\.ly|rumble\.com|viki\.com|wetv\.vip|bilibili\.com|bilibili\.tv|hbomax\.com|max\.com)$/;   // [AGENT-EXP] 2026-11-06: HBO Max ma lektora w manifeście (jak Netflix) — bez dokładania z Łowcy
// [FIX 2026-11-16] Facebook = WYŁĄCZONY: manifest nie wstrzykuje tam żadnych skryptów (ani lektora, ani cenzora),
// a ta reguła blokuje dołożenie lektora/Łowcy z pamięci „⬇ całe napisy”/Łowcy (lowcaSites) i z lowcaEnsureLektor.
const LOWCA_CENSOR_ONLY = /(^|\.)facebook\.com$/;

const LOWCA_SCRIPT_IDS = ['lowca-auto-isolated', 'lowca-auto-main', 'lowca-auto-lektor', 'lowca-auto-top', 'lowca-auto-cenzor-main', 'lowca-auto-cenzor-bridge'];   // [AGENT-EXP] 2026-10-25: + 🤐 cenzor

function lowcaHostOf(url) {
    try {
        const u = new URL(String(url || ''));
        if (!/^https?:$/.test(u.protocol)) return '';
        return u.hostname.replace(/^www\./, '').toLowerCase();
    } catch (e) { return ''; }
}
function lowcaMatches(hosts) {
    const out = [];
    for (const h of hosts) {
        if (!h || !/^[a-z0-9.-]+$/.test(h)) continue;
        out.push('*://' + h + '/*');
        if (!/^\d+(\.\d+){3}$/.test(h)) out.push('*://*.' + h + '/*');
    }
    return out;
}
async function lowcaSitesGet() {
    const { lowcaSites } = await chrome.storage.local.get('lowcaSites');
    return (lowcaSites && typeof lowcaSites === 'object') ? lowcaSites : {};
}
// Zwraca host karty, jeśli został nowo zapamiętany (albo doszła nowa domena ramki), inaczej ''.
async function lowcaRemember(tabUrl, frameUrl) {
    const top = lowcaHostOf(tabUrl);
    if (!top || LOWCA_BUILTIN.test(top) || LOWCA_CENSOR_ONLY.test(top)) return '';
    const frame = lowcaHostOf(frameUrl);
    const sites = await lowcaSitesGet();
    const s = sites[top] || { frames: [], ts: 0, hits: 0 };
    const isNew = !sites[top];
    let changed = isNew;
    if (frame && frame !== top && !LOWCA_BUILTIN.test(frame) && !s.frames.includes(frame)) { s.frames.push(frame); s.frames = s.frames.slice(-8); changed = true; }
    s.ts = Date.now(); s.hits = (s.hits || 0) + 1;
    sites[top] = s;
    await chrome.storage.local.set({ lowcaSites: sites }); // onChanged → lowcaSyncScripts
    return changed ? top : '';
}
// [FIX 2026-11-16] sprzątanie: wyrzuć Facebooka z zapamiętanych stron Łowcy (inaczej lektor/Łowca startował tam z listy).
(async () => {
    try {
        const sites = await lowcaSitesGet();
        let changed = false;
        Object.keys(sites).forEach((h) => { if (LOWCA_CENSOR_ONLY.test(h)) { delete sites[h]; changed = true; } });
        if (changed) await chrome.storage.local.set({ lowcaSites: sites });
    } catch (e) {}
})();

let lowcaSyncChain = Promise.resolve();
function lowcaSyncScripts() {
    lowcaSyncChain = lowcaSyncChain.then(lowcaSyncScriptsNow, lowcaSyncScriptsNow);
    return lowcaSyncChain;
}
async function lowcaSyncScriptsNow() {
    try {
        const sites = await lowcaSitesGet();
        // [FIX 2026-11-02] 📋 tylko strony dozwolone przez listy domen — na pozostałych Łowca nie startuje (zero procesora)
        const lists = await chrome.storage.local.get(['domainListsOn', 'domainWhitelist', 'domainBlacklist']);
        const black = lists.domainListsOn === false ? [] : DL.parse(lists.domainBlacklist);
        const tops = Object.keys(sites).filter((h) => !LOWCA_BUILTIN.test(h) && !LOWCA_CENSOR_ONLY.test(h) && !DL.state(h, '', lists).asleep);
        const all = new Set(tops);
        tops.forEach((h) => (sites[h].frames || []).forEach((f) => { if (!LOWCA_BUILTIN.test(f) && !LOWCA_CENSOR_ONLY.test(f) && !DL.matches(f, black)) all.add(f); }));
        const reg = await chrome.scripting.getRegisteredContentScripts({ ids: LOWCA_SCRIPT_IDS }).catch(() => []);
        if (reg.length) await chrome.scripting.unregisterContentScripts({ ids: reg.map((r) => r.id) }).catch(() => {});
        const allM = lowcaMatches(all), topM = lowcaMatches(tops);
        if (!allM.length) return;
        const scripts = [
            { id: 'lowca-auto-isolated', js: LOWCA_ISOLATED, matches: allM, allFrames: true, runAt: 'document_start' },
            { id: 'lowca-auto-main', js: ['assets/i18n_en.js', 'assets/i18n.js', 'assets/lowca_napisow.js'], world: 'MAIN', matches: allM, allFrames: true, runAt: 'document_start' },
            { id: 'lowca-auto-lektor', js: LOWCA_LEKTOR_FRAMES, matches: allM, allFrames: true, runAt: 'document_idle' },
            // [AGENT-EXP] 2026-10-25: 🤐 cenzor na stronach Łowcy — wycisza z napisów lektora (dom_content.js → cenzor_main.js)
            { id: 'lowca-auto-cenzor-main', js: ['assets/censor.js', 'assets/pmt_mute_timer.js', 'assets/cenzor_main.js'], world: 'MAIN', matches: allM, allFrames: true, runAt: 'document_start' },   // [FIX 2026-11-22] + model PMT (jak manifest)   // [FIX 2026-11-02] wspólny silnik cenzora
            { id: 'lowca-auto-cenzor-bridge', js: ['assets/cenzor_bridge.js'], matches: allM, allFrames: true, runAt: 'document_start' }
        ];
        if (topM.length) scripts.push({ id: 'lowca-auto-top', js: LOWCA_LEKTOR_TOP, matches: topM, allFrames: false, runAt: 'document_idle' });
        await chrome.scripting.registerContentScripts(scripts);
    } catch (e) {
        console.error('[LiveDub SW] Łowca — rejestracja skryptów:', e);
    }
}
lowcaSyncScripts();
chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && (ch.lowcaSites || ch.domainWhitelist || ch.domainBlacklist || ch.domainListsOn)) lowcaSyncScripts();
});
// Dokłada lektora (dom_content + panel) do ramek karty, w których go jeszcze nie ma —
// po pierwszym „Szukaj napisów” na nowej stronie lektor rusza od razu, bez odświeżania.
async function lowcaEnsureLektor(tabId, tabUrl) {
    if (LOWCA_BUILTIN.test(lowcaHostOf(tabUrl)) || LOWCA_CENSOR_ONLY.test(lowcaHostOf(tabUrl))) return;
    const res = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => ({ lek: !!window.__LIVEDUB_AUTO_APPLY__, video: !!document.querySelector('video'), url: location.href })
    }).catch(() => []);
    // Tylko główna ramka i ramki z filmem (nie reklamy / widżety).
    const need = res.filter((r) => r && r.result && !r.result.lek && /^https?:/.test(r.result.url) && (r.frameId === 0 || r.result.video)).map((r) => r.frameId);
    if (need.length) {
        await chrome.scripting.executeScript({ target: { tabId, frameIds: need }, files: LOWCA_LEKTOR_FRAMES }).catch(() => {});
        // [AGENT-EXP] 2026-10-25: 🤐 cenzor od razu, bez odświeżania (cenzor_main.js musi być przed mostem — most wysyła ustawienia)
        await chrome.scripting.executeScript({ target: { tabId, frameIds: need }, files: ['assets/censor.js', 'assets/pmt_mute_timer.js', 'assets/cenzor_main.js'], world: 'MAIN' }).catch(() => {});   // [FIX 2026-11-22] + model PMT (dawniej brak → tryby „pmt”/„pmtpos” bez modelu na stronach Łowcy)   // [FIX 2026-11-02] wspólny silnik cenzora
        await chrome.scripting.executeScript({ target: { tabId, frameIds: need }, files: ['assets/cenzor_bridge.js'] }).catch(() => {});
    }
    const top = res.find((r) => r && r.frameId === 0);
    if (top && top.result && !top.result.lek) {
        await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: LOWCA_LEKTOR_TOP }).catch(() => {});
    }
}
// [FIX 2026-11-02] 🧪 Kreator napisów. Wskazywanie myszką rusza we wszystkich ramkach karty — wybór albo Esc w jednej
// ramce kończy je w pozostałych (KREATOR_STOP). Zapisany selektor (KREATOR_SITE) na stronie bez wbudowanego lektora =
// lektor startuje tam sam, jak na stronie Łowcy (od razu w otwartej karcie), a przy „Tylko domeny z listy” strona
// z paska adresu trafia na białą listę.
// [FIX 2026-11-10] 🎯 Wskazywanie napisów z POPUPU (KREATOR_PICK_SAVE). Popup zamyka się, gdy tylko klikniemy w stronę,
// więc wybór zapisuje TŁO — tutaj, po KREATOR_PICKED. Popup tylko pokazuje listę i stan (customSources/customSourcesOn).
const KREATOR_FILES = ['assets/i18n_en.js', 'assets/i18n.js', 'assets/domain_lists.js', 'assets/options_hooks.js'];
const KREATOR_PENDING_KEY = 'kreatorPickPending';   // { tabId, top, at } — wskazywanie rozpoczęte z popupu
const KREATOR_PICK_MS = 5 * 60 * 1000;             // starszy wybór nie jest z popupu (taki zapisze strona Ustawień)
// [FIX 2026-11-22] jeden limit własnych selektorów na domenę — Kreator i Łowca (dawniej 20 i 12: Łowca po cichu
// wyrzucał najstarsze wpisy, także te wskazane ręcznie myszką)
const CUSTOM_SOURCES_MAX = 20;
const KREATOR_FRAMES_KEY = 'kreatorFrameHosts';     // { [domena strony]: [domeny ramek odtwarzacza z napisami] }
// Narzędzia Kreatora (wskazywanie, test) siedzą w options_hooks.js — na stronach spoza listy dokładamy je doraźnie.
async function kreatorEnsureTools(tabId) {
    const res = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => !!(window.__LivedubOpts && window.__LivedubOpts.customSelectors)
    }).catch(() => []);
    const need = (res || []).filter((r) => r && r.result === false).map((r) => r.frameId);
    if (!need.length) return;
    await chrome.scripting.executeScript({ target: { tabId, frameIds: need }, files: KREATOR_FILES }).catch(() => {});
}
async function kreatorStartPick(tabId) {
    if (tabId == null) return { ok: false, error: 'brak karty' };
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !/^https?:/i.test(tab.url || '')) return { ok: false, error: 'To nie jest strona www — otwórz film w zwykłej karcie' };
    await kreatorEnsureTools(tabId);
    const top = lowcaHostOf(tab.url);
    await chrome.storage.local.set({ [KREATOR_PENDING_KEY]: { tabId, top, at: Date.now() } });
    const r = await new Promise((res) => chrome.tabs.sendMessage(tabId, { action: 'KREATOR_PICK' }, (x) => { void chrome.runtime.lastError; res(x || null); }));
    if (!r || !r.ok) {
        await chrome.storage.local.remove(KREATOR_PENDING_KEY).catch(() => {});
        return { ok: false, error: 'Ta strona nie pozwala na wskazywanie (strona systemowa albo sklep Chrome)' };
    }
    return { ok: true, host: DL.norm(r.host) || top, top };
}
// domena + lektor po zapisaniu selektora: to samo, co robi „💾 Dodaj” w Ustawieniach (KREATOR_SITE)
async function kreatorSiteSaved(host, tabId, topHint) {
    const h = DL.norm(host);
    if (!h) return { listed: '', remembered: '' };
    const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
    const top = tab && tab.url ? lowcaHostOf(tab.url) : '';
    // selektor z tej karty (sama strona albo ramka odtwarzacza w niej) — liczy się strona z paska adresu
    const fromTab = !!top && (DL.matches(h, [top]) || DL.matches(top, [h]) || DL.norm(topHint) === top);
    const pageUrl = fromTab ? tab.url : 'https://' + h + '/';
    const listed = await domainListsAllow(pageUrl).catch(() => '');
    let remembered = '';
    if (!LOWCA_BUILTIN.test(h)) {
        remembered = await lowcaRemember(pageUrl, fromTab && h !== top ? 'https://' + h + '/' : '').catch(() => '');
        if (fromTab && tab) await lowcaEnsureLektor(tab.id, tab.url).catch(() => {});
    }
    return { listed, remembered };
}
// wybór myszką z popupu → customSources[host] (bez otwierania Ustawień). Zwraca null, gdy wskazywanie nie było z popupu.
async function kreatorSavePick(msg, sender) {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (tabId == null) return null;
    const pend = (await chrome.storage.local.get(KREATOR_PENDING_KEY).catch(() => ({})))[KREATOR_PENDING_KEY];
    if (!pend || pend.tabId !== tabId) return null;   // wskazywanie ze strony Ustawień — zapisze je ona
    await chrome.storage.local.remove(KREATOR_PENDING_KEY).catch(() => {});
    // [FIX 2026-11-22] wybór po czasie: dawniej znikał bez śladu (popup zamknięty, brak toastu) — teraz czerwony
    // toast na stronie i wpis w kreatorLastPick, który popup pokaże przy następnym otwarciu
    if (Date.now() - (pend.at || 0) > KREATOR_PICK_MS) {
        const error = 'minęło ponad ' + Math.round(KREATOR_PICK_MS / 60000) + ' min od kliknięcia 🎯.';
        await chrome.storage.local.set({ kreatorLastPick: { ok: false, error, at: Date.now(), tabId } }).catch(() => {});
        chrome.tabs.sendMessage(tabId, { action: 'KREATOR_SAVED', ok: false, error, selector: String(msg.selector || '') }, () => { void chrome.runtime.lastError; });
        return { ok: false, error };
    }
    const sel = String(msg.selector || '').trim().slice(0, 300);
    const h = DL.norm(msg.host) || String(pend.top || '');
    if (!h || !sel) return { ok: false };
    const data = await chrome.storage.local.get(['customSources', 'customSourcesOn']);
    const cs = (data.customSources && typeof data.customSources === 'object') ? data.customSources : {};
    const on = (data.customSourcesOn && typeof data.customSourcesOn === 'object') ? data.customSourcesOn : {};
    const list = Array.isArray(cs[h]) ? cs[h].slice() : [];
    if (list.indexOf(sel) === -1) list.push(sel);
    cs[h] = list.slice(-CUSTOM_SOURCES_MAX);   // ręczny wybór jest najświeższy — przy pełnej liście wypada najstarszy
    on[h] = true;
    // [FIX 2026-11-22] napisy w RAMCE odtwarzacza: selektor zostaje TYLKO pod domeną ramki (tam czytają lektor i cenzor —
    // obie strony biorą host ramki). Dawniej (2026-11-15) kopiowaliśmy go też pod domenę strony, żeby panel nie pokazywał
    // 0 źródeł — ale selektor był zawężany w DOM-ie ramki, więc na stronie głównej mógł łapać przypadkowe teksty.
    // Teraz zapamiętujemy tylko powiązanie strona → ramka (popup pokazuje je razem) i sprzątamy starą kopię.
    const topH = DL.norm(String(msg.top || pend.top || ''));
    let frameMap = null;
    if (topH && topH !== h) {
        const fm = (await chrome.storage.local.get(KREATOR_FRAMES_KEY).catch(() => ({})))[KREATOR_FRAMES_KEY];
        frameMap = (fm && typeof fm === 'object') ? fm : {};
        const fl = Array.isArray(frameMap[topH]) ? frameMap[topH].filter((x) => x !== h) : [];
        fl.push(h);
        frameMap[topH] = fl.slice(-5);
        if (Array.isArray(cs[topH])) {
            cs[topH] = cs[topH].filter((x) => x !== sel);
            if (!cs[topH].length) delete cs[topH];
        }
    }
    if (frameMap) await chrome.storage.local.set({ [KREATOR_FRAMES_KEY]: frameMap });
    await chrome.storage.local.set({ customSources: cs, customSourcesOn: on });
    const site = await kreatorSiteSaved(h, tabId, String(msg.top || ''));
    await chrome.storage.local.set({ kreatorLastPick: { ok: true, host: h, selector: sel, at: Date.now(), tabId } }).catch(() => {});
    // potwierdzenie na stronie (popup jest już zamknięty) — toast w options_hooks.js
    chrome.tabs.sendMessage(tabId, { action: 'KREATOR_SAVED', ok: true, host: h, selector: sel }, () => { void chrome.runtime.lastError; });
    return { ok: true, host: h, selector: sel, site };
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.action === 'KREATOR_PICKED' || msg.action === 'KREATOR_PICK_CANCEL') {
        const tabId = sender && sender.tab ? sender.tab.id : null;
        if (tabId == null) return;
        chrome.tabs.sendMessage(tabId, { action: 'KREATOR_STOP' }, () => { void chrome.runtime.lastError; });
        if (msg.action === 'KREATOR_PICKED') {
            // z popupu zapisuje tło (popup już nie istnieje); z Ustawień — strona Ustawień (kreatorSavePick zwraca null)
            kreatorSavePick(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
            return true;
        }
        chrome.storage.local.get(KREATOR_PENDING_KEY).then((r) => {   // Esc: czyścimy tylko własne wskazywanie tej karty
            const p = r && r[KREATOR_PENDING_KEY];
            if (p && p.tabId === tabId) return chrome.storage.local.remove(KREATOR_PENDING_KEY);
        }).catch(() => {});
        return;
    }
    if (msg.action === 'KREATOR_PICK_SAVE') {
        (async () => kreatorStartPick(msg.tabId != null ? msg.tabId : (sender && sender.tab ? sender.tab.id : null)))()
            .then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
        return true;
    }
    if (msg.action !== 'KREATOR_SITE') return;
    (async () => {
        const h = DL.norm(msg.host);
        if (!h) return { ok: false };
        const site = await kreatorSiteSaved(h, msg.tabId, String(msg.top || ''));
        return Object.assign({ ok: true }, site);
    })().then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
});
// ===== Bazy napisów (popup „🌐 Szukaj w bazach napisów”, subs_db.js) =====
// Wynik trafia do fileSubs (jak plik z dysku). Napisy nie po polsku tłumaczymy tu, w tle, od miejsca
// filmu — fileSubs odświeżane co kilka paczek, więc lektor czyta już przetłumaczone kwestie.
let subsDbJob = 0;
async function subsDbVideoMs(tabId) {
    if (tabId == null) return 0;
    const r = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => { const v = document.querySelector('video'); return v && v.duration ? v.currentTime * 1000 : -1; }
    }).catch(() => []);
    return Math.max(0, ...r.map((x) => (x && typeof x.result === 'number') ? x.result : -1));
}
async function subsDbTranslate(msg) {
    const job = ++subsDbJob;
    const name = String(msg.name || 'napisy');
    const src = String(msg.lang || 'auto') || 'auto';
    const items = (msg.cues || []).map((c) => ({ startMs: c.startMs, endMs: c.endMs, src: String(c.text || ''), text: '' }));
    if (!items.length) return;
    const now = await subsDbVideoMs(msg.tabId);
    const tabPage = msg.tabId != null ? ((await chrome.tabs.get(msg.tabId).catch(() => null)) || {}).url || '' : '';   // [AGENT-EXP]
    let first = items.findIndex((c) => c.endMs >= now);
    if (first < 0) first = 0;
    const order = [];
    for (let i = first; i < items.length; i++) order.push(i);
    for (let i = 0; i < first; i++) order.push(i);
    let done = 0, batches = 0, fails = 0, published = false;
    const startedAt = Date.now();
    const publish = async (final) => {
        const cur = (await chrome.storage.local.get('fileSubs')).fileSubs;
        if (job !== subsDbJob) return false;
        // Użytkownik w międzyczasie wczytał inny plik albo usunął napisy — nie nadpisujemy.
        if (cur && cur.subsDbJob !== job && (cur.loadedAt || 0) > startedAt) { subsDbJob++; return false; }
        if (!cur && published) { subsDbJob++; return false; }
        const cues = items.filter((c) => c.text).map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text }));
        if (!cues.length) return true;
        const pct = Math.round((done / items.length) * 100);
        await chrome.storage.local.set({ fileSubs: { name: '🌐 ' + name + (final ? '' : ' (tłumaczę: ' + pct + '%)'), cues, loadedAt: Date.now(), subsDbJob: job, tabId: msg.tabId, page: tabPage } });   // [AGENT-EXP] karta
        published = true;
        return true;
    };
    await chrome.storage.session.set({ subsDbState: { name, total: items.length, done: 0, job } }).catch(() => {});
    while (order.length) {
        if (job !== subsDbJob) return;
        const batch = [];
        let chars = 0;
        while (order.length && batch.length < 50 && chars < 2500) { const ix = order.shift(); batch.push(ix); chars += items[ix].src.length + 1; }
        let out = null;
        try { out = await extTrTranslateList(src, batch.map((ix) => items[ix].src)); } catch (e) { out = null; }
        if (job !== subsDbJob) return;
        if (!out || !out.length) {
            if (++fails > 4) { console.warn('[LiveDub SW] bazy napisów: tłumaczenie przerwane'); break; }
            order.unshift(...batch);
            await new Promise((r) => setTimeout(r, 5000));
            continue;
        }
        fails = 0;
        batch.forEach((ix, j) => { if (out[j]) items[ix].text = out[j]; });
        done += batch.length;
        await chrome.storage.session.set({ subsDbState: { name, total: items.length, done, job } }).catch(() => {});
        if (++batches === 1 || batches % 5 === 0) { if (!(await publish(false))) return; }
    }
    await publish(true);
}
const SUBSDB_ACTIONS = ['SUBSDB_SEARCH', 'SUBSDB_GET', 'SUBSDB_TRANSLATE', 'SUBSDB_PREPARE'];
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !SUBSDB_ACTIONS.includes(msg.action)) return;
    (async () => {
        try {
            if (msg.action === 'SUBSDB_SEARCH') { sendResponse(await subsDbSearch(msg.query || {})); return; }
            if (msg.action === 'SUBSDB_GET') { sendResponse({ ok: true, text: await subsDbGet(msg.item) }); return; }
            if (msg.action === 'SUBSDB_TRANSLATE') {
                subsDbTranslate(msg).catch((e) => console.error('[LiveDub SW] bazy napisów:', e));
                sendResponse({ ok: true });
                return;
            }
            if (msg.action === 'SUBSDB_PREPARE') {
                // Strona spoza listy wbudowanych: dołóż lektora do karty i zapamiętaj domenę (jak przy Łowcy).
                const tab = msg.tabId != null ? await chrome.tabs.get(msg.tabId).catch(() => null) : null;
                if (tab && tab.url) await domainListsAllow(tab.url).catch(() => '');   // [FIX 2026-11-02] 📋
                if (tab && tab.url && !LOWCA_BUILTIN.test(lowcaHostOf(tab.url))) {
                    await lowcaRemember(tab.url, '');
                    await lowcaEnsureLektor(tab.id, tab.url);
                }
                sendResponse({ ok: true });
                return;
            }
        } catch (err) {
            sendResponse({ ok: false, error: (err && err.message) || String(err) });
        }
    })();
    return true;
});
async function lowcaAutoCues(msg, sender, sendResponse) {
    const tab = sender && sender.tab;
    if (!tab || tab.id == null || !Array.isArray(msg.cues) || msg.cues.length < 5) { sendResponse({ ok: false }); return; }
    // [FIX 2026-11-02] 📋 strona poza listą domen (np. odtwarzacz z zapamiętanej domeny osadzony na obcej stronie):
    // nie zapamiętujemy jej i nie dokładamy lektora — sam z siebie nie rozchodzi się po kolejnych stronach.
    const lists = await chrome.storage.local.get(['domainListsOn', 'domainWhitelist', 'domainBlacklist']);
    if (DL.state(lowcaHostOf(tab.url), lowcaHostOf(sender.url), lists).asleep) { sendResponse({ ok: false, asleep: true }); return; }
    const saved = await lowcaRemember(tab.url, sender.url);
    await lowcaEnsureLektor(tab.id, tab.url);
    // [AGENT-EXP] 2026-10-25: cały plik HBO (z cenzora) — odbiorca LOWCA_AUTO_APPLY (lowca_auto.js, idempotentny) może jeszcze nie być w karcie
    if (msg.full) await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['assets/lowca_auto.js'] }).catch(() => {});
    chrome.tabs.sendMessage(tab.id, { action: 'LOWCA_AUTO_APPLY', cues: msg.cues, lang: msg.lang || '', full: !!msg.full, label: msg.label || '' }, () => { void chrome.runtime.lastError; });   // [AGENT-EXP] 2026-10-25 full: cały plik (HBO) ma pierwszeństwo przed kawałkami   // [AGENT-EXP] 2026-11-06 label: „czytam z: …”
    const patch = { auto: { n: msg.cues.length, lang: msg.lang || '', host: lowcaHostOf(tab.url) } };
    if (saved) patch.saved = saved;
    const st = await lowcaStateSet(tab.id, patch);
    lowcaBroadcast(st);
    sendResponse({ ok: true, saved: !!saved });
}
// [AGENT-EXP] 2026-11-06: 📌 „Zapamiętaj to źródło” (przycisk przy najlepszym znalezisku Łowcy) — dla całej domeny:
//  • domainSubPin[host] = zapis (stan przycisku w panelu Łowcy),
//  • lowcaSites[host] = strona startuje sama (Łowca + lektor + cenzor) na kolejnych filmach,
//  • customSourcesOn[host] = true — kontenery napisów zapisane przez Łowcę są używane.
// Wyłączenie: usuwa domainSubPin i zapomnienie strony (to samo, co usunięcie z listy Łowcy w Ustawieniach).
async function lowcaPin(msg, sender, sendResponse) {
    const host = String(msg.host || '').replace(/^www\./, '').toLowerCase();
    if (!host || !/^[a-z0-9.-]+$/.test(host)) { sendResponse({ ok: false }); return; }
    try {
        const tab = sender && sender.tab;
        const r = await chrome.storage.local.get(['domainSubPin', 'customSourcesOn']);
        const pins = (r.domainSubPin && typeof r.domainSubPin === 'object') ? r.domainSubPin : {};
        if (msg.on) {
            pins[host] = { on: true, at: Date.now(), label: String(msg.label || '').slice(0, 80), url: String(msg.url || '').slice(0, 300) };
        } else {
            delete pins[host];
        }
        await chrome.storage.local.set({ domainSubPin: pins });
        if (msg.on) {
            if (tab && tab.id != null) {
                await lowcaRemember(tab.url, sender.url).catch(() => '');
                await lowcaEnsureLektor(tab.id, tab.url).catch(() => {});
            }
            const on = (r.customSourcesOn && typeof r.customSourcesOn === 'object') ? r.customSourcesOn : {};
            if (on[host] === false) { on[host] = true; await chrome.storage.local.set({ customSourcesOn: on }); }
        } else if (tab && tab.url) {
            const top = lowcaHostOf(tab.url);
            const sites = await lowcaSitesGet();
            if (top && sites[top]) { delete sites[top]; await chrome.storage.local.set({ lowcaSites: sites }); }
        }
        sendResponse({ ok: true, on: !!msg.on });
    } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
}
async function lowcaResults(msg, sender, sendResponse) {
    const host = String(msg.host || '').replace(/^www\./, '').toLowerCase();
    const selectors = Array.isArray(msg.selectors)
        ? msg.selectors.filter((s) => typeof s === 'string' && s && s.length <= 300) : [];
    const items = Array.isArray(msg.items) ? msg.items.slice(-25) : [];
    if (host && selectors.length) {
        const data = await chrome.storage.local.get(['customSources', 'customSourcesOn']);
        const cs = (data.customSources && typeof data.customSources === 'object') ? data.customSources : {};
        const on = (data.customSourcesOn && typeof data.customSourcesOn === 'object') ? data.customSourcesOn : {};
        // [FIX 2026-11-22] wspólny limit z Kreatorem; Łowca tylko DOKŁADA do wolnych miejsc — nigdy nie wyrzuca
        // wcześniejszych wpisów (wśród nich mogą być selektory wskazane ręcznie myszką)
        const list = Array.isArray(cs[host]) ? cs[host].slice() : [];
        for (const s of selectors) if (!list.includes(s) && list.length < CUSTOM_SOURCES_MAX) list.push(s);
        cs[host] = list;
        if (on[host] === undefined) on[host] = true;
        await chrome.storage.local.set({ customSources: cs, customSourcesOn: on });
    }
    // [FIX 2026-11-22] wyniki z wielu ramek SUMUJEMY (dawniej ostatnia ramka nadpisywała liczniki poprzednich)
    const tab = sender && sender.tab;
    const st = await lowcaStateSet(tab ? tab.id : null, (prev) => {
        const sels = prev.sels.slice();
        for (const x of selectors) if (!sels.includes(x)) sels.push(x);
        const its = prev.items.slice();
        const key = (it) => (it && (it.url || ((it.label || '') + '|' + (it.lang || '')))) || '';
        for (const it of items) if (it && !its.some((o) => key(o) === key(it))) its.push(it);
        return { host: (tab && lowcaHostOf(tab.url)) || host || prev.host, sels: sels.slice(-20), containers: Math.min(sels.length, 20), items: its.slice(-25) };
    });
    lowcaBroadcast(st);
    sendResponse({ ok: true, saved: selectors.length });
}
// [FIX 2026-11-02] Proxy Łowcy pobiera tylko publiczne adresy http(s). Prośba przychodzi przez window.postMessage strony,
// więc bez tego dowolny skrypt strony mógł czytać przez rozszerzenie (bez CORS) serwery w sieci domowej / firmowej
// i lokalne usługi (127.0.0.1 — także serwery TTS). Napisy i playlisty leżą na publicznych CDN-ach.
function lowcaXhrAllowed(url) {
    let u;
    try { u = new URL(String(url || '')); } catch (e) { return false; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!h || h === 'localhost' || /\.(localhost|local|lan|internal|home|corp)$/.test(h)) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
        const [a, b] = h.split('.').map(Number);
        if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
    }
    if (h.indexOf(':') >= 0) {   // IPv6: pętla zwrotna, sieci lokalne (fc00::/7, fe80::/10), adresy IPv4 w IPv6
        if (h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^::ffff:/.test(h)) return false;
    }
    return true;
}
async function lowcaXhr(msg, sendResponse) {
    // Proxy GM_xmlhttpRequest z huntera (MAIN) - host *://*/* omija CORS.
    if (!lowcaXhrAllowed(msg.url)) { sendResponse({ id: msg.id, ok: false, status: 0, error: 'adres niedozwolony (tylko publiczne http/https)' }); return; }
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 30000);
    try {
        const res = await fetch(String(msg.url), { headers: msg.headers || {}, signal: ctrl.signal });
        const buf = new Uint8Array(await res.arrayBuffer()).slice(0, 32 * 1024 * 1024);
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        }
        let headers = '';
        try { const hs = []; res.headers.forEach((v, k) => hs.push(k + ': ' + v)); headers = hs.join('\r\n'); } catch (e) {}
        sendResponse({ id: msg.id, ok: res.ok, status: res.status, headers, b64: btoa(bin) });
    } catch (e) {
        sendResponse({ id: msg.id, ok: false, error: String((e && e.message) || e) });
    } finally {
        clearTimeout(timer);
    }
}
// ===== EXT-TRANSLATE (eksperyment): kolejka porcji sieciowych =====
// Content script wysyła kwestie; SW tnie na porcje wyrazowe i tłumaczy
// rotacyjnie Google→Bing→DeepL. Używane TYLKO gdy extTrOn === true.
try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || typeof msg.action !== 'string' || msg.action.indexOf('EXT_TR_') !== 0) return;
        const tabId = sender && sender.tab && sender.tab.id;
        if (msg.action === 'EXT_TR_PUSH') {
            if (tabId == null) { sendResponse({ ok: false }); return; }
            ocrOnlyWait().then(() => extTrJobPush(String(msg.jobId || ''), tabId, msg.lang, msg.items))   // [AGENT-EXP] czeka do końca OCR
                .then(() => sendResponse({ ok: true }))
                .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
            return true;
        }
        if (msg.action === 'EXT_TR_LIST') {
            ocrOnlyWait().then(() => extTrTranslateList(msg.src, msg.texts, msg.local === true, msg.brk))   // [AGENT-EXP] czeka do końca OCR   // [AGENT-EXP] local: napisy Łowcy — angielski lokalnie; brk: pauzy (kontekst)
                .then((texts) => sendResponse({ ok: true, texts }))
                .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
            return true;
        }
        // Pobranie pliku napisów dla auto_subs.js (bez CORS — uprawnienia rozszerzenia).
        if (msg.action === 'EXT_TR_FETCH') {
            const url = String(msg.url || '');
            if (url.indexOf('https://') !== 0) { sendResponse({ ok: false, status: 0, body: '' }); return; }
            fetch(url, { credentials: 'omit' }) // bez ciasteczek: z sesją pobiera tylko sama strona (auto_subs_hook.js)
                .then((r) => r.text().then((body) => sendResponse({ ok: r.ok, status: r.status, body: body.slice(0, 8 * 1024 * 1024) })))
                .catch((e) => sendResponse({ ok: false, status: 0, body: '' }));
            return true;
        }
        if (msg.action === 'EXT_TR_LIVE') {
            // [AGENT-EXP] msg.engine (OCR „Kto tłumaczy”) + w odpowiedzi silnik, który naprawdę przetłumaczył
            if (ocrOnly() && !msg.ocr) { sendResponse({ ok: false, error: 'tryb tylko OCR' }); return; }   // [AGENT-EXP] tryb „tylko OCR”
            extTrTranslateLive(msg.text, msg.engine)
                .then((r) => sendResponse({ ok: true, text: r.text, engine: r.engine }))
                .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
            return true;
        }
        // [AGENT-EXP] 🏁 Wyścig tłumaczy (okienko OCR): jedna linia jednym silnikiem, bez pamięci tłumaczeń
        if (msg.action === 'EXT_TR_RACE_ONE') {
            extTrRaceOne(String(msg.engine || ''), msg.text)
                .then((r) => sendResponse({ ok: !!r.text, text: r.text, ms: r.ms, error: r.text ? '' : 'puste tłumaczenie' }))
                .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 160) }));
            return true;
        }
        if (msg.action === 'EXT_TR_GTAB_TEXT') {
            gtabTranslateText(msg.src, msg.text)
                .then((text) => sendResponse({ ok: true, text }))
                .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
            return true;
        }
        if (msg.action === 'EXT_TR_CANCEL') {
            extTrJobCancel(String(msg.jobId || ''));
            sendResponse({ ok: true });
            return;
        }
    });
} catch (e) { /* ignore */ }
// ===== Pamięć napisów (90 dni, IndexedDB — subs_cache.js) =====
// Strony z lektorem pytają o gotowe napisy odcinka, zanim cokolwiek pobiorą lub przetłumaczą.
try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || typeof msg.action !== 'string' || msg.action.indexOf('PAMIEC_') !== 0) return;
        let p = null;
        if (msg.action === 'PAMIEC_VIDEO_GET') p = cacheGetVideo(msg.key).then((data) => ({ ok: true, data }));
        else if (msg.action === 'PAMIEC_VIDEO_PUT') p = cachePutVideo(msg.key, msg.data).then(() => ({ ok: true }));
        else if (msg.action === 'PAMIEC_STATS') p = cacheStats().then((stats) => ({ ok: true, stats }));
        else if (msg.action === 'PAMIEC_VIDEO_DEL') p = cacheDelVideo(msg.key).then(() => ({ ok: true }));   // [AGENT-EXP] 2026-11-26: 🔄 w karcie Status
        else if (msg.action === 'PAMIEC_CLEAR') p = cacheClear().then(() => ({ ok: true }));
        if (!p) return;
        p.then(sendResponse).catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
        return true;
    });
} catch (e) { /* ignore */ }
// Nawigacja kasuje wstrzykniete skrypty - czysc stan "on", zeby popup nie klamal.
try {
    chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
        // [FIX 2026-11-22] czyścimy tylko TĘ kartę (dawniej ładowanie dowolnej karty kasowało stan Łowcy)
        if (info && info.status === 'loading') lowcaStateClear(tabId);
        if (info && info.status === 'complete' && tabId === lowcaOnceTab) lowcaFreshDone(tabId, tab);
    });
    chrome.tabs.onRemoved.addListener((tabId) => { lowcaStateClear(tabId); if (tabId === lowcaOnceTab) lowcaOnceClear(); });
} catch (e) { /* ignore */ }
// ===== HBO Max: adres manifestu napisów z sieci (także pobranego przez workera odtwarzacza) =====
// [AGENT-EXP] 2026-11-06: strona nie widzi fetchtów z workera, a tam bywa manifest DASH/HLS. Tło podaje sam adres,
// a cenzor (świat MAIN) pobiera go normalnie i wyciąga z niego cały plik napisów — jak w Netflixie.
try {
    chrome.webRequest.onBeforeRequest.addListener((d) => {
        if (!d || d.tabId == null || d.tabId < 0 || !/\.(mpd|m3u8)(?=$|[?#])/i.test(d.url || '')) return;
        if (!/^https?:\/\/([^/]*\.)?(hbomax|max)\.com(\/|$)/i.test(d.initiator || '')) return;
        chrome.tabs.sendMessage(d.tabId, { action: 'HBO_MANIFEST_URL', url: d.url }, () => { void chrome.runtime.lastError; });
    }, { urls: ['<all_urls>'] });
} catch (e) { console.warn('[LiveDub SW] HBO manifest:', e); }
// [FIX 2026-11-22] ↻ Szukaj od startu strony. Po kliknięciu „Szukaj napisów” Łowca trafia na stronę, gdy odtwarzacz
// zwykle już pobrał napisy — przechwytywanie ich nie widzi, a ponowne pobranie z listy adresów zawodzi przy adresach
// podpisanych / jednorazowych / z pamięci (blob, MSE). Tu rejestrujemy Łowcę na document_start na JEDNO przeładowanie
// karty (bez pamięci podręcznej), po załadowaniu wyrejestrowujemy (najpóźniej po 30 s).
// Uwaga: rejestracja obejmuje wszystkie strony www (ramki odtwarzaczy bywają z innych domen) — dlatego tylko na chwilę.
const LOWCA_ONCE_IDS = ['lowca-once-isolated', 'lowca-once-main'];
let lowcaOnceTab = null, lowcaOnceTimer = 0;
async function lowcaOnceClear() {
    clearTimeout(lowcaOnceTimer); lowcaOnceTimer = 0;
    lowcaOnceTab = null;
    const reg = await chrome.scripting.getRegisteredContentScripts({ ids: LOWCA_ONCE_IDS }).catch(() => []);
    if (reg.length) await chrome.scripting.unregisterContentScripts({ ids: reg.map((r) => r.id) }).catch(() => {});
}
lowcaOnceClear();   // po restarcie tła — nic nie zostaje zarejestrowane na stałe
async function lowcaStartFresh(tabId) {
    const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
    if (!tab || !/^https?:/i.test(tab.url || '')) return { ok: false, error: 'To nie jest strona www — otwórz film w zwykłej karcie' };
    await domainListsAllow(tab.url).catch(() => '');
    await lowcaOnceClear();
    await chrome.scripting.registerContentScripts([
        { id: 'lowca-once-isolated', js: LOWCA_ISOLATED, matches: ['http://*/*', 'https://*/*'], allFrames: true, runAt: 'document_start', persistAcrossSessions: false },
        { id: 'lowca-once-main', js: ['assets/i18n_en.js', 'assets/i18n.js', 'assets/lowca_napisow.js'], world: 'MAIN', matches: ['http://*/*', 'https://*/*'], allFrames: true, runAt: 'document_start', persistAcrossSessions: false }
    ]);
    lowcaOnceTab = tabId;
    lowcaOnceTimer = setTimeout(() => { lowcaOnceClear(); }, 30000);
    await chrome.tabs.reload(tabId, { bypassCache: true });
    return { ok: true };
}
async function lowcaFreshDone(tabId, tab) {
    await lowcaOnceClear();
    const st = await lowcaStateSet(tabId, { on: true, host: lowcaHostOf(tab && tab.url), sels: [], containers: 0, items: [], auto: null, saved: '', startedAt: Date.now(), fresh: true });
    lowcaBroadcast(st);
    // GUI (checkbox) i start sesji — jak przy zwykłym „Szukaj napisów”
    const { lowcaGui } = await chrome.storage.local.get('lowcaGui');
    await chrome.scripting.executeScript({
        target: { tabId, allFrames: true }, world: 'MAIN', args: [!!lowcaGui],
        func: (gui) => { try { if (window.__USH__ && typeof window.__USH__.gui === 'function') window.__USH__.gui(gui); } catch (e) {} }
    }).catch(() => {});
    chrome.tabs.sendMessage(tabId, { action: 'LOWCA_CMD', cmd: 'start' }, () => { void chrome.runtime.lastError; });
}
const LOWCA_ACTIONS = ['LOWCA_START', 'LOWCA_START_FRESH', 'LOWCA_STOP', 'LOWCA_RESULTS', 'LOWCA_STATE', 'LOWCA_XHR', 'LOWCA_STATUS', 'LOWCA_AUTO_CUES', 'LOWCA_AUTO_CLEAR', 'LOWCA_PIN'];
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.action) return;
    if (!LOWCA_ACTIONS.includes(msg.action)) return;
    (async () => {
        try {
            if (msg.action === 'LOWCA_STATE') {
                sendResponse({ ok: true, state: await lowcaStateGet(msg.tabId) });
                return;
            }
            if (msg.action === 'LOWCA_STATUS') {
                // mostek z każdej ramki: „szuka” = którakolwiek ramka; „przestał” liczy się tylko z głównej ramki
                const tab = _sender && _sender.tab;
                if (!tab || tab.id == null) { sendResponse({ ok: false }); return; }
                const patch = (msg.on || _sender.frameId === 0) ? { on: !!msg.on } : {};
                const st = await lowcaStateSet(tab.id, patch);
                lowcaBroadcast(st);
                sendResponse({ ok: true });
                return;
            }
            if (msg.action === 'LOWCA_START_FRESH') {   // [FIX 2026-11-22] ↻ od startu strony
                const r = await lowcaStartFresh(msg.tabId);
                sendResponse(r);
                return;
            }
            if (msg.action === 'LOWCA_START') {
                // [CC] z przycisku CC na stronie: karta nadawcy; z popupu: aktywna karta
                let tab = (msg.fromPage && _sender && _sender.tab) ? _sender.tab : null;
                if (!tab) { const tabs = await chrome.tabs.query({ active: true, currentWindow: true }); tab = tabs && tabs[0]; }
                if (!tab || tab.id == null) throw new Error('Brak aktywnej karty');
                const listed = await domainListsAllow(tab.url).catch(() => '');   // [FIX 2026-11-02] 📋
                await lowcaInject(tab.id);
                if (msg.openPanel) {
                    await chrome.scripting.executeScript({
                        target: { tabId: tab.id }, world: 'MAIN',
                        func: () => { try { if (window.__USH__ && window.__USH__.panel) { window.__USH__.gui(true); window.__USH__.panel(true); } } catch (e) {} }
                    }).catch(() => {});
                }
                const st = await lowcaStateSet(tab.id, { on: true, host: lowcaHostOf(tab.url), sels: [], containers: 0, items: [], auto: null, saved: '', startedAt: Date.now(), fresh: false });
                lowcaBroadcast(st);
                sendResponse({ ok: true, listed, state: st });
                return;
            }
            if (msg.action === 'LOWCA_STOP') {
                // [FIX 2026-11-22] karta, którą pokazuje popup (msg.tabId), a nie „jakaś aktywna”
                let tabId = msg.tabId != null ? msg.tabId : null;
                if (tabId == null) { const tabs = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = tabs && tabs[0] ? tabs[0].id : null; }
                if (tabId != null) {
                    chrome.tabs.sendMessage(tabId, { action: 'LOWCA_CMD', cmd: 'stop' }, () => { void chrome.runtime.lastError; });
                }
                const st = await lowcaStateSet(tabId, { on: false });
                lowcaBroadcast(st);
                sendResponse({ ok: true });
                return;
            }
            if (msg.action === 'LOWCA_RESULTS') { await lowcaResults(msg, _sender, sendResponse); return; }
            if (msg.action === 'LOWCA_XHR') { await lowcaXhr(msg, sendResponse); return; }
            if (msg.action === 'LOWCA_AUTO_CUES') { await lowcaAutoCues(msg, _sender, sendResponse); return; }
            if (msg.action === 'LOWCA_PIN') { await lowcaPin(msg, _sender, sendResponse); return; }   // [AGENT-EXP] 2026-11-06: 📌
            if (msg.action === 'LOWCA_AUTO_CLEAR') {
                const tabId = _sender && _sender.tab && _sender.tab.id;
                if (tabId != null) chrome.tabs.sendMessage(tabId, { action: 'LOWCA_AUTO_APPLY', cues: null }, () => { void chrome.runtime.lastError; });
                sendResponse({ ok: true });
                return;
            }
        } catch (err) {
            console.error('[LiveDub SW] LOWCA:', err);
            sendResponse({ ok: false, error: (err && err.message) || String(err) });
        }
    })();
    return true;
});


function recFilename(title) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
        + '_' + p(d.getHours()) + '-' + p(d.getMinutes());
    const t = String(title || 'nagranie')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
        .replace(/\s+/g, ' ').trim().slice(0, 60) || 'nagranie';
    return 'lektor - ' + t + ' - ' + stamp + '.wav';
}


/* ===== [AGENT-EXP] 2026-11-14: stan lektora/cenzora per karta (karta „Status” w popupie, kropka na ikonie) ===== */
const tabStatus = new Map();   // tabId → { status, at } — najlepsza ŚWIEŻA ramka (liczona z tabFrames)
// [FIX 2026-11-21] stan per ramka: wcześniej zapis przyjmowano tylko, gdy „wynik” nie spadł — po wyłączeniu lektora
// albo przejściu na film z krótszymi napisami karta Status pokazywała stare dane aż do przeładowania strony.
const tabFrames = new Map();   // tabId → Map(frameId → { status, at })
const STATUS_FRESH_MS = 12000;
function pickTabStatus(tabId) {
    const frames = tabFrames.get(tabId);
    if (!frames) { tabStatus.delete(tabId); return; }
    const now = Date.now();
    let best = null;
    frames.forEach((rec, fid) => {
        if (now - rec.at > STATUS_FRESH_MS) { frames.delete(fid); return; }
        if (!best || statusScore(rec.status) > statusScore(best.status)) best = rec;
    });
    if (best) tabStatus.set(tabId, best); else { tabStatus.delete(tabId); tabFrames.delete(tabId); }
}
function statusScore(st) { return (st && st.lektor && st.lektor.source ? 1000 : 0) + (st && st.cenzor && st.cenzor.cues ? st.cenzor.cues : 0); }
function paintBadge(tabId) {
    const rec = tabStatus.get(tabId);
    const st = rec && Date.now() - rec.at < 20000 ? rec.status : null;
    let text = '', color = '#8e8e93';
    if (st) {
        const hasLektor = !!(st.lektor && st.lektor.source);
        const c = st.cenzor || {};
        if (hasLektor) { text = '●'; color = '#2ecc71'; }
        else if (c.on || c.live) { text = '●'; color = '#f1c40f'; }
    }
    try {
        chrome.action.setBadgeText({ tabId, text });
        chrome.action.setBadgeBackgroundColor({ tabId, color });
    } catch (e) {}
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.action === 'LEKTOR_STATUS_PUSH' && sender && sender.tab && sender.tab.id != null) {
        const id = sender.tab.id, st = msg.status || {};
        if (!tabFrames.has(id)) tabFrames.set(id, new Map());
        tabFrames.get(id).set(sender.frameId || 0, { status: st, at: Date.now() });
        pickTabStatus(id);
        if (sender.tab.active) paintBadge(id);
        return;
    }
    if (msg.action === 'GET_TAB_STATUS') {
        pickTabStatus(msg.tabId);
        const rec = tabStatus.get(msg.tabId);
        sendResponse({ ok: true, status: rec ? rec.status : null });
    }
});
try {
    chrome.tabs.onActivated.addListener((a) => { try { paintBadge(a.tabId); } catch (e) {} });
    chrome.tabs.onRemoved.addListener((tabId) => { tabStatus.delete(tabId); tabFrames.delete(tabId); });
    chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'loading' || info.url) { tabStatus.delete(tabId); tabFrames.delete(tabId); try { chrome.action.setBadgeText({ tabId, text: '' }); } catch (e) {} } });
} catch (e) {}
