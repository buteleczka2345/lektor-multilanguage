// dyktowanie_bridge.js — mostek: okno „Dyktowanie” (http://127.0.0.1:47630/app) → lektor.
// Okno napisów z dźwięku komputera podaje tu gotowe polskie zdania, a lektor je czyta
// tak samo jak napisy na YouTube (TTS_PLAY). Działa tylko na stronie aplikacji dyktowania.
(function () {
    'use strict';
    if (window.top !== window) return;
    if (location.pathname !== '/app') return;
    if (window.__lektorDyktowanieBridge) return;
    window.__lektorDyktowanieBridge = true;

    var seq = 0;
    function hello() {
        try { window.postMessage({ type: 'DKT_LEKTOR_HELLO', version: chrome.runtime.getManifest().version }, location.origin); } catch (e) {}
    }

    window.addEventListener('message', function (ev) {
        if (ev.source !== window || ev.origin !== location.origin) return;
        var m = ev.data;
        if (!m || typeof m.type !== 'string') return;
        if (m.type === 'DKT_LEKTOR_PING') {
            hello();
        } else if (m.type === 'DKT_LEKTOR_SAY') {
            var text = String(m.text || '').trim();
            if (!text) return;
            // slotMs = czas kwestii w filmie: lektor dociąga tempo (auto-nadrabianie);
            // noSkip: niczego nie pomija — czyta wszystko do końca, nawet z opóźnieniem
            var slotMs = Math.min(30000, Math.max(0, Number(m.slotMs) || 0));
            try {
                chrome.runtime.sendMessage({
                    action: 'TTS_PLAY', id: 'dkt_' + Date.now() + '_' + (++seq), text: text.slice(0, 600), durationMs: 0, slotMs: slotMs,
                    noSkip: true // czytaj wszystko do końca — bez pomijania spóźnionych kwestii
                }, function () { void chrome.runtime.lastError; });
            } catch (e) {}
        } else if (m.type === 'DKT_LEKTOR_STOP') {
            try { chrome.runtime.sendMessage({ action: 'TTS_CLEAR_BUFFER' }, function () { void chrome.runtime.lastError; }); } catch (e) {}
        }
    });

    hello();
})();
