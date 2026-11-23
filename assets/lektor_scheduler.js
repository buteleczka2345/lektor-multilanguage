// lektor_scheduler.js — [FIX 2026-11-02] WSPÓLNY harmonogram kwestii lektora.
// Wcześniej każdy skrypt miał własną kopię pętli (YouTube: oś czasu + plik, Netflix, strony DOM / Łowca, „całe napisy”)
// i kopie rozjechały się: okno kwestii i prędkość filmu (auto-nadrabianie, tempo A/B) miał tylko YouTube, ponowne czytanie
// zdania przerwanego pauzą też, a Netflix i pliki na innych stronach potrafiły czytać przy zatrzymanym filmie.
// Teraz jedna implementacja; skrypty podają tylko listę kwestii, klucze / id i swoje haki (licznik, ściszanie, blokady).
// Świat izolowany rozszerzenia (content script) — wczytywany PRZED skryptami lektora (manifest / executeScript).
(function () {
    'use strict';
    if (window.__LektorSched) return;

    var CPS = 14;   // znaki na sekundę polskiej mowy przy tempie 1 (szacunek długości kwestii)
    function estSpeechMs(text) { return String(text || '').length / CPS * 1000; }

    // Okno kwestii (ms czasu rzeczywistego): do początku następnej, najwyżej 2 s po jej końcu (polski bywa dłuższy od
    // oryginału), nie krócej niż koniec samej kwestii; dzielone przez tempo filmu (1,5× = mniej czasu).
    function slotMs(list, i, nowMs, off, rate) {
        var c = list[i], endT = c.endMs + (off || 0), nx = list[i + 1];
        var slotEnd = nx ? Math.min(nx.startMs + (off || 0), endT + 2000) : endT + 2000;
        if (slotEnd < endT) slotEnd = endT;
        return Math.max(400, (slotEnd - nowMs) / (rate > 0 ? rate : 1));
    }

    // Ile nowych zleceń nagrywania do przodu na jeden przebieg: pauza bez „buforuj przy pauzie” → 0;
    // karta w tle → 50 (Chrome zwalnia tam timery do 1 s) albo 0 bez „buforuj w tle”; zwykle 4 (bez skoków obciążenia).
    function budgetFor(video) {
        var hidden = document.visibilityState !== 'visible';
        if (video && video.paused && window.__lektorBufPauza === false) return 0;
        if (hidden) return window.__lektorBufTlo === false ? 0 : 50;
        return 4;
    }
    // Czytamy tylko, gdy film gra na widocznej karcie (w tle i w pauzie — wyłącznie nagrywanie do przodu).
    function canPlay(video) { return !!video && !video.paused && document.visibilityState === 'visible'; }

    function send(cfg, msg) {
        try {
            if (cfg.send) cfg.send(msg);
            else chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; });
        } catch (e) {}
    }
    function withExtra(msg, extra) {
        if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k];
        return msg;
    }

    // Jeden przebieg. cfg:
    //   list (posortowane po startMs), nowMs, off (przesunięcie napisów), rate (tempo filmu), lookaheadMs,
    //   budget (budgetFor), canPlay (canPlay), preroll (ms wcześniej, np. głosy zdalne),
    //   preloaded / played: Set, keyOf(c, i) → klucz w zbiorach (domyślnie c.id), idOf(c, i) → id dla lektora (domyślnie c.id),
    //   ready(c, i) → czy kwestia ma tekst (domyślnie !!c.text), allowPreload(c, i, startT), onPreload(c, i, startT),
    //   onPlay(c, i) → false = nie czytaj (blokada; kwestia zostaje oznaczona jako przeczytana), afterPlay(c, i),
    //   extra (pola dopisywane do każdej wiadomości, np. platform), send(msg).
    // Zwraca, ile zostało z budżetu nagrywania.
    function tick(cfg) {
        var list = cfg.list || [], now = cfg.nowMs, off = cfg.off || 0, look = Math.max(0, cfg.lookaheadMs || 0);
        var budget = cfg.budget || 0, pre = cfg.preroll || 0, rate = cfg.rate > 0 ? cfg.rate : 1;
        for (var i = 0; i < list.length; i++) {
            var c = list[i];
            if (!c) continue;
            var st = c.startMs + off, en = c.endMs + off;
            if (now > en + 1000) continue;
            if (st - pre > now + look) break;
            if (!(cfg.ready ? cfg.ready(c, i) : !!c.text)) continue;
            var key = cfg.keyOf ? cfg.keyOf(c, i) : c.id;
            var id = cfg.idOf ? cfg.idOf(c, i) : c.id;
            if (budget > 0 && !cfg.preloaded.has(key) && st >= now && st <= now + look
                && (!cfg.allowPreload || cfg.allowPreload(c, i, st))) {
                budget--;
                cfg.preloaded.add(key);
                if (cfg.onPreload) cfg.onPreload(c, i, st);
                // slotMs: okno kwestii od jej początku — offscreen ocenia, czy zdanie się zmieści (✂ skracanie)
                send(cfg, withExtra({ action: 'TTS_PRELOAD', id: id, text: c.text, startMs: st, endMs: en, nowMs: now,
                    slotMs: slotMs(list, i, st, off, rate) }, cfg.extra));
            }
            if (cfg.canPlay && !cfg.played.has(key) && now >= st - pre && now < en) {
                cfg.played.add(key);
                if (cfg.onPlay && cfg.onPlay(c, i) === false) continue;
                send(cfg, withExtra({ action: 'TTS_PLAY', id: id, text: c.text, durationMs: c.endMs - c.startMs,
                    startMs: st, endMs: en, rate: rate, slotMs: slotMs(list, i, now, off, rate) }, cfg.extra));
                if (cfg.afterPlay) cfg.afterPlay(c, i);
            }
        }
        return budget;
    }

    // Kwestia przerwana pauzą (bez „Czytaj zawsze do końca”): po wznowieniu czytana od początku — jeśli lektor
    // (ok. 14 znaków/s) nie zdążył jej skończyć przed pauzą. atMs = miejsce pauzy, nowMs = miejsce wznowienia.
    // Zwraca liczbę kwestii przywróconych do czytania.
    function rearmAfterPause(list, played, keyOf, atMs, nowMs, off) {
        if (!(atMs >= 0) || Math.abs(nowMs - atMs) > 1500) return 0;   // przewinięte w czasie pauzy — tym zajmuje się 'seeked'
        var n = 0;
        off = off || 0;
        for (var i = 0; i < (list || []).length; i++) {
            var c = list[i];
            if (!c) continue;
            var st = c.startMs + off, en = c.endMs + off, key = keyOf ? keyOf(c, i) : c.id;
            if (atMs < st || atMs >= en || !played.has(key)) continue;
            if (atMs - st < estSpeechMs(c.text)) { played.delete(key); n++; }
        }
        return n;
    }
    function readToEndOn() {
        try { return !!(window.__LivedubOpts && window.__LivedubOpts.get('readToEnd')); } catch (e) { return false; }
    }

    // [FIX 2026-11-02] „Czytam z: …” — skąd lektor bierze tekst w tej ramce (pasek 📊, arkusz ⚙, popup).
    var source = { name: '', cues: 0, at: 0 };
    function setSource(name, cues) {
        source = { name: String(name || ''), cues: Number(cues) || 0, at: Date.now() };
    }
    function getSource() { return source.name ? source : null; }
    try {
        chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
            if (!msg || msg.action !== 'LEKTOR_SOURCE' || !source.name) return;   // ramka bez źródła milczy — odpowie inna
            sendResponse({ ok: true, source: source.name, cues: source.cues, top: window === window.top });
        });
    } catch (e) {}

    // [FIX 2026-11-02] 🔉 „Ściszaj film tylko, gdy lektor mówi” (popup → Ducking; duckWhileSpeaking, od 3.7.1 domyślnie wł.).
    // Dokument lektora wysyła TTS_SPEAK, gdy NAPRAWDĘ zaczyna mówić, a TTS_QUEUE_IDLE, gdy skończył — film ścisza się
    // na czas mowy i wraca od razu po jej końcu (od 3.7.1 bez 0,4 s czekania). Zmiany głośności płynne (~0,25 s).
    // Skrypty stron: duckAllowed() na początku swojego applyDuck, setVol() zamiast video.volume = …, onDuck(duck, restore).
    // [FIX 2026-11-16] Wcześniej tryb „tylko gdy mówi” nie przywracał głośności, gdy lektor MILCZAŁ: film zostawał
    // na 20% (np. odtwarzacz zapamiętał poziom z poprzedniej sesji, a applyDuck kończyło się na „nie ściszaj” — bez
    // przywrócenia). Teraz stan jest liczony w JEDNYM miejscu (duckApply) i pilnowany co sekundę, także po cichu.
    var duckWhile = false, duckWhileRaw = false, duckInstant = false, speaking = false, holdT = 0, hooks = [], applied = null, speakAt = 0;
    try {
        // [FIX 2026-11-22] v3.7.1: „ściszaj tylko, gdy lektor mówi” jest domyślnie WŁĄCZONE. Jednorazowo (duckWhileMigr371)
        // włączamy je też u osób, które miały dawną domyślną wartość — potem decyduje checkbox w popupie.
        chrome.storage.local.get(['duckWhileSpeaking', 'duckWhileMigr371'], function (r) {
            r = r || {};
            if (!r.duckWhileMigr371) {
                r.duckWhileSpeaking = true;
                try { chrome.storage.local.set({ duckWhileSpeaking: true, duckWhileMigr371: true }); } catch (e) {}
            }
            duckWhileRaw = r.duckWhileSpeaking !== false;
            duckRefresh(true);   // film ma grać pełną głośnością, dopóki lektor nie odezwie się
        });
        // [FIX 2026-11-22] „natychmiast”: bez płynnej zmiany głośności i bez 0,4 s czekania po zakończeniu mowy.
        // [FIX 2026-11-22b] „natychmiast” SAM włącza tryb „tylko gdy lektor mówi” (skokowo). Wcześniej działał tylko
        // razem z trybem płynnym — gdy był zaznaczony sam, film ściszał się na stałe i nie wracał.
        chrome.storage.local.get('duckInstant', function (r) { duckInstant = !!(r && r.duckInstant); duckRefresh(true); });
        chrome.storage.onChanged.addListener(function (ch, a) {
            if (a !== 'local' || (!ch.duckInstant && !ch.duckWhileSpeaking)) return;
            if (ch.duckInstant) duckInstant = !!ch.duckInstant.newValue;
            if (ch.duckWhileSpeaking) duckWhileRaw = !!ch.duckWhileSpeaking.newValue;
            duckRefresh(false);
        });
        chrome.runtime.onMessage.addListener(function (msg) {
            if (!msg || !duckWhile) return;
            if (msg.action === 'TTS_SPEAK') {
                clearTimeout(holdT);
                if (!speaking) { try { console.debug('[Multilektor] ściszanie: lektor zaczął mówić'); } catch (e) {} }
                speaking = true;
                speakAt = Date.now();
                duckApply();
            } else if (msg.action === 'TTS_QUEUE_IDLE') {
                clearTimeout(holdT);
                // [FIX 2026-11-22] głośność wraca od razu po zakończeniu mowy — bez 0,4 s czekania (w obu trybach;
                // w trybie płynnym zaczyna się od razu ~0,25 s płynnego powrotu, w trybie „natychmiast” — skok)
                try { console.debug('[Multilektor] ściszanie: lektor skończył — przywracam głośność'); } catch (e) {}
                speaking = false; duckApply();
            }
        });
        // [FIX 2026-11-16] co sekundę: (1) pilnuj właściwej głośności (lektor milczy → pełna),
        // (2) zgubiony TTS_QUEUE_IDLE (restart silnika) nie zostawia filmu ściszonego na zawsze.
        setInterval(function () {
            if (speaking && Date.now() - speakAt > 20000) speaking = false;
            duckApply();
        }, 1000);
    } catch (e) {}
    // tryb „tylko gdy mówi” = checkbox płynny ALBO checkbox „natychmiast”
    function duckRefresh(force) {
        var nw = duckWhileRaw || duckInstant;
        var changed = nw !== duckWhile;
        duckWhile = nw;
        if (duckWhile) { duckApply(force || changed); return; }
        if (changed) {   // powrót do trybu klasycznego: film ma być ściszony stale — oddajemy głos skryptowi strony
            speaking = false;
            applied = 'duck'; hooks.forEach(function (h) { try { h.duck(); } catch (e) {} });
        }
    }
    function duckApply(force) {
        if (!hooks.length) { applied = null; return; }
        // tryb klasyczny (checkbox wył.): głośnością rządzi skrypt strony — ścisza stale, my nie mieszamy
        if (!duckWhile) { applied = 'duck'; return; }
        var want = (duckWhile && speaking) ? 'duck' : 'restore';
        if (!force && applied === want) return;
        applied = want;
        hooks.forEach(function (h) { try { want === 'duck' ? h.duck() : h.restore(); } catch (e) {} });
    }
    function duckAllowed() { return !duckWhile || speaking; }
    function onDuck(duck, restore) {
        hooks.push({ duck: duck, restore: restore });
        duckApply(true);   // nowy odbiorca od razu dostaje właściwy stan (nie czeka na TTS_SPEAK/IDLE)
    }
    var fades = typeof WeakMap === 'function' ? new WeakMap() : null;
    function setVol(v, target) {
        if (!v) return;
        target = Math.max(0, Math.min(1, Number(target)));
        if (!isFinite(target)) return;
        var run = fades && fades.get(v);
        if (!duckWhile || duckInstant || !fades) { if (run) { clearInterval(run.t); fades.delete(v); } v.volume = target; return; }
        if (run && Math.abs(run.to - target) < 0.005) return;   // już płynie w tę stronę
        if (run) clearInterval(run.t);
        var from = v.volume, n = 0;
        if (Math.abs(from - target) < 0.01) { try { v.volume = target; } catch (e) {} fades.delete(v); return; }
        var t = setInterval(function () {
            n++;
            try { v.volume = from + (target - from) * (n / 10); } catch (e) {}
            if (n >= 10) { clearInterval(t); fades.delete(v); }
        }, 25);
        fades.set(v, { t: t, to: target });
    }

    // [FIX 2026-11-22] Głośność, do której film właśnie PŁYNIE (trwa płynna zmiana) — albo null. Skrypty stron zapamiętują
    // „głośność sprzed ściszenia” z tej wartości, a nie z chwilowej v.volume: lektor odzywał się w połowie powrotu
    // (np. przy 50%), ta połowa zostawała „pierwotną głośnością” i film po każdym zdaniu wracał coraz ciszej.
    function volTarget(v) { var run = v && fades && fades.get(v); return run ? run.to : null; }

    window.__LektorSched = {
        CPS: CPS, estSpeechMs: estSpeechMs, slotMs: slotMs, budgetFor: budgetFor, canPlay: canPlay, tick: tick,
        rearmAfterPause: rearmAfterPause, readToEndOn: readToEndOn, setSource: setSource, getSource: getSource,
        duckAllowed: duckAllowed, onDuck: onDuck, setVol: setVol, volTarget: volTarget, duckWhileOn: function () { return duckWhile; }
    };
})();
