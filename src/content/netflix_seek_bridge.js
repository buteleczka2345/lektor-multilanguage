// ===========================================================================
// netflix_seek_bridge.js — bezpieczne przewijanie NETFLIX (fix M7375)
// Wstrzykiwany do świata MAIN (tam żyje netflix.appContext), bo content
// script działa w świecie izolowanym i NIE WIDZI globalnej zmiennej `netflix`.
//
// DLACZEGO NIE `video.currentTime`?
// Netflix chroni odtwarzanie licencyjne (Widevine) i aktywnie wykrywa obce
// modyfikacje osi czasu. Bezpośredni zapis `video.currentTime` wyzwala
// wewnętrzny alarm: odtwarzacz wywala "M7375" (Encountered an Unexpected
// Error) i zatrzymuje film — nawet przy JEDNYM skoku o 5 s.
//
// ROZWIĄZANIE: przewijamy NATYWNYM API odtwarzacza Netflixa (to samo, którym
// posługuje się własna skipka strzałkami):
//   netflix.appContext.state.playerApp.getAPI().videoPlayer
//     .getAllPlayerSessionIds() -> getVideoPlayerBySessionId(id)
//       .seek(t)  .getCurrentTime()  .getDuration()
// Dzięki temu Netflix traktuje skok jako swoją własną akcję (teleport),
// a nie jako atak na DRM. Komunikacja: window.postMessage.
// ===========================================================================
(function () {
    'use strict';
    if (window.__LEKTOR_NF_BRIDGE__) return;
    window.__LEKTOR_NF_BRIDGE__ = true;

    function getVideoPlayerAPI() {
        try {
            var app = window.netflix && window.netflix.appContext;
            if (!app || !app.state || !app.state.playerApp) return null;
            var api = app.state.playerApp.getAPI();
            return (api && api.videoPlayer) || null;
        } catch (e) { return null; }
    }

    // Czasem getAPI() zwraca Promise (nowsze wersje Netflixa).
    // UWAGA: gdy API w ogole nie ma, i tak wywolujemy cb(null) — dzieki temu
    // dzialaja warstwy zapasowe (przycisk skip / klawisz).
    function resolveVideoPlayerAPI(cb) {
        try {
            var r = getVideoPlayerAPI();
            if (r && typeof r.getAllPlayerSessionIds === 'function') { cb(r); return; }
            var app = window.netflix && window.netflix.appContext;
            var p = app && app.state && app.state.playerApp && app.state.playerApp.getAPI();
            if (p && typeof p.then === 'function') {
                p.then(function (api) { cb((api && api.videoPlayer) || null); })
                    .catch(function () { cb(null); });
                return;
            }
            cb(null);
        } catch (e) { cb(null); }
    }

    // Wybiera właściwą instancję odtwarzacza (ta, która NAPRAWDĘ gra film).
    // Sama długość nie wystarcza: przy reklamie i kilku sesjach lepiej
    // porównać pozycję sesji z pozycją <video> — to najpewniejszy sygnał,
    // że trafiliśmy w aktywny odtwarzacz (inaczej seek idzie w pustkę).
    function pickPlayer(vp) {
        try {
            if (!vp || typeof vp.getAllPlayerSessionIds !== 'function') return null;
            var ids = vp.getAllPlayerSessionIds() || [];
            if (!ids.length) return null;
            if (ids.length === 1) return vp.getVideoPlayerBySessionId(ids[0]);

            var v = videoEl();
            // Pozycja <video> jest punktem odniesienia tylko, gdy film juz leci
            // (przy zerze wszystkie sesje wygladaja tak samo).
            var usePos = !!(v && isFinite(Number(v.currentTime)) && Number(v.currentTime) > 0);
            var vSec = usePos ? Number(v.currentTime) : 0;
            var vPaused = (v && typeof v.paused === 'boolean') ? v.paused : null;

            var best = null, bestScore = -Infinity;
            for (var i = 0; i < ids.length; i++) {
                var p = null;
                try { p = vp.getVideoPlayerBySessionId(ids[i]); } catch (e1) { continue; }
                if (!p) continue;
                var U = 1, cur = 0, durSec = 0, pausedOk = 0;
                try { U = unitsOf(p); } catch (e2) {}
                try { cur = Number(p.getCurrentTime && p.getCurrentTime()) || 0; } catch (e3) {}
                try { durSec = (Number(p.getDuration && p.getDuration()) || 0) / U; } catch (e4) {}
                if (usePos && vPaused !== null && typeof p.getPaused === 'function') {
                    try { pausedOk = (!!p.getPaused() === vPaused) ? 1 : 0; } catch (e5) {}
                }
                // Zgodnosc pozycji (w sekundach) decyduje; dluzszy material i
                // zgodny stan pauzy to tylko rozstrzygniecie remisow.
                var score = usePos ? (-Math.abs(cur - vSec * U) / 1000) : 0;
                score += Math.min(durSec, 7200) / 10000;
                score += pausedOk * 0.5;
                if (score > bestScore) { bestScore = score; best = p; }
            }
            return best || vp.getVideoPlayerBySessionId(ids[0]);
        } catch (e) { return null; }
    }

    function post(msg) {
        try { window.postMessage(Object.assign({ __LEKTOR_NF__: true }, msg), window.location.origin); } catch (e) {}
    }

    // ------------------------------------------------------------------
    // JEDNOSTKI CZASU — to byla PRZYCZYNA "zaciecia bez przewijania".
    // Netflix liczy czas w MILISEKUNDACH: player.getCurrentTime() zwraca ms
    // i player.seek() OCZEKUJE ms. Poprzednia wersja dodawala delte w
    // sekundach (cur + 5), co dla odtwarzacza znaczy "przesun o 5 MILISEKUND"
    // — wykonywal on mikro-seek (chwilowe zacięcie), a obraz stal w miejscu.
    // Teraz cel liczymy w SEKUNDACH (tak jak HTML5 <video>), a potem
    // przeliczamy na jednostki odtwarzacza.
    // ------------------------------------------------------------------
    // Najwiekszy widoczny <video> (Netflix trzyma czasem dwa: reklama + film).
    function videoEl() {
        try {
            var vs = document.querySelectorAll('video');
            var best = null, bestArea = -1;
            for (var i = 0; i < vs.length; i++) {
                var el = vs[i];
                var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
                var area = r ? (r.width * r.height) : 0;
                if (area > bestArea) { bestArea = area; best = el; }
            }
            return best || vs[0] || null;
        } catch (e) { return null; }
    }

    // Ile jednostek odtwarzacza przypada na 1 sekunde (Netflix: 1000 = ms).
    // Ustalamy empirycznie: dlugosc z API / dlugosc z <video> (HTML5 = sekundy).
    // Gdy nie da sie ustalic — domyslnie ms (tak dziala Netflix od lat).
    function unitsOf(player) {
        try {
            var pd = Number(player.getDuration && player.getDuration()) || 0;
            var v = videoEl();
            var vd = v ? Number(v.duration) : 0;
            if (pd > 0 && isFinite(vd) && vd > 1) {
                var ratio = pd / vd;
                if (ratio > 100) return 1000;   // milisekundy
                if (ratio < 10) return 1;       // sekundy (nietypowe/starsze API)
            }
        } catch (e) {}
        return 1000;
    }

    // Krotkie ostrzezenie na stronie — TYLKO gdy skok sie nie udal, zeby
    // dalo sie to zauwazyc bez zagladania w konsole (F12).
    function toast(msg) {
        try {
            var t = document.getElementById('lektor-nf-toast');
            if (!t) {
                t = document.createElement('div');
                t.id = 'lektor-nf-toast';
                t.style.cssText = 'position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:2147483647;background:rgba(160,25,25,0.95);color:#fff;border-radius:8px;padding:8px 14px;font:13px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,0.5);pointer-events:none;';
                (document.body || document.documentElement).appendChild(t);
            }
            t.textContent = msg;
            t.style.display = 'block';
            if (toast._t) clearTimeout(toast._t);
            toast._t = setTimeout(function () { t.style.display = 'none'; }, 4000);
        } catch (e) {}
    }

    // ------------------------------------------------------------------
    // Warstwa 2: klik natywnego przycisku skoku Netflixa (+/-10 s).
    // To przycisk UI odtwarzacza, wiec Netflix traktuje skok jak wlasna akcje.
    // UWAGA: atrybuty data-uia zmieniaja sie miedzy wersjami Netflixa, dlatego
    // najpierw probujemy znane selektory, a potem SKANUJEMY widoczne przyciski
    // odtwarzacza (data-uia / aria-label zawiera "przod|tył" i "10").
    // ------------------------------------------------------------------
    var SKIP_SEL_FWD = ['[data-uia="control-forward-10"]', '[data-uia="seek-forward-10"]',
        '[data-uia="player-skip-forward"]', '[data-uia="control-forward"]'];
    var SKIP_SEL_BACK = ['[data-uia="control-backward-10"]', '[data-uia="seek-backward-10"]',
        '[data-uia="player-skip-backward"]', '[data-uia="control-backward"]'];
    function isVisible(el) {
        try {
            return !!(el && (el.offsetWidth || el.offsetHeight ||
                (el.getClientRects && el.getClientRects().length)));
        } catch (e) { return false; }
    }
    function clickNativeSkip(dir) {
        try {
            var list = dir > 0 ? SKIP_SEL_FWD : SKIP_SEL_BACK;
            for (var i = 0; i < list.length; i++) {
                var b = document.querySelector(list[i]);
                if (b && isVisible(b)) { b.click(); return true; }
            }
            // Skan awaryjny: etykiety sa zlokalizowane, wiec szukamy slow kluczowych.
            var re = dir > 0 ? /(forward|naprzód|naprzod|do przodu|przewiń w przód)/i
                : /(backward|rewind|wstecz|do tyłu|do tylu|cofnij)/i;
            var all = document.querySelectorAll('button,[role="button"]');
            for (var j = 0; j < all.length; j++) {
                var el = all[j];
                var tag = (el.getAttribute('data-uia') || '') + ' ' +
                    (el.getAttribute('aria-label') || '') + ' ' + (el.title || '');
                if (/10/.test(tag) && re.test(tag) && isVisible(el)) { el.click(); return true; }
            }
            return false;
        } catch (e) { return false; }
    }

    // ------------------------------------------------------------------
    // Warstwa 3: symulacja klawiszy (ArrowLeft/ArrowRight = +/-10 s).
    // UWAGA: syntetyczny KeyboardEvent ma isTrusted === false, wiec Netflix
    // czesto go IGNORUJE. Traktujemy to jako awaryjna, ostatnia warstwe.
    // Zdarzenie dispatchujemy na `document` — babelkuje do `window`, wiec
    // lapia je oba warianty nasluchu odtwarzacza.
    // ------------------------------------------------------------------
    function simulateKeySeek(dir) {
        try {
            var key = dir > 0 ? 'ArrowRight' : 'ArrowLeft';
            var keyCode = dir > 0 ? 39 : 37;
            var opts = {
                key: key, code: key, keyCode: keyCode, which: keyCode,
                bubbles: true, cancelable: true
            };
            document.dispatchEvent(new KeyboardEvent('keydown', opts));
            setTimeout(function () { document.dispatchEvent(new KeyboardEvent('keyup', opts)); }, 50);
            return true;
        } catch (e) { return false; }
    }

    // Skoki natywnymi przyciskami/klawiszami idą po 10 s, wiec krok = 10 s.
    var SKIP_STEP = 10;

    // Warstwa 1: natywne API odtwarzacza z POPRAWNA konwersja jednostek
    // (sekundy -> ms) i weryfikacja, ze pozycja naprawde sie zmienila.
    // Zwraca true, jesli seek zostal zlecony (odpowiedz idzie asynchronicznie),
    // albo false, gdy trzeba uzyc warstw zapasowych.
    var VERIFY_AFTER_MS = 450;
    function apiSeek(player, deltaSec, replyTo) {
        var U = unitsOf(player);                       // 1000 = ms, 1 = s
        var v = videoEl();
        var beforeP = Number(player.getCurrentTime && player.getCurrentTime()) || 0;
        var beforeSec = v ? (Number(v.currentTime) || 0) : beforeP / U;
        var durP = Number(player.getDuration && player.getDuration()) || 0;
        var eps = (U === 1000) ? 500 : 0.5;            // 0.5 s w jednostkach API

        // *** KLUCZOWA LINIA *** delta jest w SEKUNDACH, wiec mnozymy ja
        // przez U. Bez tego seek dostawal "+5" w ms, czyli 5 milisekund.
        var targetP = beforeP + Number(deltaSec) * U;
        if (targetP < 0) targetP = 0;
        if (durP > 0 && targetP > durP - eps) targetP = Math.max(0, durP - eps);
        var targetSec = targetP / U;

        try { player.seek(targetP); } catch (e) { return false; }

        setTimeout(function () {
            var afterSec;
            try {
                afterSec = v ? (Number(v.currentTime) || 0)
                    : (Number(player.getCurrentTime && player.getCurrentTime()) || 0) / U;
            } catch (e) { afterSec = targetSec; }
            var moved = Math.abs(afterSec - beforeSec);
            var near = Math.abs(afterSec - targetSec) <= 2.5;
            var okMove = near || moved >= Math.max(1, Math.abs(Number(deltaSec)) * 0.5);
            post({
                replyTo: replyTo, ok: okMove, via: 'api', unit: U,
                from: beforeSec, to: afterSec, want: targetSec
            });
            if (!okMove) {
                console.warn('[Lektor] Netflix: seek API nie zadzialal (jednostka=' + U + ', ' +
                    beforeSec.toFixed(2) + 's -> ' + afterSec.toFixed(2) + 's, chciano ' +
                    targetSec.toFixed(2) + 's) — Netflix zmienil API?');
                toast('Lektor: przewijanie nie zadzialalo (Netflix zmienil API?)');
            }
        }, VERIFY_AFTER_MS);
        return true;
    }

    function doSeek(deltaSec, replyTo) {
        resolveVideoPlayerAPI(function (vp) {
            var player = pickPlayer(vp);
            // --- Warstwa 1: wlasne API odtwarzacza (najlepsza) ---
            if (player && typeof player.seek === 'function') {
                if (apiSeek(player, deltaSec, replyTo)) return;
            }
            // --- Warstwa 2/3: natywne UI (przycisk skoku -> klawisz) ---
            var dir = Number(deltaSec) >= 0 ? 1 : -1;
            var steps = Math.max(1, Math.round(Math.abs(Number(deltaSec)) / SKIP_STEP));
            var done = 0, usedKey = false;
            function step() {
                var ok = clickNativeSkip(dir);
                if (!ok) { ok = simulateKeySeek(dir); usedKey = true; }
                done++;
                if (!ok) {
                    post({ replyTo: replyTo, ok: false, err: 'no-native-ui' });
                    console.warn('[Lektor] Netflix: brak API odtwarzacza i brak natywnych ' +
                        'przyciskow skoku — przewijanie niemozliwe');
                    toast('Lektor: przewijanie nie dziala (brak API odtwarzacza)');
                    return;
                }
                // Ograniczenie: >=130 ms miedzy krokami (maks 5 operacji/s).
                if (done < steps) setTimeout(step, 130);
                else post({ replyTo: replyTo, ok: true, via: usedKey ? 'key' : 'native', steps: done });
            }
            step();
        });
    }
    // Nasłuch poleceń z content scriptu (lektor-controls.js).
    window.addEventListener('message', function (ev) {
        if (ev.source !== window) return;
        var d = ev.data;
        if (!d || d.__LEKTOR_NF_CMD__ !== true) return;
        if (d.cmd === 'ping') {
            // Sprawdzenie, czy API odtwarzacza jest dostępne (i jaki jest czas/długość).
            resolveVideoPlayerAPI(function (vp) {
                var player = pickPlayer(vp);
                var info = { ok: !!player, cur: 0, dur: 0, unit: 0, durSec: 0 };
                if (player) {
                    try {
                        info.unit = unitsOf(player);
                        if (player.getCurrentTime) info.cur = Number(player.getCurrentTime()) || 0;
                        if (player.getDuration) info.dur = Number(player.getDuration()) || 0;
                        info.durSec = info.dur / (info.unit || 1);
                    } catch (e) {}
                }
                post({ replyTo: d.id, pong: info });
            });
        } else if (d.cmd === 'seek') {
            // Skaz zwraca potwierdzenie do content scriptu (replyTo),
            // zeby ten mogl zdiagnozowac sytuacje "brak API i brak UI".
            doSeek(Number(d.delta) || 0, d.id);
        }
    });
})();
