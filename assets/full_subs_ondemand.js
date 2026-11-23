// [AGENT-EXP] 2026-10-17: buforowanie kwestii przy zatrzymanym filmie — checkbox „Buforuj przy
// zatrzymanym filmie” (chrome.storage: preloadWhilePaused, domyślnie włączony). Wspólne dla content scriptów.
// [AGENT-EXP] 2026-10-17: buforowanie w karcie w tle — checkbox „Buforuj w tle (inna karta)”
// (chrome.storage: bufferInBackground, domyślnie włączony). W tle tylko nagrywamy, nie czytamy.
if (!('__lektorBufTlo' in window)) {
    window.__lektorBufTlo = true;
    try {
        chrome.storage.local.get('bufferInBackground', function (r) { window.__lektorBufTlo = !(r && r.bufferInBackground === false); });
        chrome.storage.onChanged.addListener(function (ch, a) { if (a === 'local' && ch.bufferInBackground) window.__lektorBufTlo = ch.bufferInBackground.newValue !== false; });
    } catch (e) {}
}
if (!('__lektorBufPauza' in window)) {
    window.__lektorBufPauza = true;
    try {
        chrome.storage.local.get('preloadWhilePaused', function (r) { window.__lektorBufPauza = !(r && r.preloadWhilePaused === false); });
        chrome.storage.onChanged.addListener(function (ch, a) { if (a === 'local' && ch.preloadWhilePaused) window.__lektorBufPauza = ch.preloadWhilePaused.newValue !== false; });
    } catch (e) {}
}
// full_subs_ondemand.js — „Pobierz całe napisy” NA ŻĄDANIE, na dowolnej stronie z filmem.
// Wstrzykiwany z popupu (chrome.scripting) TYLKO po kliknięciu przycisku — bez klikania nic tu nie działa.
// Źródło: ścieżki napisów odtwarzacza HTML5 (video.textTracks / <track src>, WebVTT).
// Nie-polskie napisy tłumaczone paczkami (EXT_TR_LIST), od bieżącego miejsca filmu.
// Czytanie: jeśli na stronie działa lektor (dom_content.js) → jego harmonogram; inaczej własny, prosty.
(function () {
    'use strict';
    if (window.__lektorFullSubs) return;

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


    var state = { found: false, cues: 0, lang: '', busy: false, status: '' };
    var items = null, token = 0, loopTimer = null, video = null, videoSrc = '';
    var played = new Set(), preloaded = new Set(), lastNow = -1;

    // [AGENT-EXP] 2026-11-06: te same kwestie dostaje 🤐 cenzor (cenzor_main.js, świat MAIN).
    // Wcześniej napisy pobrane „na żądanie” czytał tylko lektor — cenzor ich nie widział, więc przekleństwa
    // w dźwięku filmu nie były wyciszane i opcja wyglądała na niedziałającą. Wysyłamy listę od razu,
    // po każdej porcji tłumaczenia i jeszcze 3× (cenzor mógł wystartować później).
    var czSig = '', czTimers = [];
    function czPush(force) {
        if (!items || !items.length) return;
        var have = 0;
        for (var i = 0; i < items.length; i++) if (items[i].text) have++;
        var sig = items.length + '|' + have;
        if (!force && sig === czSig) return;
        czSig = sig;
        try {
            window.postMessage({ __lektorCenzor: 'cues', key: 'na żądanie', cues: items.map(function (c) {
                return { startMs: c.startMs, endMs: c.endMs, text: c.text || '', orig: c.src || '' };
            }) }, location.origin);
        } catch (e) {}
    }
    function czPushSoon() {
        czTimers.forEach(function (t) { clearTimeout(t); });
        czTimers = [0, 5000, 20000, 60000].map(function (ms) {
            return setTimeout(function () { if (items) czPush(true); }, ms);
        });
    }

    // [AGENT-EXP] 2026-11-06: 💾 zapamiętanie napisów TEGO filmu (90 dni) — następnym razem wchodzą z pamięci,
    // bez pobierania (także po odświeżeniu strony: dom_content pyta o plik tej strony). Klucz = adres filmu,
    // a przed podmianą sprawdzamy długość nagrania, żeby nie wstawić napisów z innego filmu.
    var MEM_TTL = 90 * 864e5;
    function memKey(url) {
        try {
            var u = new URL(url), keep = [];
            ['v', 'id', 'video', 'vid', 'video_id', 'episode', 'ep', 'watch', 'movie', 'film', 'p'].forEach(function (k) {
                var x = u.searchParams.get(k);
                if (x) keep.push(k + '=' + x);
            });
            return u.origin + u.pathname + '?' + keep.join('&');
        } catch (e) { return String(url || ''); }
    }
    function saveMem() {
        if (!items || !items.length || !video) return;
        try {
            chrome.storage.local.set({ fileSubs: {
                name: 'całe napisy (na żądanie)', page: location.href, loadedAt: Date.now(),
                dur: Number(video.duration) || 0,
                cues: items.map(function (c) { return { startMs: c.startMs, endMs: c.endMs, text: c.text || c.src, src: c.src }; })
            } });
        } catch (e) {}
    }
    function loadMem(cb) {
        try {
            chrome.storage.local.get(['fileSubs', 'fileSubsMem'], function (r) {
                var f = r && r.fileSubs, mem = (r && r.fileSubsMem) || {}, key = memKey(location.href);
                cb((f && f.page && memKey(f.page) === key) ? f : (mem[key] || null));
            });
        } catch (e) { cb(null); }
    }

    // [AGENT-EXP] 2026-11-06: zapamiętanie STRONY (jak po „Szukaj napisów”) — następny film na tej stronie rusza sam:
    // lektor i cenzor startują bez klikania, a całe napisy ze ścieżki odtwarzacza idą automatycznie.
    var remSent = false;
    function rememberSite() {
        if (remSent) return;
        remSent = true;
        try { chrome.runtime.sendMessage({ action: 'FULL_SUBS_REMEMBER', page: location.href }, function () { void chrome.runtime.lastError; }); } catch (e) {}
    }
    // [AGENT-EXP] 2026-10-17: 📊 pasek postępu lektora (assets/lektor_bar.js) — tylko gdy czyta własna pętla
    // (z lektorem dom_content kwestie podaje on sam)
    try {
        (window.__lektorBarProviders = window.__lektorBarProviders || {}).fullSubs = function () {
            if (!items || !items.length || !loopTimer) return null;
            return { video: video, list: items, ready: function (c) { return !!c.text; }, spoken: function (c, i) { return played.has(i); }, audioId: function (c) { return c.id; } };
        };
    } catch (e) {}
    var enabled = true, duckLevel = 20, savedVolume = null, LOOKAHEAD = 8000;

    try {
        chrome.storage.local.get(['enabled', 'duckLevel', 'lookaheadMin'], function (r) {
            if (r && r.enabled !== undefined) enabled = !!r.enabled;
            if (r && r.duckLevel !== undefined) duckLevel = Number(r.duckLevel) || 0;
            duckReady = true;   // [AGENT-EXP] 2026-10-20: nie ściszaj filmu, zanim wczytamy ustawienia (start z enabled=true) ani przy wyłączonym lektorze
            if (!enabled) restoreVolume();
            if (r && r.lookaheadMin !== undefined) { var m = Number(r.lookaheadMin); LOOKAHEAD = m > 0 ? Math.max(8000, m * 60000) : 8000; }   // [AGENT-EXP]
        });
        chrome.storage.onChanged.addListener(function (ch, area) {
            if (area !== 'local') return;
            if (ch.enabled) { enabled = !!ch.enabled.newValue; if (!enabled) { clearBuffer(); restoreVolume(); } }
            if (ch.duckLevel) duckLevel = Number(ch.duckLevel.newValue) || 0;
            if (ch.lookaheadMin) { var m2 = Number(ch.lookaheadMin.newValue); LOOKAHEAD = m2 > 0 ? Math.max(8000, m2 * 60000) : 8000; preloaded.clear(); }   // [AGENT-EXP]; 2026-10-25: okno jeszcze raz
        });
    } catch (e) {}

    function send(msg, cb) {
        try { chrome.runtime.sendMessage(msg, function (r) { void chrome.runtime.lastError; if (cb) cb(r); }); } catch (e) { if (cb) cb(null); }
    }
    function clearBuffer() { send({ action: 'TTS_CLEAR_BUFFER' }); preloaded.clear(); }   // [AGENT-EXP] preload jeszcze raz
    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function pickVideo() {
        var vs = document.querySelectorAll('video'), best = null, bestArea = 0;
        for (var i = 0; i < vs.length; i++) {
            var r = vs[i].getBoundingClientRect(), a = r.width * r.height;
            if (a > bestArea) { best = vs[i]; bestArea = a; }
        }
        return best;
    }

    function cleanText(t) {
        return String(t || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
    }

    // Prosty parser WebVTT/SRT (dla <track src>, gdy przeglądarka nie dała cue'ów).
    function parseTime(s) {
        var m = String(s).trim().replace(',', '.').match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
        if (!m) return NaN;
        return ((+(m[1] || 0)) * 3600 + (+m[2]) * 60 + parseFloat(m[3])) * 1000;
    }
    function parseVtt(text) {
        var out = [], blocks = String(text || '').replace(/\r/g, '').split(/\n{2,}/);
        for (var i = 0; i < blocks.length; i++) {
            var lines = blocks[i].split('\n'), k = lines.findIndex(function (l) { return l.indexOf('-->') !== -1; });
            if (k < 0) continue;
            var parts = lines[k].split('-->'), st = parseTime(parts[0]), en = parseTime(parts[1]);
            var t = cleanText(lines.slice(k + 1).join(' '));
            if (!isNaN(st) && !isNaN(en) && t) out.push({ startMs: st, endMs: en, text: t });
        }
        return out;
    }

    async function collectTracks(v) {
        var res = [];
        var tts = v.textTracks ? [].slice.call(v.textTracks) : [];
        var changed = [];
        tts.forEach(function (t) {
            if (t.kind !== 'subtitles' && t.kind !== 'captions') return;
            if (t.mode === 'disabled') { changed.push(t); try { t.mode = 'hidden'; } catch (e) {} } // wymusza wczytanie cue'ów
        });
        for (var w = 0; w < 20; w++) { // do 4 s na wczytanie
            if (tts.some(function (t) { return t.cues && t.cues.length; })) break;
            await wait(200);
        }
        tts.forEach(function (t) {
            if (!t.cues || !t.cues.length) return;
            var cues = [];
            for (var i = 0; i < t.cues.length; i++) {
                var c = t.cues[i], txt = cleanText(c.text);
                if (txt) cues.push({ startMs: c.startTime * 1000, endMs: c.endTime * 1000, text: txt });
            }
            if (cues.length) res.push({ lang: String(t.language || '').toLowerCase() || 'und', label: t.label || '', cues: cues });
        });
        changed.forEach(function (t) { try { t.mode = 'disabled'; } catch (e) {} });
        if (res.length) return res;
        // Zapas: <track src="..."> pobrany wprost (ta sama domena / CORS).
        var els = v.querySelectorAll('track[src]');
        for (var j = 0; j < els.length; j++) {
            try {
                var r = await fetch(els[j].src, { credentials: 'include' });
                if (!r.ok) continue;
                var cs = parseVtt(await r.text());
                if (cs.length) res.push({ lang: String(els[j].srclang || '').toLowerCase() || 'und', label: els[j].label || '', cues: cs });
            } catch (e) {}
        }
        return res;
    }

    function pickTrack(list) {
        var by = function (f) { return list.find(f) || null; };
        return by(function (t) { return /^pl/.test(t.lang) || /polski|polish/i.test(t.label); })
            || by(function (t) { return /^en/.test(t.lang) || /english|angiel/i.test(t.label); })
            || list[0];
    }

  // [AGENT-EXP] 2026-10-17: kontekst dla tłumacza — true = tu zaczyna się nowy blok (pauza >= 2 s albo nie-sąsiednia kwestia)
  function ctxBrk(list, batch) {
    return batch.map(function (ix, j) {
      if (!j || ix !== batch[j - 1] + 1) return true;
      var a = list[batch[j - 1]], b = list[ix];
      return !a || !b || !(b.startMs - a.endMs < 2000);
    });
  }
    async function translateAll(src, myToken) {
        var now = video ? video.currentTime * 1000 : 0;
        var first = items.findIndex(function (c) { return c.endMs >= now; });
        if (first < 0) first = 0;
        var order = [];
        for (var i = first; i < items.length; i++) order.push(i);
        for (var k = 0; k < first; k++) order.push(k);
        var done = 0, fails = 0;
        while (order.length) {
            if (myToken !== token) return;
            var batch = [], chars = 0;
            while (order.length && batch.length < 60 && chars < 2500) { var ix = order.shift(); batch.push(ix); chars += items[ix].src.length + 1; }
            var out = await new Promise(function (res) {
                send({ action: 'EXT_TR_LIST', src: src, brk: ctxBrk(items, batch), texts: batch.map(function (ix) { return items[ix].src; }) }, function (r) {   // [AGENT-EXP] brk: kontekst
                    res(r && r.ok && Array.isArray(r.texts) ? r.texts : null);
                });
            });
            if (myToken !== token) return;
            if (!out) {
                if (++fails > 5) { state.status = 'Tłumaczenie przerwane (brak odpowiedzi tłumacza).'; break; }
                order = batch.concat(order); await wait(5000); continue;
            }
            batch.forEach(function (ix, j) { if (out[j]) items[ix].text = cleanText(out[j]); });
            czPush();   // [AGENT-EXP] 2026-11-06: cenzor dostaje nowe tłumaczenia (przekleństwa po polsku)
            done += batch.length;
            state.status = 'Tłumaczę na polski: ' + done + '/' + items.length;
        }
        if (myToken === token && !order.length) { state.status = 'Gotowe — ' + items.length + ' kwestii po polsku, lektor czyta.'; saveMem(); }
    }

    // ===== Czytanie =====
    var duckReady = false;
    function applyDuck() {
        if (!video || !duckReady || !enabled) return;   // [AGENT-EXP] 2026-10-20: nie ściszaj filmu, zanim wczytamy ustawienia (start z enabled=true) ani przy wyłączonym lektorze
        var LS = window.__LektorSched; if (LS && LS.duckAllowed && !LS.duckAllowed()) { restoreVolume(); return; }   // [FIX 2026-11-16] lektor milczy → film gra PEŁNĄ głośnością (dotąd zostawał na 20%)
        var target = duckLevel / 100;
        var __vt = (window.__LektorSched && window.__LektorSched.volTarget) ? window.__LektorSched.volTarget(video) : null, __vn = __vt != null ? __vt : video.volume;   // [FIX 2026-11-22]
        if (savedVolume === null && __vn > target) savedVolume = __vn;
        if (video.volume > target) setV(video, target);
    }
    function setV(v, x) { var S = window.__LektorSched; if (S && S.setVol) S.setVol(v, x); else v.volume = x; }   // [FIX 2026-11-02] płynnie w trybie „tylko gdy mówi”
    function restoreVolume() {
        if (!video) { savedVolume = null; return; }
        if (savedVolume !== null) { try { setV(video, savedVolume); } catch (e) {} savedVolume = null; return; }
        // [FIX 2026-11-16] brak zapisanej głośności, a film stoi dokładnie na poziomie duckingu — to nasza robota
        var LS = window.__LektorSched;
        if (LS && LS.duckWhileOn && LS.duckWhileOn() && duckLevel >= 5 && video.volume > 0
            && Math.abs(video.volume - duckLevel / 100) <= 0.02) { try { setV(video, 1); } catch (e) {} }
        savedVolume = null;
    }
    try { window.__LektorSched.onDuck(function () { if (enabled && items) applyDuck(); }, function () { restoreVolume(); }); } catch (e) {}   // [FIX 2026-11-02] 🔉

    function stopLoop() { if (loopTimer) { clearInterval(loopTimer); loopTimer = null; } restoreVolume(); }
    var fsSrcSent = -1;   // [FIX 2026-11-02] „czytam z: …”
    function startOwnLoop() {
        stopLoop();
        loopTimer = setInterval(function () {
            if (!enabled || !items || !video) return;
            // [AGENT-EXP] 2026-11-06: lektor (dom_content) doszedł już na tej stronie (np. po zapamiętaniu strony)
            // → oddajemy mu czytanie i wyłączamy własną pętlę, żeby nie czytało się podwójnie
            if (window.__LIVEDUB_AUTO_APPLY__) {
                try { window.__LIVEDUB_AUTO_APPLY__(items, false, 'całe napisy (na żądanie)'); } catch (e) {}
                stopLoop();
                return;
            }
            var wTle = document.visibilityState !== 'visible';   // [AGENT-EXP] karta w tle: tylko buforowanie
            if (wTle && window.__lektorBufTlo === false) return;
            if (!video.isConnected || (video.currentSrc || video.src) !== videoSrc) { stop(); return; } // inny film
            var ownPauza = video.paused;   // [AGENT-EXP] pauza: tylko buforowanie, bez czytania
            if (ownPauza && window.__lektorBufPauza === false) return;
            var now = video.currentTime * 1000;
            if (lastNow >= 0 && Math.abs(now - lastNow) > 1500) { played.clear(); preloaded.clear(); clearBuffer(); } // przewinięcie
            lastNow = now;
            // [FIX 2026-11-02] wspólny harmonogram (assets/lektor_scheduler.js) — ta sama logika co YouTube / Netflix / strony DOM
            var S = window.__LektorSched;
            if (fsSrcSent !== items.length) { fsSrcSent = items.length; S.setSource('całe napisy (na żądanie)', items.length); }
            S.tick({
                list: items, nowMs: now, off: 0, rate: video.playbackRate || 1, lookaheadMs: LOOKAHEAD,
                budget: S.budgetFor(video), canPlay: S.canPlay(video), preloaded: preloaded, played: played,
                keyOf: function (c, i) { return i; }, send: send,
                onPlay: function () { applyDuck(); },
                afterPlay: function (c) {
                    clearTimeout(startOwnLoop._r);
                    if (S.duckWhileOn && S.duckWhileOn()) return;   // 🔉 głośność oddaje koniec mowy lektora, nie zegar
                    startOwnLoop._r = setTimeout(restoreVolume, Math.min(6000, Math.max(1500, c.text.length * 65) + 400));
                }
            });
        }, 100);
    }
    function stop() {
        token++;
        stopLoop();
        items = null;
        czTimers.forEach(function (t) { clearTimeout(t); });
        czTimers = []; czSig = '';
        try { window.postMessage({ __lektorCenzor: 'cues', key: 'na żądanie', cues: [] }, location.origin); } catch (e) {}
        try { if (window.__LIVEDUB_AUTO_APPLY__) window.__LIVEDUB_AUTO_APPLY__(null); } catch (e) {}
        state = { found: false, cues: 0, lang: '', busy: false, status: 'Zatrzymano (zmiana filmu).' };
    }

    async function start() {
        var v = pickVideo();
        if (!v) return { found: false, reason: 'novideo' };
        // [AGENT-EXP] 2026-11-06: najpierw pamięć — ten film już był pobrany, więc nic nie ściągamy z sieci
        var saved = await new Promise(loadMem);
        if (saved && Array.isArray(saved.cues) && saved.cues.length >= 5 && Date.now() - (+saved.loadedAt || 0) < MEM_TTL
            && (!saved.dur || !v.duration || Math.abs(saved.dur - v.duration) < 3)) {
            token++;
            var tokMem = token;
            stopLoop();
            video = v; videoSrc = v.currentSrc || v.src; played.clear(); preloaded.clear(); lastNow = -1;
            var haveText = 0;
            items = saved.cues.map(function (c, i) {
                if (c.text) haveText++;
                return { id: 'od_' + tokMem + '_' + i, startMs: c.startMs, endMs: c.endMs, src: c.src || c.text || '', text: c.text || '' };
            });
            var plMem = haveText >= items.length * 0.5;
            state = { found: true, cues: items.length, lang: 'pl', busy: !plMem, status: 'Z pamięci — ' + items.length + ' kwestii (bez pobierania), lektor czyta.' };
            if (window.__LIVEDUB_AUTO_APPLY__) { try { window.__LIVEDUB_AUTO_APPLY__(items, false, 'całe napisy (na żądanie) — z pamięci'); } catch (e) { startOwnLoop(); } }
            else startOwnLoop();
            czPushSoon();
            rememberSite();
            if (!plMem) translateAll('auto', tokMem).then(function () { if (tokMem === token) { state.busy = false; saveMem(); } });
            return { found: true, cues: items.length, lang: 'pl', translating: !plMem, fromMemory: true };
        }
        var list = await collectTracks(v);
        if (!list.length) return { found: false, reason: 'notracks' };
        token++;
        var myToken = token;
        stopLoop();
        video = v; videoSrc = v.currentSrc || v.src; played.clear(); preloaded.clear(); lastNow = -1;
        var tr = pickTrack(list);
        var pl = /^pl/.test(tr.lang) || /polski|polish/i.test(tr.label);
        var trCues = pl ? tr.cues : zdMerge(tr.cues, 'text');   // [AGENT-EXP] całe zdania do tłumaczenia
        items = trCues.map(function (c, i) {
            return { id: 'od_' + myToken + '_' + i, startMs: c.startMs, endMs: c.endMs, src: c.text, text: pl ? c.text : '' };
        });
        state = { found: true, cues: items.length, lang: tr.lang, busy: !pl, status: pl ? 'Gotowe — ' + items.length + ' kwestii (polskie), lektor czyta.' : 'Tłumaczę na polski: 0/' + items.length };
        if (window.__LIVEDUB_AUTO_APPLY__) { try { window.__LIVEDUB_AUTO_APPLY__(items, false, 'całe napisy (na żądanie)'); } catch (e) { startOwnLoop(); } }   // [FIX 2026-11-02] etykieta źródła
        else startOwnLoop();
        czPushSoon();   // [AGENT-EXP] 2026-11-06: 🤐 cenzor — wyciszanie przekleństw w dźwięku filmu
        rememberSite();   // [AGENT-EXP] 2026-11-06: strona zapamiętana — kolejny film ruszy sam
        if (!pl) translateAll(/^und/.test(tr.lang) ? 'auto' : tr.lang, myToken).then(function () { if (myToken === token) state.busy = false; });
        else saveMem();   // [AGENT-EXP] 2026-11-06: 💾 polskie napisy — od razu do pamięci
        return { found: true, cues: items.length, lang: tr.lang, translating: !pl };
    }

    window.__lektorFullSubs = {
        start: start,
        status: function () { return { found: state.found, cues: state.cues, busy: state.busy, status: state.status }; }
    };
})();
