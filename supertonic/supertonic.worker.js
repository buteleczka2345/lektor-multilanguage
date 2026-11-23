// Supertonic CPU worker — one ONNX Runtime Web (WASM, CPU only) instance per worker.
// The offscreen document owns a pool of these workers (see supertonic/engine.js), so several
// subtitle lines can be synthesized in parallel on different CPU cores while the
// offscreen main thread stays free for audio playback. (The GPU engine runs in the
// offscreen document itself, as in the original VoxNemesis.)
//
// Messages in:
//   { type: 'init', id, libUrl, urls, numThreads }
//   { type: 'generate', id, text, lang, steps, speed, seed, styleName, styleUrl }
// Messages out:
//   { type: 'ready', id, threads, isolated }
//   { type: 'result', id, samples (Float32Array, transferred), sampleRate }
//   { type: 'error', id, message }

import { InferenceSession, Tensor, env } from './lib/ort.wasm.min.mjs';
import { loadTextToSpeechFromUrls, loadVoiceStyleFromUrls, setOrt } from './lib/helper.js';

setOrt({ InferenceSession, Tensor, env });

let tts = null;
const styles = new Map(); // styleName -> Promise<Style>

function errMsg(err) {
    return (err && (err.message || err.stack)) || String(err);
}

async function init(msg) {
    env.wasm.wasmPaths = msg.libUrl;
    env.wasm.numThreads = Math.max(1, msg.numThreads | 0);
    env.logLevel = 'error'; // ORT warnings (shape ops on CPU, unknown CPU vendor) are harmless noise
    tts = await loadTextToSpeechFromUrls(msg.urls, { executionProviders: ['wasm'], logSeverityLevel: 3 });
    return { threads: env.wasm.numThreads, isolated: !!self.crossOriginIsolated };
}

function getStyle(name, url) {
    if (!styles.has(name)) {
        const p = loadVoiceStyleFromUrls([url]);
        p.catch(() => styles.delete(name));
        styles.set(name, p);
    }
    return styles.get(name);
}

async function generate(msg) {
    if (!tts) throw new Error('Engine not initialized');
    const style = await getStyle(msg.styleName, msg.styleUrl);
    if (msg.seed !== undefined && msg.seed !== null && msg.seed !== '') tts.cfgs.seed = parseInt(msg.seed, 10);
    else delete tts.cfgs.seed;
    const { wav } = await tts.call(String(msg.text || ''), msg.lang || 'en', style, msg.steps || 6, msg.speed || 1.05, 1.0);
    return { samples: Float32Array.from(wav), sampleRate: tts.sampleRate };
}

self.onmessage = async (event) => {
    const msg = event.data || {};
    try {
        if (msg.type === 'init') {
            const info = await init(msg);
            self.postMessage({ type: 'ready', id: msg.id, ...info });
        } else if (msg.type === 'generate') {
            const { samples, sampleRate } = await generate(msg);
            self.postMessage({ type: 'result', id: msg.id, samples, sampleRate }, [samples.buffer]);
        }
    } catch (err) {
        self.postMessage({ type: 'error', id: msg.id, message: errMsg(err) });
    }
};
