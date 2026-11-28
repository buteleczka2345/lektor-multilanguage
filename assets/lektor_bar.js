// [AGENT-EXP] 2026-10-17: 📊 PASEK LEKTORA — jak daleko do przodu lektor ma już NAGRANY DŹWIĘK.
// [AGENT-EXP] 2026-11-16: dwie warstwy na dole filmu (jak w YouTube):
//   1) 6 px — kwestie na osi czasu: pomarańczowa = dźwięk gotowy, zielona = lektor już przeczytał,
//      jasnoszara = tekst jest, dźwięku nie ma, ciemna = czeka na tłumaczenie; biała kreska = teraz.
//   2) 5 px — PASEK POSTĘPU Z BUFOREM: białe = obejrzane, pomarańczowe = przygotowane do przodu, ciemne = brak.
// Po prawej: „07:54 · 🔊 zapas 2:31 / 7:00 · 480/668”, po lewej źródło napisów (📍) i cenzor (🔇).
// Ten sam obrazek czyta popup (wiadomość `LEKTOR_BAR_SNAP`) — jedno źródło prawdy o zapasie: klucze NAGRANEGO
// dźwięku z pamięci lektora (nie „zamówienia” do syntezy, które mogą jeszcze nie mieć pliku).
// Dźwięk: background (LEKTOR_AUDIO_KEYS) podaje klucze nagrań tej karty z pamięci lektora (offscreen),
// klucz kwestii = id + '|' + skrót tekstu (ten sam co ttsCacheId w background.js).
// Skrypty lektora (youtube_content, dom_content, content.js Netflix, full_subs_ondemand) podają swoje kwestie
// przez window.__lektorBarProviders[nazwa] = function () { return { video, list, ready(c, i), spoken(c, i), audioId(c, i) } | null }.
// Wspólny świat izolowany rozszerzenia w ramce, więc to zwykły obiekt globalny.
// Opcja „Pasek lektora” (lektorBar, domyślnie WŁ.). Nic nie łapie myszy (pointer-events: none).
(function () {
    'use strict';
    if (window.__lektorBarLoaded) return;
    window.__lektorBarLoaded = true;
    // [FIX 2026-11-25] po przeładowaniu / aktualizacji rozszerzenia stary skrypt zostaje na karcie „osierocony”:
    // dalej rysuje pasek, ale nie słyszy już checkboxa. Nowa kopia usuwa jego pasek, a każda kopia sama się wyłącza,
    // gdy straci łączność z rozszerzeniem (alive() = false).
    function alive() { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } }
    try { document.querySelectorAll('#lektor-progress-bar').forEach(function (el) { el.remove(); }); } catch (e) {}
    window.__lektorBarProviders = window.__lektorBarProviders || {};

    var on = null, box = null,   // [FIX 2026-11-22] null = ustawienie jeszcze się wczytuje (bez mignięcia)
         cv = null, lbl = null, srcLbl = null, cenLbl = null, lastSig = '', why = 'pasek jeszcze nie wystartował';
    var audio = new Set(), audioAt = 0, audioBusy = false;
    var stats = null, statsAt = 0, statsBusy = false;   // [FIX 2026-11-02] pominięte kwestie / opóźnienie (LEKTOR_STATS)
    var limitMs = 0;   // [AGENT-EXP] 2026-11-16: limit zapasu z suwaka „Nagrywanie / zapas do przodu” (lookaheadMin)
    try {
        chrome.storage.local.get(['lektorBar', 'lookaheadMin'], function (r) {
            on = !(r && r.lektorBar === false);
            limitMs = Math.max(0, (Number(r && r.lookaheadMin) || 0) * 60000);
            lastSig = '';
        });
        setTimeout(function () { if (on === null) on = true; }, 3000);   // storage milczy → domyślnie WŁ.
        // [FIX 2026-11-25] zapasowo co 2 s czytamy checkbox sami — gdyby zdarzenie onChanged nie dotarło
        setInterval(function () {
            if (!alive()) return;
            try {
                chrome.storage.local.get('lektorBar', function (r) {
                    if (chrome.runtime.lastError) return;
                    var nx = !(r && r.lektorBar === false);
                    if (nx !== on) { on = nx; lastSig = ''; if (!on) hide(); }
                });
            } catch (e) {}
        }, 2000);
        chrome.storage.onChanged.addListener(function (ch, area) {
            if (area !== 'local') return;
            if (ch.lektorBar) { on = ch.lektorBar.newValue !== false; lastSig = ''; if (!on) hide(); }
            if (ch.lookaheadMin) { limitMs = Math.max(0, (Number(ch.lookaheadMin.newValue) || 0) * 60000); lastSig = ''; }
        });
    } catch (e) {}

    function hash(t) {   // jak ttsCacheId w background.js
        t = String(t || '');
        var h = 5381;
        for (var i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
        return (h >>> 0).toString(36);
    }
    // [FIX 2026-11-22] hash liczony raz na kwestię (WeakMap — nie dopisujemy pól do obiektów dostawcy)
    var hashMemo = new WeakMap();
    function cueHash(c) {
        var t = String((c && c.text) || ''), m = hashMemo.get(c);
        if (m && m.t === t) return m.h;
        var h = hash(t);
        if (c && typeof c === 'object') hashMemo.set(c, { t: t, h: h });
        return h;
    }
    function sameKeys(arr) {
        if (arr.length !== audio.size) return false;
        for (var i = 0; i < arr.length; i++) if (!audio.has(arr[i])) return false;
        return true;
    }
    function refreshAudio() {
        if (audioBusy || Date.now() - audioAt < 1000) return;
        audioBusy = true; audioAt = Date.now();
        try {
            chrome.runtime.sendMessage({ action: 'LEKTOR_AUDIO_KEYS' }, function (r) {
                void chrome.runtime.lastError;
                audioBusy = false;
                if (r && Array.isArray(r.keys) && !sameKeys(r.keys)) { audio = new Set(r.keys); lastSig = ''; }   // [FIX 2026-11-22] bez zmian → bez przerysowania
            });
        } catch (e) { audioBusy = false; }
    }

    // [FIX 2026-11-02] liczniki lektora tej karty: ile kwestii pominął (ostatnie 10 min) i z jakim opóźnieniem zaczyna mówić
    function refreshStats() {
        if (statsBusy || Date.now() - statsAt < 3000) return;
        statsBusy = true; statsAt = Date.now();
        try {
            chrome.runtime.sendMessage({ action: 'LEKTOR_STATS' }, function (r) {
                void chrome.runtime.lastError;
                statsBusy = false;
                var nx = r || null;   // [FIX 2026-11-22] przerysuj tylko, gdy liczby się zmieniły
                if (JSON.stringify(nx) !== JSON.stringify(stats)) { stats = nx; lastSig = ''; }
            });
        } catch (e) { statsBusy = false; }
    }
    // [FIX 2026-11-22] przesunięcie napisów (ms) — harmonogram lektora czyta kwestię w startMs + off, pasek liczy tak samo
    function offOf(d) {
        try {
            var o = typeof d.off === 'function' ? d.off() : d.off;
            o = Number(o);
            return isFinite(o) ? o : 0;
        } catch (e) { return 0; }
    }
    function sec(ms) { return (Math.round(ms / 100) / 10).toFixed(1).replace('.', ',') + ' s'; }

    // [FIX 2026-11-02] 💾 eksport przetłumaczonych napisów do .srt — polecenie z popupu (LEKTOR_EXPORT_SRT) trafia do
    // każdej ramki; odpowiada (i pobiera plik) tylko ta, która ma listę kwestii. Czasy bez przesunięcia lektora.
    function srtTime(ms) {
        ms = Math.max(0, Math.round(ms));
        var p = function (n, w) { return String(n).padStart(w || 2, '0'); };
        return p(Math.floor(ms / 3600000)) + ':' + p(Math.floor(ms / 60000) % 60) + ':' + p(Math.floor(ms / 1000) % 60) + ',' + p(ms % 1000, 3);
    }
    var srtTotal = 0;   // [FIX 2026-11-22] ile kwestii ma lista (popup ostrzega, gdy tłumaczenie jeszcze trwa)
    function srtCues(d) {
        var out = [], n = 0;
        d.list.forEach(function (c, i) {
            var ok = false;
            try { ok = !!d.ready(c, i); } catch (e) {}
            var t = String((c && c.text) || '').replace(/\s+/g, ' ').trim();
            if (!ok || !t || !(c.endMs > c.startMs)) return;
            out.push((++n) + '\n' + srtTime(c.startMs) + ' --> ' + srtTime(c.endMs) + '\n' + t + '\n');
        });
        return out;
    }
    // [FIX 2026-11-22] popup najpierw pyta WSZYSTKIE ramki o liczbę kwestii (bez pobierania), potem każe pobrać plik
    // tylko jednej — wcześniej każda ramka z listą pobierała własny plik (np. YouTube + osadzony film = 2 pliki).
    window.__lektorBarSrtInfo = function () {
        var d = pick();
        if (!d) return null;
        return { count: srtCues(d).length, total: d.list.length, top: window === window.top };
    };
    window.__lektorBarSrtExport = function (title) { var n = exportSrt(title); return n ? { ok: true, count: n, total: srtTotal } : null; };
    function exportSrt(title) {
        var d = pick();
        if (!d) return 0;
        srtTotal = d.list.length;
        var out = srtCues(d), n = out.length;
        if (!n) return 0;
        var name = String(title || document.title || 'napisy').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'napisy';
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(['\ufeff' + out.join('\n')], { type: 'application/x-subrip;charset=utf-8' }));
        a.download = name + (d.noTranslate ? '.srt' : '.pl.srt');   // [FIX 2026-11-22] Netflix: napisy w oryginale — bez „.pl”
        a.style.display = 'none';
        (document.body || document.documentElement).appendChild(a);
        a.click();
        setTimeout(function () { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) {} }, 3000);
        return n;
    }
    try {
        chrome.runtime.onMessage.addListener(function (msg, _s, sendResponse) {
            if (!msg) return;
            // [AGENT-EXP] 2026-11-16: popup pyta o stan karty (pozycja, zapas, najbliższe zdania). Odpowiada tylko
            // główna ramka — inaczej wygrałaby ramka z reklamą i popup pokazałby cudze liczby.
            if (msg.action === 'LEKTOR_BAR_SNAP') {
                // [FIX 2026-11-22] najpierw pyta tylko główna ramka (popup: frameId 0). Gdy milczy, popup pyta drugi raz
                // z anyFrame — wtedy odpowiadają ramki z prawdziwą listą kwestii (film w iframe: Dailymotion, Rumble…).
                if (window !== window.top && !msg.anyFrame) return;
                var s = snap();
                if (s && window !== window.top && !s.total) return;   // ramka bez listy — milczy (np. reklama)
                if (s) sendResponse(s);   // brak danych → milczy (popup pokaże telemetrię / „odtwórz film”)
                return;
            }
            if (msg.action !== 'LEKTOR_EXPORT_SRT') return;
            var n = exportSrt(msg.title);
            if (n) sendResponse({ ok: true, count: n, total: srtTotal });   // bez listy — milczy (odpowie inna ramka)
        });
    } catch (e) {}

    function build() {
        box = document.createElement('div');
        box.id = 'lektor-progress-bar';
        box.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;display:none;';
        cv = document.createElement('canvas');
        cv.style.cssText = 'position:absolute;left:0;bottom:0;width:100%;height:11px;border-radius:3px;';
        lbl = document.createElement('div');
        lbl.style.cssText = 'position:absolute;right:4px;bottom:14px;font:600 11px system-ui,sans-serif;color:#fff;'
            + 'background:rgba(0,0,0,.55);padding:1px 6px;border-radius:8px;white-space:nowrap;'
            + 'max-width:calc(100% - 8px);overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;';   // [FIX 2026-11-22]
        srcLbl = document.createElement('div');   // [FIX 2026-11-02] „📍 skąd czyta lektor”
        srcLbl.style.cssText = 'position:absolute;left:4px;bottom:14px;max-width:45%;overflow:hidden;text-overflow:ellipsis;font:600 11px system-ui,sans-serif;color:#fff;'
            + 'background:rgba(0,0,0,.55);padding:1px 6px;border-radius:8px;white-space:nowrap;box-sizing:border-box;';
        cenLbl = document.createElement('div');   // [AGENT-EXP] 2026-11-14: „cenzor tnie teraz” (plik / live)
        cenLbl.style.cssText = 'position:absolute;left:4px;bottom:32px;font:700 10px system-ui,sans-serif;color:#fff;display:none;'
            + 'background:#c0392b;padding:1px 6px;border-radius:8px;white-space:nowrap;';
        box.appendChild(cv); box.appendChild(lbl); box.appendChild(srcLbl); box.appendChild(cenLbl);
        try { if (self.MLi18n) { MLi18n.watch(box); } } catch (e) {}   // [AGENT-EXP] 2026-10-21: język interfejsu (PL / EN)
    }
    function hide() { if (box) box.style.display = 'none'; lastSig = ''; }

    function pick() {
        var ps = window.__lektorBarProviders, best = null;
        for (var k in ps) {
            var d = null;
            try { d = ps[k](); } catch (e) { d = null; }
            // [FIX 2026-11-16] dostawca „na żywo” (czytanie z ekranu) nie ma listy kwestii — liczy się samo wideo
            if (!d || !d.video || !d.list) continue;
            if (!d.list.length && !d.live) continue;
            if (!best || d.list.length > best.list.length) best = d;
        }
        return best;
    }
    function srcName() {
        try {
            var s = window.__LektorSched && window.__LektorSched.getSource();
            return s ? String(s.name || '') : '';
        } catch (e) { return ''; }
    }
    // [AGENT-EXP] 2026-11-16: brak listy kwestii (np. Netflix bez wczytanych napisów), ale lektor ma źródło i film gra —
    // pokazujemy samą pozycję, żeby pasek nie znikał zupełnie („w Netflixie nic nie ma”).
    function pickAny() {
        var d = pick();
        if (d) return d;
        if (!srcName()) return null;
        var v = document.querySelector('video');
        if (!v || !v.isConnected) return null;
        return { video: v, list: [], live: false, soft: true, ready: function () { return false; }, spoken: function () { return false; } };
    }
    function mmss(ms) { var s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
    function clock(ms) {
        var s = Math.max(0, Math.round(ms / 1000));
        var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), q = s % 60;
        return h ? h + ':' + ('0' + m).slice(-2) + ':' + ('0' + q).slice(-2) : mmss(ms);
    }

    // Jeden odczyt karty: pozycja, stan każdej kwestii (tekst / dźwięk / przeczytane) i dokąd sięga zapas.
    // Używają go i pasek (rysowanie), i popup (LEKTOR_BAR_SNAP) — dzięki temu liczą to samo.
    function compute(d) {
        d = d || pickAny();
        if (!d) return null;
        var v = d.video;
        if (!v || !v.isConnected) return null;
        var dur = v.duration;
        if (!isFinite(dur) || dur <= 0) return null;
        var list = d.list || [];
        var now = Math.max(0, (v.currentTime || 0) * 1000);
        var off = offOf(d);   // [FIX 2026-11-22]
        var st = new Array(list.length), ready = 0, rec = 0;
        for (var i = 0; i < list.length; i++) {
            var c = list[i], isR = false, isS = false, isA = false;
            try {
                isR = !!d.ready(c, i);
                isS = isR && !!d.spoken(c, i);
                isA = isR && !isS && d.audioId && audio.has(d.audioId(c, i) + '|' + cueHash(c));
            } catch (e) {}
            st[i] = isS ? 3 : (isA ? 2 : (isR ? 1 : 0));
            if (isR) ready++;
            if (isA) rec++;
        }
        // zapas do przodu: ciąg kwestii od bieżącego miejsca, które mają dźwięk (albo są już przeczytane)
        // [FIX 2026-11-22] kwestia, której lektor NIGDY nie nagra (sam „[muzyka]”, zablokowana fraza, pominięta), nie urywa
        // zapasu: bez liter/cyfr — pomijamy zawsze; z tekstem — gdy następna kwestia ma już dźwięk (lektor nagrywa po kolei,
        // więc dziura przed nagraną kwestią to kwestia odrzucona, a nie „jeszcze w kolejce”).
        var aheadEnd = now, aheadN = 0;
        for (i = 0; i < list.length; i++) {
            c = list[i];
            if (c.endMs + off <= now) continue;
            if (st[i] < 2) {
                if (st[i] === 0) break;        // czeka na tłumaczenie — tu kończy się zapas
                if (!/[\p{L}\p{N}]/u.test(String(c.text || ''))) continue;
                var nx = i + 1 < list.length ? st[i + 1] : 0;
                if (nx >= 2) continue;
                break;                         // tekst jest, dźwięku nie ma — tu kończy się zapas
            }
            aheadEnd = c.endMs + off; aheadN++;
        }
        return { d: d, v: v, dur: dur, now: now, off: off, list: list, st: st, ready: ready, rec: rec, aheadEnd: aheadEnd, aheadN: aheadN };
    }

    // Zrzut dla popupu: to samo, tylko „po ludzku” (ms + kawałek tekstu najbliższych kwestii z dźwiękiem).
    function snap() {
        refreshAudio();
        var s = compute();
        if (!s) return null;
        var cues = [];
        for (var i = 0; i < s.list.length && cues.length < 3; i++) {
            var c = s.list[i];
            if (c.endMs + s.off <= s.now || s.st[i] < 2) continue;
            var t = String(c.text || '').replace(/\s+/g, ' ').trim();
            if (!t) continue;
            cues.push({ atMs: Math.round(Math.max(0, c.startMs + s.off)), text: t.slice(0, 140) });
        }
        return {
            nowMs: Math.round(s.now),
            durMs: Math.round(s.dur * 1000),
            bufMs: Math.round(Math.max(0, s.aheadEnd - s.now)),
            aheadN: s.aheadN,
            ready: s.ready,
            total: s.list.length,
            noTranslate: !!s.d.noTranslate,
            live: !!(s.d.live && !s.d.soft && !s.list.length),
            soft: !!s.d.soft,
            source: srcName(),
            cues: cues
        };
    }
    window.__lektorBarSnap = snap;   // diagnostyka: `__lektorBarSnap()` w konsoli strony

    // [FIX 2026-11-25] WIDOCZNA część filmu. Netflix (okno szersze niż 16:9) robi <video> wyższy niż okno i ucina go
    // rodzicem z overflow:hidden — dół elementu był POD ekranem, więc pasek rysował się poza widokiem („nie ma paska”).
    // Przycinamy prostokąt do okna i do przodków, które obcinają zawartość.
    function visibleRect(v) {
        var b = v.getBoundingClientRect();
        var L = b.left, T = b.top, R = b.right, B = b.bottom;
        try {
            for (var el = v.parentElement; el && el !== document.documentElement; el = el.parentElement) {
                var cs = getComputedStyle(el);
                if (cs.overflowX === 'visible' && cs.overflowY === 'visible' && cs.clipPath === 'none') continue;
                var p = el.getBoundingClientRect();
                if (p.width < 2 || p.height < 2) continue;
                L = Math.max(L, p.left); T = Math.max(T, p.top); R = Math.min(R, p.right); B = Math.min(B, p.bottom);
            }
        } catch (e) {}
        L = Math.max(L, 0); T = Math.max(T, 0);
        R = Math.min(R, window.innerWidth || document.documentElement.clientWidth);
        B = Math.min(B, window.innerHeight || document.documentElement.clientHeight);
        return { left: L, top: T, right: R, bottom: B, width: Math.max(0, R - L), height: Math.max(0, B - T) };
    }

    function tick() {
        if (!alive()) {   // [FIX 2026-11-25] osierocony skrypt — sprzątamy pasek i kończymy na dobre
            try { if (box) box.remove(); } catch (e) {}
            box = null; why = 'rozszerzenie przeładowane — odśwież stronę';
            clearInterval(tickTimer);
            return;
        }
        if (on === null) { why = 'ustawienia jeszcze się wczytują'; return; }
        if (!on) { why = 'wyłączone w ustawieniach (📊 Pasek lektora)'; hide(); return; }
        if (document.visibilityState !== 'visible') { why = 'karta w tle'; hide(); return; }
        var d = pickAny();
        var v = d && d.video;
        if (!d) { why = 'brak kwestii do czytania (brak napisów / lektor milczy)'; hide(); return; }
        if (!v || !v.isConnected) { why = 'wideo zniknęło ze strony'; hide(); return; }
        if (!isFinite(v.duration) || v.duration <= 0) { why = 'film bez znanego czasu (reklama, transmisja na żywo, jeszcze się nie wczytał)'; hide(); return; }
        var r = visibleRect(v);
        if (r.width < 120 || r.height < 60) { why = 'obraz filmu za mały (' + Math.round(r.width) + '×' + Math.round(r.height) + ' px)'; hide(); return; }
        // [FIX 2026-11-16] pełny ekran na samym <video>: przeglądarka nie rysuje na nim żadnych nakładek
        var fe = document.fullscreenElement;
        if (fe && fe.tagName === 'VIDEO') { why = 'pełny ekran na <video> — przeglądarka nie pokazuje nakładek na filmie'; hide(); return; }
        why = '';
        refreshAudio();
        refreshStats();   // [FIX 2026-11-02]
        var s = compute(d);
        if (!s) { why = 'brak znanego czasu filmu'; hide(); return; }
        if (!box) build();
        var host = fe && fe.tagName !== 'VIDEO' ? fe : document.documentElement;
        // [FIX 2026-11-22] pełny ekran na elemencie z Shadow DOM (media-chrome, Vidstack…): zwykłe dzieci hosta nie są
        // rysowane, więc pasek idzie do jego shadow root (także zamkniętego — chrome.dom w skrypcie rozszerzenia)
        if (fe && host === fe) {
            var sr = null;
            try { sr = fe.shadowRoot || (chrome.dom && chrome.dom.openOrClosedShadowRoot ? chrome.dom.openOrClosedShadowRoot(fe) : null); } catch (e) {}
            if (sr) host = sr;
        }
        if (box.parentNode !== host) host.appendChild(box);
        box.style.left = Math.round(r.left) + 'px';
        box.style.width = Math.round(r.width) + 'px';
        box.style.top = Math.round(r.bottom - 30) + 'px';
        box.style.height = '30px';
        box.style.display = '';

        var W = Math.max(1, Math.round(r.width)), H = 11, CUE = 6, durMs = s.dur * 1000, list = s.list, now = s.now, off = s.off;
        // [FIX 2026-11-22] ostry obraz przy skalowaniu Windows 125–150 % (devicePixelRatio)
        var dpr = Math.min(4, Math.max(1, window.devicePixelRatio || 1));
        var narrow = W < 420;   // [FIX 2026-11-22] mały odtwarzacz — krótsza etykieta, bez „📍 źródła”
        var sig = W + '|' + dpr + '|' + off + '|' + list.length + '|' + s.ready + '|' + s.rec + '|' + s.aheadN + '|' + Math.round(now / 250)
            + '|' + (stats ? stats.skipped10m + '/' + stats.lagAvgMs : '') + '|' + limitMs + '|' + (d.soft ? 's' : (d.live ? 'l' : ''));
        if (sig === lastSig) return;
        lastSig = sig;
        var PW = Math.round(W * dpr), PH = Math.round(H * dpr);
        if (cv.width !== PW) cv.width = PW;
        if (cv.height !== PH) cv.height = PH;
        var g = cv.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, W, H);
        // warstwa 1: kwestie
        g.fillStyle = 'rgba(0,0,0,.45)';
        g.fillRect(0, 0, W, CUE);
        var COL = ['rgba(255,255,255,.12)', 'rgba(255,255,255,.38)', '#ff9f1a', '#2ecc71'];
        for (var i = 0; i < list.length; i++) {
            var c = list[i];
            if (!(c.endMs > 0)) continue;
            var x = ((c.startMs + off) / durMs) * W, w = Math.max(1, ((c.endMs - c.startMs) / durMs) * W);
            g.fillStyle = COL[s.st[i]];
            g.fillRect(x, 0, w, CUE);
        }
        // warstwa 2: postęp odtwarzania + BUFOR (białe = obejrzane, pomarańczowe = zapas, ciemne = brak)
        var py = CUE, ph = H - CUE, px = Math.min(W, Math.max(0, (now / durMs) * W));
        g.fillStyle = 'rgba(0,0,0,.55)';
        g.fillRect(0, py, W, ph);
        var bx = Math.min(W, Math.max(px, (s.aheadEnd / durMs) * W));
        if (bx > px) { g.fillStyle = '#ff9f1a'; g.fillRect(px, py, bx - px, ph); }
        g.fillStyle = '#fff';
        g.fillRect(0, py, px, ph);
        g.fillRect(Math.min(W - 2, Math.max(0, px - 1)), 0, 2, H);

        // [AGENT-EXP] 2026-10-20: dostawca bez tłumaczenia (Netflix — czyta napisy jak są) → „napisy gotowe”, nie „przetłumaczone”
        var extra = '';   // [FIX 2026-11-02] opóźnienie lektora i pominięte kwestie (wcześniej pomijanie było ciche)
        if (!narrow && stats && stats.lagAvgMs != null && stats.lagAvgMs > 400) extra += ' · ⏱ ' + sec(stats.lagAvgMs);
        if (!narrow && stats && stats.skipped10m) extra += ' · ⏭ ' + stats.skipped10m;
        if (d.soft) {
            lbl.textContent = clock(now) + ' · ⏳ napisy się wczytują';
        } else if (d.live && !list.length) {
            // [FIX 2026-11-16] czytanie z EKRANU: przyszłości nie znamy — sama pozycja, źródło obok (📍)
            lbl.textContent = '🎙 czytam z ekranu · ' + clock(now) + extra;
        } else {
            // [AGENT-EXP] 2026-11-16: krótko — pozycja, zapas i limit. Licznik „gotowe/wszystkie” tylko tam, gdzie
            // naprawdę jest tłumaczenie (na Netflixie wszystkie kwestie mają tekst, więc 668/668 to szum).
            lbl.textContent = clock(now) + ' · 🔊 zapas ' + mmss(s.aheadEnd - now) + (limitMs > 0 ? ' / ' + mmss(limitMs) : '')
                + (d.noTranslate || narrow ? '' : ' · ' + s.ready + '/' + list.length) + extra;
        }
        var src = null;
        try { src = window.__LektorSched && window.__LektorSched.getSource(); } catch (e) {}
        // [AGENT-EXP] 2026-11-14: widać, że cenzor NAPRAWDĘ tnie — i z czego (plik albo ekran/live)
        // [AGENT-EXP] 2026-11-17: pigułka widoczna ZAWSZE (nie tylko w trakcie cięcia) i mówi, czego brakuje:
        //   plik / live (brak pliku) / live (plik wył.) — bez tego „live” nic nie mówiło o przyczynie.
        // [FIX 2026-11-22] pigułka „🔇 cenzor: plik / live” na filmie WYŁĄCZONA — ten sam stan pokazuje popup
        // (karta „Status”), a na ekranie tylko zasłaniała obraz. Żeby wróciła: CEN_PILL = true.
        var CEN_PILL = false;
        var cen = null;
        try { cen = CEN_PILL ? (window.__LEKTOR_CENSOR__ || null) : null; } catch (e) {}
        if (cen) {
            var cenTxt = '🔇 cenzor: ' + (cen.on ? (cen.cueMode ? 'plik' : 'live (brak pliku)') : 'live (plik wył.)');
            if (cen.muting) cenTxt += ' · tnie';
            cenLbl.textContent = cenTxt;
            cenLbl.style.background = (cen.on && cen.cueMode) ? '#1e7a3c' : '#c0392b';
            cenLbl.style.display = '';
        } else cenLbl.style.display = 'none';
        srcLbl.textContent = src ? '📍 ' + src.name : '';
        srcLbl.style.display = src && !narrow ? '' : 'none';
        // [FIX 2026-11-22] obie etykiety obok siebie: prawa nie wchodzi na lewą
        if (src && !narrow) lbl.style.maxWidth = 'calc(55% - 8px)'; else lbl.style.maxWidth = 'calc(100% - 8px)';
    }
    var tickTimer = setInterval(tick, 500);

    // [FIX 2026-11-16] diagnostyka: w konsoli strony `__lektorBarStatus()` mówi, dlaczego paska nie ma
    // (opcja, karta w tle, brak listy kwestii, czas filmu, za mały obraz), a `__lektorBarSnap()` — co widzi popup.
    window.__lektorBarStatus = function () {
        var d = null;
        try { d = pickAny(); } catch (e) {}
        return {
            on: on,
            shown: !!(box && box.style.display !== 'none'),
            reason: why || 'pasek widoczny',
            live: !!(d && d.live),
            soft: !!(d && d.soft),
            cues: d ? d.list.length : 0,
            video: !!(d && d.video),
            limitMs: limitMs,
            snap: snap()
        };
    };
})();
