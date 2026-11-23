// Helper functions for Supertonic TTS
// Synced with official supertonic web/helper.js
// Lektor: ONNX Runtime przychodzi przez setOrt() (worker CPU: ort.wasm, GPU: ort.all), a nie z globalnego
// window.ort — dokument offscreen ma tam już ONNX Runtime z PP-OCR (inna wersja, bez WebGPU).
let ort = null;
export function setOrt(namespace) { ort = namespace; }

export const AVAILABLE_LANGS = ['en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi', 'fr', 'hi', 'hr', 'hu', 'id', 'it', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'vi', 'na'];

export function isValidLang(lang) {
    return AVAILABLE_LANGS.includes(lang);
}

/**
 * Unicode Text Processor
 */
export class UnicodeProcessor {
    constructor(indexer) {
        this.indexer = indexer;
    }

    call(textList, langList) {
        const processedTexts = textList.map((text, i) => this.preprocessText(text, langList[i]));

        const textIdsLengths = processedTexts.map(text => text.length);
        const maxLen = Math.max(...textIdsLengths);

        const textIds = processedTexts.map(text => {
            const row = new Array(maxLen).fill(0);
            for (let j = 0; j < text.length; j++) {
                const codePoint = text.codePointAt(j);
                row[j] = (codePoint < this.indexer.length) ? this.indexer[codePoint] : -1;
            }
            return row;
        });

        const textMask = this.getTextMask(textIdsLengths);
        return { textIds, textMask };
    }

    preprocessText(text, lang) {
        if (!text) return "";
        text = text.normalize('NFKD');

        // Remove emojis (comprehensive Unicode range)
        const emojiPattern = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{1FB00}-\u{1FBFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]+/gu;
        text = text.replace(emojiPattern, '');

        // Replace various dashes and symbols
        const replacements = {
            '\u2013': '-', '\u2011': '-', '\u2014': '-',
            '_': ' ',
            '\u201C': '"', '\u201D': '"',
            '\u2018': "'", '\u2019': "'",
            '\u00B4': "'", '`': "'",
            '[': ' ', ']': ' ', '|': ' ', '/': ' ',
            '#': ' ', '\u2192': ' ', '\u2190': ' ',
            '\u2026': '...', '\u00B0': ' degrees ',
            '\u00A9': '', '\u00AE': '', '\u2122': '',
            '\u2605': '', '\u2606': '', '\u2713': '', '\u2717': '',
        };
        for (const [k, v] of Object.entries(replacements)) {
            text = text.replaceAll(k, v);
        }

        // Remove remaining special symbols (stars, hearts, checkmarks, boxes, etc.)
        text = text.replace(/[♥☆♡©®™★☆✓✗✗✦✧❒❑■□▪▫◆◇◈◉●○◎⊙]/g, '');

        // Replace known expressions
        const exprReplacements = {
            '@': ' at ',
            'e.g.,': 'for example, ',
            'i.e.,': 'that is, ',
        };
        for (const [k, v] of Object.entries(exprReplacements)) {
            text = text.replaceAll(k, v);
        }

        // Fix spacing around punctuation
        text = text.replace(/ ,/g, ',');
        text = text.replace(/ \./g, '.');
        text = text.replace(/ !/g, '!');
        text = text.replace(/ \?/g, '?');
        text = text.replace(/ ;/g, ';');
        text = text.replace(/ :/g, ':');
        text = text.replace(/ '/g, "'");

        // Remove duplicate quotes
        while (text.includes('""')) text = text.replace('""', '"');
        while (text.includes("''")) text = text.replace("''", "'");
        while (text.includes('``')) text = text.replace('``', '`');

        // Remove extra spaces
        text = text.replace(/\s+/g, ' ').trim();

        // Ensure punctuation
        if (!/[.!?;:,'\"')\]}…。」』】〉》›»]$/.test(text)) {
            text += '.';
        }

        // Wrap text with language tags (critical for multilingual models)
        text = `<${lang}>${text}</${lang}>`;

        return text;
    }

    getTextMask(textIdsLengths) {
        const maxLen = Math.max(...textIdsLengths);
        return this.lengthToMask(textIdsLengths, maxLen);
    }

    lengthToMask(lengths, maxLen = null) {
        const actualMaxLen = maxLen || Math.max(...lengths);
        return lengths.map(len => {
            const row = new Array(actualMaxLen).fill(0.0);
            for (let j = 0; j < Math.min(len, actualMaxLen); j++) {
                row[j] = 1.0;
            }
            return [row];
        });
    }
}

export class Style {
    constructor(ttlTensor, dpTensor) {
        this.ttl = ttlTensor;
        this.dp = dpTensor;
    }
}

export class TextToSpeech {
    constructor(cfgs, textProcessor, dpOrt, textEncOrt, vectorEstOrt, vocoderOrt) {
        this.cfgs = cfgs;
        this.textProcessor = textProcessor;
        this.dpOrt = dpOrt;
        this.textEncOrt = textEncOrt;
        this.vectorEstOrt = vectorEstOrt;
        this.vocoderOrt = vocoderOrt;
        this.sampleRate = cfgs.ae.sample_rate;
    }

    async _infer(textList, langList, style, totalStep, speed = 1.05, progressCallback = null) {
        const bsz = textList.length;
        const { textIds, textMask } = this.textProcessor.call(textList, langList);

        const textIdsFlat = new BigInt64Array(textIds.flat().map(x => BigInt(x)));
        const textIdsTensor = new ort.Tensor('int64', textIdsFlat, [bsz, textIds[0].length]);

        const textMaskFlat = new Float32Array(textMask.flat(2));
        const textMaskTensor = new ort.Tensor('float32', textMaskFlat, [bsz, 1, textMask[0][0].length]);

        // Duration Predictor
        const dpOutputs = await this.dpOrt.run({
            text_ids: textIdsTensor,
            style_dp: style.dp,
            text_mask: textMaskTensor
        });
        const duration = Array.from(dpOutputs.duration.data);

        // Apply speed
        for (let i = 0; i < duration.length; i++) duration[i] /= speed;

        // Text Encoder
        const textEncOutputs = await this.textEncOrt.run({
            text_ids: textIdsTensor,
            style_ttl: style.ttl,
            text_mask: textMaskTensor
        });

        // Sample Noisy Latent
        let { xt, latentMask } = this.sampleNoisyLatent(
            duration,
            this.sampleRate,
            this.cfgs.ae.base_chunk_size,
            this.cfgs.ttl.chunk_compress_factor,
            this.cfgs.ttl.latent_dim
        );

        const latentMaskFlat = new Float32Array(latentMask.flat(2));
        const latentMaskTensor = new ort.Tensor('float32', latentMaskFlat, [bsz, 1, latentMask[0][0].length]);

        const totalStepArray = new Float32Array(bsz).fill(totalStep);
        const totalStepTensor = new ort.Tensor('float32', totalStepArray, [bsz]);

        // Denoising Loop
        for (let step = 0; step < totalStep; step++) {
            if (progressCallback) progressCallback(step + 1, totalStep);

            const currentStepArray = new Float32Array(bsz).fill(step);
            const currentStepTensor = new ort.Tensor('float32', currentStepArray, [bsz]);

            const xtFlat = new Float32Array(xt.flat(2));
            const xtTensor = new ort.Tensor('float32', xtFlat, [bsz, xt[0].length, xt[0][0].length]);

            const vectorEstOutputs = await this.vectorEstOrt.run({
                noisy_latent: xtTensor,
                text_emb: textEncOutputs.text_emb,
                style_ttl: style.ttl,
                latent_mask: latentMaskTensor,
                text_mask: textMaskTensor,
                current_step: currentStepTensor,
                total_step: totalStepTensor
            });

            const denoised = Array.from(vectorEstOutputs.denoised_latent.data);

            const latentDim = xt[0].length;
            const latentLen = xt[0][0].length;
            xt = [];
            let idx = 0;
            for (let b = 0; b < bsz; b++) {
                const batch = [];
                for (let d = 0; d < latentDim; d++) {
                    const row = [];
                    for (let t = 0; t < latentLen; t++) {
                        row.push(denoised[idx++]);
                    }
                    batch.push(row);
                }
                xt.push(batch);
            }
        }

        // Vocoder
        const finalXtFlat = new Float32Array(xt.flat(2));
        const finalXtTensor = new ort.Tensor('float32', finalXtFlat, [bsz, xt[0].length, xt[0][0].length]);

        const vocoderOutputs = await this.vocoderOrt.run({ latent: finalXtTensor });
        let wav = Array.from(vocoderOutputs.wav_tts.data);

        // Apply Volume
        if (speed !== 1.0) {
            // volume is not in the official API signature here, handled in call()
        }

        return { wav, duration };
    }

    async call(text, lang, style, totalStep, speed = 1.05, volume = 1.0, progressCallback = null) {
        const maxLen = (lang === 'ko' || lang === 'ja') ? 120 : 300;
        const textList = chunkText(text, maxLen);
        const langList = new Array(textList.length).fill(lang);
        let wavCat = [];
        let durCat = 0;

        for (let i = 0; i < textList.length; i++) {
            const { wav, duration } = await this._infer([textList[i]], [langList[i]], style, totalStep, speed, progressCallback);

            if (wavCat.length === 0) {
                wavCat = wav;
                durCat = duration[0];
            } else {
                const silenceLen = Math.floor(0.1 * this.sampleRate);
                const silence = new Array(silenceLen).fill(0);
                wavCat = [...wavCat, ...silence, ...wav];
                durCat += duration[0] + 0.1;
            }
        }

        // Apply volume
        if (volume !== 1.0) {
            wavCat = wavCat.map(s => s * volume);
        }

        return { wav: wavCat, duration: [durCat] };
    }

    sampleNoisyLatent(duration, sampleRate, baseChunkSize, chunkCompress, latentDim) {
        const bsz = duration.length;
        const maxDur = Math.max(...duration);

        const wavLenMax = Math.floor(maxDur * sampleRate);
        const wavLengths = duration.map(d => Math.floor(d * sampleRate));

        const chunkSize = baseChunkSize * chunkCompress;
        const latentLen = Math.floor((wavLenMax + chunkSize - 1) / chunkSize);
        const latentDimVal = latentDim * chunkCompress;

        // Seeded RNG
        const seed = (this.cfgs.seed !== undefined) ? this.cfgs.seed : Math.random();
        let rngState = seed;
        const random = () => {
            if (this.cfgs.seed === undefined) return Math.random();
            rngState = (rngState * 1664525 + 1013904223) % 4294967296;
            return rngState / 4294967296;
        };

        const xt = [];
        for (let b = 0; b < bsz; b++) {
            const batch = [];
            for (let d = 0; d < latentDimVal; d++) {
                const row = [];
                for (let t = 0; t < latentLen; t++) {
                    const u1 = Math.max(0.0001, random());
                    const u2 = random();
                    const val = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
                    row.push(val);
                }
                batch.push(row);
            }
            xt.push(batch);
        }

        const latentLengths = wavLengths.map(len => Math.floor((len + chunkSize - 1) / chunkSize));
        const latentMask = this.lengthToMask(latentLengths, latentLen);

        // Apply mask
        for (let b = 0; b < bsz; b++) {
            for (let d = 0; d < latentDimVal; d++) {
                for (let t = 0; t < latentLen; t++) {
                    xt[b][d][t] *= latentMask[b][0][t];
                }
            }
        }

        return { xt, latentMask };
    }

    lengthToMask(lengths, maxLen = null) {
        const actualMaxLen = maxLen || Math.max(...lengths);
        return lengths.map(len => {
            const row = new Array(actualMaxLen).fill(0.0);
            for (let j = 0; j < Math.min(len, actualMaxLen); j++) {
                row[j] = 1.0;
            }
            return [row];
        });
    }
}

function chunkText(text, maxLen = 300) {
    if (typeof text !== 'string') {
        throw new Error(`chunkText expects a string, got ${typeof text}`);
    }

    const paragraphs = text.trim().split(/\n\s*\n+/).filter(p => p.trim());
    const chunks = [];

    for (let paragraph of paragraphs) {
        paragraph = paragraph.trim();
        if (!paragraph) continue;

        // Split by sentence boundaries, excluding common abbreviations
        const sentences = paragraph.split(/(?<!Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|Ph\.D\.|etc\.|e\.g\.|i\.e\.|vs\.|Inc\.|Ltd\.|Co\.|Corp\.|St\.|Ave\.|Blvd\.)(?<!\b[A-Z]\.)(?<=[.!?])\s+/);

        let currentChunk = "";

        for (let sentence of sentences) {
            if (currentChunk.length + sentence.length + 1 <= maxLen) {
                currentChunk += (currentChunk ? " " : "") + sentence;
            } else {
                if (currentChunk) chunks.push(currentChunk.trim());
                currentChunk = sentence;
            }
        }

        if (currentChunk) chunks.push(currentChunk.trim());
    }

    return chunks;
}

// Load style tensors from one or more style files (URL strings).
export async function loadVoiceStyle(voiceStylePaths, verbose = false) {
    const bsz = voiceStylePaths.length;

    const firstResponse = await fetch(voiceStylePaths[0]);
    const firstStyle = await firstResponse.json();

    const ttlDims = firstStyle.style_ttl.dims;
    const dpDims = firstStyle.style_dp.dims;

    const ttlSize = bsz * ttlDims[1] * ttlDims[2];
    const dpSize = bsz * dpDims[1] * dpDims[2];
    const ttlFlat = new Float32Array(ttlSize);
    const dpFlat = new Float32Array(dpSize);

    for (let i = 0; i < bsz; i++) {
        const response = await fetch(voiceStylePaths[i]);
        const voiceStyle = await response.json();

        const ttlData = voiceStyle.style_ttl.data.flat(Infinity);
        ttlFlat.set(ttlData, i * ttlDims[1] * ttlDims[2]);

        const dpData = voiceStyle.style_dp.data.flat(Infinity);
        dpFlat.set(dpData, i * dpDims[1] * dpDims[2]);
    }

    const ttlTensor = new ort.Tensor('float32', ttlFlat, [bsz, ttlDims[1], ttlDims[2]]);
    const dpTensor = new ort.Tensor('float32', dpFlat, [bsz, dpDims[1], dpDims[2]]);

    return new Style(ttlTensor, dpTensor);
}

// Load style tensors directly from already-resolved URLs.
export async function loadVoiceStyleFromUrls(styleUrls) {
    const response = await fetch(styleUrls[0]);
    const styleJson = await response.json();
    return buildStyleFromJson(styleJson);
}

// Build style tensors from parsed JSON.
function buildStyleFromJson(styleJson) {
    const ttlDims = styleJson.style_ttl.dims;
    const dpDims = styleJson.style_dp.dims;

    const ttlData = styleJson.style_ttl.data.flat(Infinity);
    const dpData = styleJson.style_dp.data.flat(Infinity);

    const ttlTensor = new ort.Tensor('float32', Float32Array.from(ttlData), [1, ttlDims[1], ttlDims[2]]);
    const dpTensor = new ort.Tensor('float32', Float32Array.from(dpData), [1, dpDims[1], dpDims[2]]);

    return new Style(ttlTensor, dpTensor);
}

// Load TTS models from a directory path bundled with the extension.
export async function loadTextToSpeech(onnxDir, options = {}) {
    const cfgs = await (await fetch(`${onnxDir}/tts.json`)).json();
    const sessionOptions = {
        executionProviders: ['wasm'],
        ...options
    };
    const loadSession = path => ort.InferenceSession.create(path, sessionOptions);

    const [dp, textEnc, vectorEst, vocoder] = await Promise.all([
        loadSession(`${onnxDir}/duration_predictor.onnx`),
        loadSession(`${onnxDir}/text_encoder.onnx`),
        loadSession(`${onnxDir}/vector_estimator.onnx`),
        loadSession(`${onnxDir}/vocoder.onnx`)
    ]);

    const indexer = await (await fetch(`${onnxDir}/unicode_indexer.json`)).json();
    const processor = new UnicodeProcessor(indexer);

    return new TextToSpeech(cfgs, processor, dp, textEnc, vectorEst, vocoder);
}

// Load TTS models from explicit asset URLs (suitable for cached downloads).
export async function loadTextToSpeechFromUrls(urls, options = {}) {
    const cfgs = await (await fetch(urls.ttsJson)).json();
    const sessionOptions = {
        executionProviders: ['wasm'],
        ...options
    };
    const loadSession = path => ort.InferenceSession.create(path, sessionOptions);

    const [dp, textEnc, vectorEst, vocoder] = await Promise.all([
        loadSession(urls.durationPredictor),
        loadSession(urls.textEncoder),
        loadSession(urls.vectorEstimator),
        loadSession(urls.vocoder)
    ]);

    const indexer = await (await fetch(urls.unicodeIndexer)).json();
    const processor = new UnicodeProcessor(indexer);

    return new TextToSpeech(cfgs, processor, dp, textEnc, vectorEst, vocoder);
}

// Export for testing in Node.js environment
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { UnicodeProcessor, Style, TextToSpeech, loadTextToSpeech, loadVoiceStyle, AVAILABLE_LANGS, isValidLang };
}
