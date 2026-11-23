// [AGENT-EXP] 2026-10-24: Matcha-TTS-PL-Edge-v2 w przeglądarce — worker (ONNX Runtime Web, WASM/CPU).
// Synteza 1:1 jak w Space machinekind/matcha-tts-pl-v2 (silnik „edge”) i tts.py z Matcha-TTS-PL-Edge-v2:
// tekst → (angielskie słowa w {…}) → IPA espeak-ng → id symboli → enkoder (stochastyczny rytm, z_dur) →
// dekoder (2/4 kroki ODE) → wokoder HiFi-GAN V2. Całe zdania naraz (bez strumieniowania), 0,2 s ciszy między zdaniami.
//
// Wiadomości do workera:  { type: 'synth', id, voice, steps, text, temperature, lengthScale, style }
// Odpowiedzi:             { type: 'result', id, samples (Float32Array, przekazany), sampleRate } | { type: 'error', id, message }

// [AGENT-EXP] 2026-10-24: ONNX Runtime ładowany przy pierwszej syntezie: ort.all (WebGPU + WASM), gdy próbujemy karty,
// albo lżejszy ort.wasm, gdy liczymy od razu na procesorze (test: ort.all na procesorze ~1,4× wolniej). Worker, który
// zaczął z kartą i zszedł na procesor, zostaje na ort.all — engine.js wymienia go na nowy, gdy jest wolny.
let InferenceSession, Tensor, env, ortAll = false;
async function loadOrt() {
    if (InferenceSession) return;
    const cpu = gpuBroken || tryb === 'cpu_fp32';   // [AGENT-EXP] 2026-10-24: wariant „wszystko na procesorze” — lżejszy ort.wasm
    const m = await import(cpu ? '../supertonic/lib/ort.wasm.min.mjs' : '../supertonic/lib/ort.all.min.mjs');
    ({ InferenceSession, Tensor, env } = m);
    ortAll = !cpu;
    env.wasm.wasmPaths = new URL('../supertonic/lib/', import.meta.url).href;
    env.wasm.numThreads = Math.max(1, Math.min(4, (self.navigator && navigator.hardwareConcurrency) || 1));
    env.logLevel = 'error';
}
import { splitSentences } from './zdania.js';   // [AGENT-EXP] 2026-10-24: wspólny z engine.js (dzielenie między workery)
import { textToIpa, ipaToIds, initPhonemizer } from './cleaner.js';
import { initEnglish, markEnglish } from './english.js';

const SR = 22050, HOP = 256, GAP_S = 0.2;

let S = null, SKey = '';   // sesje bieżącego głosu: { vj, enc, dec, voc, gdzie, karta }
// [AGENT-EXP] 2026-10-24: DWA warianty (test _test_matcha_cpu_gpu w kopii „TEST Matcha warianty”: cała karta fp32 była
// 2–3× wolniejsza od procesora, koder i dekoder na karcie szkodziły; pomagał tylko wokoder na karcie, ~25% szybciej):
//   'kombi'    — koder sdp int8 i dekoder 4 kroki int8 na procesorze, wokoder fp32 na karcie (domyślny);
//               zapas: te same pliki, wokoder też na procesorze, gdy karty nie ma albo jest wolna (WebGPU nie liczy int8);
//   'cpu_fp32' — wszystko fp32 na procesorze (koder sdp, dekoder 4 kroki, wokoder), naturalny rytm.
let gpuBroken = !(self.navigator && navigator.gpu);
let tryb = 'kombi';   // z wiadomości (msg.tryb); zmianę wariantu obsługuje engine.js (nowe workery)
const CPU_FILES = ['encoder_sdp_int8.onnx', 'decoder_t4_int8.onnx', 'vocoder.onnx'];
const FP32_FILES = ['encoder_sdp.onnx', 'decoder_t4.onnx', 'vocoder.onnx'];
// [AGENT-EXP] 2026-10-24: karta wolniejsza niż procesor → procesor. Chrome hamuje WebGPU w ukrytych stronach (a dokument
// lektora jest zawsze ukryty): w teście każde zdanie trwało wtedy stałe ~2,8 s, procesor liczy ~0,35 s na 1 s mowy.
// „Wolno” = dłużej niż procesor: 0,4 s na sekundę mowy + 0,1 s. Sprawdzane próbą po wczytaniu i potem przy każdej kwestii
// (2 wolne z rzędu → procesor do końca życia workera; engine.js tworzy nowy po bezczynności lektora).
const PROBE_TEXT = 'Dzień dobry, jak się masz?';
let slowRuns = 0, lastSynthMs = 0;
const gpuSlow = (ms, samples) => ms > (0.4 * samples / SR) * 1000 + 100;

async function releaseVoice() {
    if (!S) return;
    for (const k of ['enc', 'dec', 'voc']) try { await S[k].release(); } catch (e) {}
    S = null; SKey = '';
}

// [AGENT-EXP] 2026-10-24: plik modelu z pamięci rozszerzenia (IndexedDB 'lektorVoices'/'files', klucz 'matcha/<głos>/<plik>';
// popup pobiera go z HuggingFace w „Języki świata”). 2026-11-02: modeli nie ma już w paczce — brakujący głos pobiera engine.js.
function idbGet(key) {
    return new Promise((resolve) => {
        let req;
        try { req = indexedDB.open('lektorVoices', 1); } catch (e) { resolve(null); return; }
        req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('files')) req.result.createObjectStore('files'); };
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
            const db = req.result;
            try {
                const get = db.transaction('files', 'readonly').objectStore('files').get(key);
                get.onsuccess = () => { resolve(get.result || null); db.close(); };
                get.onerror = () => { resolve(null); db.close(); };
            } catch (e) { resolve(null); db.close(); }
        };
    });
}
async function modelBytes(voice, f) {
    const v = await idbGet('matcha/' + voice + '/' + f);
    if (!v) throw new Error('brak modelu ' + voice + '/' + f + ' — pobierz głos Matcha w popupie („Języki świata”)');
    return v instanceof Blob ? new Uint8Array(await v.arrayBuffer()) : new Uint8Array(v.buffer ? v.buffer.slice(0) : v);
}

async function loadVoice(voice) {
    const key = voice + '|' + tryb + '|' + (gpuBroken || tryb !== 'kombi' ? 'cpu' : 'gpu');   // [AGENT-EXP] 2026-10-24: cpu_fp32 = zawsze 'cpu' (inaczej wczytywał modele przy każdej kwestii)
    if (S && SKey === key) return S;
    await releaseVoice();
    const bytes = (f) => modelBytes(voice, f);   // [AGENT-EXP] 2026-10-24: pamięć rozszerzenia (pobrany z internetu)
    const vj = JSON.parse(new TextDecoder().decode(await bytes('voices.json')));
    if (!gpuBroken && tryb === 'kombi') {
        try {
            const opt = { executionProviders: [{ name: 'webgpu', preferredLayout: 'NCHW' }], graphOptimizationLevel: 'all', logSeverityLevel: 3 };
            const optCpu = { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 };
            const [e, d, v] = CPU_FILES;   // [AGENT-EXP] 2026-10-24: kombinacja — tylko wokoder na karcie
            S = { vj, gdzie: 'koder i dekoder: procesor, wokoder: karta', karta: true, enc: await InferenceSession.create(await bytes(e), optCpu),
                dec: await InferenceSession.create(await bytes(d), optCpu), voc: await InferenceSession.create(await bytes(v), opt) };
            // próba: pierwsze liczenie kompiluje shadery, mierzone jest drugie
            const spk = speakerEmb(vj, null);
            await sentence(S, PROBE_TEXT, spk, 0.6, 0.92);
            const t0 = performance.now();
            const probe = await sentence(S, PROBE_TEXT, spk, 0.6, 0.92);
            const ms = Math.round(performance.now() - t0);
            if (!gpuSlow(ms, probe.length)) {
                slowRuns = 0;
                SKey = key;
                self.postMessage({ type: 'log', text: 'kombinacja (wokoder na karcie): próba ' + ms + ' ms na ' + (probe.length / SR).toFixed(2) + ' s mowy — liczę z kartą' });
                return S;
            }
            gpuBroken = true;
            await releaseVoice();
            self.postMessage({ type: 'log', cpu: true, text: 'karta graficzna wolniejsza niż procesor (próba ' + ms + ' ms na ' + (probe.length / SR).toFixed(2) + ' s mowy) — liczę na procesorze' });
        } catch (err) {
            gpuBroken = true;
            await releaseVoice();
            self.postMessage({ type: 'log', cpu: true, text: 'karta graficzna niedostępna, liczę na procesorze: ' + String(err && err.message || err).slice(0, 120) });
        }
    }
    const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 };
    // [AGENT-EXP] 2026-10-24: najpierw wybrany wariant, a gdy jego plików nie ma (Języki świata: INT8 i F32 osobno), drugi
    // (INT8 / F32), zamiast przerywać lektora; błąd dopiero, gdy nie ma żadnego.
    const pref = tryb === 'cpu_fp32';
    let fp32 = pref, encB = null, decB = null, err0 = null;
    for (const f32 of [pref, !pref]) {
        try {
            const [e, d] = f32 ? FP32_FILES : CPU_FILES;
            encB = await bytes(e);
            decB = await bytes(d);
            fp32 = f32;
            err0 = null;
            break;
        } catch (err) { if (!err0) err0 = err; }
    }
    if (err0) throw err0;
    if (fp32 !== pref) self.postMessage({ type: 'log', text: 'brak plików ' + (pref ? 'F32' : 'INT8') + ' Matchy — liczę ' + (fp32 ? 'F32' : 'INT8') + '; pobierz je w popupie („Języki świata”)' });
    S = { vj, gdzie: fp32 ? 'procesor (fp32)' : 'procesor', karta: false, enc: await InferenceSession.create(encB, opt),
        dec: await InferenceSession.create(decB, opt), voc: await InferenceSession.create(await bytes(CPU_FILES[2]), opt) };
    SKey = voice + '|' + tryb + '|cpu';
    return S;
}

function gauss(n) {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i += 2) {
        const u = 1 - Math.random(), v = Math.random(), r = Math.sqrt(-2 * Math.log(u));
        a[i] = r * Math.cos(2 * Math.PI * v);
        if (i + 1 < n) a[i + 1] = r * Math.sin(2 * Math.PI * v);
    }
    return a;
}
// [80,T] klatki a..b → [80,L] (dopełnione zerami)
function sliceT(src, T, a, b, L) {
    const out = new Float32Array(80 * L);
    for (let c = 0; c < 80; c++) out.set(src.subarray(c * T + a, c * T + b), c * L);
    return out;
}

function speakerEmb(vj, style) {
    const s = style == null ? vj.defaults.style : style;
    const spk = Float32Array.from(vj.speakers['0'].emb);
    const st = vj.styles[String(s)];
    if (st) for (let i = 0; i < spk.length; i++) spk[i] += st.emb[i];
    return new Tensor('float32', spk, [1, spk.length]);
}

async function sentence(S, text, spk, temperature, tempo) {
    const ipa = await textToIpa(markEnglish(text));
    const { seq } = ipaToIds(ipa);
    if (seq.length < 3) return new Float32Array(0);
    const sdp = S.vj.durations && S.vj.durations.sdp;
    const eo = await S.enc.run({
        x: new Tensor('int64', BigInt64Array.from(seq.map(BigInt)), [1, seq.length]),
        x_lengths: new Tensor('int64', BigInt64Array.from([BigInt(seq.length)]), [1]),
        scales: new Tensor('float32', Float32Array.from([temperature, tempo, sdp ? sdp.dur_temperature : 0.667]), [3]),
        z_dur: new Tensor('float32', gauss(seq.length), [1, 1, seq.length]),
        spk_emb: spk,
    });
    const T = Number(eo.mel_lengths.data[0]), Tf = eo.mu.dims[2];
    if (!T) return new Float32Array(0);
    const L = Math.ceil(T / 4) * 4;   // dekoder: długość wielokrotnością 4, nadmiar zamaskowany
    const mask = new Float32Array(L); mask.fill(1, 0, T);
    const d = await S.dec.run({
        mu: new Tensor('float32', sliceT(eo.mu.data, Tf, 0, T, L), [1, 80, L]),
        mask: new Tensor('float32', mask, [1, 1, L]),
        z: new Tensor('float32', sliceT(gauss(80 * T), T, 0, T, L), [1, 80, L]),
        spk_emb: spk,
        temperature: new Tensor('float32', Float32Array.from([temperature]), []),
    });
    const w = await S.voc.run({ mel: new Tensor('float32', sliceT(d.mel.data, L, 0, T, T), [1, 80, T]) });
    return Float32Array.from(w.wav.data.subarray(0, T * HOP), (x) => Math.max(-1, Math.min(1, x)));
}

async function synth(msg) {
    await Promise.all([initPhonemizer(), initEnglish()]);
    if (!InferenceSession) tryb = msg.tryb === 'cpu_fp32' ? 'cpu_fp32' : 'kombi';   // [AGENT-EXP] 2026-10-24: wariant ustalany przy starcie workera
    if (msg.forceCpu && !gpuBroken) gpuBroken = true;   // [AGENT-EXP] 2026-10-24: inny worker już ustalił, że karta jest wolna / niedostępna
    await loadOrt();
    const S = await loadVoice(msg.voice);
    const spk = speakerEmb(S.vj, msg.style);
    const temperature = Number.isFinite(msg.temperature) ? msg.temperature : S.vj.defaults.temperature;
    const tempo = Number.isFinite(msg.lengthScale) ? msg.lengthScale : S.vj.defaults.length_scale;
    const pieces = [];
    const sents = msg.split === false ? [String(msg.text || '').trim()] : splitSentences(String(msg.text || ''));   // [AGENT-EXP] 2026-10-24: część od engine.js — bez dzielenia
    const t0 = performance.now();   // [AGENT-EXP] 2026-10-24: samo liczenie (bez wczytania modelu) — do oceny karty
    for (let i = 0; i < sents.length; i++) {
        pieces.push(await sentence(S, sents[i], spk, temperature, tempo));
        if (i < sents.length - 1) pieces.push(new Float32Array(Math.round(GAP_S * SR)));
    }
    lastSynthMs = Math.round(performance.now() - t0);
    const n = pieces.reduce((a, p) => a + p.length, 0);
    const out = new Float32Array(n);
    let o = 0, peak = 0;
    for (const p of pieces) { out.set(p, o); o += p.length; }
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
    if (peak > 0 && !msg.bezNormy) { const g = Math.pow(10, -1 / 20) / peak; for (let i = 0; i < n; i++) out[i] *= g; }   // −1 dBFS jak serwer Matcha; bezNormy: normalizuje engine.js po sklejeniu
    return out;
}

self.onmessage = async (e) => {
    const msg = e.data || {};
    if (msg.type !== 'synth') return;
    try {
        const t0 = performance.now();
        let samples;
        try { samples = await synth(msg); }
        catch (err) {   // [AGENT-EXP] 2026-10-24: błąd na karcie w trakcie liczenia → jeszcze raz na procesorze
            if (!S || !S.karta) throw err;
            gpuBroken = true;
            await releaseVoice();
            self.postMessage({ type: 'log', cpu: true, text: 'błąd karty graficznej, przechodzę na procesor: ' + String(err && err.message || err).slice(0, 120) });
            samples = await synth(msg);
        }
        const info = { ms: Math.round(performance.now() - t0), gdzie: S ? S.gdzie : '', ortAll: ortAll };   // ortAll: worker ma ort.all (engine.js wymienia go na procesorze)
        if (S && S.karta) {   // [AGENT-EXP] 2026-10-24: karta zwolniła w trakcie (np. hamowanie ukrytej strony)
            if (gpuSlow(lastSynthMs, samples.length)) slowRuns++; else slowRuns = 0;
            if (slowRuns >= 2) {
                gpuBroken = true;
                await releaseVoice();
                self.postMessage({ type: 'log', cpu: true, text: 'karta graficzna zwolniła (' + lastSynthMs + ' ms na ' + (samples.length / SR).toFixed(2) + ' s mowy, 2× z rzędu) — następne kwestie na procesorze' });
            }
        }
        self.postMessage({ type: 'result', id: msg.id, samples, sampleRate: SR, info }, [samples.buffer]);
    } catch (err) {
        self.postMessage({ type: 'error', id: msg.id, message: (err && (err.message || err.stack)) || String(err) });
    }
};
