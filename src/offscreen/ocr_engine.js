// ocr_engine.js — silnik OCR (Tesseract.js) w dokumencie lektora (offscreen), NIEZALEŻNY od Łowcy.
// Strona (assets/ocr_tool.js) robi tylko zrzut ramki filmu i przysyła obrazek przez background
// (OCR_TOOL_RECOGNIZE) — rozpoznawanie odbywa się tutaj, z plików rozszerzenia (folder ocr/),
// więc strona nie może go zablokować (CSP), a Łowca nie musi być uruchomiony.
// Biblioteka ładuje się dopiero przy pierwszym rozpoznawaniu; po 2 min bez pracy silnik jest zwalniany.
(function () {
    'use strict';
    const BUNDLED = ['pol', 'eng', 'chi_sim', 'chi_tra']; // języki w paczce (ocr/*.traineddata.gz) — bez internetu
    const IDLE_MS = 2 * 60 * 1000;
    let lib = null, worker = null, workerLangs = '', initP = null, lastUse = 0;

    function loadLib() {
        if (lib) return Promise.resolve(lib);
        return new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = chrome.runtime.getURL('ocr/tesseract.min.js');
            s.onload = () => { lib = window.Tesseract; if (lib && lib.createWorker) res(lib); else rej(new Error('brak biblioteki Tesseract')); };
            s.onerror = () => rej(new Error('nie można wczytać ocr/tesseract.min.js'));
            document.head.appendChild(s);
        });
    }
    function simdOk() {
        try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch (e) { return false; }
    }
    async function dropWorker() {
        const w = worker; worker = null; workerLangs = '';
        if (w) { try { await w.terminate(); } catch (e) { /* ignoruj */ } }
    }
    async function getWorker(langs) {
        if (worker && workerLangs === langs) return worker;
        if (initP && initP.langs === langs) return initP.p;
        const p = (async () => {
            await dropWorker();
            const T = await loadLib();
            const list = langs.split('+').filter(Boolean);
            const offline = list.every((l) => BUNDLED.includes(l));
            const opts = {
                workerPath: chrome.runtime.getURL('ocr/worker.min.js'),
                // konkretny plik rdzenia: przy samym katalogu Tesseract 7 szuka też wariantu „relaxedsimd”, którego nie ma w paczce
                corePath: chrome.runtime.getURL('ocr/' + (simdOk() ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js')),
                workerBlobURL: false, gzip: true, logger: () => {}
            };
            // wszystkie języki w paczce → z folderu ocr/; inaczej z internetu (zapamiętane potem w pamięci rozszerzenia)
            if (offline) { opts.langPath = chrome.runtime.getURL('ocr'); opts.cacheMethod = 'none'; }
            const w = await T.createWorker(list, 1, opts);
            try { await w.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' }); } catch (e) { /* ignoruj */ }
            worker = w; workerLangs = langs;
            return w;
        })();
        initP = { langs, p };
        try { return await p; } finally { if (initP && initP.p === p) initP = null; }
    }

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || msg.target !== 'offscreen') return;
        if (msg.action === 'OCR_TOOL_RECOGNIZE' && msg.engine !== 'ppocr') {   // PP-OCR: ppocr_engine.js
            (async () => {
                try {
                    lastUse = Date.now();
                    const langs = String(msg.langs || 'eng');
                    const w = await getWorker(langs);
                    const r = await w.recognize(msg.image, {}, { text: true, blocks: true });
                    lastUse = Date.now();
                    const d = (r && r.data) || {};
                    const lines = [];
                    (d.blocks || []).forEach((b) => (b.paragraphs || []).forEach((p) => (p.lines || []).forEach((l) => lines.push({ text: l.text, conf: l.confidence }))));
                    if (!lines.length && d.text) String(d.text).split('\n').forEach((t) => lines.push({ text: t, conf: d.confidence }));
                    sendResponse({ ok: true, lines, langs });
                } catch (e) {
                    sendResponse({ ok: false, error: String((e && e.message) || e) });
                }
            })();
            return true;
        }
        if (msg.action === 'OCR_TOOL_STOP') {
            dropWorker().then(() => sendResponse({ ok: true }));
            return true;
        }
    });

    // Bez pracy przez IDLE_MS → zwalniamy silnik (wątek + pamięć modelu)
    setInterval(() => { if (worker && !initP && Date.now() - lastUse > IDLE_MS) dropWorker(); }, 30000);
})();
