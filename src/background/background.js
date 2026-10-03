const OFFSCREEN_PATH = chrome.runtime.getURL('src/offscreen/offscreen.html');

// W paczce jest DOKŁADNIE jeden głos (Sherpa VITS). Nazwy z dawnych list Pipera
// (pl_PL-gosia-medium, pl_PL-jarvis… ) nie istnieją — każde ustawienie sprowadzamy
// do oryginalnego głosu, żeby popup i silnik nie rozjeżdżały się nazwami.
const SHERPA_VOICE = 'pl_PL-meski_wg_glos-medium';

// ===== Blokowane frazy — lektor NIGDY ich nie czyta =====
// Centralny filtr: ostateczna kontrola odbywa się tutaj, przed TTS_PLAY → callOffscreen.
const BLOCKED_PHRASES = [
    'only the translation',
    'only the translation ,,'
];
function isBlockedPhrase(text) {
    if (!text || typeof text !== 'string') return false;
    const t = text.toLowerCase();
    for (let i = 0; i < BLOCKED_PHRASES.length; i++) {
        if (t.includes(BLOCKED_PHRASES[i])) return true;
    }
    for (let i = 0; i < userBlockedPhrases.length; i++) {
        if (t.includes(userBlockedPhrases[i])) return true;
    }
    return false;
}

// ===== Użytkownicze blokady z panelu (zapisane w chrome.storage.local) =====
// Ładuje się automatycznie przy starcie service workera i aktualizuje przy zmianach.
let userBlockedPhrases = [];

function loadUserBlockedPhrases() {
    try {
        const result = chrome.storage.local.get('userBlockedPhrases');
        userBlockedPhrases = Array.isArray(result.userBlockedPhrases) ? result.userBlockedPhrases : [];
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
    const justification = 'Play Piper TTS audio and run ONNX/WASM workers';
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
            console.warn('[LiveDub SW] offscreen message:', msg);
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

chrome.runtime.onInstalled.addListener(() => {
    ensureOffscreen().catch((err) => console.error('[LiveDub SW] offscreen install:', err));
});

ensureOffscreen().catch((err) => console.error('[LiveDub SW] offscreen boot:', err));

const TTS_ACTIONS = [
    'TTS_PRELOAD',
    'TTS_PLAY',
    'TTS_PAUSE',
    'TTS_CLEAR_BUFFER',
    'INIT_TTS',
    'CLEAR_CACHE',
    'TTS_RESTART_OFFSCREEN'
];

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
                chrome.storage.local.set({ __offscreenLog: Array.isArray(msg.entries) ? msg.entries : [] });
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
        chrome.storage.local.get(['ttsVolume', 'piperSpeed', 'offlineVoice', 'customVoice', 'builtinVoiceRemoved', 'censorEnabled', 'censorMode', 'censorCustomWords'], (items) => {
            sendResponse({
                settings: {
                    ttsVolume: items.ttsVolume === undefined ? 100 : items.ttsVolume,
                    piperSpeed: Number(items.piperSpeed) || 1,
                    offlineVoice: SHERPA_VOICE,
                    customVoice: (items.customVoice && typeof items.customVoice === 'object') ? items.customVoice : null,
                    builtinVoiceRemoved: !!items.builtinVoiceRemoved,
                    censorEnabled: items.censorEnabled === undefined ? true : !!items.censorEnabled,
                    censorMode: ['remove', 'beep', 'replace'].indexOf(items.censorMode) >= 0 ? items.censorMode : 'remove',
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
    if (changes.ttsVolume) patch.ttsVolume = changes.ttsVolume.newValue;
    if (changes.piperSpeed) patch.piperSpeed = changes.piperSpeed.newValue;
    if (changes.offlineVoice) patch.offlineVoice = changes.offlineVoice.newValue;
    if (changes.customVoice) patch.customVoice = changes.customVoice.newValue;
    if (changes.builtinVoiceRemoved) patch.builtinVoiceRemoved = changes.builtinVoiceRemoved.newValue;
    if (changes.censorEnabled) patch.censorEnabled = changes.censorEnabled.newValue;
    if (changes.censorMode) patch.censorMode = changes.censorMode.newValue;
    if (changes.censorCustomWords) patch.censorCustomWords = changes.censorCustomWords.newValue;
    if (!Object.keys(patch).length) return;
    ensureOffscreen()
        .then(() => sendOffscreen({ action: 'SETTINGS_PATCH', settings: patch }))
        .catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.action) return;
    if (msg.target === 'offscreen') return;
    if (msg.action === 'OFFSCREEN_READY') {
        sendResponse({ status: 'ok' });
        return true;
    }

    if (!TTS_ACTIONS.includes(msg.action)) return;

    (async () => {
        try {
            const settings = await chrome.storage.local.get(['engine', 'piperSpeed']);
            const voiceId = SHERPA_VOICE;

            if (msg.action === 'TTS_RESTART_OFFSCREEN') {
                try { await chrome.offscreen.closeDocument(); } catch (_) { /* ignore */ }
                await ensureOffscreen();
                sendResponse({ status: 'Offscreen restarted' });
                return;
            }

            if (msg.action === 'INIT_TTS' || msg.action === 'CLEAR_CACHE') {
                const resp = await callOffscreen({ ...msg, voiceId });
                sendResponse(resp);
                return;
            }

            if (msg.action === 'TTS_PRELOAD') {
                if (isBlockedPhrase(msg.text)) { sendResponse({ status: 'blocked' }); return; } // pomijamy wstępną syntezę
                callOffscreen({ ...msg, voiceId }, 20).catch(() => {});
                sendResponse({ status: 'Preload handled' });
                return;
            }

            if (msg.action === 'TTS_PLAY') {
                const piperSpeed = Number(settings.piperSpeed) || 1;
                if (isBlockedPhrase(msg.text)) { sendResponse({ status: 'blocked' }); return; } // fraza na czarnej liście
                const resp = await callOffscreen({ ...msg, voiceId, piperSpeed });
                sendResponse(resp);
                return;
            }

            if (msg.action === 'TTS_PAUSE' || msg.action === 'TTS_CLEAR_BUFFER') {
                callOffscreen(msg, 12).catch(() => {});
                sendResponse({ status: 'Paused/Cleared' });
            }
        } catch (err) {
            console.error('[LiveDub SW] TTS:', err);
            sendResponse({ status: 'error', error: (err && err.message) || String(err) });
        }
    })();
    return true;
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
                    await chrome.storage.local.set({
                        ['__recTelemetry_' + plat]: {
                            platform: plat,
                            nowMs: msg.nowMs || 0,
                            aheadMs: msg.aheadMs || 0,
                            preloaded: msg.preloaded || 0,
                            total: msg.total || 0,
                            aheadWords: msg.aheadWords || 0,
                            remainingWords: msg.remainingWords || 0,
                            remainingCues: msg.remainingCues || 0,
                            spokenWords: msg.spokenWords || 0,
                            totalWords: msg.totalWords || 0,
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
