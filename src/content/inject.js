// inject.js — Multilektor: napisy Netflixa, świat strony (MAIN). Wstrzykuje go content.js-BgeP3Ise.js.
// [AGENT-EXP] 2026-10-21: napisane od nowa — własna implementacja w miejsce kodu przejętego z Live Dubbing.
//
// Odtwarzacz sam pobiera pliki napisów (TTML / DFXP). Podglądamy odpowiedzi fetch i XHR, plik zamieniamy na kwestie
// { id, text, lines, startMs, endMs } i oddajemy content scriptowi: postMessage { type: MSG, subtitles, source }.
// Nazwa typu zostaje dawna — słuchają jej content.js-BgeP3Ise.js i cenzor_main.js.
// Każdy adres pliku = osobne źródło (klucz 's1', 's2'…): Netflix i Immersive Translate potrafią wczytać dwie ścieżki
// naraz, a lektor czyta tylko jedną. Ten sam plik z tą samą treścią nie jest wysyłany drugi raz.
(function () {
    'use strict';
    if (window.__multilektorNfHook) return;
    window.__multilektorNfHook = true;

    var MSG = 'LIVEDUB_SUBTITLE_DATA';
    var SKIP_TYPE = /^(video|audio|image|font)\/|wasm|javascript|css|json/i;   // tego nie czytamy wcale
    var MAX_BYTES = 30 * 1024 * 1024;
    var TTP_NS = 'http://www.w3.org/ns/ttml#parameter';

    // ---------- źródła ----------
    var sources = new Map();   // adres pliku → { key, url, fp }
    var seq = 0;
    function sourceOf(url) {
        var u = String(url || '');
        var s = sources.get(u);
        if (!s) { s = { key: 's' + (++seq), url: u, fp: '' }; sources.set(u, s); }
        return s;
    }
    // odcisk treści (FNV-1a + długość) — kolejna partia napisów pod tym samym adresem ma inny odcisk
    function fingerprint(str) {
        var h = 0x811c9dc5;
        for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
        return (h >>> 0).toString(16) + '.' + str.length;
    }

    // ---------- czas ----------
    // „01:02:03.456”, „02:03.4”, „7235410000t”, „12.5s”, „250ms”, „3m”, „1h”, „90f”, sama liczba = sekundy
    function toMs(value, tickRate, frameRate) {
        var v = String(value == null ? '' : value).trim();
        if (!v) return NaN;
        var c = /^(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)$/.exec(v);
        if (c) return Math.round(((+(c[1] || 0)) * 3600 + (+c[2]) * 60 + parseFloat(c[3].replace(',', '.'))) * 1000);
        var o = /^(\d+(?:\.\d+)?)(h|ms|m|s|t|f)$/.exec(v);
        if (o) {
            var n = parseFloat(o[1]);
            switch (o[2]) {
                case 'h': return Math.round(n * 3600000);
                case 'm': return Math.round(n * 60000);
                case 's': return Math.round(n * 1000);
                case 'ms': return Math.round(n);
                case 't': return Math.floor(n * 1000 / tickRate);
                default: return Math.round(n * 1000 / frameRate);
            }
        }
        var sec = parseFloat(v);
        return Number.isFinite(sec) ? Math.round(sec * 1000) : NaN;
    }

    // ---------- tekst akapitu ----------
    // <br/> to SPACJA (nie nowy wiersz): sklejone „możesz<br/>wypierdalać” gubiło słowo cenzorowi, a osobne wiersze
    // lektor bierze za napisy dwujęzyczne. Wiersze dzielą tylko prawdziwe znaki nowej linii (Immersive Translate).
    function pText(node) {
        var out = '';
        for (var n = node.firstChild; n; n = n.nextSibling) out += (n.nodeType === 3 || n.nodeType === 4) ? n.nodeValue : n.nodeType === 1 ? (String(n.localName || n.nodeName || '').toLowerCase().replace(/^.*:/, '') === 'br' ? ' ' : pText(n)) : '';
        return out;
    }

    function rootParam(root, name, dflt) {
        var v = root && (root.getAttributeNS(TTP_NS, name) || root.getAttribute('ttp:' + name));
        var n = parseFloat(v);
        return n > 0 ? n : dflt;
    }

    function parseTtml(xmlText, key) {
        var doc = new DOMParser().parseFromString(xmlText, 'text/xml');
        if (doc.getElementsByTagName('parsererror').length) return [];
        var root = doc.documentElement;
        var tickRate = rootParam(root, 'tickRate', 10000000);
        var frameRate = rootParam(root, 'frameRate', 30);
        var ps = doc.getElementsByTagNameNS('*', 'p');
        var out = [];
        for (var i = 0; i < ps.length; i++) {
            var p = ps[i];
            var lines = pText(p).split(/[\r\n]+/).map(function (s) { return s.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
            if (!lines.length) continue;
            var start = toMs(p.getAttribute('begin') || p.getAttribute('t'), tickRate, frameRate);
            if (!Number.isFinite(start)) continue;
            var end = toMs(p.getAttribute('end'), tickRate, frameRate);
            var dur = toMs(p.getAttribute('dur') || p.getAttribute('d'), tickRate, frameRate);
            if (Number.isFinite(dur) && (p.hasAttribute('dur') || p.hasAttribute('d'))) end = start + dur;
            if (!Number.isFinite(end) || end <= start) end = start + 2000;
            // Netflix potrafi dać dwa wiersze jednego napisu jako dwa <p> o tym samym czasie — to jedna kwestia
            var twin = null;
            for (var j = out.length - 1; j >= 0; j--) {
                if (Math.abs(out[j].startMs - start) < 100 && Math.abs(out[j].endMs - end) < 100) { twin = out[j]; break; }
            }
            if (twin) {
                twin.text += ' ' + lines.join(' ');
                lines.forEach(function (l) { if (twin.lines.indexOf(l) < 0) twin.lines.push(l); });
                continue;
            }
            out.push({ id: key + '_' + start + '_' + i, text: lines.join(' '), lines: lines, startMs: start, endMs: end });
        }
        return out;
    }

    function looksLikeTtml(t) {
        var head = t.slice(0, 4000);
        return /<(?:\w+:)?tt[\s>]/.test(head) || head.indexOf('http://www.w3.org/ns/ttml') !== -1 || /dfxp/i.test(head);
    }

    // [FIX 2026-11-22] Zmiana tytułu (adres /watch/…) → zapominamy odciski. Lektor wyrzuca wtedy stare pliki, a po powrocie
    // do filmu odtwarzacz potrafi pobrać TEN SAM plik pod tym samym adresem — bez tego nie trafiał już do lektora.
    var lastPath = location.pathname;
    function checkPath() {
        var p = location.pathname;
        if (p === lastPath) return;
        lastPath = p;
        sources.forEach(function (s) { s.fp = ''; });
        kept.clear();
    }

    // [FIX 2026-11-25] Hak startuje już przy document_start (manifest, świat MAIN), a lektor (content.js) dopiero przy
    // document_idle. Pierwszy film otwarty od razu na /watch/ pobierał napisy, zanim ktokolwiek słuchał — pasek i lektor
    // ruszały dopiero od następnego odcinka. Zapamiętujemy więc kwestie bieżącego tytułu i na prośbę lektora
    // (REPLAY_REQ) wysyłamy je drugi raz osobnym typem (REPLAY), żeby inni słuchacze MSG nie dostali dubli.
    var kept = new Map();   // klucz źródła → { source, cues }
    function keep(src, cues) {
        var k = kept.get(src.key);
        if (!k) { k = { source: { key: src.key, url: src.url }, cues: [] }; kept.set(src.key, k); }
        k.cues = k.cues.concat(cues);
    }
    window.addEventListener('message', function (e) {
        if (e.source !== window || !e.data || e.data.type !== 'LIVEDUB_SUBTITLE_REPLAY_REQ') return;
        checkPath();
        kept.forEach(function (k) {
            if (k.cues.length) window.postMessage({ type: 'LIVEDUB_SUBTITLE_REPLAY', subtitles: k.cues, source: k.source }, location.origin);
        });
    });

    function inspect(url, text) {
        if (typeof text !== 'string' || text.length < 20 || !looksLikeTtml(text)) return;
        checkPath();
        var src = sourceOf(url);
        var fp = fingerprint(text);
        if (src.fp === fp) return;
        var cues;
        try { cues = parseTtml(text, src.key); } catch (e) { console.warn('[Multilektor] napisy Netflixa:', e); return; }
        if (!cues.length) return;
        src.fp = fp;
        keep(src, cues);
        window.postMessage({ type: MSG, subtitles: cues, source: { key: src.key, url: src.url } }, location.origin);
    }

    // ---------- podgląd fetch ----------
    var fetch0 = window.fetch;
    if (typeof fetch0 === 'function') {
        window.fetch = function (input) {
            var pr = fetch0.apply(this, arguments);
            pr.then(function (res) {
                try {
                    if (!res || !res.clone) return;
                    var type = (res.headers && res.headers.get('content-type')) || '';
                    var len = Number(res.headers && res.headers.get('content-length')) || 0;
                    if (SKIP_TYPE.test(type) || len > MAX_BYTES) return;
                    var url = typeof input === 'string' ? input : (input && input.url) || String(input || '');
                    res.clone().text().then(function (t) { inspect(url, t); }, function () {});
                } catch (e) { /* odpowiedź nie do odczytu */ }
            }, function () {});
            return pr;
        };
    }

    // ---------- podgląd XHR (tylko odpowiedzi tekstowe) ----------
    var XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (XP) {
        var open0 = XP.open, send0 = XP.send;
        XP.open = function (method, url) { this.__mlUrl = String(url); return open0.apply(this, arguments); };
        XP.send = function () {
            var x = this;
            try {
                x.addEventListener('load', function () {
                    try { if (!x.responseType || x.responseType === 'text') inspect(x.__mlUrl, x.responseText); } catch (e) {}
                });
            } catch (e) {}
            return send0.apply(this, arguments);
        };
    }
})();
