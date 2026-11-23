// ppocr_core.js — PP-OCRv6 tiny / small (ONNX) w przeglądarce: wykrywanie linijek (DB) + rozpoznawanie (CTC).
// Czysty silnik bez API rozszerzenia (testowalny na zwykłej stronie). Używa globalnego `ort`
// (onnxruntime-web, plik ppocr/ort/ort.wasm.min.js). Wejście: canvas z kolorowym wycinkiem kadru
// (BEZ zamiany na czarno-biały). Wyjście: linijki [{ text, conf (0–100) }] od góry do dołu.
//   window.PPOCR.create(baseUrl) → { recognize(canvas, model), dispose() }
//   baseUrl = adres folderu ppocr/ (z ukośnikiem na końcu); model: 'v6tiny' | 'v6small'
//   (jeden wielojęzyczny model — łacińskie z polskimi znakami + chiński; small też japoński)
(function () {
    'use strict';
    // det: model wykrywania + progi (wartości z inference.yml modeli PaddlePaddle)
    const MODELS = {
        v6tiny: { det: { file: 'PP-OCRv6_tiny_det.onnx', thresh: 0.2, box: 0.4, unclip: 1.4 }, file: 'PP-OCRv6_tiny_rec.onnx', dict: 'ppocrv6_tiny_dict.txt' },
        v6small: { det: { file: 'PP-OCRv6_small_det.onnx', thresh: 0.2, box: 0.4, unclip: 1.4 }, file: 'PP-OCRv6_small_rec.onnx', dict: 'ppocrv6_small_dict.txt' }
    };
    const DET_MAX_SIDE = 960, REC_H = 48, REC_MAX_W = 1920;

    function create(base) {
        const ort = window.ort;
        if (!ort) throw new Error('brak onnxruntime-web (ort)');
        ort.env.wasm.wasmPaths = base + 'ort/';
        ort.env.wasm.numThreads = 1;          // bez izolacji cross-origin wątki i tak nie działają
        ort.env.wasm.proxy = false;
        const sess = {}, dicts = {};
        function session(key, file) {
            if (!sess[key]) sess[key] = ort.InferenceSession.create(base + 'modele/' + file, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
            return sess[key];
        }
        async function dict(model) {
            if (!dicts[model]) {
                dicts[model] = fetch(base + 'modele/' + MODELS[model].dict).then((r) => r.text()).then((t) => {
                    const chars = t.replace(/\r/g, '').split('\n');
                    if (chars.length && chars[chars.length - 1] === '') chars.pop();
                    return ['', ...chars, ' '];          // 0 = blank (CTC), koniec = spacja
                });
            }
            return dicts[model];
        }
        const cv = (w, h) => { const c = (typeof OffscreenCanvas !== 'undefined') ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }); return c; };

        // obraz → tensor NCHW float32 w kolejności BGR (tak trenowano PaddleOCR: cv2 czyta BGR)
        function toTensor(src, sx, sy, sw, sh, w, h, norm) {
            const c = cv(w, h), x = c.getContext('2d', { willReadFrequently: true });
            x.imageSmoothingQuality = 'high';
            x.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
            const d = x.getImageData(0, 0, w, h).data, n = w * h, f = new Float32Array(3 * n);
            for (let i = 0, p = 0; i < n; i++, p += 4) {
                const b = d[p + 2] / 255, g = d[p + 1] / 255, r = d[p] / 255;
                if (norm === 'det') { f[i] = (b - 0.485) / 0.229; f[n + i] = (g - 0.456) / 0.224; f[2 * n + i] = (r - 0.406) / 0.225; }
                else { f[i] = (b - 0.5) / 0.5; f[n + i] = (g - 0.5) / 0.5; f[2 * n + i] = (r - 0.5) / 0.5; }
            }
            return new ort.Tensor('float32', f, [1, 3, h, w]);
        }

        // ---- wykrywanie: mapa prawdopodobieństwa → prostokąty linijek (spójne obszary, rozszerzone „unclip”) ----
        async function detect(src, W, H, D) {
            const s = Math.min(1, DET_MAX_SIDE / Math.max(W, H));
            const dw = Math.max(32, Math.round(W * s / 32) * 32), dh = Math.max(32, Math.round(H * s / 32) * 32);
            const det = await session('det:' + D.file, D.file);
            const out = await det.run({ [det.inputNames[0]]: toTensor(src, 0, 0, W, H, dw, dh, 'det') });
            const prob = out[det.outputNames[0]].data, bin = new Uint8Array(dw * dh);
            for (let i = 0; i < bin.length; i++) bin[i] = prob[i] > D.thresh ? 1 : 0;
            const seen = new Uint8Array(dw * dh), stack = new Int32Array(dw * dh), boxes = [];
            for (let start = 0; start < bin.length; start++) {
                if (!bin[start] || seen[start]) continue;
                let top = 0, x0 = dw, y0 = dh, x1 = 0, y1 = 0, cnt = 0, sum = 0;
                stack[top++] = start; seen[start] = 1;
                while (top) {
                    const i = stack[--top], x = i % dw, y = (i / dw) | 0;
                    cnt++; sum += prob[i];
                    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
                    if (x > 0 && bin[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
                    if (x < dw - 1 && bin[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
                    if (y > 0 && bin[i - dw] && !seen[i - dw]) { seen[i - dw] = 1; stack[top++] = i - dw; }
                    if (y < dh - 1 && bin[i + dw] && !seen[i + dw]) { seen[i + dw] = 1; stack[top++] = i + dw; }
                }
                const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
                if (bh < 3 || cnt < 4 || sum / cnt < D.box) continue;   // wąskie „I” / „l” też zostają
                const dist = (bw * bh * D.unclip) / (2 * (bw + bh));            // „unclip” jak w DBNet
                const sx = W / dw, sy = H / dh;
                const X0 = Math.max(0, (x0 - dist) * sx), Y0 = Math.max(0, (y0 - dist) * sy);
                const X1 = Math.min(W, (x1 + 1 + dist) * sx), Y1 = Math.min(H, (y1 + 1 + dist) * sy);
                if (X1 - X0 >= 4 && Y1 - Y0 >= 4) boxes.push({ x: X0, y: Y0, w: X1 - X0, h: Y1 - Y0 });
            }
            return mergeLines(boxes);
        }

        // Sklejanie słów w linijki: prostokąty nachodzące na siebie w pionie i blisko w poziomie → jeden
        // (model rozpoznaje całą linijkę naraz — lepszy kontekst i mniej przebiegów). Kolejność: od góry, od lewej.
        function mergeLines(boxes) {
            boxes.sort((a, b) => a.y - b.y);
            const lines = [];
            for (const b of boxes) {
                const L = lines.find((l) => { const ov = Math.min(l.y + l.h, b.y + b.h) - Math.max(l.y, b.y); return ov > 0.5 * Math.min(l.h, b.h); });
                if (L) L.items.push(b); else lines.push({ y: b.y, h: b.h, items: [b] });
            }
            const out = [];
            for (const l of lines) {
                l.items.sort((a, b) => a.x - b.x);
                let cur = null;
                for (const b of l.items) {
                    const hgt = cur ? Math.max(cur.h, b.h) : b.h;
                    if (cur && b.x - (cur.x + cur.w) < 2 * hgt) {
                        const x0 = Math.min(cur.x, b.x), y0 = Math.min(cur.y, b.y), x1 = Math.max(cur.x + cur.w, b.x + b.w), y1 = Math.max(cur.y + cur.h, b.y + b.h);
                        cur = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
                    } else { if (cur) out.push(cur); cur = { x: b.x, y: b.y, w: b.w, h: b.h }; }
                }
                if (cur) out.push(cur);
            }
            out.sort((a, b) => (Math.abs(a.y - b.y) < Math.min(a.h, b.h) * 0.5 ? a.x - b.x : a.y - b.y));
            return out;
        }

        // ---- rozpoznawanie jednej linijki: wysokość 48 px → CTC (najbardziej prawdopodobny znak, bez powtórzeń i „blank”) ----
        async function recLine(src, box, model, chars) {
            const w = Math.max(16, Math.min(REC_MAX_W, Math.round(REC_H * box.w / box.h)));
            const rec = await session(model, MODELS[model].file);
            const out = await rec.run({ [rec.inputNames[0]]: toTensor(src, box.x, box.y, box.w, box.h, w, REC_H, 'rec') });
            const t = out[rec.outputNames[0]], T = t.dims[1], C = t.dims[2], p = t.data;
            let text = '', last = 0, confSum = 0, confN = 0;
            for (let i = 0; i < T; i++) {
                let best = 0, bp = -1; const o = i * C;
                for (let c = 0; c < C; c++) { const v = p[o + c]; if (v > bp) { bp = v; best = c; } }
                if (best !== 0 && best !== last) { text += chars[best] || ''; confSum += bp; confN++; }
                last = best;
            }
            return { text: text.trim(), conf: confN ? (confSum / confN) * 100 : 0 };
        }

        return {
            async recognize(src, model) {
                model = MODELS[model] ? model : 'v6tiny';
                const W = src.width, H = src.height;
                const [boxes, chars] = await Promise.all([detect(src, W, H, MODELS[model].det), dict(model)]);
                const lines = [];
                for (const b of boxes.slice(0, 6)) {                         // napisy: najwyżej kilka linijek
                    const r = await recLine(src, b, model, chars);
                    if (r.text) lines.push(r);
                }
                return lines;
            },
            // [AGENT-EXP] 🎯 auto-ramka: tylko wykrywanie (gdzie jest tekst), bez rozpoznawania liter — model tiny, szybko
            async find(src) {
                return detect(src, src.width, src.height, MODELS.v6tiny.det);
            },
            async dispose() {
                for (const k of Object.keys(sess)) { try { (await sess[k]).release(); } catch (e) { /* ignoruj */ } delete sess[k]; }
            }
        };
    }
    window.PPOCR = { create };
})();
