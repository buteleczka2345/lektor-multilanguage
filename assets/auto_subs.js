// auto_subs.js — automatyczne pobieranie CAŁYCH napisów do lektora (świat izolowany, tylko główna ramka).
// Serwisy: iQIYI (iq.com), WeTV, Viki, Bilibili (bilibili.com) i Bstation (bilibili.tv).
// Metody pobierania wzorowane na DownSub: lista ścieżek z odpowiedzi odtwarzacza / API serwisu,
// plik napisów pobierany z ciasteczkami strony (auto_subs_hook.js) albo przez service worker.
// Ścieżka: polska → angielska → inna; nie-polska jest tłumaczona paczkami (od bieżącego miejsca filmu)
// silnikiem wybranym w ustawieniach. Wynik trafia do harmonogramu „napisy z pliku” w dom_content.js.
// Ręcznie wczytany plik z popupu ma zawsze pierwszeństwo.
(function () {
    'use strict';
    if (window.top !== window) return;
    if (window.__lektorAutoSubs) return;
    window.__lektorAutoSubs = true;

    // [AGENT-EXP] 2026-10-15 (z userscriptu Piper 4.2.17): CAŁE ZDANIA ZAMIAST KAWAŁKÓW.
    // Kwestia napisów to często pół zdania („I told you that if you” / „came back, I'd leave.”). Tłumacz dostawał
    // każdą kwestię osobno i oddawał urywki bez sensu (test w Chrome: „I don't think we should” + „go there tonight.”
    // → „Myślę, że nie powinniśmy | Idź tam dziś wieczorem.”, całe zdanie → „Nie sądzę, że powinniśmy tam iść dziś
    // wieczorem.”). Przed tłumaczeniem sklejamy kolejne kwestie w zdanie; grupę zamyka koniec zdania (. ! ? …),
    // przerwa w mowie, myślnik nowej osoby, dźwięk [..] albo limit długości / czasu. Czas zdania: start pierwszej
    // kwestii, koniec ostatniej. Opcja „Tłumacz całe zdania” (extTrJoinSentences, domyślnie WŁ.).
    var ZD_MAX_CHARS = 220, ZD_MAX_MS = 12000, ZD_GAP_MS = 1500;
    var zdOn = true;
    try {
        chrome.storage.local.get('extTrJoinSentences', function (r) { if (r && r.extTrJoinSentences === false) zdOn = false; });
        chrome.storage.onChanged.addListener(function (ch, area) { if (area === 'local' && ch.extTrJoinSentences) zdOn = ch.extTrJoinSentences.newValue !== false; });
    } catch (e) {}
    function zdPlain(t) { return String(t || '').replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '').trim(); }
    function zdEnds(t) { return /[.!?…。！？♪\])]["'”’»]*$/.test(zdPlain(t)); }
    function zdEllipsis(t) { return /(\.\.\.|…)["'”’»]*$/.test(zdPlain(t)); }
    // nowa osoba („- Hi.”) albo dźwięk / muzyka („[wzdycha]”, „♪”) — od tego nie zaczyna się dalszy ciąg zdania
    function zdNewSpeaker(t) { return /^[-–—]\s*\S|^[\[(♪]/.test(zdPlain(t)); }
    // Czy „next” to dalszy ciąg zdania „cur” (gapMs = przerwa między nimi).
    function zdContinues(cur, next, gapMs) {
        var c = zdPlain(cur), n = zdPlain(next);
        if (!c || !n || zdNewSpeaker(n)) return false;
        if (/^[-–—]/.test(c) && /\s[-–—]\s*\S/.test(c)) return false;   // „- Hi. - Hello.” — dwie osoby w jednej kwestii
        var lower = /^(\.\.\.|…)?\s*\p{Ll}/u.test(n);
        if (zdEnds(c) && !(zdEllipsis(c) && lower)) return false;       // „I was thinking...” + „...maybe” — dalej
        if (c.length + 1 + n.length > ZD_MAX_CHARS) return false;
        return gapMs <= (lower ? ZD_GAP_MS * 2 : ZD_GAP_MS);
    }
    function zdJoin(a, b) {
        a = String(a || '').trim(); b = String(b || '').trim();
        if (!a) return b;
        if (!b) return a;
        if (zdEllipsis(a) && /^(\.\.\.|…)/.test(b)) {
            a = a.replace(/(\.\.\.|…)(["'”’»]*)$/, '$2');
            b = b.replace(/^(\.\.\.|…)\s*/, '');
        }
        return (a + ' ' + b).replace(/\s+/g, ' ').trim();
    }
    // Lista {startMs, endMs, [field]} → nowa lista zdań {startMs, endMs, [field]}; wejście bez zmian.
    function zdMerge(list, field) {
        if (!zdOn || !list || list.length < 2) return list;
        field = field || 'text';
        var out = [], g = null;
        for (var i = 0; i < list.length; i++) {
            var c = list[i], t = String((c && c[field]) || '').replace(/\s+/g, ' ').trim();
            if (!t) continue;
            var st = +c.startMs || 0, en = Math.max(+c.endMs || 0, st + 400);
            if (g && en - g.startMs <= ZD_MAX_MS && zdContinues(g[field], t, st - g.endMs)) {
                g[field] = zdJoin(g[field], t);
                g.endMs = Math.max(g.endMs, en);
                continue;
            }
            if (g) out.push(g);
            g = { startMs: st, endMs: en };
            g[field] = t;
        }
        if (g) out.push(g);
        if (out.length < list.length) { try { console.log('[Lektor] Całe zdania: ' + list.length + ' kwestii → ' + out.length + ' zdań do tłumaczenia'); } catch (e) {} }
        return out;
    }


    var host = location.hostname.toLowerCase();
    var SITE = /(^|\.)(iq|iqiyi)\.com$/.test(host) ? 'iq'
        : /(^|\.)wetv\.vip$/.test(host) ? 'wetv'
        : /(^|\.)viki\.com$/.test(host) ? 'viki'
        : /(^|\.)bilibili\.tv$/.test(host) ? 'bilitv'
        : /(^|\.)bilibili\.com$/.test(host) ? 'bili'
        : /(^|\.)primevideo\.com$/.test(host) || /amazon\.com\/video/.test(location.pathname) ? 'prime'
        : null;
    if (!SITE) return;

    var lastStatus = '', curCount = 0;
    var LOG = function () {
        try { lastStatus = [].slice.call(arguments).map(function (a) { return typeof a === 'string' ? a : ''; }).join(' ').trim(); } catch (e) {}
        try { console.log.apply(console, ['%c[Lektor auto-napisy]', 'color:#7ee0ff'].concat([].slice.call(arguments))); } catch (e) {}
    };
    var IQ_LANG = { 1: 'zh-CN', 2: 'zh-TW', 3: 'en', 4: 'ko', 5: 'ja', 18: 'th', 21: 'ms', 23: 'vi', 24: 'id', 26: 'es', 27: 'pt', 28: 'ar' };
    var NAME_CODE = { english: 'en', polish: 'pl', polski: 'pl', french: 'fr', spanish: 'es', vietnamese: 'vi', arabic: 'ar', portuguese: 'pt',
        'bahasa indonesia': 'id', indonesian: 'id', german: 'de', korean: 'ko', thai: 'th', 'simplified chinese': 'zh-CN', 'traditional chinese': 'zh-TW',
        'bahasa malaysia': 'ms', malay: 'ms', japanese: 'ja', italian: 'it', russian: 'ru', turkish: 'tr', hindi: 'hi', filipino: 'tl', burmese: 'my', khmer: 'km' };
    function nameToCode(n) { return NAME_CODE[String(n || '').trim().toLowerCase()] || 'und'; }
    // [FIX 2026-11-16] Domyślnie WŁ.: lektor sam ściąga cały plik napisów odcinka (jak w Ustawieniach).
    var autoOn = true, lektorOn = true;
    try {
        chrome.storage.local.get(['enabled'], function (r) { if (r && r.enabled === false) lektorOn = false; });
        chrome.storage.onChanged.addListener(function (ch, area) {
            if (area !== 'local' || !ch.enabled) return;
            lektorOn = ch.enabled.newValue !== false;
            // lektor wyłączony = przerwij pobieranie/tłumaczenie (jakby go nie było)
            if (!lektorOn) { runToken++; busy = false; curKey = ''; apply(null); }
        });
        chrome.storage.local.get(['autoSubsOn', 'autoSubsOnDemandV1'], function (r) {
            if (!r || !r.autoSubsOnDemandV1) { // jednorazowa migracja: automat WŁ. (domyślne 2026-11-16)
                try { chrome.storage.local.set({ autoSubsOn: true, autoSubsOnDemandV1: true }); } catch (e) {}
                return;
            }
            autoOn = r.autoSubsOn === true;
        });
        chrome.storage.onChanged.addListener(function (ch, area) {
            if (area !== 'local' || !ch.autoSubsOn) return;
            autoOn = ch.autoSubsOn.newValue === true;
            if (!autoOn) apply(null); else { curKey = ''; tick(); }
        });
    } catch (e) {}

    // ================= Komunikacja =================
    var hookData = {}; // site -> ostatnie dane z auto_subs_hook.js
    var idOwner = {}; // id odcinka z odtwarzacza → adres odcinka, do którego należy (chroni przed starą listą)
    function foreignId(id) { return !!(id && idOwner[id] && idOwner[id] !== curKey); }
    var hookWaiters = [];
    var fetchSeq = 0, fetchPending = {};
    window.addEventListener('message', function (ev) {
        if (ev.source !== window) return;
        var m = ev.data;
        if (!m || typeof m.type !== 'string') return;
        if (m.type === 'LEKTOR_AUTOSUB_DATA' && m.site) {
            hookData[m.site] = m.payload;
            var w = hookWaiters; hookWaiters = [];
            w.forEach(function (f) { f(); });
        } else if (m.type === 'LEKTOR_AUTOSUB_FETCHED' && fetchPending[m.id]) {
            var cb = fetchPending[m.id]; delete fetchPending[m.id];
            cb({ ok: !!m.ok, status: m.status, body: String(m.body || '') });
        }
    });
    function waitHook(ms) {
        return new Promise(function (res) {
            var t = setTimeout(res, ms);
            hookWaiters.push(function () { clearTimeout(t); res(); });
            try { window.postMessage({ type: 'LEKTOR_AUTOSUB_GET', site: SITE }, '*'); } catch (e) {}
        });
    }
    // fetch w kontekście strony (ciasteczka użytkownika)
    function pageFetch(url, cred) {
        return new Promise(function (res) {
            var id = 'f' + (++fetchSeq) + '_' + Date.now();
            var t = setTimeout(function () { delete fetchPending[id]; res({ ok: false, status: 0, body: '' }); }, 20000);
            fetchPending[id] = function (r) { clearTimeout(t); res(r); };
            window.postMessage({ type: 'LEKTOR_AUTOSUB_FETCH', id: id, url: url, cred: cred || 'include' }, '*');
        });
    }
    // fetch przez service worker (bez CORS — uprawnienia rozszerzenia)
    function swFetch(url, cred) {
        return new Promise(function (res) {
            try {
                chrome.runtime.sendMessage({ action: 'EXT_TR_FETCH', url: url, cred: cred || 'omit' }, function (r) {
                    void chrome.runtime.lastError;
                    res(r && typeof r.body === 'string' ? r : { ok: false, status: 0, body: '' });
                });
            } catch (e) { res({ ok: false, status: 0, body: '' }); }
        });
    }
    // api = API serwisu (wymaga sesji: najpierw z ciasteczkami strony);
    // plik = plik napisów na CDN (iQIYI odrzuca żądania z ciasteczkami — najpierw bez nich).
    async function getText(url, api) {
        var steps = api
            ? [[pageFetch, 'include'], [pageFetch, 'omit'], [swFetch, 'omit']]
            : [[swFetch, 'omit'], [pageFetch, 'omit'], [pageFetch, 'include']];
        for (var i = 0; i < steps.length; i++) {
            var r = await steps[i][0](url, steps[i][1]);
            if (r.ok && r.body && r.body.length > 10) return r.body;
        }
        return '';
    }
    async function getJson(url) {
        var t = await getText(url, true);
        try { return JSON.parse(t); } catch (e) { return null; }
    }

    // ================= Parsery =================
    function tsMs(s) {
        var p = String(s).trim().replace(',', '.').split(':').map(Number);
        if (p.some(isNaN)) return -1;
        if (p.length === 3) return Math.round((p[0] * 3600 + p[1] * 60 + p[2]) * 1000);
        if (p.length === 2) return Math.round((p[0] * 60 + p[1]) * 1000);
        return -1;
    }
    function clean(t) {
        return String(t || '').replace(/\{[^}]*\}/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
    }
    var ARROW = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
    function parseVttSrt(text) {
        var lines = String(text || '').replace(/^﻿/, '').replace(/\r/g, '').split('\n');
        var cues = [];
        for (var i = 0; i < lines.length; i++) {
            var m = lines[i].match(ARROW);
            if (!m) continue;
            var s = tsMs(m[1]), e = tsMs(m[2]);
            var buf = [];
            for (var j = i + 1; j < lines.length && lines[j].trim() && !ARROW.test(lines[j]); j++) buf.push(lines[j]);
            // numer następnej kwestii bez pustej linii — nie jest tekstem
            if (buf.length && /^\d+$/.test(buf[buf.length - 1].trim()) && ARROW.test(lines[i + buf.length + 1] || '')) buf.pop();
            var t = clean(buf.join(' '));
            if (s >= 0 && e > s && t) cues.push({ startMs: s, endMs: e, text: t });
        }
        return cues;
    }
    function parseBiliJson(text) {
        try {
            var j = JSON.parse(text);
            if (!j || !Array.isArray(j.body)) return [];
            return j.body.map(function (o) {
                return { startMs: Math.round((o.from || 0) * 1000), endMs: Math.round((o.to || 0) * 1000), text: clean(o.content) };
            }).filter(function (c) { return c.text && c.endMs > c.startMs; });
        } catch (e) { return []; }
    }
    function parseAny(text) {
        var t = String(text || '').trim();
        if (t[0] === '{') { var b = parseBiliJson(t); if (b.length) return b; }
        return parseVttSrt(t);
    }

    // ================= Lista ścieżek dla serwisów =================
    // Każda ścieżka: { lang, name, url, id } (id = odcinek — chroni przed starą listą po zmianie odcinka)
    async function tracksIq() {
        if (!hookData.iq) await waitHook(4000);
        var d = hookData.iq;
        if (!d || !Array.isArray(d.stl) || foreignId(d.tvid)) return [];
        var base = String(d.dstl || 'https://meta.video.iqiyi.com').replace(/^http:\/\//i, 'https://').replace(/\/+$/, '');
        return d.stl.map(function (s) {
            var p = s.webvtt || s.srt;
            if (!p) return null;
            var url = /^https?:\/\//i.test(p) ? p.replace(/^http:\/\//i, 'https://') : p.indexOf('//') === 0 ? 'https:' + p : base + (p[0] === '/' ? p : '/' + p);
            var lang = IQ_LANG[s.lid] || nameToCode(s._name);
            return { lang: lang, name: s._name || lang, url: url, id: d.tvid };
        }).filter(Boolean);
    }
    async function tracksWetv() {
        if (!hookData.wetv) await waitHook(4000);
        var d = hookData.wetv;
        if (d && foreignId(d.vid)) return [];
        var fi = d && d.data && d.data.sfl && d.data.sfl.fi;
        if (!Array.isArray(fi)) return [];
        return fi.map(function (l, i) {
            var u = (l.urlList && Array.isArray(l.urlList.ui) && (l.urlList.ui.find(function (x) { return x && x.url; }) || {}).url) || l.url;
            if (!u) return null;
            return { lang: String(l.lang || 'und').trim().toLowerCase(), name: l.name || l.captionName || '', url: u, wetv: true, id: d.vid };
        }).filter(Boolean);
    }
    function vikiScan(text) {
        var out = {}, re = /https:\\?\/\\?\/api\.viki\.io\\?\/v4\\?\/videos\\?\/([^/\\]+)\\?\/(?:auth_)?subtitles\\?\/([a-z]{2,3}(?:-[A-Za-z0-9]+)?)\.vtt[^"'\s)]+/gi, m;
        var vid = (/\/videos\/(\d+v)/i.exec(location.pathname) || [])[1];
        while ((m = re.exec(text))) {
            if (vid && m[1].toLowerCase() !== vid.toLowerCase()) continue;
            var url;
            try { url = JSON.parse('"' + m[0].replace(/"/g, '\\"') + '"'); } catch (e) { url = m[0].replace(/\\u0026/gi, '&').replace(/\\\//g, '/'); }
            var lang = m[2].toLowerCase();
            if (!out[lang] || (/auth_subtitles/.test(out[lang]) && !/auth_subtitles/.test(url))) out[lang] = url;
        }
        return Object.keys(out).map(function (l) { return { lang: l, name: l, url: out[l], id: vid }; });
    }
    async function tracksViki() {
        var n = document.getElementById('__NEXT_DATA__');
        var t = vikiScan((n && n.textContent) || '');
        if (t.length) return t;
        try { var r = await fetch(location.href, { credentials: 'include' }); if (r.ok) return vikiScan(await r.text()); } catch (e) {}
        return [];
    }
    async function biliApi(path) {
        var j = await getJson('https://api.bilibili.com' + path);
        if (!j || j.code !== 0) return null;
        return j.data || j.result || null;
    }
    async function tracksBili() {
        var u = new URL(location.href);
        var mv = /^\/(?:s\/)?video\/(?:(BV[0-9A-Za-z]{10,})|av(\d+))/i.exec(u.pathname);
        var mb = /^\/bangumi\/play\/(ep|ss)(\d+)/i.exec(u.pathname);
        var idParam = null, cid = null;
        if (mv) {
            idParam = mv[1] ? 'bvid=' + mv[1] : 'aid=' + mv[2];
            var part = parseInt(u.searchParams.get('p') || '1', 10) || 1;
            var v = await biliApi('/x/web-interface/view?' + idParam);
            cid = v && ((v.pages && v.pages[part - 1] && v.pages[part - 1].cid) || v.cid);
        } else if (mb) {
            var s = await biliApi('/pgc/view/web/season?' + (mb[1].toLowerCase() === 'ep' ? 'ep_id=' : 'season_id=') + mb[2]);
            var eps = (s && s.episodes) || [];
            var ep = (mb[1].toLowerCase() === 'ep' && eps.find(function (e) { return String(e.id) === mb[2]; })) || eps[0];
            if (ep && ep.aid && ep.cid) { idParam = 'aid=' + ep.aid; cid = ep.cid; }
        }
        if (!idParam || !cid) return [];
        var p = await biliApi('/x/player/wbi/v2?' + idParam + '&cid=' + cid) || await biliApi('/x/player/v2?' + idParam + '&cid=' + cid);
        var subs = (p && p.subtitle && p.subtitle.subtitles) || [];
        return subs.map(function (t) {
            if (!t.subtitle_url || !t.lan) return null;
            var ai = /^ai-/.test(t.lan);
            return { lang: (ai ? t.lan.slice(3) : t.lan).toLowerCase(), name: t.lan_doc || t.lan, ai: ai,
                url: t.subtitle_url.indexOf('//') === 0 ? 'https:' + t.subtitle_url : t.subtitle_url, id: idParam + cid };
        }).filter(Boolean).sort(function (a, b) { return Number(a.ai) - Number(b.ai); });
    }
    async function tracksBiliTv() {
        var path = location.pathname;
        var mp = /^(?:\/[a-z]{2}(?:-[a-z]{2,4})?)?\/play\/(\d+)(?:\/(\d+))?/i.exec(path);
        var mv = /^(?:\/[a-z]{2}(?:-[a-z]{2,4})?)?\/video\/(\d+)/i.exec(path);
        var ep = mp && mp[2];
        if (mp && !ep) {
            var a = document.querySelector('.ep-item--active, [class*="ep-item"][class*="active"]');
            var mm = a && /\/play\/\d+\/(\d+)/.exec(a.getAttribute('href') || '');
            if (mm) ep = mm[1];
        }
        var q = ep ? 'episode_id=' + ep : mv ? 'aid=' + mv[1] : null;
        if (!q) return [];
        var j = await getJson('https://api.bilibili.tv/intl/gateway/web/v2/subtitle?platform=web&s_locale=en_US&' + q);
        var d = j && j.code === 0 && j.data;
        if (!d) return [];
        var map = {};
        (d.video_subtitle || []).forEach(function (t) { if (t.srt && t.srt.url && t.lang_key) map[t.lang_key] = t.srt.url; });
        (d.subtitles || []).forEach(function (t) { if (t.url && t.lang_key && !map[t.lang_key] && !/\.ass(?:[?#]|$)/i.test(t.url)) map[t.lang_key] = t.url; });
        return Object.keys(map).map(function (k) { return { lang: k.toLowerCase(), name: k, url: map[k], id: q }; });
    }
    async function tracksPrime() {
        var out = [];
        try {
            var entries = performance.getEntriesByType('resource') || [];
            var seen = {};
            for (var i = 0; i < entries.length; i++) {
                var url = String(entries[i].name || '');
                if (!url || seen[url]) continue;
                if (/subtitle|caption|ttml|vtt|timedtext|closedcaption/i.test(url)) {
                    seen[url] = true;
                    var lang = /pl|polish|polski/i.test(url) ? 'pl' : 'und';
                    out.push({ lang: lang, name: lang === 'pl' ? 'Polski (PV)' : 'Napisy (PV)', url: url, id: location.pathname });
                }
            }
        } catch (e) {}
        return out;
    }
    var TRACKS = { iq: tracksIq, wetv: tracksWetv, viki: tracksViki, bili: tracksBili, bilitv: tracksBiliTv, prime: tracksPrime };

    // WeTV: link bywa playlistą .m3u8 z jednym plikiem napisów
    async function fetchTrackText(tr) {
        if (tr.wetv) {
            var i = tr.url.indexOf('.m3u8');
            if (i !== -1) { var direct = await getText(tr.url.slice(0, i), false); if (direct && !/^\s*#EXTM3U/.test(direct)) return direct; }
            var pl = await getText(tr.url, false);
            if (pl && /^\s*#EXTM3U/.test(pl)) {
                var line = pl.split(/\r?\n/).map(function (l) { return l.trim(); }).find(function (l) { return l && l[0] !== '#'; });
                if (line) { try { return await getText(new URL(line, tr.url).href, false); } catch (e) {} }
                return '';
            }
            return pl;
        }
        return getText(tr.url, false);
    }

    function pickTrack(list) {
        var by = function (f) { return list.find(f) || null; };
        return by(function (t) { return /^pl/.test(t.lang) && !t.ai; }) || by(function (t) { return /^pl/.test(t.lang); })
            || by(function (t) { return /^en/.test(t.lang) && !t.ai; }) || by(function (t) { return /^en/.test(t.lang); })
            || by(function (t) { return !t.ai; }) || list[0] || null;
    }

    // ================= Tłumaczenie paczkami =================
  // [AGENT-EXP] 2026-10-17: kontekst dla tłumacza — true = tu zaczyna się nowy blok (pauza >= 2 s albo nie-sąsiednia kwestia)
  function ctxBrk(list, batch) {
    return batch.map(function (ix, j) {
      if (!j || ix !== batch[j - 1] + 1) return true;
      var a = list[batch[j - 1]], b = list[ix];
      return !a || !b || !(b.startMs - a.endMs < 2000);
    });
  }
    function translateList(src, texts, brk) {
        return new Promise(function (res) {
            try {
                chrome.runtime.sendMessage({ action: 'EXT_TR_LIST', src: src, texts: texts, brk: brk }, function (r) {   // [AGENT-EXP] brk: kontekst
                    void chrome.runtime.lastError;
                    res(r && r.ok && Array.isArray(r.texts) ? r.texts : null);
                });
            } catch (e) { res(null); }
        });
    }
    async function translateAll(cues, src, token, onProgress) {
        var v = document.querySelector('video');
        var now = v ? v.currentTime * 1000 : 0;
        var first = cues.findIndex(function (c) { return c.endMs >= now; });
        if (first < 0) first = 0;
        var order = [];
        for (var i = first; i < cues.length; i++) order.push(i);
        for (var k = 0; k < first; k++) order.push(k);
        order = order.filter(function (ix) { return !cues[ix].text; }); // z pamięci już są — tylko brakujące
        var done = cues.length - order.length, batches = 0;
        while (order.length) {
            if (token !== runToken) return; // inny film — przerwij
            var batch = [], chars = 0;
            while (order.length && batch.length < 60 && chars < 2500) { var ix = order.shift(); batch.push(ix); chars += cues[ix].src.length + 1; }
            var out = await translateList(src, batch.map(function (ix) { return cues[ix].src; }), ctxBrk(cues, batch));   // [AGENT-EXP]
            if (token !== runToken) return;
            if (!out) { LOG('błąd tłumaczenia paczki — ponawiam za 5 s'); order = batch.concat(order); await new Promise(function (r) { setTimeout(r, 5000); }); continue; }
            batch.forEach(function (ix, j) { if (out[j]) cues[ix].text = out[j]; });
            done += batch.length;
            LOG('przetłumaczono ' + done + ' / ' + cues.length);
            if (onProgress && (++batches % 3 === 0 || !order.length)) onProgress();
        }
    }

    // ================= Pamięć (90 dni, service worker → IndexedDB) =================
    function cacheLoad(key) {
        return new Promise(function (res) {
            try {
                chrome.runtime.sendMessage({ action: 'PAMIEC_VIDEO_GET', key: key }, function (r) {
                    void chrome.runtime.lastError;
                    res(r && r.ok && r.data && Array.isArray(r.data.cues) && r.data.cues.length ? r.data : null);
                });
            } catch (e) { res(null); }
        });
    }
    function cacheSave(key, tr, items) {
        try {
            chrome.runtime.sendMessage({
                action: 'PAMIEC_VIDEO_PUT', key: key,
                data: { site: SITE, lang: tr.lang, id: tr.id || '', title: document.title, zd: zdOn ? 1 : 0,   // [AGENT-EXP] zd: całe zdania
                    cues: items.map(function (c) { return [c.startMs, c.endMs, c.src, c.text || '']; }) }
            }, function () { void chrome.runtime.lastError; });
        } catch (e) {}
    }

    // ================= Przekazanie do lektora =================
    function apply(cues) {
        curCount = cues ? cues.length : 0;
        try { if (window.__LIVEDUB_AUTO_APPLY__) window.__LIVEDUB_AUTO_APPLY__(cues, false, 'całe napisy strony (automat)'); } catch (e) {}   // [FIX 2026-11-02] etykieta źródła
    }

    var curKey = '', runToken = 0, busy = false;
    function videoKey() {
        var u = new URL(location.href);
        return SITE + '|' + u.pathname + '|' + (u.searchParams.get('p') || '') + '|' + (u.searchParams.get('vid') || '');
    }
    async function run(key) {
        var token = ++runToken;
        busy = true;
        try {
            apply(null);
            var mem = await cacheLoad(key);
            if (token !== runToken) return;
            if (mem && zdOn && !mem.zd && !/^pl/.test(mem.lang || '')) mem = null;   // [AGENT-EXP] zapis sprzed „całych zdań” — od nowa
            if (mem) {
                if (mem.id) idOwner[mem.id] = key;
                var memTr = { lang: mem.lang, id: mem.id };
                var memItems = mem.cues.map(function (c, i) {
                    return { id: 'auto_' + token + '_' + i, startMs: c[0], endMs: c[1], src: c[2], text: c[3] || '' };
                });
                var missing = memItems.filter(function (c) { return !c.text; }).length;
                LOG('z pamięci: ' + memItems.length + ' kwestii (' + mem.lang + ')' + (missing ? ', do dokończenia tłumaczenia: ' + missing : ' — bez pobierania'));
                apply(memItems);
                if (missing) {
                    await translateAll(memItems, /^und/.test(mem.lang) ? 'auto' : mem.lang, token, function () { cacheSave(key, memTr, memItems); });
                }
                return;
            }
            var list = [];
            for (var attempt = 0; attempt < 6 && !list.length; attempt++) {
                if (token !== runToken) return;
                list = await TRACKS[SITE]();
                if (!list.length) await new Promise(function (r) { setTimeout(r, 5000); }); // np. odtwarzacz jeszcze nie ruszył
            }
            if (!list.length) { LOG('brak listy napisów (włącz film / napisy w odtwarzaczu)'); return; }
            var tr = pickTrack(list);
            if (tr.id) idOwner[tr.id] = key;
            LOG('ścieżki:', list.map(function (t) { return t.lang; }).join(', '), '→ wybrana:', tr.lang);
            var text = await fetchTrackText(tr);
            var cues = parseAny(text);
            if (!cues.length) { LOG('nie udało się pobrać/odczytać pliku napisów', tr.url); return; }
            if (token !== runToken) return;
            var pl = /^pl/.test(tr.lang);
            if (!pl) cues = zdMerge(cues, 'text');   // [AGENT-EXP] całe zdania do tłumaczenia
            var items = cues.map(function (c, i) {
                return { id: 'auto_' + token + '_' + i, startMs: c.startMs, endMs: c.endMs, src: c.text, text: pl ? c.text : '' };
            });
            LOG('pobrano ' + items.length + ' kwestii (' + tr.lang + ')' + (pl ? '' : ' — tłumaczę na polski'));
            apply(items);
            cacheSave(key, tr, items); // plik już nie będzie pobierany ponownie
            if (!pl) await translateAll(items, tr.lang === 'und' ? 'auto' : tr.lang, token, function () { cacheSave(key, tr, items); });
        } catch (e) {
            LOG('błąd:', (e && e.message) || e);
        } finally {
            if (token === runToken) busy = false;
        }
    }
    // [FIX 2026-11-02] 📋 domena poza listą lektora (biała / czarna lista) — nic nie pobieramy ani nie tłumaczymy
    function sleeping() { try { return !!(window.__LivedubOpts && window.__LivedubOpts.asleep()); } catch (e) { return false; } }
    try { if (window.__LivedubOpts && window.__LivedubOpts.onSleep) window.__LivedubOpts.onSleep(function (a) {
        if (a) { runToken++; busy = false; curKey = ''; apply(null); } else tick();
    }); } catch (e) {}
    function tick() {
        if (!lektorOn || sleeping()) return; // lektor wyłączony / uśpiony listą domen: nic nie pobieramy
        if (document.visibilityState !== 'visible') return; // karta w tle: nic nie robimy
        if (!autoOn) {
            // tryb „na żądanie”: nowy odcinek = koniec pobierania/tłumaczenia poprzedniego
            if (curKey && videoKey() !== curKey) { runToken++; busy = false; curKey = ''; apply(null); }
            return;
        }
        if (!document.querySelector('video')) return;
        var key = videoKey();
        if (key === curKey) return;
        curKey = key;
        // nowy odcinek: stare dane z odtwarzacza nie pasują
        if (SITE === 'iq' || SITE === 'wetv') hookData[SITE] = null;
        run(key);
    }
    setInterval(tick, 2000);
    tick();

    // NA ŻĄDANIE: przycisk „Pobierz całe napisy” w popupie.
    try {
        chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
            if (!msg) return;
            if (msg.action === 'LOAD_FULL_SUBS') {
                if (!lektorOn) { sendResponse({ ok: false, error: 'Lektor jest wyłączony — włącz go, żeby pobrać napisy.' }); return true; }
                if (sleeping()) { sendResponse({ ok: false, error: 'Tej strony nie ma na liście domen lektora — dopisz ją w popupie (📋 ➕ Dodaj tę stronę) albo wyłącz „Tylko domeny z listy”.' }); return true; }
                if (!document.querySelector('video')) { sendResponse({ ok: false, error: 'Nie widzę filmu na tej stronie — włącz odtwarzanie.' }); return true; }
                curKey = videoKey();
                if (SITE === 'iq' || SITE === 'wetv') hookData[SITE] = null;
                lastStatus = 'Szukam napisów…';
                run(curKey);
                sendResponse({ ok: true });
                return true;
            }
            if (msg.action === 'FULL_SUBS_STATUS') {
                sendResponse({ ok: true, onDemand: !!curKey && curKey === videoKey(), cues: curCount, busy: busy, status: lastStatus });
                return true;
            }
        });
    } catch (e) {}
})();
