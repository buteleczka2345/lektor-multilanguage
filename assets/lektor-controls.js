// lektor-controls.js
(function () {
    'use strict';
    if (window.__LEKTOR_CONTROLS_JS_RUNNING__) return;
    window.__LEKTOR_CONTROLS_JS_RUNNING__ = true;
    try { if (/^\/embed\//.test(location.pathname)) return; } catch (e) {} // ramka Hover: pasek tylko na topie
    var controls = null, hiddenPill = null, visible = true, speed = 1, offset = 0;
    function updateSpeedDisplay() { var e = document.getElementById('lektor-speed-val'); if (e) e.textContent = speed.toFixed(1) + 'x'; }
    function updateOffsetDisplay() { var e = document.getElementById('lektor-offset-val'); if (e) { var s = offset >= 0 ? '+' : '−'; e.textContent = s + Math.abs(offset) + ' ms'; } }
    function updateTicks() {
        var t = document.getElementById('lektor-controls-ticks');
        if (!t) return;
        var k = t.children;
        for (var i = 0; i < k.length; i++) {
            var h = 3 + (i / k.length) * 11 * speed;
            k[i].style.height = Math.min(14, h) + 'px';
            var b = 0.08 + (i / k.length) * 0.27 * speed;
            k[i].style.background = 'rgba(255,255,255,' + Math.min(0.42, b) + ')';
        }
    }
    function changeSpeed(d) { speed = Math.max(0.5, Math.min(2.0, speed + d)); updateSpeedDisplay(); updateTicks(); try { chrome.storage.local.set({ piperSpeed: speed }); } catch (e) {} }
    function changeOffset(d) { offset = Math.max(-60000, Math.min(60000, offset + d)); updateOffsetDisplay(); window.__LIVEDUB_OFFSET_MS__ = offset; try { chrome.storage.local.set({ subtitleOffsetMs: offset }); } catch (e) {} }
    // ---------------------------------------------------------------------
    // BEZPIECZNE PRZEWIJANIE (fix: crash / błąd odtwarzacza Netflixa)
    //
    // Netflix używa MSE. Seria żądań video.currentTime bez pauzy wywoływana
    // w trakcie „drgnięcia" suwaka (autorepeat przycisku) wywala odtwarzacz
    // („błąd odtwarzacza", crash) — bo każde żądanie wywołuje nowe pobranie
    // segmentu i zerwie SourceBuffer.
    //
    // Zasady:
    //  1) DEBOUNCE — kolejne żądania w krótkim czasie się SĄ sumują w jedno
    //     (nie wysyłamy serii currentTime podczas ruchu suwaka).
    //  2) Pauza wideo przed zmianą currentTime.
    //  3) Odczekiwanie kilkudziesięciu ms (bufor MSE ma się przetworzyć).
    //  4) currentTime ustawiane RAZ, po czym czekamy na 'seeked'
    //     (watchdog, gdyby zdarzenie nie dotarło) i dopiero wtedy play().
    // ---------------------------------------------------------------------
    var IS_NETFLIX = /(^|\.)netflix\.com$/i.test((location.hostname || '').split(':')[0]);
    var SEEK_DEBOUNCE_MS = 180;   // scalanie zadan suwaka/przycisku (debounce)
    var SEEK_PAUSE_MS = 80;       // odczekaj po pause() przed ustawieniem currentTime
    var SEEK_PLAY_MS = 40;        // odczekaj po 'seeked' przed play()
    var SEEK_WATCHDOG_MS = 1500;  // maks. czekanie na 'seeked'
    var seekTimer = null, seekQueue = 0, seekBusy = false;

    // ------------------------------------------------------------------
    // NETFLIX (M7375!): w ogole NIE dotykamy video.currentTime.
    // Netflix ma ochrone licencyjna (Widevine) i aktywnie wykrywa obce
    // modyfikacje osi czasu - nawet JEDEN zapis currentTime wywala blad
    // "M7375" i zatrzymuje film. Skok idzie NATYWNYM API odtwarzacza
    // (to samo, co wlasne strzalki), wstrzyknietym do swiata MAIN jako
    // src/content/netflix_seek_bridge.js.
    // ------------------------------------------------------------------
    var nfReady = false, nfBridgeOk = false, nfMsgId = 0, nfBridgeWarned = false;
    var nfWaiters = {};

    function injectBridge() {
        try {
            var s = document.createElement('script');
            s.src = chrome.runtime.getURL('src/content/netflix_seek_bridge.js');
            s.onload = function () { this.remove(); nfBridgeOk = true; };
            s.onerror = function () { this.remove(); };
            (document.head || document.documentElement).appendChild(s);
        } catch (e) { nfBridgeOk = false; }
    }
    // Wysyla komende do bridge'a. Odpowiedz jest ASYNC, wiec nie blokujemy skoku —
    // czekamy na callback (do diagnostyki) albo na timeout.
    function nfSend(msg, cb, timeoutMs) {
        var id = 'c' + (++nfMsgId);
        if (cb) {
            nfWaiters[id] = cb;
            setTimeout(function () {
                if (nfWaiters[id]) { delete nfWaiters[id]; cb(null); }
            }, timeoutMs || 2500);
        }
        msg.id = id;
        try { window.postMessage(Object.assign({ __LEKTOR_NF_CMD__: true }, msg), window.location.origin); }
        catch (e) { if (cb) cb(null); }
    }
    window.addEventListener('message', function (ev) {
        if (ev.source !== window) return;
        var d = ev.data;
        if (!d || d.__LEKTOR_NF__ !== true) return;
        if (d.replyTo && nfWaiters[d.replyTo]) {
            var cb = nfWaiters[d.replyTo]; delete nfWaiters[d.replyTo];
            cb(d);
        }
    });
    // Skok na Netflixie: zawsze przez pomost w swiecie MAIN (natywne API
    // odtwarzacza -> przycisk UI -> klawisz). ZWRACA true od razu — wynik
    // przychodzi asynchronicznie (pomost dodatkowo weryfikuje, czy pozycja
    // naprawde sie przesunela).
    //(video.currentTime na Netflixie jest W OGOLE zablokowane: wywolywalo M7375)
    function seekViaNetflix(delta) {
        // NIE wymagamy nfBridgeOk: pomost moze byc uruchomiony takze
        // deklaratywnie z manifestu ("world": "MAIN"), a wtedy <script>
        // nie odpala onload. O zyciu pomostu rozstrzyga sama odpowiedz.
        nfSend({ cmd: 'seek', delta: delta }, function (res) {
            if (res && res.ok) { nfReady = true; nfBridgeOk = true; }
            else {
                var why = (res && res.err) ? res.err : 'niepotwierdzony';
                console.warn('[Lektor] Netflix: skok niewykonany (' + why + ') — ' + delta + 's');
            }
        });
        return true;
    }
    function pingNetflix() {
        nfSend({ cmd: 'ping' }, function (res) {
            if (res && res.pong) { nfReady = true; nfBridgeOk = true; }
            else if (!nfBridgeWarned) {
                nfBridgeWarned = true;
                console.warn('[Lektor] Netflix: pomost przewijania nie odpowiada — ' +
                    'przyciski \u25C4/\u25BA nie zadzialaja. Sprawdz, czy w rozszerzeniu ' +
                    'jest plik src/content/netflix_seek_bridge.js');
            }
        }, 3000);
    }
    if (IS_NETFLIX) { injectBridge(); }

    function findVideo() {
        try {
            var list = document.querySelectorAll('video');
            if (!list.length) return null;
            // Netflix trzyma czasem kilka <video> (np. reklama + właściwy) —
            // bierzemy największy widoczny, a nie pierwszy w DOM.
            var best = null, bestArea = -1;
            for (var i = 0; i < list.length; i++) {
                var el = list[i];
                if (el.__lektorAdVideo) continue;
                var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
                var area = r ? (r.width * r.height) : 0;
                if (area > bestArea) { bestArea = area; best = el; }
            }
            return best || list[0];
        } catch (e) { return null; }
    }

    function releaseSeekLock(v, wasPlaying) {
        seekBusy = false;
        if (wasPlaying) {
            try { var p = v.play(); if (p && p.catch) p.catch(function () {}); } catch (e2) {}
        }
        // Jeśli w trakcie oczekiwania doszły nowe żądania — wykonaj je teraz.
        if (seekQueue) flushSeek();
    }

    function doSeek(delta) {
        var v = findVideo();
        if (!v) { seekBusy = false; return; }
        var wasPlaying = !v.paused && !v.ended;
        var dur = (typeof v.duration === 'number' && isFinite(v.duration)) ? v.duration : null;
        var target = v.currentTime + delta;
        if (target < 0) target = 0;
        if (dur !== null && target > dur - 0.25) target = Math.max(0, dur - 0.25);

        // 1) Pauza przed zmianą pozycji.
        try { if (!v.paused) v.pause(); } catch (e1) {}

        // 2) Odczekaj, aż odtwarzacz przetworzy stan po pauzie.
        setTimeout(function () {
            // 3) Jedyne żądanie currentTime (zawoalizowane w seekQueue).
            var settled = false;
            var onSeeked = function () {
                if (settled) return;
                settled = true;
                try { v.removeEventListener('seeked', onSeeked); } catch (e2) {}
                clearTimeout(watchdog);
                // 4) Krótka chwila stabilizacji, potem play().
                setTimeout(function () { releaseSeekLock(v, wasPlaying); }, SEEK_PLAY_MS);
            };
            var watchdog = setTimeout(onSeeked, SEEK_WATCHDOG_MS);
            try { v.addEventListener('seeked', onSeeked); } catch (e3) {}
            try { v.currentTime = target; } catch (e4) { clearTimeout(watchdog); releaseSeekLock(v, wasPlaying); }
        }, SEEK_PAUSE_MS);
    }

    function flushSeek() {
        // Trwa poprzedni seek — NIE wysyłamy kolejnego currentTime, tylko
        // czekamy na jego zakończenie (żądania zostają w kolejce).
        if (seekBusy) {
            if (seekTimer) clearTimeout(seekTimer);
            seekTimer = setTimeout(function () { seekTimer = null; flushSeek(); }, SEEK_DEBOUNCE_MS);
            return;
        }
        var delta = seekQueue;
        seekQueue = 0;
        if (!delta) return;

        // --- NETFLIX: natywne API odtwarzacza (jedyne bezpieczne wejscie) ---
        if (IS_NETFLIX) {
            // Ścieżka 'currentTime' poniżej jest na Netflixie ZABLOKOWANA,
            // bo zwykly zapis wywala odtwarzacz bledem M7375.
            seekViaNetflix(delta);
            seekBusy = true;
            // Skok to teleport (nie zmiana bufora MSE), wiec odtwarzacz
            // jest gotowy szybko. Blokada musi byc KRÓTSZA niz debounce
            // (SEEK_DEBOUNCE_MS), inaczej kolejne klikniecia nigdy nie
            // przejdą (kolejka utknie na blokadzie).
            setTimeout(function () { releaseBridgeLock(); }, 120);
            return;
        }
        seekBusy = true;
        doSeek(delta);
    }
    // Po skoku teleportem odblokowujemy kolejkę (Netflix sam zgłasza 'seeked').
    function releaseBridgeLock() { seekBusy = false; if (seekQueue) flushSeek(); }

    var SEEK_MAX_QUEUE = 5;  // w kolejce może czekać najwyżej JEDEN krok (5 s)
    // Zbiera żądania w trakcie ruchu suwaka/przytrzymania przycisku.
    function requestSeek(delta) {
        // Kolejka jest OGRANICZONA do jednego kroku: przytrzymanie przycisku
        // nie może uzbierać wielosekundowego „skoku" na końcu (i w ten sposób
        // zwiększamy liczbę zgłoszeń 'seeked', które pcha MSE Netflixa).
        seekQueue = Math.max(-SEEK_MAX_QUEUE, Math.min(SEEK_MAX_QUEUE, seekQueue + delta));
        // Podczas trwajacego seeku (seekBusy) NIE kasujemy timera — kolejka musi
        // sie scalic do jednego skoku, a nie byc wywolywana co pauza.
        if (seekBusy) return;
        if (seekTimer) clearTimeout(seekTimer);
        seekTimer = setTimeout(function () {
            seekTimer = null;
            flushSeek();
        }, SEEK_DEBOUNCE_MS);
    }
    // Debounce + kolejka + bezpieczny seek (pauza -> przerwa -> currentTime -> play).
    function seekVideo(s) { try { requestSeek(s); } catch (e) {} }
    // --- Bramka rate-limit: 1 skok co 200 ms (maks 5 operacji/s) ---
    var lastSeekAt = 0;
    function safeSeek(seconds) {
        var now = Date.now();
        if (now - lastSeekAt < 200) return false;
        lastSeekAt = now;
        seekVideo(seconds);
        return true;
    }
    // Komendy z popupu / background (action: 'seek', {seconds: 5}).
    try {
        if (chrome.runtime && chrome.runtime.onMessage) {
            chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
                if (message && message.action === 'seek') {
                    var ok = safeSeek(Number(message.seconds) || 0);
                    try { sendResponse({ status: ok ? 'ok' : 'throttled', seconds: message.seconds }); } catch (e) {}
                }
                return true;
            });
        }
    } catch (e2) {}
    // Przycisk ◄ / ►: pierwsze kliknięcie działa natychmiast, trzymanie powtarza
    // seek co HOLD_REPEAT_MS — ale KAŻDE powtórzenie przechodzi przez kolejkę
    // i debounce, więc do odtwarzacza nigdy nie leci seria currentTime.
    var HOLD_REPEAT_MS = 320, HOLD_DELAY_MS = 420;
    function mkSeekBtn(label, title, delta) {
        var b = document.createElement('button');
        b.type = 'button'; b.textContent = label; b.title = title;
        b.style.cssText = 'background:rgba(255,255,255,0.12);color:#eee;border:1px solid rgba(255,255,255,0.2);border-radius:5px;padding:2px 8px;font:12px system-ui,sans-serif;cursor:pointer;';
        var holdTimer = null, repTimer = null, fromPointer = false;
        function stop() {
            if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
            if (repTimer) { clearInterval(repTimer); repTimer = null; }
            document.removeEventListener('mouseup', stop);
            document.removeEventListener('mouseleave', stop);
        }
        b.addEventListener('click', function () {
            // 'click' po mousedown/Enter jest DUPLIKATEM — ten seek już wykonaliśmy.
            if (fromPointer) { fromPointer = false; return; }
            seekVideo(delta);
        });
        b.addEventListener('mousedown', function (ev) {
            if (ev.button !== 0) return;
            // Przytrzymanie: click zostanie zjedzony (fromPointer), powtarzamy seekVideo.
            ev.preventDefault();
            fromPointer = true;
            seekVideo(delta);
            holdTimer = setTimeout(function () {
                repTimer = setInterval(function () { seekVideo(delta); }, HOLD_REPEAT_MS);
            }, HOLD_DELAY_MS);
            document.addEventListener('mouseup', stop);
            document.addEventListener('mouseleave', stop);
        });
        b.addEventListener('keydown', function (ev) {
            if (ev.key !== 'Enter' && ev.key !== ' ') return;
            if (ev.repeat) return; // autorepeat klawiatury: ignorujemy (seria żądań)
            ev.preventDefault();
            fromPointer = true;   // 'click' po Enterze/spacji jest duplikatem
            seekVideo(delta);
        });
        b.addEventListener('keyup', function () { fromPointer = false; });
        b.addEventListener('blur', function () { fromPointer = false; stop(); });
        return b;
    }
    function setVisible(v) { visible = v; try { chrome.storage.local.set({ lektorControlsVisible: v }); } catch (e) {} applyVisibility(); }
    function applyVisibility() { if (controls) controls.style.display = visible ? 'flex' : 'none'; if (hiddenPill) hiddenPill.style.display = visible ? 'none' : 'flex'; }
    function mkBtn(l, t, cb) { var b = document.createElement('button'); b.type = 'button'; b.textContent = l; b.title = t; b.style.cssText = 'background:rgba(255,255,255,0.12);color:#eee;border:1px solid rgba(255,255,255,0.2);border-radius:5px;padding:2px 8px;font:12px system-ui,sans-serif;cursor:pointer;'; b.addEventListener('click', cb); return b; }
    function ensureControls() {
        if (controls && controls.isConnected) return controls;
        var root = document.body || document.documentElement;
        if (!root) return null;
        controls = document.createElement('div');
        controls.id = 'lektor-controls-bar';
        controls.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147483647;display:flex;flex-direction:column;gap:3px;';
        var ticks = document.createElement('div');
        ticks.id = 'lektor-controls-ticks';
        ticks.style.cssText = 'display:flex;gap:3px;align-items:flex-end;height:14px;padding:0 6px;';
        for (var i = 0; i < 14; i++) { var t = document.createElement('div'); t.style.cssText = 'width:2px;background:rgba(255,255,255,0.12);border-radius:1px;transition:height .2s,background .2s;'; ticks.appendChild(t); }
        controls.appendChild(ticks);
        var offRow = document.createElement('div');
        offRow.style.cssText = 'display:flex;align-items:center;gap:3px;background:rgba(14,14,18,0.96);border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:3px 6px;';
        offRow.appendChild(mkBtn('−1s', 'Cofnij lektora o 1 s', function () { changeOffset(-1000); }));
        offRow.appendChild(mkBtn('−100', 'Cofnij lektora o 100 ms', function () { changeOffset(-100); }));
        var oe = document.createElement('span'); oe.id = 'lektor-offset-val'; oe.style.cssText = 'font:bold 11px system-ui,sans-serif;color:#ffd;min-width:55px;text-align:center;'; offRow.appendChild(oe);
        offRow.appendChild(mkBtn('+100', 'Przesuń lektora o 100 ms', function () { changeOffset(100); }));
        offRow.appendChild(mkBtn('+1s', 'Przesuń lektora o 1 s', function () { changeOffset(1000); }));
        controls.appendChild(offRow);
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:4px;background:rgba(14,14,18,0.96);border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:3px 6px;';
        row.appendChild(mkSeekBtn('◄', 'Cofnij wideo o 5 s (przytrzymaj = przewijaj)', -5));
        row.appendChild(mkBtn('−', 'Wolniej', function () { changeSpeed(-0.1); }));
        var se = document.createElement('span'); se.id = 'lektor-speed-val'; se.style.cssText = 'font:bold 14px system-ui,sans-serif;color:#7ee0ff;min-width:40px;text-align:center;'; row.appendChild(se);
        row.appendChild(mkBtn('+', 'Szybciej', function () { changeSpeed(0.1); }));
        row.appendChild(mkSeekBtn('►', 'Przewiń wideo o 5 s (przytrzymaj = przewijaj)', 5));
        var hb = mkBtn('─', 'Schowaj', function () { setVisible(false); }); hb.style.marginLeft = 'auto'; row.appendChild(hb);
        controls.appendChild(row);
        root.appendChild(controls);
        hiddenPill = document.createElement('button'); hiddenPill.textContent = '🎤'; hiddenPill.type = 'button'; hiddenPill.title = 'Pokaż pasek'; hiddenPill.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147483647;display:none;align-items:center;background:rgba(14,14,18,0.96);color:#eee;border:1px solid rgba(255,255,255,0.2);border-radius:999px;padding:5px 12px;font:11px system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,0.4);';
        hiddenPill.addEventListener('click', function () { setVisible(true); });
        root.appendChild(hiddenPill);
        chrome.storage.local.get(['piperSpeed', 'lektorControlsVisible', 'subtitleOffsetMs'], function (r) { speed = Number(r && r.piperSpeed) || 1; if (r.lektorControlsVisible !== undefined) visible = !!r.lektorControlsVisible; offset = (typeof r.subtitleOffsetMs === 'number') ? r.subtitleOffsetMs : 0; window.__LIVEDUB_OFFSET_MS__ = offset; updateSpeedDisplay(); updateOffsetDisplay(); updateTicks(); applyVisibility(); });
        chrome.storage.onChanged.addListener(function (c, a) { if (a !== 'local') return; if (c.piperSpeed) { speed = Number(c.piperSpeed.newValue) || 1; updateSpeedDisplay(); updateTicks(); } if (c.lektorControlsVisible) { visible = !!c.lektorControlsVisible.newValue; applyVisibility(); } if (c.subtitleOffsetMs !== undefined) { offset = Number(c.subtitleOffsetMs.newValue) || 0; window.__LIVEDUB_OFFSET_MS__ = offset; updateOffsetDisplay(); } });
        return controls;
    }
    if (document.body) ensureControls(); else document.addEventListener('DOMContentLoaded', ensureControls);
    // Wykrycie API odtwarzacza Netflixa (diagnostyka + ustawienie nfReady).
    if (IS_NETFLIX) { pingNetflix(); setTimeout(pingNetflix, 3000); }
})();
