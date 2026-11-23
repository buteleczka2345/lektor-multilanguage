// ===== SILNIK SUPERTONIC (przeniesiony z VoxNemesis) =====
// Supertone Supertonic 3 (ONNX) — polski głos liczony lokalnie w przeglądarce, bez serwera.
// Model (~kilkaset MB) pobiera się raz z Hugging Face do Cache Storage, potem działa offline.
// Sprzęt wybiera ustawienie engineBackend:
//   'cpu'  — pula workerów (supertonic.worker.js, ONNX Runtime WASM): jeden worker na 4 wątki
//            procesora (max 3; 1 poniżej 8 GB RAM), po 2 wątki każdy. ~0,6–0,8 GB RAM na worker.
//   'igpu' / 'gpu' — karta zintegrowana / dedykowana (WebGPU): jeden silnik w dokumencie offscreen,
//            ort.all + ['webgpu', 'wasm']. Gdy GPU nie działa → automatycznie pula CPU (przyczyna w statusie).
// Kolejka z pierwszeństwem: kwestia czytana TERAZ (urgent) wyprzedza nagrywanie do przodu (normal).
// Moduł nie gra dźwięku — zwraca WAV, który offscreen.js wkłada do wspólnej kolejki lektora
// (tempo A/B/C, nadrabianie, głośność, nagrywanie, pamięć na dysku), jak przy pozostałych silnikach.

import { loadTextToSpeechFromUrls, loadVoiceStyleFromUrls, setOrt } from './lib/helper.js';
import { getModelBaseUrl } from './lib/models.js';

const MODEL_ID = 'supertonic-3';   // jedyny model Supertonic z językiem polskim
const LANG = 'pl';                 // Lektor zawsze czyta po polsku
export const DEFAULT_VOICE = 'Supertonic M1';
export const VOICES = ['Supertonic M1', 'Supertonic M2', 'Supertonic F1', 'Supertonic F2'];
export const DEFAULT_STEPS = 4;
const NATURAL_SPEED = 1.05;        // naturalne tempo modelu; prędkość lektora robi kolejka odtwarzania

const MODEL_PATHS = {
    ttsJson: 'onnx/tts.json',
    durationPredictor: 'onnx/duration_predictor.onnx',
    textEncoder: 'onnx/text_encoder.onnx',
    vectorEstimator: 'onnx/vector_estimator.onnx',
    vocoder: 'onnx/vocoder.onnx',
    unicodeIndexer: 'onnx/unicode_indexer.json'
};
const BASE_URL = getModelBaseUrl(MODEL_ID);
const CACHE_NAME = 'supertonic-assets-' + MODEL_ID;   // ta sama nazwa co w VoxNemesis

const WORKER_INIT_TIMEOUT_MS = 180000;
const WORKER_GEN_TIMEOUT_MS = 120000;

let log = () => {};
export function setLogger(fn) { if (typeof fn === 'function') log = fn; }

function errMsg(err) {
    return (err && (err.message || err.stack)) || String(err);
}

function runtimeUrl(path) {
    try { return chrome.runtime.getURL(path); } catch (e) { return path; }
}

// ===== Pliki modelu: Cache Storage + adresy blob =====
const objectUrlCache = new Map();
const download = { phase: 'idle', done: 0, total: Object.keys(MODEL_PATHS).length, file: '', error: null };

function downloadUrl(path) {
    return BASE_URL + '/' + path + '?download=1';
}

async function cachedResponse(remoteUrl, label) {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(remoteUrl);
    if (hit) return hit;
    download.phase = 'download';
    download.file = label;
    log('supertonic-pobieranie', label);
    const resp = await fetch(remoteUrl);
    if (!resp.ok) throw new Error('Nie udało się pobrać ' + label + ' (HTTP ' + resp.status + ')');
    await cache.put(remoteUrl, resp.clone());
    return resp;
}

function objectUrl(remoteUrl, label) {
    if (objectUrlCache.has(remoteUrl)) return objectUrlCache.get(remoteUrl);
    const p = cachedResponse(remoteUrl, label)
        .then((r) => r.blob())
        .then((b) => URL.createObjectURL(b));
    p.catch(() => objectUrlCache.delete(remoteUrl));
    objectUrlCache.set(remoteUrl, p);
    return p;
}

const doneFiles = new Set();
async function modelUrlMap() {
    download.error = null;
    if (download.phase !== 'ready') download.phase = 'check';
    try {
        const entries = await Promise.all(Object.entries(MODEL_PATHS).map(async ([key, path]) => {
            const url = await objectUrl(downloadUrl(path), key);
            doneFiles.add(key);
            download.done = doneFiles.size;
            return [key, url];
        }));
        download.phase = 'ready';
        download.file = '';
        return Object.fromEntries(entries);
    } catch (e) {
        download.phase = 'error';
        download.error = errMsg(e);
        throw e;
    }
}

function voiceStyleUrl(voiceName) {
    const style = String(voiceName || DEFAULT_VOICE).replace('Supertonic ', '');
    return objectUrl(downloadUrl('voice_styles/' + style + '.json'), voiceName);
}

// ===== Pula silników („sloty”) =====
let backend = 'cpu';
let gpuFellBack = false;   // wybrano GPU, ale nie dało się go użyć → pula CPU
let gpuError = null;
let slots = [];            // { ready, busy, lastUsed, provider, threads, run(job), dispose() }
let slotGen = 0;           // rośnie przy zmianie sprzętu: stara praca jest odrzucana
let initPromise = null;
let lastError = null;
const waiters = { urgent: [], normal: [] };

function isGpuBackend() {
    return backend === 'gpu' || backend === 'igpu';
}

function hwThreads() {
    return Math.max(1, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1);
}

function maxSlots() {
    if (isGpuBackend() && !gpuFellBack) return 1;
    const mem = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 8;
    // Jeden worker na 4 wątki zostawia rdzenie na dekodowanie wideo i stronę.
    return Math.max(1, Math.min(mem >= 8 ? 3 : 1, Math.floor(hwThreads() / 4)));
}

function threadsPerSlot() {
    return hwThreads() >= 2 ? 2 : 1;
}

function resetSlots(reason) {
    slotGen++;
    const err = new Error(reason || 'Silnik zatrzymany');
    for (const slot of slots.slice()) removeSlot(slot, err);
    slots = [];
    initPromise = null;
    for (const q of [waiters.urgent, waiters.normal]) {
        while (q.length) q.shift().reject(err);
    }
}

function removeSlot(slot, reason) {
    const idx = slots.indexOf(slot);
    if (idx >= 0) slots.splice(idx, 1);
    try { slot.dispose(reason || new Error('Silnik zatrzymany')); } catch (e) { /* ignore */ }
}

// [AGENT-EXP] 2026-10-24: ONNX Runtime ustawia kartę (env.webgpu.adapter) tylko RAZ — potem pole jest tylko do odczytu
// („Cannot assign to read only property 'adapter'”, a dedykowana ↔ zintegrowana spadała na CPU). Dlatego osobna kopia
// ort.all na każdą kartę (adres z ?karta=…) i karta wpisywana tylko przy pierwszym użyciu tej kopii.
const ortAllByPref = new Map();   // powerPreference → { promise, adapterSet, gpuName }
function loadOrtAll(pref) {
    let e = ortAllByPref.get(pref);
    if (!e) {
        e = { promise: import(runtimeUrl('supertonic/lib/ort.all.min.mjs') + '?karta=' + pref), adapterSet: false, gpuName: null };
        e.promise.catch(() => ortAllByPref.delete(pref));
        ortAllByPref.set(pref, e);
    }
    return e;
}

// „nvidia · ampere” z GPUAdapter.info (starszy Chrome: brak info → null).
function describeAdapter(adapter) {
    const info = (adapter && adapter.info) || {};
    return [info.vendor, info.architecture].filter(Boolean).join(' · ') || info.description || null;
}

// --- GPU: oryginalny silnik VoxNemesis, w tym dokumencie ---
async function createGpuSlot() {
    if (typeof navigator === 'undefined' || !navigator.gpu) throw new Error('ta przeglądarka nie ma WebGPU');
    // Laptopy z dwiema kartami: 'gpu' prosi o dedykowaną, 'igpu' o zintegrowaną. Decyduje Chrome —
    // na Windows często daje zintegrowaną, chyba że start z --force_high_performance_gpu
    // (instrukcja: supertonic/GPU-NVIDIA-instrukcja.txt). Status pokazuje, którą kartę dostaliśmy.
    const powerPreference = backend === 'igpu' ? 'low-power' : 'high-performance';
    const adapter = await navigator.gpu.requestAdapter({ powerPreference });
    if (!adapter) throw new Error('WebGPU nie znalazło karty graficznej');
    const ortEntry = loadOrtAll(powerPreference);   // [AGENT-EXP] 2026-10-24: kopia ONNX Runtime tej karty
    const ns = await ortEntry.promise;
    const ortNs = ns.default && ns.default.InferenceSession ? ns.default : ns;
    if (!ortEntry.adapterSet) {
        ortNs.env.wasm.wasmPaths = runtimeUrl('supertonic/lib/');
        ortNs.env.wasm.numThreads = Math.max(1, Math.min(4, hwThreads()));
        ortNs.env.wasm.simd = true;
        // Inaczej ONNX Runtime poprosiłby o własną kartę, bez preferencji.
        ortNs.env.webgpu = ortNs.env.webgpu || {};
        ortNs.env.webgpu.powerPreference = powerPreference;
        ortNs.env.webgpu.adapter = adapter;
        ortNs.env.logLevel = 'error';
        ortEntry.adapterSet = true;
        ortEntry.gpuName = describeAdapter(adapter);
    }
    const gpuName = ortEntry.gpuName;   // karta, którą ta kopia naprawdę liczy
    setOrt(ortNs);
    const engine = await loadTextToSpeechFromUrls(await modelUrlMap(), { executionProviders: ['webgpu', 'wasm'], logSeverityLevel: 3 });
    const styles = new Map();
    const getStyle = (name) => {
        if (!styles.has(name)) {
            const p = voiceStyleUrl(name).then((url) => loadVoiceStyleFromUrls([url]));
            p.catch(() => styles.delete(name));
            styles.set(name, p);
        }
        return styles.get(name);
    };
    await getStyle(DEFAULT_VOICE);
    const slot = {
        provider: 'webgpu',
        gpuName,
        threads: ortNs.env.wasm.numThreads,
        async run(job) {
            const style = await getStyle(job.voiceName);
            delete engine.cfgs.seed;
            try {
                const { wav } = await engine.call(job.text, LANG, style, job.steps, job.speed, 1.0);
                return { samples: Float32Array.from(wav), sampleRate: engine.sampleRate };
            } catch (e) {
                // np. utracone urządzenie GPU: ten silnik odpada, następna kwestia buduje nowy
                // (a gdy GPU zniknęło na dobre — przechodzi na workery CPU).
                log('supertonic-gpu', errMsg(e) + ' → restart silnika GPU');
                removeSlot(slot, e);
                throw e;
            }
        },
        dispose() {
            styles.clear();
            // [AGENT-EXP] 2026-10-24: zwolnij sesje (pamięć karty) — inaczej po zmianie karty stary model zostawał w VRAM
            for (const s of [engine.dpOrt, engine.textEncOrt, engine.vectorEstOrt, engine.vocoderOrt]) try { s && s.release && s.release(); } catch (e) { /* ignore */ }
        }
    };
    return slot;
}

async function createGpuSlotOrFallback() {
    try {
        const slot = await createGpuSlot();
        gpuError = null;
        return slot;
    } catch (e) {
        gpuFellBack = true;
        gpuError = errMsg(e);
        log('supertonic-gpu', 'GPU niedostępne (' + gpuError + ') → workery CPU');
        return createWorkerSlot();
    }
}

// --- CPU: jeden silnik na worker ---
async function createWorkerSlot() {
    const urls = await modelUrlMap();
    const worker = new Worker(runtimeUrl('supertonic/supertonic.worker.js'), { type: 'module' });
    const jobs = new Map();
    let seq = 0;
    let slot = null;
    const callWorker = (msg, timeoutMs) => new Promise((resolve, reject) => {
        const id = ++seq;
        // Zawieszony worker jest wymieniany: kolejna praca liczyłaby dwie syntezy na jednej sesji.
        const timer = setTimeout(() => {
            jobs.delete(id);
            reject(new Error('Worker Supertonic nie odpowiedział w ' + Math.round(timeoutMs / 1000) + ' s'));
            if (slot) { removeSlot(slot); refillSlots(); }
        }, timeoutMs);
        jobs.set(id, { resolve, reject, timer });
        worker.postMessage({ ...msg, id });
    });
    const failAll = (err) => {
        for (const job of jobs.values()) { clearTimeout(job.timer); job.reject(err); }
        jobs.clear();
    };
    worker.onmessage = (e) => {
        const data = e.data || {};
        const job = jobs.get(data.id);
        if (!job) return;
        jobs.delete(data.id);
        clearTimeout(job.timer);
        if (data.type === 'error') job.reject(new Error(data.message || 'błąd workera Supertonic'));
        else job.resolve(data);
    };
    worker.onerror = (e) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        const err = new Error((e && e.message) || 'worker Supertonic padł');
        failAll(err);
        if (slot) { removeSlot(slot, err); refillSlots(); }
    };
    try {
        const info = await callWorker({ type: 'init', libUrl: runtimeUrl('supertonic/lib/'), urls, numThreads: threadsPerSlot() }, WORKER_INIT_TIMEOUT_MS);
        slot = {
            provider: 'wasm',
            threads: info.threads,
            isolated: info.isolated,
            async run(job) {
                const styleUrl = await voiceStyleUrl(job.voiceName);
                const r = await callWorker({ type: 'generate', ...job, lang: LANG, styleName: job.voiceName, styleUrl }, WORKER_GEN_TIMEOUT_MS);
                return { samples: r.samples, sampleRate: r.sampleRate };
            },
            dispose(err) {
                failAll(err || new Error('worker zatrzymany'));
                try { worker.terminate(); } catch (e) { /* ignore */ }
            }
        };
        return slot;
    } catch (err) {
        failAll(err);
        try { worker.terminate(); } catch (e) { /* ignore */ }
        throw err;
    }
}

// Tworzy slot i zwraca go jako zajęty: należy do wywołującego.
async function spawnSlot() {
    const gen = slotGen;
    const placeholder = { ready: false, busy: true, lastUsed: Date.now(), dispose() {} };
    slots.push(placeholder);
    const t0 = Date.now();
    try {
        const slot = await ((isGpuBackend() && !gpuFellBack) ? createGpuSlotOrFallback() : createWorkerSlot());
        if (gen !== slotGen) { try { slot.dispose(); } catch (e) { /* ignore */ } throw new Error('Silnik zrestartowany w trakcie startu'); }
        Object.assign(slot, { ready: true, busy: true, lastUsed: Date.now() });
        slots[slots.indexOf(placeholder)] = slot;
        lastError = null;
        log('supertonic', (slot.provider === 'webgpu'
            ? 'GPU (WebGPU' + (slot.gpuName ? ', ' + slot.gpuName : '') + ')'
            : 'CPU, ' + slot.threads + ' wątki') + ' · worker ' + slots.length + '/' + maxSlots() + ' gotowy w ' + (Date.now() - t0) + ' ms');
        refillSlots(); // pula mogła urosnąć (GPU → CPU)
        return slot;
    } catch (err) {
        removeSlot(placeholder);
        lastError = errMsg(err);
        if (gen === slotGen) refillSlots();
        throw err;
    }
}

// Slot padł: kwestie czekające za nim czekałyby w nieskończoność — startujemy zastępstwo.
function refillSlots() {
    while (slots.length < maxSlots() && (waiters.urgent.length || waiters.normal.length)) {
        const ticket = waiters.urgent.shift() || waiters.normal.shift();
        spawnSlot().then(ticket.resolve, ticket.reject);
    }
}

function pickIdleSlot() {
    let best = null;
    for (const slot of slots) {
        if (slot.ready && !slot.busy && (!best || slot.lastUsed < best.lastUsed)) best = slot;
    }
    return best;
}

function acquireSlot(ticket) {
    const idle = pickIdleSlot();
    if (idle) {
        idle.busy = true;
        return Promise.resolve(idle);
    }
    if (slots.length < maxSlots()) return spawnSlot();
    return new Promise((resolve, reject) => {
        ticket.resolve = resolve;
        ticket.reject = reject;
        waiters[ticket.priority === 'urgent' ? 'urgent' : 'normal'].push(ticket);
    });
}

// Slot od razu do następnego czekającego (najpierw pilne), inaczej wolny.
function releaseSlot(slot) {
    slot.lastUsed = Date.now();
    if (slots.indexOf(slot) < 0) { refillSlots(); return; }
    const next = waiters.urgent.shift() || waiters.normal.shift();
    if (next) next.resolve(slot);
    else slot.busy = false;
}

// ===== API dla offscreen.js =====

// Nagrywanie do przodu, które właśnie stało się kwestią do przeczytania → na początek kolejki.
export function promoteTicket(ticket) {
    const idx = waiters.normal.indexOf(ticket);
    if (idx < 0) return;
    waiters.normal.splice(idx, 1);
    ticket.priority = 'urgent';
    waiters.urgent.push(ticket);
}

// Kasuje czekające (jeszcze nie liczone) nagrywanie do przodu — np. po zmianie głosu.
export function cancelNormalWaiters() {
    const err = new Error('anulowano');
    while (waiters.normal.length) waiters.normal.shift().reject(err);
}

// CPU ↔ GPU: działające workery są wymieniane przy następnej kwestii.
export function configure(opts) {
    const next = opts && (opts.backend === 'gpu' || opts.backend === 'igpu') ? opts.backend : 'cpu';
    if (next === backend) return;
    backend = next;
    gpuFellBack = false;
    gpuError = null;
    if (slots.length) {
        log('supertonic', next === 'gpu' ? 'przełączam na GPU dedykowaną' : next === 'igpu' ? 'przełączam na GPU zintegrowaną' : 'przełączam na CPU');
        resetSlots('Zmiana sprzętu');
    }
}

// Zatrzymuje silnik (zwalnia RAM / kartę). Pobrany model zostaje w Cache Storage.
export function resetEngine(reason) {
    gpuFellBack = false;
    gpuError = null;
    resetSlots(reason || 'Restart silnika');
}

// Rozgrzewka: pobiera model (za pierwszym razem) i startuje pierwszy silnik.
export function warmUp() {
    if (slots.some((s) => s.ready)) return Promise.resolve(true);
    if (!initPromise) {
        initPromise = (async () => {
            try {
                const slot = await acquireSlot({ priority: 'urgent' });
                releaseSlot(slot);
                return true;
            } finally {
                initPromise = null;
            }
        })();
    }
    return initPromise;
}

export function isBusy() {
    return slots.some((s) => s.busy) || waiters.urgent.length > 0 || waiters.normal.length > 0;
}

// Synteza na wolnym slocie → { promise: Promise<Blob WAV>, ticket }.
// ticket pozwala awansować czekające nagrywanie do przodu (promoteTicket) albo je anulować.
export function synthesizeWav(text, opts) {
    opts = opts || {};
    const ticket = { priority: opts.priority === 'urgent' ? 'urgent' : 'normal', resolve: null, reject: null };
    const gen = slotGen;
    const t0 = Date.now();
    const promise = (async () => {
        const slot = await acquireSlot(ticket);
        let out;
        try {
            if (gen !== slotGen) throw new Error('Silnik zrestartowany');
            out = await slot.run({
                text: String(text || ''),
                voiceName: VOICES.indexOf(opts.voiceName) >= 0 ? opts.voiceName : DEFAULT_VOICE,
                steps: Math.max(1, Math.min(20, Number(opts.steps) || DEFAULT_STEPS)),
                speed: NATURAL_SPEED
            });
        } finally {
            releaseSlot(slot);
        }
        const blob = wavBlob(trimSilence(out.samples, out.sampleRate), out.sampleRate);
        log('supertonic-ok', (Date.now() - t0) + ' ms · ' + String(text || '').slice(0, 30));
        return blob;
    })();
    return { promise, ticket };
}

export function engineStatus() {
    const ready = slots.filter((s) => s.ready);
    return {
        backend,
        provider: ready.length ? ready[0].provider : null,
        gpuName: (ready.length && ready[0].gpuName) || null,
        gpuError,
        gpuFellBack,
        starting: slots.some((s) => !s.ready),
        slotsReady: ready.length,
        slotsMax: maxSlots(),
        threads: ready.length ? ready[0].threads : threadsPerSlot(),
        isolated: (typeof self !== 'undefined') ? !!self.crossOriginIsolated : false,
        queued: waiters.urgent.length + waiters.normal.length,
        download: Object.assign({}, download),
        lastError
    };
}

// ===== WAV =====
function wavBlob(samples, sampleRate) {
    const input = samples instanceof Float32Array ? samples : new Float32Array(samples);
    const n = input.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0, o = 44; i < n; i++, o += 2) {
        const s = Math.max(-1, Math.min(1, input[i]));
        v.setInt16(o, s < 0 ? s * 32768 : s * 32767, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
}

// Przycina ciszę na końcach, żeby podzielone kwestie nie miały dziur.
function trimSilence(samples, sampleRate) {
    if (!samples || !samples.length || !sampleRate) return samples;
    const TH = 0.004;
    const n = samples.length;
    const tail = Math.max(1, Math.round(sampleRate * 0.08));
    const head = Math.max(1, Math.round(sampleRate * 0.02));
    let end = n;
    while (end > tail && Math.abs(samples[end - 1]) < TH) end--;
    end = Math.min(n, end + tail);
    let start = 0;
    while (start < end - 1 && Math.abs(samples[start]) < TH) start++;
    start = Math.max(0, start - head);
    if ((end - start) < Math.floor(n * 0.15)) return samples;
    if (start === 0 && end === n) return samples;
    return samples.subarray(start, end);
}
