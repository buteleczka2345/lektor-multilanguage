// auto_subs_hook.js — świat MAIN strony (document_start): iq.com / iqiyi.com, WeTV, Viki, Bilibili.
// 1) Podsłuchuje odpowiedzi odtwarzacza z listą napisów (iQIYI: /dash?…tvid= → data.program.stl,
//    WeTV: JSONP /getvinfo → sfl.fi) i przekazuje je do lektora (dom_content.js) przez postMessage.
// 2) Na prośbę lektora wykonuje fetch w kontekście strony (z ciasteczkami albo bez) —
//    API Bilibili wymaga sesji użytkownika, a część CDN-ów przyjmuje tylko żądania ze strony.
(function () {
    'use strict';
    if (window.__lektorAutoSubsHook) return;
    window.__lektorAutoSubsHook = true;

    var host = location.hostname.toLowerCase();
    var isIq = /(^|\.)(iq|iqiyi)\.com$/.test(host);
    var isWetv = /(^|\.)wetv\.vip$/.test(host);

    var last = {}; // site -> ostatnio złapane dane (do ponownego wysłania na żądanie)
    function post(site, payload) {
        last[site] = payload;
        try { window.postMessage({ type: 'LEKTOR_AUTOSUB_DATA', site: site, payload: payload }, '*'); } catch (e) {}
    }

    // ---- iQIYI: odpowiedź /dash (JSON albo JSONP) ----
    function stripJsonp(t) {
        t = String(t || '').trim();
        if (t[0] === '{' || t[0] === '[') return t;
        var a = t.indexOf('('), b = t.lastIndexOf(')');
        return a > 0 && b > a ? t.slice(a + 1, b) : t;
    }
    function iqFromDash(url, text) {
        try {
            var j = JSON.parse(stripJsonp(text));
            var data = j && j.data;
            var stl = data && data.program && data.program.stl;
            if (!Array.isArray(stl) || !stl.length) return;
            var m = /[?&]tvid=(\d+)/.exec(url);
            post('iq', { tvid: m ? m[1] : '', stl: stl, dstl: (data && data.dstl) || null });
        } catch (e) {}
    }
    function iqFromNextData() {
        try {
            var n = document.getElementById('__NEXT_DATA__');
            if (!n || !n.textContent) return null;
            var find = function (o, k, d) {
                if (d > 15 || !o || typeof o !== 'object') return null;
                if (k in o) return o[k];
                for (var key in o) { var r = find(o[key], k, d + 1); if (r != null) return r; }
                return null;
            };
            var j = JSON.parse(n.textContent);
            var stl = find(j, 'stl', 0), dstl = find(j, 'dstl', 0), info = find(j, 'curVideoInfo', 0);
            if (!Array.isArray(stl) || !stl.length) return null;
            return { tvid: info && info.tvId != null ? String(info.tvId) : '', stl: stl, dstl: typeof dstl === 'string' ? dstl : null };
        } catch (e) { return null; }
    }

    // ---- WeTV: JSONP /getvinfo — owijamy callback, żeby zobaczyć dane ----
    function wetvWrap(src) {
        if (!/\/getvinfo\?/.test(src)) return;
        var cb, vid;
        try { var u = new URL(src, location.href); cb = u.searchParams.get('callback'); vid = u.searchParams.get('vid') || ''; } catch (e) { return; }
        if (!cb) return;
        var orig = window[cb];
        if (typeof orig === 'function' && orig.__lektorWrapped) return;
        var wrapped = function (data) {
            try { post('wetv', { vid: vid, data: data }); } catch (e) {}
            return typeof orig === 'function' ? orig.apply(this, arguments) : undefined;
        };
        wrapped.__lektorWrapped = true;
        window[cb] = wrapped;
    }
    if (isWetv) {
        var hookNode = function (proto, name) {
            var f = proto[name];
            if (typeof f !== 'function') return;
            proto[name] = function () {
                for (var i = 0; i < arguments.length; i++) {
                    var n = arguments[i];
                    try { if (n && n.tagName === 'SCRIPT' && typeof n.src === 'string') wetvWrap(n.src); } catch (e) {}
                }
                return f.apply(this, arguments);
            };
        };
        hookNode(Node.prototype, 'appendChild');
        hookNode(Node.prototype, 'insertBefore');
        hookNode(Element.prototype, 'append');
        hookNode(Element.prototype, 'prepend');
        try {
            var d = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
            if (d && d.set && d.get) {
                Object.defineProperty(HTMLScriptElement.prototype, 'src', {
                    configurable: true, enumerable: d.enumerable, get: d.get,
                    set: function (v) { try { if (typeof v === 'string') wetvWrap(v); } catch (e) {} return d.set.call(this, v); }
                });
            }
        } catch (e) {}
    }

    // ---- Podsłuch XHR/fetch (iQIYI /dash) ----
    if (isIq) {
        var isDash = function (u) { return /\/dash\?/i.test(u) && /[?&]tvid=\d/.test(u); };
        var xOpen = XMLHttpRequest.prototype.open, xSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (m, u) { this.__lektorUrl = String(u || ''); return xOpen.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function () {
            var self = this;
            if (isDash(self.__lektorUrl)) {
                self.addEventListener('load', function () {
                    try {
                        var t = (self.responseType === '' || self.responseType === 'text') ? self.responseText
                            : (self.responseType === 'json' ? JSON.stringify(self.response) : '');
                        if (t) iqFromDash(self.__lektorUrl, t);
                    } catch (e) {}
                });
            }
            return xSend.apply(this, arguments);
        };
        var oFetch = window.fetch;
        window.fetch = function (input) {
            var p = oFetch.apply(this, arguments);
            try {
                var u = String((input && input.url) || input || '');
                if (isDash(u)) p.then(function (r) { return r.clone().text(); }).then(function (t) { iqFromDash(u, t); }).catch(function () {});
            } catch (e) {}
            return p;
        };
    }

    // ---- Żądania od lektora ----
    window.addEventListener('message', function (ev) {
        if (ev.source !== window) return;
        var m = ev.data;
        if (!m || typeof m.type !== 'string') return;
        if (m.type === 'LEKTOR_AUTOSUB_GET') {
            // Lektor pyta o to, co już złapaliśmy (np. załadował się po odtwarzaczu)
            if (m.site === 'iq' && !last.iq) { var nd = iqFromNextData(); if (nd) last.iq = nd; }
            if (last[m.site]) post(m.site, last[m.site]);
        } else if (m.type === 'LEKTOR_AUTOSUB_FETCH') {
            fetch(m.url, { credentials: m.cred || 'include' })
                .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, status: r.status, body: t }; }); })
                .catch(function (e) { return { ok: false, status: 0, body: String((e && e.message) || e) }; })
                .then(function (res) {
                    try { window.postMessage({ type: 'LEKTOR_AUTOSUB_FETCHED', id: m.id, ok: res.ok, status: res.status, body: res.body }, '*'); } catch (e) {}
                });
        }
    });
})();
