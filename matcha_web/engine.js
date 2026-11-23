// [AGENT-EXP] 2026-10-24: Matcha-TTS-PL-Edge-v2 w przeglądarce — strona offscreenu. Workery (matcha.worker.js)
// z kolejką tutaj, żeby kwestia czytana TERAZ (pilne) szła przed nagrywaniem do przodu.
// synthesizeWav(text, opts) → Promise<Blob audio/wav>, tak jak matchaSynthesize przez WebSocket.
// [AGENT-EXP] 2026-10-24: PULA 2 workerów (przeniesione z kopii „TEST Matcha warianty”: 1,9× szybciej na procesorze).
// Dokument lektora nie jest cross-origin isolated → ONNX w workerze ma 1 wątek, więc 2 workery = 2 rdzenie naraz:
// kwestia czytana teraz i nagrywanie do przodu liczą się równolegle, a długa kwestia (kilka zdań) jest dzielona na zdania
// (splitSentences z zdania.js, jak w workerze), każde na innym workerze; sklejenie z 0,2 s ciszy i −1 dBFS.
// Karta / procesor: na karcie liczy JEDEN worker (test: dwa naraz na jednej karcie przeszkadzały sobie — 4,7 s na kwestię
// zamiast 0,6 s, i oba schodziły na procesor). Gdy worker przejdzie na procesor (log z cpu: true) → forceCpu: pula rośnie
// do 2 workerów (oba na procesorze), drugi od razu wczytuje model.
import { splitSentences } from './zdania.js';

const WORKER_TIMEOUT_MS = 180000;   // pierwsza synteza wczytuje model (~30–90 MB) i espeak
const POOL_SIZE = 2;   // na procesorze; na karcie 1 (poolSize())
const GAP_S = 0.2;
let pool = [];                      // { nr, worker, running: { id, job, timer } | null }
let slotNr = 0;
let seq = 0;
let forceCpu = false;
// [AGENT-EXP] 2026-10-24: dwa warianty (matcha.worker.js): 'kombi' — na karcie tylko wokoder, więc 2 workery naraz nie
// przeszkadzają sobie (test: 2 workery, RTF 0,23); 'cpu_fp32' — wszystko na procesorze. Pula zawsze 2 workery.
let tryb = 'kombi';
const poolSize = () => POOL_SIZE;
function setTryb(t) {   // zmiana wariantu → nowe workery (worker wczytuje ort i pliki pod swój wariant)
    t = t === 'cpu_fp32' ? 'cpu_fp32' : 'kombi';
    if (t === tryb) return;
    tryb = t;
    reset('zmiana wariantu');
}
let lastWarm = null;   // opcje ostatniego warmUp — do wczytania drugiego workera po przejściu na procesor
const queue = { urgent: [], normal: [] };
let log = () => {};

// [AGENT-EXP] 2026-11-02: modeli nie ma w paczce. Zanim workery zaczną liczyć, głos musi mieć w pamięci rozszerzenia
// (IndexedDB 'lektorVoices'/'files', klucze 'matcha/<głos>/<plik>' jak popup „Języki świata”) komplet INT8 albo F32;
// gdy nie ma żadnego, brakujące pliki INT8 (~27 MB) pobieramy RAZ z HuggingFace i stawiamy znacznik '_ok' (popup: 🗑).
const REPO = 'https://huggingface.co/machinekind/Matcha-TTS-PL-Edge-v2/resolve/main/';
const INT8_FILES = ['voices.json', 'encoder_sdp_int8.onnx', 'decoder_t4_int8.onnx', 'vocoder.onnx'];
const F32_FILES = ['voices.json', 'vocoder.onnx', 'encoder_sdp.onnx', 'decoder_t4.onnx'];
const ready = new Map();   // głos → true (komplet jest) | Promise (sprawdzanie / pobieranie w toku)
function idb(mode, fn) {   // fn(store) → wynik po zakończeniu transakcji
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('lektorVoices', 1);
        req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('files')) req.result.createObjectStore('files'); };
        req.onerror = () => reject(req.error || new Error('IndexedDB niedostępna'));
        req.onsuccess = () => {
            const db = req.result;
            try {
                const tx = db.transaction('files', mode);
                const out = fn(tx.objectStore('files'));
                tx.oncomplete = () => { db.close(); resolve(out); };
                tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error('IndexedDB: zapis nieudany')); };
            } catch (e) { db.close(); reject(e); }
        };
    });
}
async function ensureModel(voice) {
    const key = (f) => 'matcha/' + voice + '/' + f;
    const keys = (await idb('readonly', (st) => st.getAllKeys(IDBKeyRange.bound(key(''), key('￿'))))).result.map(String);
    const has = (f) => keys.includes(key(f));
    if (INT8_FILES.every(has) || F32_FILES.every(has)) return;
    const missing = INT8_FILES.filter((f) => !has(f));
    for (let i = 0; i < missing.length; i++) {
        const f = missing[i];
        log('matcha-web-pobieranie', voice + '/' + f + ' (' + (i + 1) + '/' + missing.length + ') z HuggingFace…');
        const r = await fetch(REPO + voice + '/' + f);
        if (!r.ok) throw new Error(f + ': HTTP ' + r.status);
        const data = new Uint8Array(await r.arrayBuffer());
        if (/\.onnx$/.test(f) && !(data.length > 1024 * 1024 && data[0] === 0x08)) throw new Error(f + ' nie wygląda na model ONNX');
        await idb('readwrite', (st) => st.put(data, key(f)));
    }
    await idb('readwrite', (st) => st.put(Date.now(), key('_ok')));
    log('matcha-web-pobieranie', 'głos ' + voice + ' pobrany (INT8) — następnym razem z pamięci, także bez internetu');
}
// true = można liczyć; false = sprawdzanie / pobieranie w toku (potem pump() sam ruszy kolejkę)
function modelReady(voice) {
    const r = ready.get(voice);
    if (r === true) return true;
    if (!r) ready.set(voice, ensureModel(voice).then(() => { ready.set(voice, true); pump(); }, (err) => {
        ready.delete(voice);   // następna kwestia spróbuje jeszcze raz
        const m = 'nie ma głosu ' + voice + ' i nie udało się go pobrać (' + ((err && err.message) || err) + ') — sprawdź internet albo pobierz go w popupie („Języki świata”)';
        log('matcha-web-pobieranie-fail', m);
        cancelQueued(m);
    }));
    return false;
}

export function setLogger(fn) { if (typeof fn === 'function') log = fn; }

function makeSlot() {
    const slot = { nr: ++slotNr, worker: new Worker(new URL('./matcha.worker.js', import.meta.url), { type: 'module' }), running: null, cpuOrt: forceCpu };   // cpuOrt: od startu na procesorze (lżejszy ort.wasm)
    slot.worker.onmessage = (e) => {
        const d = e.data || {};
        if (d.type === 'log') {   // karta / procesor
            log('matcha-web', 'worker ' + slot.nr + ': ' + d.text);
            if (d.cpu) goCpu();
            return;
        }
        if (d.type === 'result' && d.info) slot.cpuOrt = !d.info.ortAll;   // lżejszy ort.wasm — nie trzeba wymieniać
        if (d.type === 'result' && d.info && d.info.gdzie === 'procesor') goCpu();   // też gdy karty nie było od początku (bez logu)
        if (!slot.running || d.id !== slot.running.id) return;
        const { job, timer } = slot.running;
        clearTimeout(timer);
        slot.running = null;
        if (d.type === 'result') job.resolve({ samples: d.samples, sampleRate: d.sampleRate, info: d.info, nr: slot.nr });
        else job.reject(new Error('Matcha w przeglądarce: ' + (d.message || 'błąd syntezy')));
        pump();
    };
    slot.worker.onerror = (e) => {
        const err = new Error('Matcha w przeglądarce: worker padł (' + ((e && e.message) || 'nieznany błąd') + ')');
        log('matcha-web-worker-fail', err.message);
        killSlot(slot, err);
        pump();
    };
    pool.push(slot);
    return slot;
}

// Worker liczy na procesorze → pula 2 workerów; drugi od razu wczytuje model.
function goCpu() {
    if (forceCpu) return;
    forceCpu = true;
    enqueue({ voice: (lastWarm && lastWarm.voice) || 'male_voxcpm_2', steps: 4, text: 'Dzień dobry.', nowy: true }, false).catch(() => {});
}

function killSlot(slot, err) {
    try { slot.worker.terminate(); } catch (e) {}
    pool = pool.filter((s) => s !== slot);
    if (!pool.length) warmKey = '';
    if (slot.running) { clearTimeout(slot.running.timer); slot.running.job.reject(err || new Error('Matcha w przeglądarce: worker zamknięty')); slot.running = null; }
}

function pump() {
    for (;;) {
        const list = queue.urgent.length ? queue.urgent : queue.normal;
        if (!list.length) return;
        if (!modelReady(list[0].msg.voice)) return;   // [AGENT-EXP] 2026-11-02: głos się pobiera — kolejka czeka
        // po przejściu na procesor: wolne workery zaczęte z kartą (ort.all — wolniejszy na procesorze) wymieniamy na nowe
        if (forceCpu) for (const s of pool.slice()) if (!s.running && !s.cpuOrt) killSlot(s);
        let slot = list[0].msg.nowy && pool.length < poolSize() ? null : pool.find((s) => !s.running);   // nowy: wczytanie modelu w NOWYM workerze
        if (!slot) {
            if (pool.length >= poolSize()) return;   // wszystkie zajęte — czekamy
            slot = makeSlot();
        }
        const job = list.shift();
        const id = ++seq;
        const timer = setTimeout(() => {
            killSlot(slot, new Error('Matcha w przeglądarce nie odpowiedział w ' + Math.round(WORKER_TIMEOUT_MS / 1000) + ' s.'));
            pump();
        }, WORKER_TIMEOUT_MS);
        slot.running = { id, job, timer };
        slot.worker.postMessage({ type: 'synth', id, forceCpu, tryb, ...job.msg });
    }
}

function enqueue(msg, pilne, ticket) {
    return new Promise((resolve, reject) => {
        (pilne ? queue.urgent : queue.normal).push({ msg, resolve, reject, ticket: ticket || null });
        pump();
    });
}

// [FIX 2026-11-02] Awans: kwestia nagrywana do przodu właśnie ma być czytana — jej czekające części (ticket z opts.ticket)
// przechodzą z kolejki zwykłej do pilnej (w tej samej kolejności). Części już liczone kończą się normalnie.
export function promote(ticket) {
    if (!ticket) return 0;
    let n = 0;
    for (let i = 0; i < queue.normal.length;) {
        if (queue.normal[i].ticket === ticket) { queue.urgent.push(queue.normal.splice(i, 1)[0]); n++; }
        else i++;
    }
    if (n) pump();
    return n;
}

// opts: { voice: 'male_voxcpm_2' | 'female_voxcpm_2', steps: 2|4, temperature, lengthScale, style, pilne }
export function synthesizeWav(text, opts = {}) {
    setTryb(opts.tryb);   // [AGENT-EXP] 2026-10-24
    const base = { voice: opts.voice || 'male_voxcpm_2', steps: opts.steps === 2 ? 2 : 4,
        temperature: opts.temperature, lengthScale: opts.lengthScale, style: opts.style };
    const t0 = performance.now();
    const parts = poolSize() > 1 ? splitSentences(String(text || '')) : [String(text || '')];   // na karcie 1 worker — bez dzielenia
    const jobs = parts.length > 1
        ? parts.map((p) => enqueue({ ...base, text: p, split: false, bezNormy: true }, opts.pilne, opts.ticket))
        : [enqueue({ ...base, text: String(text || '') }, opts.pilne, opts.ticket)];
    return Promise.all(jobs).then((res) => {
        const sr = res[0].sampleRate;
        let out = res[0].samples;
        if (res.length > 1) {
            const gap = Math.round(GAP_S * sr);
            const n = res.reduce((a, r) => a + r.samples.length, 0) + gap * (res.length - 1);
            out = new Float32Array(n);
            let o = 0, peak = 0;
            res.forEach((r, i) => { out.set(r.samples, o); o += r.samples.length + (i < res.length - 1 ? gap : 0); });
            for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
            if (peak > 0) { const g = Math.pow(10, -1 / 20) / peak; for (let i = 0; i < n; i++) out[i] *= g; }   // −1 dBFS jak worker
        }
        const gdzie = [...new Set(res.map((r) => r.info && r.info.gdzie).filter(Boolean))].join(' + ');
        log('matcha-web-czas', Math.round(performance.now() - t0) + ' ms → ' + (out.length / sr).toFixed(2) + ' s mowy · ' + gdzie
            + ' · części: ' + res.length + ' · workery: ' + [...new Set(res.map((r) => r.nr))].join('+'));
        return wavBlob(out, sr);
    });
}

// Zmiana głosu / silnika / pauza: porzuca czekające zadania (bieżące kończą się same).
// which: 'urgent' (czytane teraz — jak zamknięcie matchaSockets), 'normal' (do przodu — matchaPreloadSockets), 'all'.
export function cancelQueued(reason = 'anulowano', which = 'all') {
    const lists = which === 'urgent' ? [queue.urgent] : which === 'normal' ? [queue.normal] : [queue.urgent, queue.normal];
    for (const list of lists) {
        while (list.length) list.shift().reject(new Error('Matcha w przeglądarce: ' + reason));
    }
}

// Bezczynność lektora: zwalnia workery (pamięć modelu); następna synteza wczyta je od nowa (i znów spróbuje karty).
export function reset(reason = 'zresetowany') {
    cancelQueued(reason);
    for (const s of pool.slice()) killSlot(s, new Error('Matcha w przeglądarce: ' + reason));
    forceCpu = false;
    for (const [v, r] of ready) if (r === true) ready.delete(v);   // [AGENT-EXP] 2026-11-02: głos mógł zostać skasowany w popupie
}

// [AGENT-EXP] 2026-10-24: wczytanie modelu zawczasu (start lektora) — we wszystkich workerach puli naraz, żeby pierwsza
// długa kwestia (dzielona na zdania) nie czekała 5–10 s na wczytanie drugiego.
let warmKey = '';
export function warmUp(opts = {}) {
    setTryb(opts.tryb);   // [AGENT-EXP] 2026-10-24
    const key = (opts.voice || 'male_voxcpm_2') + '|' + tryb;
    if (warmKey === key) return;
    warmKey = key;
    lastWarm = opts;
    for (let i = 0; i < poolSize(); i++) synthesizeWav('Dzień dobry.', opts).catch(() => { warmKey = ''; });
}

export function isBusy() { return pool.some((s) => s.running) || queue.urgent.length > 0 || queue.normal.length > 0; }

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
