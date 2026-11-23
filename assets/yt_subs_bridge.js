// yt_subs_bridge.js — MAIN world (strona YouTube), document_start.
// 1) Przechwytuje napisy, które player sam pobiera (/api/timedtext) — YouTube wymaga tokena,
//    więc zwykły fetch spoza playera bywa pusty (metoda ze skryptu "YouTube Subtitle Downloader").
// 2) Zamienia je na SRT i oddaje content scriptowi (postMessage).
// 3) Tłumaczy zdania Translator API Chrome (en→pl, lokalnie). Do tłumaczenia idą WYŁĄCZNIE
//    zdania {idx, text}; znaczniki czasu zostają w content scripcie, a wynik wraca pod ten sam idx.
(function () {
    'use strict';
    if (window.__LektorYtBridge) return;
    window.__LektorYtBridge = true;

    var TAG = '__lektorYt';
    var cache = new Map(); // "videoId|lang|kind" -> surowa odpowiedź timedtext

    function isTimedtext(url) { return typeof url === 'string' && url.indexOf('/api/timedtext') !== -1; }
    function keyFromUrl(url) {
        try {
            var u = new URL(url, location.origin);
            // [AGENT-EXP] 2026-10-21: auto-tłumaczenie YouTube (tlang) ma własny klucz — nie miesza się z oryginałem
            return [u.searchParams.get('v'), u.searchParams.get('lang'), u.searchParams.get('kind') || '', u.searchParams.get('tlang') || ''].join('|');
        } catch (e) { return null; }
    }
    function store(url, text) {
        var k = keyFromUrl(url);
        if (k && text && text.trim()) cache.set(k, text);
    }

    var origFetch = window.fetch;
    window.fetch = async function (input) {
        var res = await origFetch.apply(this, arguments);
        try {
            var url = typeof input === 'string' ? input : (input && input.url);
            if (isTimedtext(url)) res.clone().text().then(function (t) { store(url, t); }).catch(function () {});
        } catch (e) {}
        return res;
    };
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, url) { this.__ltUrl = String(url); return origOpen.apply(this, arguments); };
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
        if (isTimedtext(this.__ltUrl)) {
            var x = this;
            x.addEventListener('load', function () { try { if (typeof x.response === 'string') store(x.__ltUrl, x.response); } catch (e) {} });
        }
        return origSend.apply(this, arguments);
    };

    // ---------- json3 / XML -> kwestie -> SRT ----------
    function decodeEntities(s) {
        return s.replace(/&#(\d+);/g, function (_, n) { return String.fromCodePoint(+n); })
            .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCodePoint(parseInt(n, 16)); })
            .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    }
    function parseRaw(raw) {
        raw = String(raw || '').trim();
        var cues = [], i;
        if (raw.charAt(0) === '{') {
            var evs = (JSON.parse(raw).events || []).filter(function (e) { return e && e.segs; });
            var pending = null;
            var flush = function () { if (pending && pending.text.trim()) cues.push(pending); pending = null; };
            for (i = 0; i < evs.length; i++) {
                var e = evs[i];
                var text = e.segs.map(function (s) { return s.utf8 || ''; }).join('').replace(/\s+/g, ' ').trim();
                var st = e.tStartMs || 0;
                var en = st + (e.dDurationMs || 2000);
                if (!text) continue;
                if (e.aAppend === 1 && pending) { pending.text += ' ' + text; pending.end = en; continue; }
                flush();
                pending = { start: st, end: en, text: text };
            }
            flush();
        } else {
            var re = /<(text|p)\b([^>]*)>([\s\S]*?)<\/\1>/g, m;
            var attr = function (a, n) { var r = a.match(new RegExp('\\b' + n + '="([^"]*)"')); return r ? r[1] : null; };
            while ((m = re.exec(raw))) {
                var tx = decodeEntities(decodeEntities(m[3].replace(/<[^>]+>/g, ''))).replace(/\s+/g, ' ').trim();
                if (!tx) continue;
                var s0 = m[1] === 'text' ? parseFloat(attr(m[2], 'start')) * 1000 : +attr(m[2], 't');
                var d0 = m[1] === 'text' ? parseFloat(attr(m[2], 'dur') || '2') * 1000 : +(attr(m[2], 'd') || 2000);
                cues.push({ start: s0, end: s0 + d0, text: tx });
            }
        }
        cues.sort(function (a, b) { return a.start - b.start; });
        // ASR zazębia kwestie w czasie — przycinamy koniec do początku następnej.
        for (i = 0; i < cues.length - 1; i++) {
            if (cues[i].end > cues[i + 1].start) cues[i].end = Math.max(cues[i].start + 300, cues[i + 1].start);
        }
        return cues;
    }
    function pad(n, w) { return String(n).padStart(w || 2, '0'); }
    function srtTime(ms) {
        ms = Math.max(0, Math.round(ms));
        return pad(Math.floor(ms / 3600000)) + ':' + pad(Math.floor(ms % 3600000 / 60000)) + ':' + pad(Math.floor(ms % 60000 / 1000)) + ',' + pad(ms % 1000, 3);
    }
    function toSrt(cues) {
        return cues.map(function (c, i) { return (i + 1) + '\n' + srtTime(c.start) + ' --> ' + srtTime(c.end) + '\n' + c.text + '\n'; }).join('\n');
    }

    // ---------- player / ścieżki ----------
    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    function getPlayer() { return document.getElementById('movie_player'); }
    function getInfo() {
        var p = getPlayer();
        var pr = (p && p.getPlayerResponse && p.getPlayerResponse()) || window.ytInitialPlayerResponse;
        return {
            videoId: pr && pr.videoDetails && pr.videoDetails.videoId,
            tracks: (pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks) || []
        };
    }
    function pickTrack(tracks) {
        var by = function (f) { for (var i = 0; i < tracks.length; i++) if (f(tracks[i])) return tracks[i]; return null; };
        return by(function (t) { return /^pl/i.test(t.languageCode) && t.kind !== 'asr'; })
            || by(function (t) { return /^pl/i.test(t.languageCode); })
            || by(function (t) { return /^en/i.test(t.languageCode) && t.kind !== 'asr'; })
            || by(function (t) { return /^en/i.test(t.languageCode); })
            || by(function (t) { return t.kind !== 'asr'; })
            || tracks[0] || null;
    }

    // [AGENT-EXP] 2026-10-21: tlang ('pl') = ścieżka przetłumaczona przez YouTube („Automatyczne tłumaczenie” w odtwarzaczu,
    // jak w Live Dubbing) — tłumaczy serwer YouTube, bez limitu. Wzór: cenzor_main.js autoLoad.
    async function getRaw(track, videoId, tlang) {
        tlang = tlang || '';
        var key = [videoId, track.languageCode, track.kind || '', tlang].join('|');
        if (cache.has(key)) return cache.get(key);
        try { // próba 1: bezpośredni fetch
            var u = new URL(track.baseUrl, location.origin);
            u.searchParams.set('fmt', 'json3');
            if (tlang) u.searchParams.set('tlang', tlang);
            var t = await (await origFetch(u.toString(), { credentials: 'include' })).text();
            if (t && t.trim() && (!tlang || parseRaw(t).length)) return t;   // [AGENT-EXP] tłumaczenie: tylko gdy są kwestie
        } catch (e) {}
        // próba 2: player sam ładuje ścieżkę, my łapiemy odpowiedź
        var player = getPlayer();
        if (!player || !player.setOption) throw new Error('Brak playera');
        var prev = player.getOption && player.getOption('captions', 'track');
        if (player.loadModule) player.loadModule('captions');
        await sleep(300);
        var list = player.getOption('captions', 'tracklist') || [];
        var target = list.filter(function (x) { return x.languageCode === track.languageCode && (x.kind || '') === (track.kind || ''); })[0] || { languageCode: track.languageCode };
        if (tlang) target = Object.assign({}, target, { translationLanguage: { languageCode: tlang, languageName: 'Polski' } });   // [AGENT-EXP]
        player.setOption('captions', 'track', target);
        for (var i = 0; i < 30 && !cache.has(key); i++) await sleep(200);
        try {
            if (prev && prev.languageCode) player.setOption('captions', 'track', prev);
            else if (player.unloadModule) player.unloadModule('captions');
        } catch (e) {}
        if (cache.has(key)) return cache.get(key);
        throw new Error('Nie udało się wczytać napisów (włącz raz CC i spróbuj ponownie)');
    }

    // ---------- Translator API Chrome ----------
    var translators = {};
    async function getTranslator(src) {
        src = String(src || 'en').toLowerCase().split('-')[0];
        if (translators[src]) return translators[src];
        if (typeof self.Translator === 'undefined') throw new Error('Ta wersja Chrome nie ma Translator API');
        var av = await self.Translator.availability({ sourceLanguage: src, targetLanguage: 'pl' });
        if (av === 'unavailable') throw new Error('Brak tłumaczenia ' + src + '→pl w Chrome');
        if (av === 'downloadable' || av === 'downloading') throw new Error('Pakiet ' + src + '→pl nie jest zainstalowany (chrome://on-device-translation-internals)');
        translators[src] = await self.Translator.create({ sourceLanguage: src, targetLanguage: 'pl' });
        return translators[src];
    }

    function reply(reqId, data) {
        data[TAG] = 'res'; data.reqId = reqId;
        window.postMessage(data, location.origin);
    }

    // [AGENT-EXP] 2026-10-15: słownik fraz z Pipera (assets/phrase_dict.js, wczytany przed tym plikiem — manifest.json).
    // Translator Chrome bierze idiomy dosłownie („Come on” → „No to dawaj”) — trafienie ze słownika wygrywa.
    function phraseLookup(text, lang) {
        try { var P = window.__LektorPhrase; return (P && P.lookup(text, lang)) || ''; } catch (e) { return ''; }
    }

    var translateEpoch = 0;
    async function doTranslate(d) {
        var epoch = ++translateEpoch; // nowe żądanie przerywa poprzednie
        try {
            var tr = await getTranslator(d.lang);
            var items = d.items || [];
            // [AGENT-EXP] 2026-10-17: z kontekstem — kolejne kwestie do pauzy w mowie (items[i].brk) jednym tekstem
            // (nowa linia = granica, do 8 kwestii / 800 znaków); gdy linie się nie zgadzają — pojedynczo jak dawniej
            var i = 0;
            while (i < items.length) {
                if (epoch !== translateEpoch) return;
                var out = phraseLookup(items[i].text, d.lang);   // [AGENT-EXP] najpierw słownik fraz (całe zdanie / kwestia)
                if (out) { reply(d.reqId, { part: true, idx: items[i].idx, text: out }); i++; continue; }
                var grp = [items[i]], chars = String(items[i].text || '').length;
                while (d.context && i + grp.length < items.length && grp.length < 8) {
                    var nx = items[i + grp.length], nt = String(nx.text || '');
                    if (nx.brk !== false || chars + nt.length > 800 || phraseLookup(nt, d.lang)) break;
                    grp.push(nx); chars += nt.length + 1;
                }
                var lines = null;
                if (grp.length > 1) {
                    try {
                        var joined = grp.map(function (g) { return String(g.text || '').replace(/\s*[\r\n]+\s*/g, ' ').trim(); }).join('\n');
                        lines = String((await tr.translate(joined)) || '').split(/\s*\n+\s*/).map(function (l) { return l.trim(); }).filter(Boolean);
                        if (lines.length !== grp.length) lines = null;
                    } catch (e) { lines = null; }
                    if (epoch !== translateEpoch) return;
                }
                for (var j = 0; j < grp.length; j++) {
                    var t = lines ? lines[j] : '';
                    if (!lines) { try { t = await tr.translate(grp[j].text); } catch (e) { t = ''; } if (epoch !== translateEpoch) return; }
                    reply(d.reqId, { part: true, idx: grp[j].idx, text: t });
                }
                i += grp.length;
            }
            reply(d.reqId, { done: true, ok: true });
        } catch (err) {
            reply(d.reqId, { done: true, ok: false, error: String((err && err.message) || err) });
        }
    }

    async function doGet(d) {
        try {
            var info = getInfo();
            if (!info.videoId || (d.videoId && info.videoId !== d.videoId)) throw new Error('Player jeszcze nie gotowy');
            if (!info.tracks.length) throw new Error('Ten film nie ma napisów');
            var track = pickTrack(info.tracks);
            // [AGENT-EXP] 2026-10-21: d.tlang = 'pl' → polska wersja od YouTube (polska ścieżka zostaje sobą)
            var isPlTrack = /^pl/i.test(track.languageCode || '');
            var tl = d.tlang && !isPlTrack ? d.tlang : '';
            if (tl && track.isTranslatable === false) throw new Error('YouTube nie tłumaczy tej ścieżki');
            var cues = parseRaw(await getRaw(track, info.videoId, tl));
            if (!cues.length) throw new Error('Pusty plik napisów');
            reply(d.reqId, { done: true, ok: true, videoId: info.videoId, lang: tl || track.languageCode, kind: track.kind || '',
                ytTr: tl ? 1 : 0, srcLang: track.languageCode, srt: toSrt(cues) });
        } catch (err) {
            reply(d.reqId, { done: true, ok: false, error: String((err && err.message) || err) });
        }
    }

    // OPTIONS-PAGE: czy film jest polski (język audio / ręczne polskie napisy) — dla opcji „polskie kanały"
    function doMeta(d) {
        var res = { polish: false };
        try {
            var p = getPlayer();
            var pr = (p && p.getPlayerResponse && p.getPlayerResponse()) || window.ytInitialPlayerResponse;
            var lang = (pr && pr.microformat && pr.microformat.playerMicroformatRenderer && pr.microformat.playerMicroformatRenderer.defaultAudioLanguage)
                || (pr && pr.videoDetails && pr.videoDetails.defaultAudioLanguage);
            if (typeof lang === 'string' && /^pl/i.test(lang.trim())) res.polish = true;
            var tr = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks;
            // [AGENT-EXP] 2026-10-28: automatyczne (asr) polskie napisy — YouTube robi je z mowy, więc film mówi po polsku.
            // [FIX 2026-11-02] RĘCZNE polskie napisy już NIE znaczą „film po polsku”: mają je też zagraniczne filmy (TED,
            // kanały popularnonaukowe) — i to najlepsze źródło dla lektora; wcześniej lektor przez nie milkł albo nie ściszał filmu.
            if (Array.isArray(tr)) tr.forEach(function (t) { if (/^pl/i.test(t.languageCode || '') && t.kind === 'asr') res.polish = true; });
            res.videoId = pr && pr.videoDetails && pr.videoDetails.videoId;
        } catch (e) {}
        reply(d.reqId, { done: true, ok: true, polish: res.polish, videoId: res.videoId });
    }

    window.addEventListener('message', function (ev) {
        if (ev.source !== window || ev.origin !== location.origin) return;
        var d = ev.data;
        if (!d || d[TAG] !== 'req') return;
        if (d.cmd === 'get') doGet(d);
        else if (d.cmd === 'translate') doTranslate(d);
        else if (d.cmd === 'cancel') translateEpoch++;
        else if (d.cmd === 'meta') doMeta(d);
    });
})();
