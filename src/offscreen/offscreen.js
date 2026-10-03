// Offscreen bootstrap: register the message listener before loading Sherpa.

const SHERPA_VOICE = 'pl_PL-meski_wg_glos-medium';
const TTS_NORM_VER = 'kropka2'; // znacznik wersji normalizacji — widoczny w logu offscreen (popup)

let voiceId = SHERPA_VOICE;
let session = null;
let sessionBusy = false;
let sessionGen = 0;
// ===== PULA WORKERÓW SHERPA (wielordzeniowa synteza) =====
// SHERPA_POOL_SIZE = ile workerów (osobnych wątków CPU) syntezuje równocześnie.
// Workery powstają LENIWIE (gdy brakuje wolnego) — przy pojedynczych kwestiach
// zużycie pamięci jak dawniej; każdy worker ≈ 0,35–0,5 GB (model + dane WASM).
// 1 = zachowanie jak dotychczas; 6 = optimum z benchmarku 2026-09-16
const SHERPA_POOL_SIZE = 6; // BURST 3.9x, STREAM -46% vs 1 watek

// ===== WŁASNY GŁOS (model Sherpa/Piper wskazany przez użytkownika) =====
// Popup zapisuje 3 pliki modelu w IndexedDB ('lektorVoices'/'files'); worker
// startuje z ?voice=custom i czyta model stamtąd. espeak-ng-data pozostaje
// wspólna (z paczki) — głos musi być zgodny z polską fonetyką.
const CUSTOM_VOICE_BIG_ONNX_BYTES = 150 * 1024 * 1024; // powyżej tego ograniczamy pulę
const CUSTOM_VOICE_POOL = 2;                           // duży własny model = mniej workerów (RAM)
let customVoice = null; // { enabled, name, sizeOnnx } | null
// Wbudowany głos męski (plik w paczce) wyłączony przez użytkownika przyciskiem 🗑.
// Chrome nie pozwala rozszerzeniu kasować własnych plików, więc „usunięcie”
// wbudowanego głosu = ta flaga: silnik odmawia startu z wbudowanego modelu.
// Lektor mówi wtedy wyłącznie wybranym własnym głosem (jeśli jest zapisany).
let builtinVoiceRemoved = false;
// Ten sam problem, ale wykryty „w locie”: plik modelu zniknął z paczki (skasowany
// ręcznie na dysku), a flaga builtinVoiceRemoved jeszcze nie zdążyła się ustawić.
// Wykrywamy HTTP 404 przy starcie workera, zapamiętujemy i od tej pory nie
// próbujemy kolejnych spawnów (inaczej każda kwestia = nowy worker + nowy fetch 404).
let builtinModelMissing = false;
const BUILTIN_MISSING_MSG = 'Brak pliku wbudowanego modelu męskiego w folderze rozszerzenia '
    + '(sherpa/vits-piper-pl_PL-meski_wg_glos-medium/pl_PL-meski_wg_glos-medium.onnx). '
    + 'Lektor milczy do czasu wybrania innego głosu: kliknij ▶ przy głosie na liście „Własny głos”, '
    + 'albo wgraj plik .onnx z powrotem do folderu i kliknij „Przywróć wbudowany głos męski”.';
function poolSize() {
    return (customVoice && customVoice.enabled && (customVoice.sizeOnnx || 0) > CUSTOM_VOICE_BIG_ONNX_BYTES)
        ? CUSTOM_VOICE_POOL : SHERPA_POOL_SIZE;
}
let sherpaPool = [];          // elementy: { worker, ready, busy, pending, t0, lastUsed }
const audioCache = new Map();
const player = document.getElementById('tts-player');
if (player) player.addEventListener('error', () => {
    // Błąd elementu audio (np. uszkodzony/odwołany blob) — trafia do czarnej skrzynki,
    // którą widać w popupie przy „Ostatnie kwestie”.
    try { offLogPush('audio-error', player.error ? ('kod ' + player.error.code + ' ' + (player.error.message || '')) : 'nieznany'); } catch (e) {}
});

// ===== Głośność lektora =====
// ttsVolume: popup zapisuje 0..400 (%), tutaj konwertujemy na 0..1 (dzielenie przez 100).
// Zakres 0..100% działa po staremu — natywnym player.volume (element audio ma
// twarde maksimum 1.0). Wartości powyżej 100% (suwak do 400%) idą przez Web Audio:
// GainNode wzmacnia sygnał, a przed wyjściem stoi DynamicsCompressor (limiter),
// który nie pozwala szczytom przyciąć / zniekształcić głosu lektora.
let lectorVolume = 1;   // player.volume — zawsze 0..1 (oryginalny mechanizm, nietknięty)
let lectorBoost = 1;    // wzmocnienie >1 tylko dla ttsVolume >100% (max 4.0)
// Prędkość lektora — trzymana modularnie i czytana na MOMENT odtwarzania,
// dzięki czemu zmiana w popupie działa natychmiast, nawet gdy lektor mówi.
let lectorSpeed = 1;
function clamp01(v) {
    v = Number(v);
    if (!Number.isFinite(v)) return 1;
    return Math.min(1, Math.max(0, v));
}
function applyLectorVolume() {
    try {
        if (!player) return;
        player.volume = lectorVolume; // 0..1 — oryginalny mechanizm, bez zmian
        if (lectorBoost > 1) {
            if (ensureAudioGraph() && boostGain) {
                resumeAudioCtx();
                routeBoostPath(); // ścieżka przez limiter (boost >100%)
                try { boostGain.gain.setTargetAtTime(lectorBoost, audioCtx.currentTime, 0.02); }
                catch (e) { boostGain.gain.value = lectorBoost; } // płynnie, bez „klików"
            } else {
                // Brak Web Audio — maksimum to natywne 100%; lektor gra bez turbo,
                // ale nigdy nie milknie (stara ścieżka pozostaje nietknięta).
                lectorBoost = 1;
            }
        } else if (boostGain) {
            routeBoostPath(); // powrót na przezroczystą ścieżkę (gain = 1.0, bez limitera)
            try { boostGain.gain.setTargetAtTime(1, audioCtx.currentTime, 0.02); }
            catch (e) { boostGain.gain.value = 1; }
        }
    } catch (e) {}
}

// ===== Graf Web Audio dla wzmocnienia >100% — budowany LAZJOWO, jednorazowo =====
// createMediaElementSource można wywołać DOKŁADNIE raz na element audio, więc graf
// powstaje przy pierwszym przejściu powyżej 100% i dalej jest tylko przełączany:
//   boost ≤ 100% → src → gain(1.0) → destination     (przezroczyste 1:1 — jak dawniej)
//   boost > 100% → src → gain(boost) → limiter → destination (wzmocnienie + anty-clip)
let boostSrc = null;
let boostGain = null;
let boostLimiter = null;
let audioCtx = null;
let audioGraphFailed = false;
function ensureAudioGraph() {
    if (boostGain || audioGraphFailed) return !!boostGain;
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx || !player) throw new Error('AudioContext niedostępny');
        audioCtx = new Ctx();
        boostSrc = audioCtx.createMediaElementSource(player); // przechwycenie wyjścia elementu
        boostGain = audioCtx.createGain();
        boostGain.gain.value = lectorBoost;
        boostLimiter = audioCtx.createDynamicsCompressor();
        // Limiter działa dopiero przy szczytach: poniżej progu sygnał przechodzi
        // bez zmian (głos nienaruszony), powyżej — tłumiony zamiast trzaskać.
        boostLimiter.threshold.value = -3;   // dB — włącza się blisko pełnej skali
        boostLimiter.knee.value = 6;         // miękkie wejście = brak słyszalnego „pstryknięcia"
        boostLimiter.ratio.value = 20;       // mocne tłumienie samych szczytów
        boostLimiter.attack.value = 0.003;   // 3 ms — łapie transienty dyktowane
        boostLimiter.release.value = 0.25;   // 250 ms — płynny powrót głośności
        routeBoostPath();
        try { offLogPush('audio-graph', 'Web Audio: głośność lektora >100% aktywna'); } catch (e2) {}
    } catch (e) {
        audioGraphFailed = true;
        boostGain = null;
        // Fallback: gdyby przechwycenie się nie udało, dźwięk zostaje na zwykłej
        // ścieżce elementu (player.volume) — bez turbo, ale bez awarii lektora.
        try { offLogPush('audio-graph', 'brak Web Audio: ' + errMsg(e)); } catch (e2) {}
    }
    return !!boostGain;
}
function routeBoostPath() {
    if (!audioCtx || !boostSrc || !boostGain) return;
    try {
        boostSrc.disconnect();
        boostGain.disconnect();
        if (boostLimiter) boostLimiter.disconnect();
        boostSrc.connect(boostGain);
        if (lectorBoost > 1 && boostLimiter) {
            boostGain.connect(boostLimiter);
            boostLimiter.connect(audioCtx.destination);
        } else {
            boostGain.connect(audioCtx.destination); // przezroczyste — brak limitera
        }
    } catch (e) {
        // Awaryjnie przywróć najprostszą ścieżkę, żeby lektor nigdy nie umilkł.
        try { boostSrc.connect(boostGain); boostGain.connect(audioCtx.destination); } catch (e2) {}
    }
}
function resumeAudioCtx() {
    try { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {}); } catch (e) {}
}
// Top-levelowe wywołania chrome.* opakowane w try/catch — jeśli kontekst rozszerzenia
// został unieważniony (reload), nie mogą zabić całego modułu przed rejestracją listenera.
// UWAGA: chrome.storage NIE JEST dostępne w dokumencie offscreen (nowsze Chrome ograniczają
// API offscreen do chrome.runtime m.in.) — ustawienia pobieramy wiadomościami od background.
function applySettings(s) {
    if (!s || typeof s !== 'object') return;
    if (s.ttsVolume !== undefined) {
        let v = Number(s.ttsVolume) / 100;
        if (!Number.isFinite(v)) v = 1;
        lectorVolume = clamp01(Math.min(v, 1));      // 0..100% → natywnie, jak dotychczas
        lectorBoost = Math.min(4, Math.max(1, v));   // 100..400% → GainNode + limiter
        if (v > 1) ensureAudioGraph();
        applyLectorVolume();
    }
    if (s.piperSpeed !== undefined) lectorSpeed = clampSpeed(s.piperSpeed);
    if (s.offlineVoice && s.offlineVoice !== voiceId && s.offlineVoice === SHERPA_VOICE) {
        offLogPush('voice-change', String(s.offlineVoice));
        playQueue.length = 0;
        finishCurrent();
        try { player.pause(); } catch (e) {}
    }
    if (s.customVoice !== undefined) {
        const nv = (s.customVoice && typeof s.customVoice === 'object') ? s.customVoice : null;
        const was = !!(customVoice && customVoice.enabled);
        customVoice = nv;
        const is = !!(nv && nv.enabled);
        if (is !== was) {
            offLogPush('voice-change', is ? ('WŁASNY głos: ' + (nv.name || 'model')) : 'wbudowany głos Sherpa');
            playQueue.length = 0;
            finishCurrent();
            try { player.pause(); } catch (e2) {}
            // Pełna przebudowa: workery startują z ?voice=custom / bez parametru
            terminatePool();
            session = null;
            sessionGen++;
        }
    }
    // Wbudowany głos wyłączony / przywrócony → przebuduj pulę, żeby zmiana
    // zadziałała od razu. Gdy nic nie jest aktywne, lektor milczy do momentu
    // wybrania innego głosu — to celowe (użytkownik usunął wbudowany).
    if (s.builtinVoiceRemoved !== undefined) {
        const nvRemoved = !!s.builtinVoiceRemoved;
        if (nvRemoved !== builtinVoiceRemoved) {
            builtinVoiceRemoved = nvRemoved;
            builtinModelMissing = false; // zmiana stanu = pozwól spróbować od nowa
            offLogPush('builtin-voice', nvRemoved
                ? 'wbudowany głos męski WYŁĄCZONY - gra tylko głos własny'
                : 'wbudowany głos męski PRZYWRÓCONY');
            playQueue.length = 0;
            finishCurrent();
            try { player.pause(); } catch (e3) {}
            terminatePool();
            session = null;
            sessionGen++;
        }
    }

    // Cenzura przeklecstw (censor.js wczytany przed tym modulem).
    if (window.Censor && window.Censor.applySettings) {
        try { window.Censor.applySettings(s); } catch (e) { /* cenzura nie moze zabic lektora */ }
    }
}
// Cenzura przeklecstw - censor.js jest wczytany przed tym modulem (offscreen.html).
// Tekst kwestii czyszczony jest PRZED synteza, niezaleznie od jezyka glosu.
function censoredText(t) {
    try {
        if (window.Censor && window.Censor.applyText) return window.Censor.applyText(t);
    } catch (e) { /* cenzura nie moze zabic lektora */ }
    return String(t || '');
}
try {
    chrome.runtime.sendMessage({ action: 'GET_TTS_SETTINGS' })
        .then((s) => { if (s && s.settings) applySettings(s.settings); })
        .catch(() => {});
} catch (e) { console.warn('[Offscreen] settings init skipped:', e); }

// ===== Wczesny PING + diagnostyka startu =====
// Ten listener odpowiada na PING/GET_STATUS nawet wtedy, gdy cokolwiek niżej w pliku rzuci.
// Błędy startu trafiają do chrome.storage ('__offscreenError') i są widoczne w popupie.
let lastBootError = null;
function recordBootError(msg) {
    lastBootError = msg;
    // chrome.storage jest niedostępne w offscreen — diagnostykę zapisuje background.
    try { chrome.runtime.sendMessage({ action: 'OFFSCREEN_DIAG', kind: 'error', msg, ts: Date.now() }).catch(() => {}); } catch (e) {}
}
try {
    window.addEventListener('error', (ev) => {
        recordBootError((ev && (ev.message || (ev.error && ev.error.message))) || 'unknown error');
    });
    window.addEventListener('unhandledrejection', (ev) => {
        recordBootError((ev && ev.reason && (ev.reason.message || String(ev.reason))) || 'unknown rejection');
    });
} catch (e) { /* ignore */ }
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (!msg || msg.target !== 'offscreen') return;
    if (msg.action === 'PING' || msg.action === 'GET_STATUS') {
        sendResponse({
            status: 'ok',
            isInitializing: !!sessionBusy,
            isReady: !!session,
            cacheSize: audioCache.size,
            voiceId,
            bootError: lastBootError,
            poolSize: sherpaPool.length,
            poolReady: sherpaPool.filter((w) => w.ready).length,
            // Statystyki cenzury (ile języków / słów) — popup pokazuje je na żywo,
            // żeby użytkownik widział faktyczny zasięg, a nie liczbę na sztywno.
            censorLanguages: (window.Censor && window.Censor.langCount) ? window.Censor.langCount() : 0,
            censorWords: (window.Censor && window.Censor.wordCount) ? window.Censor.wordCount() : 0
        });
    }
});


(function keepAlive() {
    const el = document.getElementById('keepAlive');
    if (!el) return;
    el.volume = 0.01;
    el.play().catch(() => {});
})();

// ===== Kolejka odtwarzania — nowe zdania NIE przerywają bieżącego =====
const playQueue = [];
let queueActive = false;
let queueDone = null; // zamyka bieżący element (usuwa listenery)
const MAX_QUEUE = 4; // ponad to pomijamy najstarsze, żeby lektor nie gonił
const MAX_CACHE = 120; // był 50 — większy zapas = mniej „zdmuchiwanych” preloadów
const playingUrls = new Set(); // URL-e aktualnie grane/w kolejce — eviction ich nie rusza

function clampSpeed(s) {
    s = Number(s);
    if (!Number.isFinite(s) || s <= 0) return 1;
    return Math.min(3, Math.max(0.5, s)); // STAŁA prędkość — tylko wartość z popupu
}

function finishCurrent() {
    if (queueDone) { const d = queueDone; d(); }
}

function runQueue() {
    if (queueActive) return;
    const next = playQueue.shift();
    if (!next) return;
    queueActive = true;
    playNext(next);
}

function playNext(item) {
    if (!player) { queueActive = false; return; }
    const done = () => {
        if (queueDone !== done) return; // przerwane przez CLEAR/PAUSE
        queueDone = null;
        queueActive = false;
        player.removeEventListener('ended', done);
        player.removeEventListener('error', done);
        try { playingUrls.delete(item.url); } catch (e) {}
        setTimeout(runQueue, 10);
    };
    queueDone = done;
    player.addEventListener('ended', done);
    player.addEventListener('error', done);
    player.onloadedmetadata = null;
    player.src = item.url;
    player.preservesPitch = true;
    player.volume = lectorVolume; // głośność lektora — przy KAŻDym odtworzeniu
    if (lectorBoost > 1) { ensureAudioGraph(); resumeAudioCtx(); } // turbo >100%: AudioContext musi grać
    player.playbackRate = lectorSpeed; // prędkość z popupu brana na moment odtwarzania (nie przy kolejkowaniu)
    player.play().catch((err) => { console.error('[Offscreen] play:', err); try { offLogPush('play-error', errMsg(err)); } catch (e) {} done(); });
}

function enqueuePlay(url, durationMs, piperSpeed) {
    playQueue.push({ url, durationMs });
    if (playQueue.length > MAX_QUEUE) {
        const dropped = playQueue.shift();
        try { playingUrls.delete(dropped.url); } catch (e) {}
    }
    playingUrls.add(url);
    runQueue();
}

function resetVoice(nextId) {
    if (!nextId || nextId === voiceId || nextId !== SHERPA_VOICE) return;
    // Generacja rośnie TYLKO przy faktycznej zmianie głosu — bump przy każdej
    // wiadomości (PRELOAD/PLAY latają co ~50-250 ms) unieważniałby trwającą
    // budowę modelu w nieskończoność (build nigdy się nie kończy → timeout).
    sessionGen++;
    for (const u of audioCache.values()) URL.revokeObjectURL(u);
    audioCache.clear();
    playingUrls.clear();
    voiceId = nextId;
    session = null;
    terminatePool();
}

// ===== Pula workerów Sherpa: każdy worker = osobny wątek z własną instancją WASM.
// Generacje rozdzielane na wolne workery → równoległa synteza (do SHERPA_POOL_SIZE rdzeni).

function terminatePool() {
    for (const item of sherpaPool) {
        try { item.worker.terminate(); } catch (e) { /* ignoruj */ }
    }
    sherpaPool = [];
}

function handleWorkerData(item, data) {
    if (data.type === 'sherpa-onnx-tts-result') {
        item.busy = false;
        if (item.pending) {
            const pending = item.pending;
            item.pending = null;
            clearTimeout(pending.timer);
            pending.resolve(floatAudioToWavBlob(trimSilence(data.samples, data.sampleRate), data.sampleRate));
        }
    } else if (data.type === 'error') {
        item.busy = false;
        const error = new Error(data.message || 'Błąd Sherpa');
        if (item.pending) {
            const pending = item.pending;
            item.pending = null;
            clearTimeout(pending.timer);
            pending.reject(error);
        } else {
            offLogPush('pool-error', errMsg(error));
        }
    }
}

function pickIdleWorker() {
    let best = null;
    for (const item of sherpaPool) {
        if (item.ready && !item.busy && (!best || item.lastUsed < best.lastUsed)) best = item;
    }
    return best;
}

function spawnPoolWorker() {
    return new Promise((resolve, reject) => {
        // Wbudowany głos "usunięty" (🗑), a nie ma aktywnego własnego → nie ma
        // czym mówić. Zamiast cichej awarii dajemy jasny komunikat w logu silnika.
        if (builtinVoiceRemoved && !(customVoice && customVoice.enabled)) {
            reject(new Error('Wbudowany głos męski jest WYŁĄCZONY. Wybierz inny głos na liście "Własny głos" albo kliknij "Przywróć wbudowany głos męski" w ustawieniach lektora.'));
            return;
        }
        // Plik modelu zniknął z dysku (404 wykryte przy poprzedniej próbie) — nie
        // spawnujemy kolejnych workerów, tylko od razu mówimy, co zrobić.
        if (builtinModelMissing && !(customVoice && customVoice.enabled)) {
            reject(new Error(BUILTIN_MISSING_MSG));
            return;
        }

        const workerUrl = chrome.runtime.getURL('sherpa/sherpa-onnx-tts.worker.js')
            + (customVoice && customVoice.enabled ? '?voice=custom' : '')
            + (customVoice && customVoice.enabled && customVoice.id ? '&id=' + encodeURIComponent(String(customVoice.id)) : '')
            + (customVoice && customVoice.enabled && customVoice.type ? '&type=' + encodeURIComponent(String(customVoice.type)) : '');
        const worker = new Worker(workerUrl);
        const item = { worker, ready: false, busy: false, pending: null, t0: Date.now(), lastUsed: 0 };
        let settled = false;
        const timeout = setTimeout(() => fail(new Error('Sherpa nie zakończył inicjalizacji w ciągu 120 sekund')), 120000);
        const fail = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            const idx = sherpaPool.indexOf(item);
            if (idx >= 0) sherpaPool.splice(idx, 1);
            try { worker.terminate(); } catch (e) { /* ignoruj */ }
            reject(error instanceof Error ? error : new Error(String(error)));
        };
        worker.onerror = (event) => {
            const error = event.error || new Error(event.message || 'Błąd workera Sherpa');
            if (!settled) { fail(error); return; }
            // Martwy worker po inicjalizacji: usuń z puli i odrzuć czekającą generację.
            const idx = sherpaPool.indexOf(item);
            if (idx >= 0) sherpaPool.splice(idx, 1);
            try { worker.terminate(); } catch (e) { /* ignoruj */ }
            if (item.pending) {
                const pending = item.pending;
                item.pending = null;
                clearTimeout(pending.timer);
                pending.reject(error);
            }
        };
        worker.onmessage = (event) => {
            const data = event.data || {};
            if (data.type === 'sherpa-onnx-tts-ready') {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                item.ready = true;
                offLogPush('pool-init', 'worker #' + sherpaPool.indexOf(item) + ' gotowy (' + (Date.now() - item.t0) + ' ms)');
                resolve(item);
                return;
            }
            // Błąd PRZED gotowością (np. brak pliku modelu po ręcznym skasowaniu na
            // dysku → HTTP 404). Wcześniej komunikat workera trafiał tylko do logu,
            // a wywołanie wisiało aż do timeoutu 120 s — teraz kończymy od razu.
            if (data.type === 'error' && !settled) {
                const msg = String(data.message || 'Błąd inicjalizacji Sherpa');
                const builtinGone = !(customVoice && customVoice.enabled) && /HTTP\s*404/.test(msg) && /\.onnx/.test(msg);
                if (builtinGone) builtinModelMissing = true;
                fail(new Error(builtinGone ? (BUILTIN_MISSING_MSG + ' (' + msg + ')') : msg));
                return;
            }
            handleWorkerData(item, data);
        };
        sherpaPool.push(item);
    });
}

// FIX „kropka”: VITS (espeak-ng, PL) wypowiada kropkę na końcu fragmentu
// jako słowo „kropka”, a przecinek jest niemy. Zamieniamy kropki (i
// wielokropki/„…”) na przecinki — pauza zostaje, wypowiadane słowo znika.
// Cyfry dziesiętne („3.14”) są bezpieczne: łapiemy tylko kropkę przed
// spacją/końcem tekstu.
function ttsNormalizeText(text) {
    let t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return t;
    t = t.replace(/\u2026/g, ',');             // „…” → pauza
    // Kropki (też przed cudzysłowem/nawiasem/wielokropki), ale NIE w liczbach („3.14”, „2.5.1”):
    t = t.replace(/(?<!\d)\.+(?!\d)/g, ',');
    t = t.replace(/\s*,\s*,/g, ',');           // zdublowane pauzy
    return t;
}

const SHERPA_GEN_TIMEOUT_MS = 120000;

function predictOnPool(text) {
    const raw = String(text || '');
    text = ttsNormalizeText(raw); // FIX „kropka”: gra, preload i stream idą tędy
    if (text !== raw) offLogPush('norm', raw.slice(0, 60) + '  →  ' + text.slice(0, 60));
    const myGen = sessionGen;
    const startedAt = Date.now();
    const attempt = async () => {
        let item = pickIdleWorker();
        if (!item) {
            if (sherpaPool.length < poolSize()) {
                offLogPush('pool-spawn', 'worker ' + (sherpaPool.length + 1) + '/' + poolSize());
                item = await spawnPoolWorker();
            } else {
                const waitStart = Date.now();
                while (!(item = pickIdleWorker())) {
                    if (sessionGen !== myGen) throw new Error('Sesja TTS unieważniona (zmiana głosu)');
                    if (Date.now() - waitStart > 60000) throw new Error('Timeout: brak wolnego workera TTS');
                    await new Promise((r) => setTimeout(r, 25));
                }
            }
        }
        item.busy = true;
        item.lastUsed = Date.now();
        return new Promise((resolve, reject) => {
            const pending = {
                resolve,
                reject,
                timer: setTimeout(() => {
                    item.busy = false;
                    if (item.pending === pending) item.pending = null;
                    reject(new Error('Sherpa nie odpowiedział w ciągu ' + Math.round(SHERPA_GEN_TIMEOUT_MS / 1000) + ' s'));
                }, SHERPA_GEN_TIMEOUT_MS)
            };
            item.pending = pending;
            try {
                item.worker.postMessage({ type: 'generate', text: String(text || ''), sid: 0, speed: lectorSpeed });
            } catch (e) {
                clearTimeout(pending.timer);
                item.busy = false;
                item.pending = null;
                reject(e);
            }
        });
    };
    return attempt().then(
        (blob) => { offLogPush('gen-ok', Math.round(Date.now() - startedAt) + ' ms | pula: ' + sherpaPool.length + ' w.'); return blob; },
        (err) => { offLogPush('gen-fail', errMsg(err)); throw err; }
    );
}

function createSherpaSession() {
    return spawnPoolWorker().then((item) => ({
        predict: (text) => predictOnPool(text),
        worker: item.worker
    }));
}function floatAudioToWavBlob(samples, sampleRate) {
    const input = samples instanceof Float32Array ? samples : new Float32Array(samples);
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
        const value = Math.max(-1, Math.min(1, input[i]));
        pcm[i] = value < 0 ? value * 32768 : value * 32767;
    }
    const buffer = new ArrayBuffer(44 + pcm.byteLength);
    const view = new DataView(buffer);
    const write = (offset, text) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    write(0, 'RIFF');
    view.setUint32(4, 36 + pcm.byteLength, true);
    write(8, 'WAVE');
    write(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, 'data');
    view.setUint32(40, pcm.byteLength, true);
    new Int16Array(buffer, 44).set(pcm);
    return new Blob([buffer], { type: 'audio/wav' });
}

// ===== Z-FIX: przycinanie ciszy na brzegach paczek =====
// VITS dokleja na końcu każdej generacji spory ogon ciszy; przy krojeniu
// po przecinku te ogony sumują się w słyszalne przerwy. Zostawiamy krótką
// naturalną pauzę (TAIL_MS) na końcu i minimalny margines na początku.
function trimSilence(samples, sampleRate) {
    if (!samples || !samples.length || !sampleRate) return samples;
    const TH = 0.004;      // próg ciszy (skala -1..1)
    const TAIL_MS = 80;    // naturalna pauza na końcu (przecinek/kropka)
    const HEAD_MS = 20;    // margines na początku
    const n = samples.length;
    const tail = Math.max(1, Math.round(sampleRate * TAIL_MS / 1000));
    const head = Math.max(1, Math.round(sampleRate * HEAD_MS / 1000));
    let end = n;
    while (end > tail && Math.abs(samples[end - 1]) < TH) end--;
    end = Math.min(n, end + tail);
    let start = 0;
    while (start < end - 1 && Math.abs(samples[start]) < TH) start++;
    start = Math.max(0, start - head);
    if ((end - start) < Math.floor(n * 0.15)) return samples; // nie tnij, gdy wyszłoby za dużo
    if (start === 0 && end === n) return samples;
    return samples.subarray(start, end);
}

async function getSession() {
    const myGen = sessionGen;
    if (session && sessionGen === myGen) return session;
    if (session) session = null;
    if (sessionBusy) {
        const start = Date.now();
        while (sessionBusy && Date.now() - start < 45000) {
            await new Promise((r) => setTimeout(r, 50));
            if (sessionGen !== myGen) return getSession();
            if (session && sessionGen === myGen) return session;
        }
        if (session && sessionGen === myGen) return session;
        if (session) session = null;
        if (sessionBusy) throw new Error('Timeout podczas ładowania Sherpa');
    }
    sessionBusy = true;
    const t0 = Date.now();
    offLogPush('init-start', voiceId + (customVoice && customVoice.enabled ? ' | WŁASNY: ' + (customVoice.name || 'model') : '') + ' | pula TTS: max ' + poolSize() + ' wątków');
    try {
        session = await createSherpaSession();
        if (sessionGen !== myGen) {
            // W trakcie budowy zmieniono głos — odrzuć i zbuduj aktualny.
            // WAŻNE: zwolnij sessionBusy PRZED rekurencją — rekurencyjne getSession
            // inaczej czekałoby na zwolnienie blokady, którą trzyma ta ramka (deadlock 45 s).
            offLogPush('init-stale', voiceId);
            session = null;
            terminatePool();
            sessionBusy = false;
            return getSession();
        }
        offLogPush('init-ok', voiceId + ' | norm ' + TTS_NORM_VER + ' (' + (Date.now() - t0) + ' ms)');
        return session;
    } catch (err) {
        session = null;
        // Fallback: własny głos nie wstał → wróć na wbudowany (jeden poziom rekurencji;
        // enabled=false gwarantuje brak pętli). Blokadę zwalniamy PRZED rekurencją.
        if (customVoice && customVoice.enabled) {
            customVoice = Object.assign({}, customVoice, { enabled: false, _failed: true });
            try { chrome.runtime.sendMessage({ action: 'CUSTOM_VOICE_FALLBACK', name: customVoice.name, error: errMsg(err) }); } catch (e) {}
            offLogPush('custom-fail', errMsg(err) + ' → powrót na wbudowany głos');
            sessionBusy = false;
            return getSession();
        }
        offLogPush('init-fail', errMsg(err));
        throw err;
    } finally {
        sessionBusy = false;
    }
}

function errMsg(err) {
    return (err && (err.message || err.stack)) || String(err);
}

// Czarna skrzynka: ostatnie zdarzenia silnika (diagnostyka zawieszeń w popupie)
const offLog = [];
function offLogPush(tag, msg) {
    offLog.push({ tag, msg: String(msg || '').slice(0, 300), ts: Date.now() });
    if (offLog.length > 12) offLog.shift();
    try { chrome.runtime.sendMessage({ action: 'OFFSCREEN_DIAG', kind: 'log', entries: offLog.slice() }).catch(() => {}); } catch (e) {}
}

// Live-ustawienia lektora — background przesyła patch po każdej zmianie w popupie
// (chrome.storage.onChanged nie istnieje w offscreen, więc push idzie wiadomością).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== 'offscreen') return;
    if (msg.action === 'SETTINGS_PATCH') {
        applySettings(msg.settings || {});
        sendResponse({ status: 'settings_applied' });
        return true;
    }
});

// Live-ustawienia lektora — zmiany przychodziły tu przez chrome.storage.onChanged,
// ale to API nie istnieje w offscreen; zastąpiono je listenerem SETTINGS_PATCH powyżej.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== 'offscreen') return;

    // PING/GET_STATUS obsługuje wczesny listener na górze pliku (odpowiada zawsze).

    if (msg.action === 'INIT_TTS') {
        resetVoice(msg.voiceId);
        getSession()
            .then(() => {
                lastBootError = null;
                try { chrome.runtime.sendMessage({ action: 'OFFSCREEN_DIAG', kind: 'clear-error' }).catch(() => {}); } catch (e) {}
                sendResponse({ status: 'initialized', voiceId });
            })
            .catch((err) => { recordBootError(errMsg(err)); sendResponse({ status: 'error', error: errMsg(err) }); });
        return true;
    }

    if (msg.action === 'CLEAR_CACHE') {
        for (const u of audioCache.values()) URL.revokeObjectURL(u);
        audioCache.clear();
        sendResponse({ status: 'cache_cleared' });
        return true;
    }

    if (msg.action === 'TTS_PRELOAD') {
        resetVoice(msg.voiceId);
        const { id } = msg;
        const text = censoredText(msg.text);
        if (!text || text.length < 2) {
            // Cala kwestia to bylo przeklecstwo - nie syntetyzujemy (cisza).
            sendResponse({ status: 'muted' });
            return true;
        }
        sendResponse({ status: 'preloading' });
        getSession()
            .then((s) => predictPreload(s, text))
            .then((blob) => {
                const url = URL.createObjectURL(blob);
                audioCache.set(id, url);
                if (audioCache.size > MAX_CACHE) {
                    for (const [k, u] of audioCache) {
                        if (playingUrls.has(u)) continue; // nie wywaczaj tego, co gra / czeka w kolejce
                        URL.revokeObjectURL(u);
                        audioCache.delete(k);
                        break;
                    }
                }
                // REC: kwestia zsyntezowana → zapisz czysty głos z timestampem (jeśli nagrywamy).
                recCapture(msg, blob).catch(() => {});
            })
            .catch((err) => { console.error('[Offscreen] preload:', err); offLogPush('preload-fail', errMsg(err)); });
        return true;
    }

    if (msg.action === 'TTS_PLAY') {
        resetVoice(msg.voiceId);
        const cached = audioCache.get(msg.id);
        if (cached) {
            enqueuePlay(cached, msg.durationMs, msg.piperSpeed);
            offLogPush('play', String(msg.id || '').slice(0, 40) + ' (z bufora)');
            sendResponse({ status: 'playing' });
            return true;
        }
        const ctext = censoredText(msg.text);
        if (!ctext || ctext.length < 2) {
            // Kwestia po cenzurze pusta - milczymy (nie ma czego grac).
            sendResponse({ status: 'muted' });
            return true;
        }
        msg.text = ctext;
        sendResponse({ status: 'predicting_and_playing' });
        getSession()
            .then((s) => predictStream(s, msg))
            .catch((err) => { console.error('[Offscreen] play predict:', err); offLogPush('play-fail', errMsg(err)); });
        return true;
    }

    if (msg.action === 'TTS_PAUSE') {
        playQueue.length = 0;
        finishCurrent();
        if (player) player.pause();
        sendResponse({ status: 'paused' });
        return true;
    }

    if (msg.action === 'TTS_CLEAR_BUFFER') {
        playQueue.length = 0;
        finishCurrent();
        if (player) {
            player.pause();
            player.src = '';
        }
        for (const u of audioCache.values()) URL.revokeObjectURL(u);
        audioCache.clear();
        sendResponse({ status: 'cleared' });
        return true;
    }

    // ===== REC: sterowanie nagrywaniem (nadchodzi przez background od przycisku na stronie) =====
    if (msg.action === 'REC_START') {
        recState.recording = true;
        recState.sessionId = msg.sessionId || ('rec_' + Date.now());
        recState.seq = 0;
        recState.count = 0;
        recState.words = 0;
        recSavedIds.clear();
        offLogPush('rec-start', recState.sessionId);
        recClearAll()
            .then(() => sendResponse({ ok: true, sessionId: recState.sessionId }))
            .catch((e) => sendResponse({ ok: true, sessionId: recState.sessionId, warn: String(e) }));
        return true;
    }
    if (msg.action === 'REC_STOP') {
        recState.recording = false;
        offLogPush('rec-stop', String(recState.count));
        sendResponse({ ok: true, count: recState.count, sessionId: recState.sessionId });
        return true;
    }
    if (msg.action === 'REC_STATUS') {
        sendResponse({
            recording: recState.recording,
            count: recState.count,
            words: recState.words,
            synthCues: recSynth.cues,
            synthWords: recSynth.words,
            sessionId: recState.sessionId
        });
        return true;
    }
    if (msg.action === 'REC_EXPORT') {
        recExport(msg.sessionId || recState.sessionId)
            .then((r) => sendResponse(r))
            .catch((e) => sendResponse({ ok: false, error: errMsg(e) }));
        return true;
    }
    if (msg.action === 'REC_DELETE') {
        // Kasowanie zbuforowanego nagrania (po eksporcie albo na żądanie).
        recDeleteSession(msg.sessionId || recState.sessionId)
            .then(() => sendResponse({ ok: true }))
            .catch((e) => sendResponse({ ok: false, error: errMsg(e) }));
        return true;
    }
});

console.log('[Offscreen] listener ready');
chrome.runtime.sendMessage({ action: 'OFFSCREEN_READY' }).catch(() => {});

// ===== Nagrywanie lektora (REC) — czysty głos zapisywany do IndexedDB =====
// Każda zsyntezowana kwestia (WAV z Pipea) trafia do bazy z timestampem filmu.
// „Eksport" skleja kwestie w jeden WAV: cisza o długości nagrania + głos we właściwych
// offsetach. Przewijanie/pauzy nie mają znaczenia — pozycja wynika z timestampu.
const REC_DB = 'livedub-rec';
const REC_STORE = 'segs';
const recState = { recording: false, sessionId: null, seq: 0, count: 0, words: 0 };
const recSavedIds = new Set();
const recSynth = { cues: 0, words: 0 };   // globalne statystyki syntezy (wszystkie platformy)
const recSeenIds = new Set();             // dedupe licznika syntezy (preload + play tej samej kwestii)
let recDbPromise = null;

function recDb() {
    if (!recDbPromise) {
        recDbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(REC_DB, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(REC_STORE)) {
                    const st = db.createObjectStore(REC_STORE, { keyPath: 'key' });
                    st.createIndex('sessionId', 'sessionId', { unique: false });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('IndexedDB: błąd otwarcia'));
        });
        recDbPromise.catch(() => { recDbPromise = null; });
    }
    return recDbPromise;
}

function recPut(rec) {
    return recDb().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(REC_STORE, 'readwrite');
        tx.objectStore(REC_STORE).put(rec);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    }));
}

function recClearAll() {
    return recDb().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(REC_STORE, 'readwrite');
        tx.objectStore(REC_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    }));
}

function recDeleteSession(sessionId) {
    return recDb().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(REC_STORE, 'readwrite');
        const req = tx.objectStore(REC_STORE).index('sessionId').openCursor(IDBKeyRange.only(sessionId));
        req.onsuccess = () => { const c = req.result; if (c) { c.delete(); c.continue(); } };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    }));
}

// Auto-czyszczenie: nagrania starsze niż 72 h usuwają się same
// („buforuje i później samo się kasuje").
const REC_MAX_AGE_MS = 72 * 60 * 60 * 1000;
function recPruneOld(maxAgeMs) {
    const cutoff = Date.now() - (maxAgeMs || REC_MAX_AGE_MS);
    return recDb().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(REC_STORE, 'readwrite');
        const req = tx.objectStore(REC_STORE).openCursor();
        req.onsuccess = () => {
            const c = req.result;
            if (!c) return;
            const rec = c.value;
            if (rec && typeof rec.createdAt === 'number' && rec.createdAt < cutoff) c.delete();
            c.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    }));
}

function recGetAll(sessionId) {
    return recDb().then((db) => new Promise((resolve, reject) => {
        const req = db.transaction(REC_STORE, 'readonly')
            .objectStore(REC_STORE).index('sessionId').getAll(sessionId);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    }));
}

// Pula sama rozdziela generacje — globalny łańcuch serializujący zbędny.
function predictPreload(session, text) {
    return session.predict(text);
}

function predictPlay(session, text) {
    return session.predict(text);
}// ===== Streaming długich kwestii (wersja WASM/CPU):
// dłuższe kwestie dzielimy na zdania → pierwsza paczka gra, póki reszta się syntetyzuje.
// Skuteczny „time to first audio" dla długich napisów spada kilkukrotnie.
const STREAM_MIN_CHARS = 160;  // krótsze kwestie syntezujemy w całości (bez strat na prozodii)
const STREAM_CHUNK_CHARS = 120; // paczki po ~120 znaków (było 200) — szybszy start 1. dźwięku
// Krojenie na paczki: granicami są końce zdań (.!?…) ORAZ PRZECINKI.
// Pierwsza paczka = pierwszy człon (tekst do 1. przecinka/kropki) — lektor
// zaczyna generować i grać "już po przecinku", nie czekając na koniec zdania.
function splitForStreaming(text) {
    const t = String(text || '').trim();
    if (t.length < STREAM_MIN_CHARS) return null;
    const frags = t.match(/[^.!?…,]+[.!?…,]+["'”’)\]]*\s*|[^.!?…,]+$/g) || [t];
    if (!frags.length) return null;
    const chunks = [frags[0].trim()];
    let cur = '';
    for (let i = 1; i < frags.length; i++) {
        const f = frags[i];
        if (cur && (cur + f).length > STREAM_CHUNK_CHARS) { chunks.push(cur.trim()); cur = f; }
        else cur += f;
    }
    if (cur.trim()) chunks.push(cur.trim());
    return chunks.length > 1 ? chunks : null;
}
async function predictStream(session, msg) {
    // Podczas nagrywania (REC) NIE dzielimy — nagrywamy pełne kwestie z jednym timestampem.
    const chunks = recState.recording ? null : splitForStreaming(msg.text);
    if (!chunks) {
        const blob = await predictPlay(session, msg.text || '');
        const url = URL.createObjectURL(blob);
        audioCache.set(msg.id, url);
        enqueuePlay(url, msg.durationMs, msg.piperSpeed);
        offLogPush('play', String(msg.id || '').slice(0, 40) + ' (synteza na gorąco)');
        // REC: kwestia zsyntezowana „na gorąco” (bez preloadu) → też zapisz.
        recCapture(msg, blob).catch(() => {});
        return;
    }
    offLogPush('stream', 'kwestia ' + String(msg.id || '').slice(0, 30) + ' → ' + chunks.length + ' paczek (równolegle, do ' + poolSize() + ' wątków)');
    // Równoległa synteza wszystkich paczek (pula workerów), odtwarzanie w ORYGINALNEJ kolejności.
    const jobs = chunks.map((chunk) => predictPlay(session, chunk));
    jobs.forEach((j) => j.catch(() => {}));
    for (let i = 0; i < jobs.length; i++) {
        const blob = await jobs[i];
        const url = URL.createObjectURL(blob);
        audioCache.set(msg.id + '#' + i, url);
        enqueuePlay(url, 0, msg.piperSpeed);
        offLogPush('play', 'paczka ' + (i + 1) + '/' + chunks.length + ' (stream)');
    }
}function recParseWav(buf) {
    try {
        const dv = new DataView(buf);
        if (buf.byteLength < 44) return null;
        if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'RIFF') return null;
        let off = 12, fmt = null, data = null;
        while (off + 8 <= buf.byteLength) {
            const id = String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
            const size = Math.min(dv.getUint32(off + 4, true), buf.byteLength - off - 8);
            if (id === 'fmt ' && size >= 16) {
                fmt = { channels: dv.getUint16(off + 8, true), sampleRate: dv.getUint32(off + 12, true), bits: dv.getUint16(off + 22, true) };
            } else if (id === 'data') {
                data = new Uint8Array(buf, off + 8, size);
            }
            off += 8 + size + (size % 2);
        }
        if (!fmt || !data || fmt.channels < 1 || fmt.sampleRate < 1) return null;
        return { channels: fmt.channels, sampleRate: fmt.sampleRate, bits: fmt.bits || 16, data };
    } catch (e) { return null; }
}

function recBuildWav(pcm, sampleRate, channels) {
    const bytes = pcm.length * 2;
    const buf = new ArrayBuffer(44 + bytes);
    const dv = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); dv.setUint32(4, 36 + bytes, true); ws(8, 'WAVE');
    ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
    dv.setUint16(22, channels, true); dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * channels * 2, true); dv.setUint16(32, channels * 2, true);
    dv.setUint16(34, 16, true);
    ws(36, 'data'); dv.setUint32(40, bytes, true);
    new Int16Array(buf, 44).set(pcm);
    return buf;
}

function recResample(w, targetRate) {
    const bytesPerFrame = Math.max(1, (w.bits / 8) * w.channels);
    const frames = Math.floor(w.data.length / bytesPerFrame);
    const src = new Int16Array(w.data.buffer, w.data.byteOffset, frames * w.channels);
    const out = new Int16Array(Math.max(1, Math.ceil(frames * targetRate / w.sampleRate)));
    for (let i = 0; i < out.length; i++) {
        const t = i * w.sampleRate / targetRate;
        const base = Math.floor(t);
        const i0 = Math.min(base, frames - 1);
        const i1 = Math.min(base + 1, frames - 1);
        const fr = t - base;
        const a = src[i0 * w.channels], b = src[i1 * w.channels];
        out[i] = Math.round(a + (b - a) * fr);
    }
    return out;
}

function recWordCount(t) {
    t = String(t || '').trim();
    return t ? t.split(/\s+/).length : 0;
}

async function recCapture(msg, blob) {
    if (!msg || !msg.id) return;
    // Statystyki syntezy liczone dla KAŻDEJ kwestii (nawet bez nagrywania).
    if (!recSeenIds.has(msg.id)) {
        recSeenIds.add(msg.id);
        recSynth.cues++;
        recSynth.words += recWordCount(msg.text);
        if (recSeenIds.size > 20000) recSeenIds.clear();
    }
    // Nagrywanie na WSZYSTKICH platformach (suwak > 0 = REC w locie).
    if (!recState.recording || !blob) return;
    if (recSavedIds.has(msg.id)) return;
    recSavedIds.add(msg.id);
    const buf = await blob.arrayBuffer();
    const w = recParseWav(buf);
    if (!w) return;
    const bytesPerFrame = Math.max(1, (w.bits / 8) * w.channels);
    const frames = Math.floor(w.data.length / bytesPerFrame);
    const durMs = Math.round(frames / w.sampleRate * 1000);
    // Netflix: dokładny startMs z napisów. YouTube/Prime/iQ: moment czytania (videoTimeMs).
    const startMs = (typeof msg.startMs === 'number' && msg.startMs >= 0)
        ? msg.startMs
        : (typeof msg.videoTimeMs === 'number' && msg.videoTimeMs >= 0 ? msg.videoTimeMs : 0);
    const rec = {
        key: recState.sessionId + '|' + recState.seq,
        sessionId: recState.sessionId,
        seq: recState.seq++,
        id: msg.id,
        text: String(msg.text || '').slice(0, 500),
        startMs,
        durMs,
        sampleRate: w.sampleRate,
        channels: w.channels,
        bits: w.bits,
        blob,
        createdAt: Date.now()
    };
    await recPut(rec);
    recState.count++;
    recState.words += recWordCount(msg.text);
}

async function recExport(sessionId) {
    if (!sessionId) return { ok: false, error: 'Brak sesji nagrywania.' };
    const segs = (await recGetAll(sessionId)).sort((a, b) => (a.startMs - b.startMs) || (a.seq - b.seq));
    if (!segs.length) {
        return { ok: false, error: 'Brak zapisanych kwestii — lektor nic nie wypowiedział podczas nagrywania.' };
    }
    let endMs = 0;
    for (const s of segs) endMs = Math.max(endMs, s.startMs + s.durMs);
    const rate = segs[0].sampleRate;
    let mix;
    try {
        mix = new Int16Array(Math.max(1, Math.ceil(endMs / 1000 * rate)));
    } catch (e) {
        return { ok: false, error: 'Za długie nagranie (~' + Math.round(endMs / 60000) + ' min) — zabrakło pamięci. Nagraj krótszy fragment.' };
    }
    for (const s of segs) {
        try {
            const buf = await s.blob.arrayBuffer();
            const w = recParseWav(buf);
            if (!w) continue;
            let pcm;
            if (w.sampleRate === rate) {
                pcm = new Int16Array(w.data.buffer, w.data.byteOffset, Math.floor(w.data.length / 2));
            } else {
                pcm = recResample(w, rate);
            }
            const offS = Math.round(s.startMs / 1000 * rate);
            for (let i = 0; i < pcm.length; i++) {
                const j = offS + i;
                if (j >= mix.length) break;
                const v = mix[j] + pcm[i];
                mix[j] = v > 32767 ? 32767 : (v < -32768 ? -32768 : v);
            }
        } catch (e) { /* pomiń uszkodzony segment */ }
    }
    const wavBuf = recBuildWav(mix, rate, 1);
    const out = new Blob([wavBuf], { type: 'audio/wav' });
    return {
        ok: true,
        url: URL.createObjectURL(out),
        count: segs.length,
        durationMs: endMs,
        sizeBytes: out.size
    };
}

// Przy starcie silnika (KONIEC modułu — wszystkie stałe już zainicjalizowane):
// usuń nagrania starsze niż 72 h — bufor sam się opróżnia.
// Uwaga: wywołanie musi być PO deklaracji REC_MAX_AGE_MS (dodane na końcu pliku
// celowo — wcześniejsze umieszczenie wywoływało TDZ ReferenceError i wywalało
// inicjalizację modułu → lektor kompletnie milczał).
try { recPruneOld().catch(() => {}); } catch (e) { console.warn('[Offscreen] prune:', e); }
