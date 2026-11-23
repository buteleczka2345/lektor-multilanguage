// ppocr_engine.js — silnik PP-OCRv6 (ONNX) w dokumencie lektora: drugi silnik OCR do wyboru obok Tesseracta.
// Obsługuje OCR_TOOL_RECOGNIZE z engine:'ppocr' (Tesseract: ocr_engine.js). Obrazek przychodzi KOLOROWY
// (bez zamiany na czarno-biały). onnxruntime-web i modele ładują się dopiero przy pierwszym użyciu
// (folder ppocr/), po 2 min bez pracy są zwalniane.
(function () {
    'use strict';
    const IDLE_MS = 2 * 60 * 1000;
    let pp = null, loading = null, lastUse = 0, busy = 0;

    function loadScript(src) {
        return new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = src; s.onload = res; s.onerror = () => rej(new Error('nie można wczytać ' + src));
            document.head.appendChild(s);
        });
    }
    async function engine() {
        if (pp) return pp;
        if (!loading) {
            loading = (async () => {
                if (!window.ort) await loadScript(chrome.runtime.getURL('ppocr/ort/ort.wasm.min.js'));
                if (!window.PPOCR) await loadScript(chrome.runtime.getURL('src/offscreen/ppocr_core.js'));
                pp = window.PPOCR.create(chrome.runtime.getURL('ppocr/'));
                return pp;
            })().finally(() => { loading = null; });
        }
        return loading;
    }
    async function toCanvas(dataUrl) {
        const blob = await (await fetch(dataUrl)).blob();
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        c.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close();
        return c;
    }

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || msg.target !== 'offscreen') return;
        if (msg.action === 'OCR_TOOL_RECOGNIZE' && msg.engine === 'ppocr') {
            busy++;
            (async () => {
                try {
                    lastUse = Date.now();
                    const e = await engine();
                    const c = await toCanvas(msg.image);
                    const lines = await e.recognize(c, msg.model === 'v6small' ? 'v6small' : 'v6tiny');
                    lastUse = Date.now();
                    sendResponse({ ok: true, lines, engine: 'ppocr' });
                } catch (err) {
                    sendResponse({ ok: false, error: 'PP-OCR: ' + String((err && err.message) || err) });
                } finally { busy--; }
            })();
            return true;
        }
        if (msg.action === 'OCR_TOOL_FIND') {   // [AGENT-EXP] 🎯 auto-ramka: prostokąty z tekstem na całej klatce
            busy++;
            (async () => {
                try {
                    lastUse = Date.now();
                    const e = await engine();
                    const c = await toCanvas(msg.image);
                    const boxes = await e.find(c);
                    lastUse = Date.now();
                    sendResponse({ ok: true, boxes, w: c.width, h: c.height });
                } catch (err) {
                    sendResponse({ ok: false, error: 'PP-OCR: ' + String((err && err.message) || err) });
                } finally { busy--; }
            })();
            return true;
        }
        if (msg.action === 'OCR_TOOL_STOP') {   // Tesseract też dostaje STOP (ocr_engine.js) — tu tylko zwalniamy, bez odpowiedzi
            if (pp && !busy) { const p = pp; pp = null; p.dispose(); }
        }
    });
    setInterval(() => { if (pp && !busy && Date.now() - lastUse > IDLE_MS) { const p = pp; pp = null; p.dispose(); } }, 30000);
})();
