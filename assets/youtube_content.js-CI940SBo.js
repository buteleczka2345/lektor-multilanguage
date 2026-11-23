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
// youtube_content.js — Live-Dubbing content script (tylko Piper, lektor z Immersive Translate)
// =========================================================================================
// KANAŁY LEKTORA (wszystkie czytają WYŁĄCZNIE z Immersive Translate, chyba że napisano inaczej):
//
//  [STRONA GŁÓWNA]  napisy IMT przy głównym odtwarzaczu → live, offset ⚙ działa, plik ma priorytet.
//  [HOVER NATYWNY]  napisy IMT w kontenerze ytd-inline-preview-renderer / #inline-preview-player /
//                   ytd-video-preview → zawsze live, bez offsetu, plik go nie blokuje.
//  [EMBED /embed/]  RAMKA z userscripta "YouTube on Hover Preview" (pływające okienko).
//                   Skrypt wstrzykuje się do ramki (all_frames). W ramce:
//                   - wideo ramki jest WYCISZANE (oryginał EN nie gryzie się z lektorem),
//                   - czyta OŚ CZASU (timedtext json3 + tlang=pl) — idealna synchronizacja,
//                   - fallback: live IMT w ramce, gdy oś czasu niedostępna,
//                   - strona GŁÓWNA dostaje postMessage → ducking głównego filmu na czas kwestii.
//
//  USE_TIMEDTEXT = false → na stronie głównej oś czasu ZGASZONA (kod zostaje na potrzeby embedu).
//
//  DEBUG (zwykła konsola F12 na youtube.com — atrybuty DOM są wspólne dla światów):
//    document.documentElement.getAttribute('data-livedub-loaded')  → "1" = plik żyje
//    document.documentElement.getAttribute('data-livedub-mode')    → "page" | "embed"
//    document.documentElement.getAttribute('data-livedub-src')     → np. "MH" (main+hover), "EMBM"
//    window.__LIVEDUB_DEBUG_SOURCES__() → { main, hover }
// =========================================================================================
(function () {
    'use strict';

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


    // === Sonda: znacznik życia pliku (widoczny ze zwykłej konsoli) ===
    try { document.documentElement.setAttribute('data-livedub-loaded', '1'); } catch (e) {}

    // === EMBED: czy to ramka podglądu userscripta (/embed/<ID>)? ===
    var IS_EMBED = /^\/embed\//.test(location.pathname);
    try { document.documentElement.setAttribute('data-livedub-mode', IS_EMBED ? 'embed' : 'page'); } catch (e) {}

    // =========================================================================
    // SELEKTORY IMMERSIVE TRANSLATE
    // =========================================================================
    var TARGET_BASE = ['.imt-captions-text', '.imt-cue', '[class*="imt-"]', '[class*="immersive-translate"]'];
    var TARGET_SELECTORS = TARGET_BASE.slice(); // + selektory z Kreatora napisów (OPTIONS-PAGE)
    var ORIGIN_SELECTORS = ['.immersive-translate-origin-text', '[data-immersive-translate-translation-element="origin"]', '[class*="imt-origin"]'];
    var ORIGIN_GROUP = ORIGIN_SELECTORS.join(',');
    var JUNK_PHRASES = ['Immersive Translate', 'Google Translate', 'DeepL Translate', 'Translated by', 'Włącz tłumaczenie napisów', 'Click to translate', 'Przełącz tłumaczenie', 'Tłumaczenie napisów', 'Download subtitle translation', 'Download subtitles', 'Download subtitle', 'Subtitle translation'];

    // =========================================================================
    // === HOVER (Wariant A): konfiguracja kanału podglądu natywnego ===
    // =========================================================================
    var HOVER_CONTAINER_SEL = 'ytd-inline-preview-renderer, #inline-preview-player, ytd-video-preview';
    // UWAGA: osobna lista dla <video> (sklejanie z przecinkami źle wiąże potomka):
    var HOVER_VIDEO_SEL = 'ytd-inline-preview-renderer video, #inline-preview-player video, ytd-video-preview video';
    var HOVER_INTERRUPT = true;      // kwestia hover przerywa bieżącą wypowiedź (TTS_CLEAR_BUFFER, globalne!)
    var ytAutoOn = false, ytSourcePref = 'imt';
    // [AGENT-EXP] 2026-11-14: wspólny przełącznik „Tylko z ekranu (Immersive Translate)” — ten sam na każdej platformie.
    // Gdy włączony, YouTube czyta tłumaczenie IT z ekranu (nie własne SRT) — chyba że sam naciśniesz ⬇ dla tego filmu.
    var subScreenOnly = false;
    try {
        chrome.storage.local.get('primeSubtitleSource', function (r) {
            subScreenOnly = !!r && (r.primeSubtitleSource === 'immersive' || r.primeSubtitleSource === 'native');
        });
        chrome.storage.onChanged.addListener(function (ch, a) {
            if (a !== 'local' || !ch.primeSubtitleSource) return;
            var v = ch.primeSubtitleSource.newValue;
            subScreenOnly = v === 'immersive' || v === 'native';
        });
    } catch (e) {} // ytAuto (checkbox w popupie) włącza własne napisy na YouTube bez Immersive Translate
    // NA ŻĄDANIE: przycisk w popupie pobiera całe napisy TYLKO dla bieżącego filmu (id filmu).
    // Domyślnie: czytanie w locie z Immersive Translate, bez pobierania całych napisów.
    var onDemandVid = '';
    function calcTimedtext() {
        // [AGENT-EXP] 2026-11-14: YouTube jak HBO/Netflix — napisy ściągają się SAME przy każdym filmie,
        // także przy „Tylko Immersive Translate” i przy wyłączonym lektorze (pliku potrzebuje cenzor).
        // Czy lektor z nich czyta, decyduje osobno subScreenOnly (niżej w pętli osi czasu).
        return !!ttGetVideoId();
    }
    var USE_TIMEDTEXT = false;       // ytSource='auto': własne napisy (SRT) + Translator Chrome; 'imt' (domyślnie): tylko Immersive Translate. EMBED: oś czasu zawsze.
    var HOVER_MIN_INTERVAL_MS = 120; // anty-"karabin" przy szybkich zmianach napisów w podglądzie

    var lastMainSubtitle = '', lastHoverSubtitle = '';
    var mainDebounceTimer = null, hoverDebounceTimer = null;
    var lastHoverPlayAt = 0;

    // ===== Blokowane frazy =====
    var BLOCKED_PHRASES = ['only the translation', 'only the translation ,,'];
    function isBlockedPhrase(text) {
        var t = String(text || '').toLowerCase();
        for (var i = 0; i < BLOCKED_PHRASES.length; i++) {
            if (t.indexOf(BLOCKED_PHRASES[i]) !== -1) return true;
        }
        return false;
    }

    // Twarda blokada UI Immersive Translate / playera — linie te NIGDY nie są czytane.
    var LIVEDUB_HARD_BLOCK_RE = new RegExp('(?:' + [
        'request\\s*ai\\s*subtitles?',
        'ai\\s*subtitles?\\s*\\(\\s*beta\\s*\\)',
        'enable\\s*subtitles?',
        'enable\\s*captions?',
        'subtitles?\\s*settings',
        'captions?\\s*settings',
        'subtitle\\s*translation',
        'subtitles?\\s*translation',
        'download\\s*subtitles?',
        'request\\s*subtitles?',
        'turn\\s+on\\s+(?:the\\s+)?subtitles?',
        'translat\\w*\\s+using',
        'using\\s+free\\s+translat\\w*',
        'free\\s+translation',
        'translation\\s+service',
        'translated?\\s+by',
        'w[lł]acz\\s*napis',
        'kliknij\\s*tłumacz',
        't[lł]umaczen\\w*\\s+za\\s+pomoc'
    ].join('|') + ')', 'i');

    // [FIX 2026-11-02] Wulgaryzmy wycina teraz WYŁĄCZNIE jeden cenzor (assets/censor.js) zgodnie z ustawieniami
    // (wł./wył., usuń / beep / gwiazdki, własne słowa). Ten stały wzorzec wycinał je zawsze — wbrew wyłączonemu cenzorowi,
    // tryby beep / gwiazdki nie miały czego zamienić, a rdzenie łapały też niewinne słowa (np. „szmatka”).

    var IMMT_POLL_MS = 250, DEBOUNCE_MS = 30; // poll to tylko zapas — zmiany łapie MutationObserver

    // --- Stan ---
    var enabled = true, engine = 'offline', duckLevel = 20, savedVolume = null, video = null;
    var lastSubtitle = '', playingIds = new Set();
    // OPTIONS-PAGE: opcje ze strony ustawień (window.__LivedubOpts z options_hooks.js)
    function opt(k, dflt) {
        try { var v = window.__LivedubOpts && window.__LivedubOpts.get(k); return v === undefined ? dflt : v; } catch (e) { return dflt; }
    }
    var optPolishVideo = false, optPolishVideoId = '';   // wynik z bridge'a: film po polsku
    var lektorPausedVideo = false, lektorSelfPlay = false;
    function optAsleepNow() { try { return !!(window.__LivedubOpts && window.__LivedubOpts.asleep()); } catch (e) { return false; } }
    function optApplyAsleep() {            // białe/czarne listy domen: na "uśpionej" domenie lektor milczy
        try { if (optAsleepNow() && enabled) { enabled = false; stopSpeechSilently(); } } catch (e) {}
    }
    try { if (window.__LivedubOpts) window.__LivedubOpts.onChange(function () {
        try { TARGET_SELECTORS = TARGET_BASE.concat(window.__LivedubOpts.customSelectors()); } catch (e) {}   // Kreator napisów
        optApplyAsleep();
    }); } catch (e) {}
    // [FIX 2026-11-02] 📋 lista domen zmieniona na otwartej karcie: uśpij lektora (bez obserwatora, pobierania i tłumaczenia
    // napisów — strona poza listą nie zużywa procesora) albo obudź go ze stanem z popupu (dawniej zostawał wyłączony do odświeżenia).
    try { if (window.__LivedubOpts && window.__LivedubOpts.onSleep) window.__LivedubOpts.onSleep(function (a) {
        if (a) { applyEnabled(false); try { autoCancel(); } catch (e) {} return; }
        chrome.storage.local.get('enabled', function (r) { applyEnabled(!r || r.enabled === undefined ? true : !!r.enabled); ttMaybeReload(); });
    }); } catch (e) {}
    // Pauza filmu razem z lektorem: pauza na czas kwestii, wznowienie po TTS_QUEUE_IDLE.
    function optPauseForLektor() {
        if (IS_EMBED || !opt('pauseVideoWithLektor', false)) return;
        var v = getVideo();
        if (!v || v.paused || lektorPausedVideo) return;
        lektorPausedVideo = true;
        try { v.pause(); } catch (e) {}
    }
    function optResumeAfterLektor() {
        if (!lektorPausedVideo) return;
        lektorPausedVideo = false;
        var v = getVideo();
        if (!v) return;
        lektorSelfPlay = true;
        try { var pr = v.play(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) {}
    }
    chrome.runtime.onMessage.addListener(function (msg) {
        if (msg && msg.action === 'TTS_QUEUE_IDLE') optResumeAfterLektor();
    });
    var spokenWords = 0, spokenCues = 0;
    var recentSpoken = [];
    var fileSubs = [], fileTimer = null, fileLookahead = 180000;
    var filePreloaded = new Set(), filePlayed = new Set();
    var observer = null, pollTimer = null;
    var bc = null;
    try { bc = new BroadcastChannel('livedub-youtube'); } catch (e) { bc = null; }
    var tabFocused = document.hasFocus() || document.visibilityState === 'visible';

    // --- Offset napisów (tylko kanał GŁÓWNY na stronie głównej; EMBED/HOVER nie stosują) ---
    var storageOffsetMs = 0;
    function getOff() {
        var g = window.__LIVEDUB_OFFSET_MS__;
        return (typeof g === 'number') ? g : (storageOffsetMs || 0);
    }
    try {
        window.__LIVEDUB_OFFSET_HOOKS__ = window.__LIVEDUB_OFFSET_HOOKS__ || [];
        window.__LIVEDUB_OFFSET_HOOKS__.push(function (newOff) {
            try { if (enabled) chrome.runtime.sendMessage({ action: 'TTS_CLEAR_BUFFER' }); } catch (e) {}
            try {
                var v = getVideo();
                if (!v) return;
                var nowMs = v.currentTime * 1000;
                for (var j = 0; j < ttSubs.length; j++) {
                    var s2 = ttSubs[j];
                    if (!ttPlayed.has(s2) && (s2.endMs + newOff) < nowMs) ttPlayed.add(s2);
                }
                for (var k = 0; k < fileSubs.length; k++) {
                    var s3 = fileSubs[k];
                    if (!filePlayed.has(s3) && (s3.endMs + newOff) < nowMs) filePlayed.add(s3);
                }
            } catch (e) {}
        });
    } catch (e) {}

    // --- Log wypowiedzianych tekstów ---
    var spokenLog = [];
    function pushSpoken(t) {
        t = String(t || '').trim();
        if (!t) return;
        spokenLog.push(t);
        if (spokenLog.length > 100) spokenLog.shift();
    }
    try {
        window.__LIVEDUB_GET_SPOKEN__ = function () { return spokenLog.slice(); };
        window.__LIVEDUB_CLEAR_SPOKEN__ = function () { spokenLog.length = 0; };
        window.__LIVEDUB_DEBUG_SOURCES__ = function () { return getImtSubtitles(); };
    } catch (e) {}

    try {
        window.__LIVEDUB_GET_MODE__ = function () {
            if (IS_EMBED) return { mode: ttSubs.length ? 'embed-timeline' : 'embed-live', cues: ttSubs.length };
            if (fileSubs.length) return { mode: 'file', cues: fileSubs.length };
            if (ttSubs.length) return { mode: 'timeline', cues: ttSubs.length };
            return { mode: 'live', cues: 0 };
        };
    } catch (e) {}

    // --- Ustawienia ---
    function loadSettings() {
        chrome.storage.local.get(['enabled', 'duckLevel', 'engine', 'subtitleOffsetMs', 'ytSource', 'ytAuto', 'ytOnDemandV1', 'ytAutoV2'], function (res) {
            // Jednorazowa migracja: automatyczne pobieranie całych napisów WYŁĄCZONE (teraz przycisk w popupie).
            if (!res.ytOnDemandV1) {
                res.ytAuto = false; res.ytSource = 'imt';
                try { chrome.storage.local.set({ ytAuto: false, ytSource: 'imt', ytOnDemandV1: true }); } catch (e) {}
            }
            // [AGENT-EXP] 2026-10-17: na prośbę użytkownika automat WŁ. domyślnie — całe napisy filmu pobierane od razu
            // i tłumaczone (angielskie lokalnym Translatorem Chrome). Jednorazowo (ytAutoV2); potem decyduje checkbox.
            if (!res.ytAutoV2) {
                res.ytAuto = true;
                try { chrome.storage.local.set({ ytAuto: true, ytAutoV2: true }); } catch (e) {}
            }
            ytAutoOn = !!res.ytAuto;
            ytSourcePref = res.ytSource || 'imt';
            USE_TIMEDTEXT = calcTimedtext(); ttMaybeReload();
            if (res.enabled !== undefined) enabled = !!res.enabled;
            optApplyAsleep(); // OPTIONS-PAGE
            initZeroLagObserver(); // wyłączony = odłączony obserwator i pętla
            if (res.duckLevel !== undefined) duckLevel = clampPct(res.duckLevel);
            if (res.engine !== undefined) engine = res.engine;
            if (typeof res.subtitleOffsetMs === 'number') storageOffsetMs = res.subtitleOffsetMs;
            if (engine !== 'offline') console.warn('[LiveDub] Silnik != offline. Tryb Immersive→Piper wymaga "Offline (Piper)" w popupie.');
            duckReady = true;   // [AGENT-EXP] 2026-10-20: nie ściszaj filmu, zanim wczytamy ustawienia (start z enabled=true) ani przy wyłączonym lektorze
            if (enabled && document.visibilityState === 'visible' && !IS_EMBED) applyDuck();
            else if (!enabled && !IS_EMBED) duckRestoreWhenVideo();   // [AGENT-EXP] 2026-10-20
        });
    }
    // Włącz / wyłącz (popup) — też po zmianie listy domen (onSleep wyżej); uśpiona domena zawsze = wyłączony.
    function applyEnabled(v) {
        enabled = !!v; optApplyAsleep(); initZeroLagObserver();
        if (enabled) { lastSubtitle = ''; lastMainSubtitle = ''; lastHoverSubtitle = ''; if (document.visibilityState === 'visible' && !IS_EMBED) applyDuck(); }
        else { stopSpeechSilently(); if (opt('extTrStopWithLektor', false)) { try { autoCancel(); } catch (e) {} } }   // [AGENT-EXP] opcja: zatrzymaj też tłumaczenie razem z lektorem
    }
    chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        if (changes.enabled !== undefined) applyEnabled(changes.enabled.newValue);
        if (changes.duckLevel !== undefined) { duckLevel = clampPct(changes.duckLevel.newValue); if (enabled && document.visibilityState === 'visible') { if (!IS_EMBED) applyDuck(); else if (__embDuckSaved !== null) { try { var vD = getVideo(); if (vD) vD.volume = Math.min(__embDuckSaved, duckLevel / 100); } catch (eD) {} } } }
        if (changes.engine !== undefined) engine = changes.engine.newValue;
        if (changes.ytSource !== undefined || changes.ytAuto !== undefined) {
            if (changes.ytSource !== undefined) ytSourcePref = changes.ytSource.newValue || 'imt';
            if (changes.ytAuto !== undefined) ytAutoOn = !!changes.ytAuto.newValue;
            USE_TIMEDTEXT = calcTimedtext();
            stopSpeechSilently();
            ttVideoId = ''; autoFailVid = ''; // wymusza ponowne wczytanie/wyzerowanie osi czasu
            ttMaybeReload();
        }
        if (changes.subtitleOffsetMs !== undefined) storageOffsetMs = Number(changes.subtitleOffsetMs.newValue) || 0;
    });

    function clampPct(v) { v = Number(v); if (!isFinite(v)) return 20; return Math.max(0, Math.min(100, v)); }

    // --- Element wideo + ducking ---
    function getVideo() {
        if (video && video.isConnected) return video;
        video = document.querySelector('video.html5-main-video') || document.querySelector('video');
        if (video) {
            video.addEventListener('seeked', function () { ttResync = true; ttSpoken.length = 0; playingIds.clear(); try { filePlayed.clear(); } catch (e) {} stopSpeechSilently('seek'); });   // [AGENT-EXP] cofnięcie → plik czytany jeszcze raz; 2026-10-28 'seek' = bez podgłaśniania
            video.addEventListener('pause', function () { if (lektorPausedVideo) return; filePausedAt = video.currentTime * 1000; if (!opt('readToEnd', false)) ttSpoken.length = 0; stopSpeechSilently('pause'); });   // [FIX 2026-11-02] filePausedAt   // [AGENT-EXP] 2026-10-26: przerwane zdanie po wznowieniu czytane od nowa // OPTIONS-PAGE: pauza od lektora nie kasuje bufora; [AGENT-EXP] 2026-10-22 'pause' → przy „Czytaj zawsze do końca” lektor dokańcza zdanie
            video.addEventListener('play', function () {
                if (lektorSelfPlay) { lektorSelfPlay = false; return; }
                ttResync = true;
                // [FIX 2026-11-02] plik napisów: kwestia przerwana pauzą — od początku (oś czasu robi to przez ttResync)
                var at = filePausedAt; filePausedAt = -1;
                if (fileSubs.length && !opt('readToEnd', false)) { try { window.__LektorSched.rearmAfterPause(fileSubs, filePlayed, null, at, video.currentTime * 1000, getOff()); } catch (e) {} }
            });
            video.addEventListener('volumechange', function () {
                // Nie walczymy z suwakiem usera: dokrecanie max raz na 2 s.
                if (!enabled || !tabFocused || IS_EMBED) return;
                var now = Date.now();
                if (now - __duckLastApply < 2000) return;
                __duckLastApply = now;
                applyDuck();
            });
            video.addEventListener('play', function () { if (enabled && !IS_EMBED) applyDuck(); else if (!enabled && duckReady && !IS_EMBED && duckMemGet() !== null) restoreVolume(); });   // [AGENT-EXP] 2026-10-20
            if (enabled && tabFocused && !IS_EMBED) applyDuck();
        }
        return video;
    }
    // === EMBED: w ramce NIE duckujemy (mute oryginału załatwia sprawę); duck robi strona główna ===
    // [AGENT-EXP] 2026-10-20: pamięć głośności sprzed ściszenia (localStorage strony). Netflix/YouTube same zapamiętują
    // głośność — gdy karta zamknęła się w trakcie ściszenia, film startował na 20% i wyłączony lektor nie miał
    // czego przywrócić. Teraz pierwotna głośność wraca (przy wyłączonym lektorze — przy starcie filmu).
    var DUCK_MEM_KEY = 'lektorDuckOrig';
    function duckMemGet() { try { var n = parseFloat(localStorage.getItem(DUCK_MEM_KEY)); return n > 0 && n <= 1 ? n : null; } catch (e) { return null; } }
    function duckMemSet(v) { try { if (v === null) localStorage.removeItem(DUCK_MEM_KEY); else localStorage.setItem(DUCK_MEM_KEY, String(v)); } catch (e) {} }
    function __mlVolNow(v) { var S = window.__LektorSched, t = S && S.volTarget ? S.volTarget(v) : null; return t != null ? t : v.volume; }   // [FIX 2026-11-22] głośność docelowa płynnej zmiany
    function duckOrig(v) { if (savedVolume === null) { var m = duckMemGet(); if (m !== null && m > __mlVolNow(v)) savedVolume = m; } }
    // [AGENT-EXP] 2026-10-20: lektor WYŁ., a w pamięci jest głośność sprzed ściszenia — czekamy na film (pojawia się
    // później niż ustawienia) i przywracamy przy jego starcie (po tym, jak odtwarzacz ustawi swoją zapamiętaną).
    function duckRestoreWhenVideo() {
        var n = 0;
        (function tryIt() {
            if (enabled || duckMemGet() === null) return;
            var v = getVideo();   // podpina też nasłuch 'play'
            if (v) { if (!v.paused) restoreVolume(); return; }
            if (++n < 120) setTimeout(tryIt, 1000);
        })();
    }
    var duckReady = false;
    function applyDuck() {
        if (IS_EMBED) return;
        if (!duckReady || !enabled) return;   // [AGENT-EXP] 2026-10-20: nie ściszaj filmu, zanim wczytamy ustawienia (start z enabled=true) ani przy wyłączonym lektorze
        var v = getVideo(); if (!v) return;
        if (!fileSubs.length && isPolishVideo()) { if (savedVolume !== null || duckMemGet() !== null) restoreVolume(); return; }
        var LS = window.__LektorSched; if (LS && LS.duckAllowed && !LS.duckAllowed()) { restoreVolume(); return; }   // [FIX 2026-11-16] lektor milczy → film gra PEŁNĄ głośnością (dotąd zostawał na 20%)
        var target = duckLevel / 100;
        duckOrig(v);   // [AGENT-EXP] 2026-10-20
        if (savedVolume === null && __mlVolNow(v) > target) savedVolume = __mlVolNow(v);   // [FIX 2026-11-22]
        if (savedVolume !== null) duckMemSet(savedVolume);   // [AGENT-EXP] 2026-10-20
        if (savedVolume !== null) {
            setV(v, Math.min(target, savedVolume));
        } else if (v.volume > target) {
            setV(v, target);
        }
    }
    function setV(v, x) { var S = window.__LektorSched; if (S && S.setVol) S.setVol(v, x); else v.volume = x; }   // [FIX 2026-11-02] płynnie w trybie „tylko gdy mówi”
    function restoreVolume() {
        var v = getVideo();
        if (v && !IS_EMBED) { duckOrig(v); duckMemSet(null); }
        if (!v) { savedVolume = null; return; }
        if (savedVolume !== null) { setV(v, savedVolume); savedVolume = null; return; }
        // [FIX 2026-11-16] Brak zapisanej głośności, a film stoi dokładnie na poziomie duckingu — oddajemy pełną głośność.
        var LS = window.__LektorSched;
        if (!IS_EMBED && LS && LS.duckWhileOn && LS.duckWhileOn() && duckLevel >= 5 && v.volume > 0
            && Math.abs(v.volume - duckLevel / 100) <= 0.02) setV(v, 1);
    }   // [AGENT-EXP] 2026-10-20: + pamięć
    try { window.__LektorSched.onDuck(function () { if (enabled) applyDuck(); }, function () { if (!IS_EMBED) restoreVolume(); }); } catch (e) {}   // [FIX 2026-11-02] 🔉

    // === HOVER: wyciszenie natywnego podglądu (poll 50 ms podbija, gdyby YT przywracał dźwięk) ===
    function muteHoverPreview() {
        try {
            var vs = document.querySelectorAll(HOVER_VIDEO_SEL);
            for (var i = 0; i < vs.length; i++) if (!vs[i].muted) vs[i].muted = true;
        } catch (e) {}
    }
    // === EMBED: wyciszenie WŁASNEGO wideo ramki (oryginał EN) ===
    var __embedBaseVol = null; // zapamietana glosnosc ramki (do STOP/user-mute)
    var __embedEverPlayed = false; // udany start: od tej pory natywne przyciski YT rzadza
    function muteEmbedVideo() {
        // Ramka ma GRAc GLOSNO: nie mutujemy preview. Tylko odblokowanie
        // autoplay (play bez mute) gdy pauza nie jest od usera (STOP/Esc).
        // Hover nie mute'uje preview (autoplay z dzwiekiem staje) - OLD: — wycisz + wymus play,
        // ale NIE gdy user spauzowal (Esc / STOP preview) — inaczej pauza „nie dziala".
        try {
            var v = getVideo();
            if (!v) return;
            try { v.muted = false; } catch (eM) {}
            if (__embedBaseVol === null) { try { __embedBaseVol = v.volume; v.volume = 0.3; } catch (eV) {} } // 30% tylko raz, nie nadpisuj suwaka
            if (v.paused && !__embedPausedByUser && !__embedEverPlayed) { try { var pr = v.play(); if (pr && pr.catch) pr.catch(function () {}); } catch (e3) {} }
        } catch (e) {}
    }

    // --- TTS: wyłącznie Piper (offline). Bez chrome.tts. ---
    function liveSrc(n) { try { var S = window.__LektorSched, g = S && S.getSource(); if (S && (!g || g.name !== n)) S.setSource(n, 0); } catch (e) {} }   // [FIX 2026-11-02] „czytam z: …”
    function emitTTS(text, source) {
        if (!text || isBlockedPhrase(text) || engine !== 'offline') return;
        if (!IS_EMBED && opt('autoMuteHidden', true) && document.visibilityState !== 'visible') return;
        if (IS_EMBED && source === 'hover') return;                        // hover nie istnieje w ramce
        if (!IS_EMBED && source !== 'hover' && fileSubs.length) return;    // plik → tylko scheduler plikowy
        if (!IS_EMBED && source !== 'hover' && USE_TIMEDTEXT && ttSubs.length) return; // oś czasu (gdy włączona)
        if (window.__LivedubPanel && window.__LivedubPanel.isBlocked(text)) {
            window.__LivedubPanel.log(text, 'blocked');
            return;
        }
        var vRec = null;
        try { vRec = (source === 'hover') ? document.querySelector(HOVER_VIDEO_SEL) : getVideo(); } catch (e) {}
        var id = (source === 'hover' ? 'imt_h_' : (IS_EMBED ? 'em_' : 'imt_')) + Date.now() + '_' + text.length;
        if (source !== 'hover' && vRec) { var vMs = vRec.currentTime * 1000 - getOff(); ttSpokenAdd(vMs - 1500, vMs); }   // [AGENT-EXP] 2026-10-26: potem oś czasu nie czyta tego drugi raz
        optPauseForLektor(); // OPTIONS-PAGE
        liveSrc(source === 'hover' ? 'na żywo: podgląd miniatury (Immersive Translate)' : (IS_EMBED ? 'na żywo: podgląd Hover' : 'na żywo: Immersive Translate'));
        chrome.runtime.sendMessage({
            action: 'TTS_PLAY', id: id, text: text, durationMs: 0,
            videoTimeMs: vRec ? Math.round(vRec.currentTime * 1000) : 0
        });
        // === EMBED: popros o ducking na stronie GLOWNEJ (postMessage + BC fallback przez blank.org) ===
        if (IS_EMBED) {
            try { window.top.postMessage({ __livedubDuck: 1, on: 1, len: String(text).length }, location.origin); } catch (e) {}
            livedubDuckBC('duck', String(text).length);
        }
        var w = String(text || '').trim().split(/\s+/).filter(Boolean).length;
        spokenWords += w;
        spokenCues++;
        recentSpoken.push({ t: text, w: w });
        if (recentSpoken.length > 5) recentSpoken.shift();
        pushSpoken(text);
        playingIds.add(id);
        if (window.__LivedubPanel) window.__LivedubPanel.log(text, 'spoken');
    }
    // UWAGA GLOBALNA: TTS_CLEAR_BUFFER nie niesie tabId — czyści bufor dla WSZYSTKICH kart.
    function stopSpeechSilently(reason) {   // [AGENT-EXP] 2026-10-22: reason 'pause' = pauza filmu (offscreen może dokończyć zdanie)
        // [AGENT-EXP] 2026-10-18: try/catch + .catch — po przeładowaniu rozszerzenia (stara karta) błąd szedł do chrome://extensions
        if (engine === 'offline') { try { chrome.runtime.sendMessage({ action: 'TTS_CLEAR_BUFFER', reason: reason || '' }).catch(() => {}); } catch (e) {} }
        // [AGENT-EXP] 2026-10-17: po pauzie / przewinięciu zleć preload jeszcze raz (gotowe nagrania lektor odda
        // od razu z pamięci / dysku) — wcześniej kwestie zostawały „zleconymi”, a ich dźwięk przepadał
        try { ttPreloaded.clear(); filePreloaded.clear(); } catch (e) {}
        playingIds.clear(); if (!IS_EMBED && reason !== 'seek' && reason !== 'pause') restoreVolume();   // [AGENT-EXP] 2026-10-28: przewinięcie/pauza nie podgłaśnia na chwilę filmu (zaraz i tak znów ściszany)
    }

    // --- Czyszczenie tekstu ---
    function cleanTranslationJunk(text) {
        if (!text) return '';
        text = text.replace(/^\s*[>›»]+ ?/g, ' '); // znaczniki „>> co to jest" z napisow YT
        if (opt('soundCuesFilter', true)) text = text.replace(/^\s*[♪♫]+ ?/g, ' '); // oznaczenia muzyki (OPTIONS-PAGE: opcja)
        text = text.replace(/^\s*[-–—]+ ?/g, ' '); // myslniki dialogowe
        text = text.replace(/\s+/g, ' ').trim();
        if (opt('soundCuesFilter', true)) text = text.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/（[^）]*）/g, ' ').replace(/【[^】]*】/g, ' ').replace(/\s{2,}/g, ' ').trim();
        if (text && LIVEDUB_HARD_BLOCK_RE.test(text)) return '';
        for (var i = 0; i < JUNK_PHRASES.length; i++) {
            var esc = JUNK_PHRASES[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            text = text.replace(new RegExp(esc, 'gi'), ' ');
        }
        return text.replace(/\s+/g, ' ').trim();
    }

    function isOriginNode(el) {
        if (!el || el.nodeType !== 1) return false;
        try { if (el.matches && el.matches(ORIGIN_GROUP)) return true; } catch (e) {}
        var p = el.parentElement || el.parentNode;
        while (p) {
            try { if (p.matches && p.matches(ORIGIN_GROUP)) return true; } catch (e) {}
            p = p.parentElement || p.parentNode;
            if (p && p.nodeType === 11) p = p.host || null;
        }
        return false;
    }

    function isHoverNode(el) {
        try { return !!(el.closest && el.closest(HOVER_CONTAINER_SEL)); } catch (e) { return false; }
    }

    // ENERGIA: lista Shadow Rootów odświeżana max co 2 s (zamiast querySelectorAll('*')
    // po całej stronie YouTube przy każdym skanie — to zjadało CPU/baterię).
    var SHADOW_REFRESH_MS = 2000;
    var shadowRootsCache = [], shadowRootsAt = 0;
    function gatherShadowRoots(root, out) {
        var all;
        try { all = root.querySelectorAll('*'); } catch (e) { return; }
        for (var k = 0; k < all.length; k++) {
            var sr = null;
            try { sr = all[k].shadowRoot; } catch (e) { sr = null; }
            if (sr) { out.push(sr); gatherShadowRoots(sr, out); }
        }
    }
    function getShadowRoots() {
        var now = Date.now();
        if (now - shadowRootsAt > SHADOW_REFRESH_MS) {
            var out = [];
            gatherShadowRoots(document, out);
            shadowRootsCache = out;
            shadowRootsAt = now;
        }
        return shadowRootsCache;
    }

    function collectTextIn(root, results, forceHover) {
        for (var i = 0; i < TARGET_SELECTORS.length; i++) {
            var sel = TARGET_SELECTORS[i];
            try {
                var nodes = root.querySelectorAll(sel);
                for (var j = 0; j < nodes.length; j++) {
                    var node = nodes[j];
                    if (isOriginNode(node)) continue;
                    if (node.closest && node.closest('[data-lektor-ocr]')) continue; // [AGENT-EXP] most OCR — czyta go sam OCR
                    var rawTxt = node.getAttribute && node.getAttribute('data-lkc-raw');   // [AGENT-EXP] 2026-11-17: napis z kreskami (tryb „dashes”) — czytamy oryginał
                    var text = cleanTranslationJunk(String(rawTxt != null ? rawTxt : (node.innerText || node.textContent || '')));
                    if (text.length >= 2 && !/^\d+:\d+/.test(text)) results.push({ text: text, hover: forceHover || isHoverNode(node) });
                }
            } catch (e) {}
        }
    }

    // =========================================================================
    // ENERGIA: ZAPAMIĘTANY KONTENER NAPISÓW (Immersive Translate)
    // Raz znaleziony kontener → czytamy i obserwujemy TYLKO jego (nie całą stronę).
    // Gdzie był (selektor + znacznik hosta Shadow DOM) zapisujemy w pamięci (localStorage),
    // więc na kolejnym filmie znajdujemy go od razu, bez przeszukiwania strony.
    // Pełne (globalne) szukanie: WYŁĄCZNIE na żądanie — przycisk „🔍 Znajdź napisy” w popupie.
    // Bez zapisu w pamięci NIC nie szukamy — lektor czeka na kliknięcie 🔍 (oszczędność energii).
    // =========================================================================
    var IMT_HINT_KEY = 'livedub_imtHint';
    var PLAYER_SEL = '#movie_player, .html5-video-player, #player-container, ytd-player';
    var imtLock = null, imtHint = null, imtLockEmptySince = 0;
    try { imtHint = JSON.parse(localStorage.getItem(IMT_HINT_KEY) || 'null'); } catch (e) { imtHint = null; }
    function imtNodeOk(node) {
        if (!node || isOriginNode(node) || isHoverNode(node)) return false;
        if (node.closest && node.closest('[data-lektor-ocr]')) return false; // [AGENT-EXP] most OCR — czyta go sam OCR
        var rawTxt = node.getAttribute && node.getAttribute('data-lkc-raw');   // [AGENT-EXP] 2026-11-17: napis z kreskami (tryb „dashes”) — czytamy oryginał
        var t = cleanTranslationJunk(String(rawTxt != null ? rawTxt : (node.innerText || node.textContent || '')));
        return t.length >= 2 && !/^\d+:\d+/.test(t);
    }
    function imtMakeLock(root, node, sel) {
        var box = root.nodeType === 11 ? root
            : (node.closest(PLAYER_SEL) || node.parentElement || node);
        return { root: root, box: box, sel: sel };
    }
    function imtLockAliveFor(l) {
        if (!l) return false;
        if (l.root.nodeType === 11) return !!(l.root.host && l.root.host.isConnected);
        return !!(l.box && l.box.isConnected);
    }
    function imtLockAlive() { return imtLockAliveFor(imtLock); }
    // [AGENT-EXP] 2026-10-24: wspólna pamięć miejsca napisów Immersive Translate (ta sama co w dom_content.js:
    // chrome.storage.local 'imtKnownPlaces' = znaczniki elementów IT z Shadow DOM, znalezione na dowolnej stronie).
    var IMT_KNOWN_KEY = 'imtKnownPlaces', imtKnownHosts = [];
    try { chrome.storage.local.get(IMT_KNOWN_KEY, function (r) { var k = r && r[IMT_KNOWN_KEY]; if (k && Array.isArray(k.hosts)) imtKnownHosts = k.hosts.slice(0, 8); }); } catch (e) {}
    function imtRememberHost(host) {
        if (!host || imtKnownHosts.indexOf(host) === 0) return;
        imtKnownHosts = [host].concat(imtKnownHosts.filter(function (h) { return h !== host; })).slice(0, 8);
        try { var o = {}; o[IMT_KNOWN_KEY] = { hosts: imtKnownHosts }; chrome.storage.local.set(o); } catch (e) {}
    }
    function imtTryKnown() { // znane miejsca IT (wspólna pamięć + klasy IT w odtwarzaczu) — celowane zapytania
        var roots = [];
        for (var i = 0; i < imtKnownHosts.length; i++) {
            var hs; try { hs = document.getElementsByTagName(imtKnownHosts[i]); } catch (e) { continue; }
            for (var j = 0; j < hs.length; j++) if (hs[j].shadowRoot) roots.push(hs[j].shadowRoot);
        }
        roots.push(document.querySelector(PLAYER_SEL) || document);
        for (var r = 0; r < roots.length; r++) {
            for (var t = 0; t < TARGET_SELECTORS.length; t++) {
                var node = null;
                try { node = roots[r].querySelector(TARGET_SELECTORS[t]); } catch (e) {}
                if (imtNodeOk(node)) {
                    imtHint = { sel: TARGET_SELECTORS[t], host: roots[r].host ? roots[r].host.tagName.toLowerCase() : '' };
                    try { localStorage.setItem(IMT_HINT_KEY, JSON.stringify(imtHint)); } catch (e) {}
                    return imtMakeLock(roots[r].nodeType === 1 ? document : roots[r], node, TARGET_SELECTORS[t]);
                }
            }
        }
        return null;
    }
    function imtTryHint() { // szybkie: getElementsByTagName + querySelector, bez przeszukiwania strony
        if (!imtHint || !imtHint.sel) return imtTryKnown();   // [AGENT-EXP] 2026-10-24: brak zapisu tej strony → wspólna pamięć
        var roots = [];
        if (imtHint.host) {
            var hs = document.getElementsByTagName(imtHint.host);
            for (var i = 0; i < hs.length; i++) if (hs[i].shadowRoot) roots.push(hs[i].shadowRoot);
        } else {
            // w dokumencie szukamy w odtwarzaczu (IMT tłumaczy też komentarze/tytuły — to nie napisy)
            var pl = document.querySelector(PLAYER_SEL);
            roots.push(pl || document);
        }
        for (var r = 0; r < roots.length; r++) {
            var node = null;
            try { node = roots[r].querySelector(imtHint.sel); } catch (e) {}
            if (imtNodeOk(node)) return imtMakeLock(roots[r].nodeType === 1 ? document : roots[r], node, imtHint.sel);
        }
        return imtTryKnown();   // [AGENT-EXP] 2026-10-24: zapis tej strony nie trafił → wspólna pamięć
    }
    function imtFullSearch() { // drogie — rzadko
        var roots = [document].concat(getShadowRoots());
        // 1. przebieg: tylko w odtwarzaczu / Shadow DOM (napisy); 2. przebieg: gdziekolwiek
        for (var pass = 0; pass < 2; pass++)
        for (var i = 0; i < TARGET_SELECTORS.length; i++) {
            for (var r = 0; r < roots.length; r++) {
                if (roots[r].host && !roots[r].host.isConnected) continue;
                var nodes;
                try { nodes = roots[r].querySelectorAll(TARGET_SELECTORS[i]); } catch (e) { continue; }
                for (var j = 0; j < nodes.length; j++) {
                    if (!imtNodeOk(nodes[j])) continue;
                    if (pass === 0 && roots[r].nodeType !== 11 && !nodes[j].closest(PLAYER_SEL)) continue;
                    imtHint = { sel: TARGET_SELECTORS[i], host: roots[r].host ? roots[r].host.tagName.toLowerCase() : '' };
                    try { localStorage.setItem(IMT_HINT_KEY, JSON.stringify(imtHint)); } catch (e) {}
                    imtRememberHost(imtHint.host);   // [AGENT-EXP] 2026-10-24: do wspólnej pamięci
                    return imtMakeLock(roots[r], nodes[j], TARGET_SELECTORS[i]);
                }
            }
        }
        return null;
    }
    var imtLastTry = 0;
    function imtEnsureLock() {
        if (imtLockAlive()) return; // kontener żyje → nic nie szukamy
        var now = Date.now();
        if (now - imtLastTry < 1000) return; // brak kontenera: tanie próby max raz na sekundę
        imtLastTry = now;
        var prev = imtLock;
        imtLock = imtTryHint(); // tylko zapamiętane miejsce (celowane, bez przeszukiwania strony)
        if (imtLock !== prev) { imtLockEmptySince = 0; imtObserveLock(); }
        // [AGENT-EXP] 2026-10-23: ramka Hover (/embed/ pod blank.org) ma osobny localStorage (bez zapisanego miejsca),
        // a 🔍 z popupu do niej nie trafia — bez tego ramka nigdy nie znajdowała napisów i lektor milczał (każdy silnik).
        // Dokument ramki jest mały, więc szukamy w nim sami (najwyżej raz na sekundę, póki nie ma kontenera).
        if (!imtLock && IS_EMBED) imtSearchOnDemand();
        // [AGENT-EXP] 2026-10-24: też na zwykłym YouTube — Immersive Translate bez przycisku 🔍. Film gra, brak miejsca
        // napisów → szukamy sami co 2 s (po 2 min bez skutku co 10 s, energia). Działa dla każdego silnika lektora.
        else if (!imtLock) {
            var v = document.querySelector('video');
            if (v && !v.paused && now - imtAutoLast >= (imtAutoTries < 60 ? 2000 : 10000)) {
                imtAutoLast = now;
                imtAutoTries++;
                if (imtSearchOnDemand()) imtAutoTries = 0;
            }
        }
    }
    var imtAutoLast = 0, imtAutoTries = 0;   // [AGENT-EXP] 2026-10-24
    // NA ŻĄDANIE: jednorazowe globalne szukanie (cała strona + Shadow DOM) → zapis w pamięci.
    // Zapis ZASTĘPUJE poprzedni (imtHint to jedno miejsce) — nigdy stare + nowe.
    // Nic nie znaleziono → dotychczasowy zapis zostaje bez zmian.
    function imtSearchOnDemand() {
        shadowRootsAt = 0; // świeża lista Shadow DOM tylko na tę jedną akcję
        var lock = imtFullSearch();
        shadowRootsCache = []; // nie trzymamy listy — dalej działa tylko zapamiętany kontener
        if (lock) { imtLock = lock; imtLockEmptySince = 0; imtObserveLock(); }
        return lock;
    }

    // Podział na kanały: najświeższy main + najświeższy hover (osobno).
    function getImtSubtitles() {
        var items = [];
        imtEnsureLock();
        if (imtLock) collectTextIn(imtLock.box, items, false);
        // Podgląd Hover (miniaturki): tylko gdy jest na stronie — czytamy wyłącznie jego wnętrze.
        var hv = null;
        try { hv = document.querySelector(HOVER_CONTAINER_SEL); } catch (e) {}
        if (hv) {
            collectTextIn(hv, items, true);
            var srs = [];
            gatherShadowRoots(hv, srs); // tylko wnętrze podglądu (mały fragment), nie cała strona
            for (var h = 0; h < srs.length; h++) collectTextIn(srs[h], items, true);
        }
        var hasMain = items.some(function (x) { return !x.hover; });
        if (imtLock && !hasMain) { if (!imtLockEmptySince) imtLockEmptySince = Date.now(); }
        else imtLockEmptySince = 0;
        var main = null, hover = null;
        for (var i = items.length - 1; i >= 0; i--) {
            if (!hover && items[i].hover) hover = items[i].text;
            if (!main && !items[i].hover) main = items[i].text;
            if (main && hover) break;
        }
        return { main: main, hover: hover };
    }

    // Auto-wyłącz: natywna polska ścieżka audio → nie dublujemy (tylko strona główna).
    // ENERGIA: wynik sprawdzania menu cache'owany na 2 s (wcześniej: wszystkie przyciski strony co 50 ms).
    var polishTrackCache = false, polishTrackAt = 0;
    function detectPolishAudioTrack() {
        var now = Date.now();
        if (now - polishTrackAt < 2000) return polishTrackCache;
        polishTrackAt = now;
        polishTrackCache = detectPolishAudioTrackNow();
        return polishTrackCache;
    }
    // [AGENT-EXP] 2026-10-27: wspólny warunek „film po polsku” (ścieżka audio lub kanał) — dla skanu i dla ściszania
    function isPolishVideo() {
        return (opt('detectYTPolish', true) && detectPolishAudioTrack()) || (opt('detectYTPolishChannel', true) && optPolishVideo);
    }
    function detectPolishAudioTrackNow() {
        var v = getVideo();
        if (v && v.audioTracks && v.audioTracks.length) {
            for (var i = 0; i < v.audioTracks.length; i++) {
                var t = v.audioTracks[i], lbl = (t.label || '') + ' ' + (t.language || '');
                if (/polski|^pl|pl-PL/i.test(lbl) && t.enabled) return true;
            }
        }
        try {
            var rows = document.querySelectorAll('yt-formatted-string, ytmenuitemviewmodel, button');
            for (var i = 0; i < rows.length; i++) {
                if (!/selected|active/i.test(rows[i].className || '')) continue; // tanie sprawdzenie najpierw
                var txt = rows[i].textContent || '';
                if (/polski/i.test(txt)) return true;
            }
        } catch (e) {}
        return false;
    }

    // === HOVER: planowanie kwestii podglądu (debounce + min-odstęp + test życia preview) ===
    function scheduleHoverEmit(text) {
        clearTimeout(hoverDebounceTimer);
        var fire = function () {
            var wait = HOVER_MIN_INTERVAL_MS - (Date.now() - lastHoverPlayAt);
            if (wait > 0) { hoverDebounceTimer = setTimeout(fire, wait); return; }
            try { if (!document.querySelector(HOVER_CONTAINER_SEL)) return; } catch (e) { return; }
            lastHoverPlayAt = Date.now();
            applyDuck();
            emitTTS(text, 'hover');
        };
        hoverDebounceTimer = setTimeout(fire, DEBOUNCE_MS);
    }

    // =========================================================================
    // === EMBED: pętla skanu RAMKI podglądu ===
    // Priorytet: oś czasu (timedtext, synchronizacja z preview) → fallback live IMT.
    // =========================================================================
    function embedScan() {
        if (__embedPausedByUser) return; // STOP: zero skanu, zero TTS
        var _vv = getVideo();
        if (_vv && _vv.paused && __embedEverPlayed) return; // natywna pauza z paska YT: tez nie czytaj
        muteEmbedVideo();
        if (ttSubs.length) return; // czyta scheduler czasowy startTtLoop()
        var s = getImtSubtitles();
        try { document.documentElement.setAttribute('data-livedub-src', 'EMB' + (s.main ? 'M' : '-')); } catch (e) {}
        if (!s.main || s.main === lastMainSubtitle) return;
        lastMainSubtitle = s.main;
        clearTimeout(mainDebounceTimer);
        mainDebounceTimer = setTimeout(function () { emitTTS(s.main, 'embed'); }, DEBOUNCE_MS);
    }

    // --- Glowna petla skanu (STRONA GLOWNA; w EMBED dispatch wyzej) ---
    function scanImmersiveSubtitles() {
        if (!enabled || engine !== 'offline') return;
        if (document.visibilityState !== 'visible') return; // karta w tle: zero wyszukiwania
        if (IS_EMBED) { embedScan(); return; }
        if (isPolishVideo()) { stopSpeechSilently(); applyDuck(); return; }   // [AGENT-EXP] 2026-10-27: applyDuck przy polskim = przywróć głośność // OPTIONS-PAGE
        muteHoverPreview();
        // ENERGIA: napisy z pliku / osi czasu czyta scheduler — DOM skanujemy tylko gdy jest podgląd hover.
        if (fileSubs.length || (USE_TIMEDTEXT && ttSubs.length && !subScreenOnly)) {
            var hoverOn = false;
            try { hoverOn = !!document.querySelector(HOVER_CONTAINER_SEL); } catch (e) {}
            if (!hoverOn) { lastHoverSubtitle = ''; return; }
        }
        var s = getImtSubtitles();
        try { document.documentElement.setAttribute('data-livedub-src', (s.main ? 'M' : '-') + (s.hover ? 'H' : '-')); } catch (e) {}

        // ---------- kanał HOVER: zawsze live, offset NIE dotyczy ----------
        if (s.hover) {
            if (s.hover !== lastHoverSubtitle) {
                lastHoverSubtitle = s.hover;
                if (HOVER_INTERRUPT) {
                    try { chrome.runtime.sendMessage({ action: 'TTS_CLEAR_BUFFER' }); } catch (e) {}
                }
                scheduleHoverEmit(s.hover);
            }
        } else {
            lastHoverSubtitle = '';
        }

        // ---------- kanał GŁÓWNY: plik/oś czasu mają pierwszeństwo ----------
        if (fileSubs.length) return;
        if (USE_TIMEDTEXT && ttSubs.length && !subScreenOnly) return;
        if (!s.main || s.main === lastMainSubtitle) return;
        lastMainSubtitle = s.main;
        lastSubtitle = s.main;
        clearTimeout(mainDebounceTimer);
        mainDebounceTimer = setTimeout(function () { applyDuck(); emitTTS(s.main, 'main'); }, DEBOUNCE_MS + Math.max(0, getOff()));
    }

    // === ENERGIA: skan zbiorczy — wiele zmian DOM naraz = jeden skan, max co SCAN_MIN_MS ===
    // (YouTube zmienia DOM dziesiątki razy na sekundę; wcześniej każda zmiana = pełny skan strony).
    var SCAN_MIN_MS = 100, lastScanAt = 0, scanTimer = null;
    function requestScan() {
        if (!enabled || scanTimer) return;
        if (document.visibilityState !== 'visible') return; // karta w tle: zero wyszukiwania
        var wait = Math.max(0, SCAN_MIN_MS - (Date.now() - lastScanAt));
        scanTimer = setTimeout(function () {
            scanTimer = null;
            lastScanAt = Date.now();
            scanImmersiveSubtitles();
        }, wait);
    }

    // === ZERO-LAG: MutationObserver + poll zapasowy ===
    function initZeroLagObserver() {
        if (typeof MutationObserver === 'undefined') return;
        if (observer) observer.disconnect();
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }

        observer = new MutationObserver(requestScan);
        if (!wantScan()) return; // w tle / wyłączony / są całe napisy → zero obserwowania strony

        imtObserveLock(); // obserwujemy TYLKO zapamiętany kontener napisów (nie całą stronę)
        pollTimer = setInterval(requestScan, IMMT_POLL_MS);
    }
    function imtObserveLock() {
        if (!observer) return;
        observer.disconnect();
        if (!wantScan() || !imtLockAlive()) return; // bez kontenera: tylko poll (szuka rzadko, patrz imtEnsureLock)
        try { observer.observe(imtLock.box, { childList: true, subtree: true, characterData: true }); } catch (e) {}
    }
    // ENERGIA: skan strony potrzebny TYLKO do czytania w locie. Gdy są całe napisy (plik / oś czasu),
    // czyta harmonogram czasowy — obserwator i pętla stoją, nic nie przeszukuje strony.
    function fullSubsActive() {
        if (!IS_EMBED && fileSubs.length) return true;
        if (subScreenOnly) return false;   // [AGENT-EXP] 2026-11-14: tryb „tylko z ekranu” — plik jest, ale czyta ekran
        return ttSubs.length > 0 && (IS_EMBED || USE_TIMEDTEXT);
    }
    function wantScan() { return enabled && document.visibilityState === 'visible' && !fullSubsActive(); }
    var lastWantScan = null;
    setInterval(function () { // tani strażnik stanu (bez dotykania DOM): przełącza skan tylko przy zmianie
        var w = wantScan();
        if (w === lastWantScan) return;
        lastWantScan = w;
        initZeroLagObserver();
        if (!w && scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    }, 1000);
    // Karta w tle: odłącz obserwatora i pętlę (zero pracy); powrót na kartę: podłącz od nowa.
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') { initZeroLagObserver(); ttMaybeReload(); }
        else {
            if (observer) observer.disconnect();
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
        }
    });

    // --- Focus / cross-tab audio-focus ---
    function onFocus() { tabFocused = true; if (bc) bc.postMessage({ cmd: 'active' }); if (enabled && !IS_EMBED) applyDuck(); }
    function onBlur() { tabFocused = false; if (bc) bc.postMessage({ cmd: 'inactive' }); }
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') { tabFocused = true; if (enabled && !IS_EMBED) applyDuck(); }
        else { tabFocused = false; if (opt('autoMuteHidden', true)) stopSpeechSilently(); } // OPTIONS-PAGE
    });
    if (bc) bc.onmessage = function (ev) {
        var d = ev.data || {};
        if (d.cmd === 'active' && !tabFocused && opt('singleTabMode', true)) stopSpeechSilently(); // OPTIONS-PAGE
    };

    // === EMBED: strona GLOWNA przyjmuje prosbe ramki podgladu o ducking ===
    // Ramka Hover idzie przez blank.org (top -> blank.org -> /embed), wiec postMessage
    // bywa wycinany — fallback to BroadcastChannel (ten sam origin youtube.com).
    var __duckRestoreTimer = null;
    var __duckLastApply = 0; // dokrecanie glosnosci max raz na 2 s (nie walczymy z suwakiem usera)
    var __livedubBC = null;
    var __hoverCtlBC = null; // kanal sterowania ramka Hover: top -> embed (stop/start)
    var __embedPausedByUser = false; // ramka: user spauzowal preview — nie robimy auto-play
    try { __livedubBC = ('BroadcastChannel' in window) ? new BroadcastChannel('livedub-youtube') : null; } catch (e) { __livedubBC = null; }
    try { __hoverCtlBC = ('BroadcastChannel' in window) ? new BroadcastChannel('livedub-hover-ctl') : null; } catch (e) { __hoverCtlBC = null; }
    var __embDuckSaved = null, __embDuckTimer = null;
    function livedubEmbedDuckOwn(len) {
        // Ducking wlasnego filmu ramki: na czas kwestii volume = duckLevel (z popupu).
        var v = getVideo();
        if (!v || v.paused) return;
        try {
            if (__embDuckSaved === null) __embDuckSaved = v.volume;
            v.volume = Math.min(__embDuckSaved, duckLevel / 100);
            clearTimeout(__embDuckTimer);
            __embDuckTimer = setTimeout(function () {
                var v2 = getVideo();
                if (v2 && __embDuckSaved !== null) { try { v2.volume = __embDuckSaved; } catch (e2) {} }
                __embDuckSaved = null;
            }, Math.min(4000, Math.max(1500, (len || 0) * 65) + 400));
        } catch (e) {}
    }
    function livedubDuckBC(kind, len) {
        try { if (__livedubBC) __livedubBC.postMessage({ __livedubDuck: 1, kind: kind, len: len }); } catch (e) {}
        if (IS_EMBED && kind === 'duck') livedubEmbedDuckOwn(len); // film w ramce tez duckowany
    }
    function livedubDuckHold(len) {
        // Nie ma czego sciszac: top spauzowany albo bez wideo — nie ustawiaj timera.
        var v = getVideo();
        if (!v || v.paused) { clearTimeout(__duckRestoreTimer); return; }
        applyDuck();
        // Twardy sufit: sciszamy na czas kwestii, max 4 s. Kazda kwestia resetuje timer,
        // wiec przy ciaglym czytaniu wczesniej nigdy nie wracalo do normy.
        var hold = Math.max(1500, (len || 0) * 65) + 400;
        if (hold > 4000) hold = 4000;
        clearTimeout(__duckRestoreTimer);
        __duckRestoreTimer = setTimeout(restoreVolume, hold);
    }
    function livedubDuckHoldMsg(d) {
        livedubDuckHold(d && d.len);
    }
    if (__livedubBC) { try { __livedubBC.onmessage = function (ev) {
        if (IS_EMBED) return; // ramka tylko nadaje, nie duckuje siebie
        var d = ev.data || {};
        if (!d || d.__livedubDuck !== 1) return;
        if (d.kind === 'duck') livedubDuckHoldMsg(d);
        else { clearTimeout(__duckRestoreTimer); restoreVolume(); }
    }; } catch (e) {} }
    // Ramka Hover: pauza/play na komende z topu + Esc (ramka ma focus gdy mysz nad nia).
    // Bez tego klik w preview lapie Hover (przeciaganie okienka) i nie da sie zatrzymac.
    function livedubEmbedSetPaused(paused) {
        if (!IS_EMBED) return;
        __embedPausedByUser = !!paused;
        try {
            var v = getVideo();
            if (v) {
                if (paused) { try { v.pause(); } catch (eM) {} stopSpeechSilently(); }
                else { try { v.muted = false; v.volume = 0.3; } catch (eM2) {} try { var pr = v.play(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) {} }
            } else if (paused) stopSpeechSilently();
        } catch (e) {}
    }
    if (IS_EMBED) {
        if (__hoverCtlBC) { try { __hoverCtlBC.onmessage = function (ev) {
            var d = ev.data || {};
            if (!d || d.__livedubHoverCtl !== 1) return;
            if (d.cmd === 'pause') { livedubEmbedSetPaused(true); try { if (__embedStopBtn && __embedStopBtn._sync) __embedStopBtn._sync(); } catch (eS) {} }
            else if (d.cmd === 'play') { livedubEmbedSetPaused(false); try { if (__embedStopBtn && __embedStopBtn._sync) __embedStopBtn._sync(); } catch (eS2) {} }
        }; } catch (e) {} }
        document.addEventListener('keydown', function (ev) {
            if (ev && ev.code === 'Escape') { ev.preventDefault(); livedubEmbedSetPaused(true); }
        });
        // Reczne wznowienie przez usera kasuje flage pauzy.
        document.addEventListener('play', function (ev) {
            try { if (ev && ev.target && ev.target.localName === 'video') { __embedPausedByUser = false; __embedEverPlayed = true; } } catch (e) {}
        }, true);
    }
    // Ramka Hover: WLASNY przycisk STOP/PLAY w rogu ramki (topu nie widac znad preview,
    // a Hover lapie klikniecia do przeciagania - dlatego przycisk jest duzy i na wierzchu).
    var __embedStopBtn = null;
    function livedubEmbedStopBtn() {
        if (!IS_EMBED) return;
        if (__embedStopBtn && __embedStopBtn.isConnected) return;
        __embedStopBtn = document.createElement('button');
        __embedStopBtn.id = 'livedub-embed-stop';
        __embedStopBtn.type = 'button';
        __embedStopBtn.textContent = '\u23F9 STOP';
        __embedStopBtn.title = 'Lektor: STOP podgladu Hover (klik = PLAY)';
        __embedStopBtn.dataset.mode = 'stop';
        __embedStopBtn.style.cssText = 'position:fixed;top:6px;right:6px;z-index:2147483647;background:rgba(200,20,20,0.92);color:#fff;border:2px solid #fff;border-radius:8px;padding:6px 12px;font:bold 13px system-ui,sans-serif;cursor:pointer;';
        var syncEmbedBtn = function () {
            try {
                if (__embedPausedByUser) { __embedStopBtn.textContent = '\u25B6 PLAY'; __embedStopBtn.style.background = 'rgba(20,140,40,0.92)'; __embedStopBtn.dataset.mode = 'play'; }
                else { __embedStopBtn.textContent = '\u23F9 STOP'; __embedStopBtn.style.background = 'rgba(200,20,20,0.92)'; __embedStopBtn.dataset.mode = 'stop'; }
            } catch (eS) {}
        };
        __embedStopBtn._sync = syncEmbedBtn;
        __embedStopBtn.addEventListener('click', function (ev) {
            try { ev.preventDefault(); ev.stopPropagation(); } catch (e0) {}
            livedubEmbedSetPaused(!__embedPausedByUser);
            syncEmbedBtn();
        });
        __embedStopBtn.addEventListener('mousedown', function (ev) { try { ev.stopPropagation(); } catch (e0) {} }, true);
        (document.body || document.documentElement).appendChild(__embedStopBtn);
    }
    var __embedTtsBtn = null;
    function livedubEmbedTtsSync() {
        try {
            if (!__embedTtsBtn) return;
            if (enabled) { __embedTtsBtn.textContent = '\uD83D\uDD0A Lektor'; __embedTtsBtn.style.background = 'rgba(20,140,40,0.92)'; __embedTtsBtn.title = 'Lektor: W\u0141\u0104CZONY (klik = wy\u0142\u0105cz ca\u0142y TTS)'; }
            else { __embedTtsBtn.textContent = '\uD83D\uDD07 Lektor'; __embedTtsBtn.style.background = 'rgba(80,80,88,0.92)'; __embedTtsBtn.title = 'Lektor: WY\u0141\u0104CZONY (klik = w\u0142\u0105cz)'; }
        } catch (eS) {}
    }
    function livedubEmbedTtsBtn() {
        if (!IS_EMBED) return;
        try { var _old = document.getElementById('livedub-embed-stop'); if (_old && _old.parentNode) _old.parentNode.removeChild(_old); } catch (eR) {}
        if (__embedTtsBtn && __embedTtsBtn.isConnected) { livedubEmbedTtsSync(); return; }
        __embedTtsBtn = document.createElement('button');
        __embedTtsBtn.id = 'livedub-embed-tts';
        __embedTtsBtn.type = 'button';
        __embedTtsBtn.style.cssText = 'position:fixed;bottom:8px;right:10px;z-index:2147483647;color:#fff;border:1px solid rgba(255,255,255,0.35);border-radius:999px;padding:4px 10px;font:bold 11px system-ui,sans-serif;cursor:pointer;';
        __embedTtsBtn.addEventListener('click', function (ev) {
            try { ev.preventDefault(); ev.stopPropagation(); } catch (e0) {}
            try { chrome.storage.local.set({ enabled: !enabled }); } catch (e1) { enabled = !enabled; livedubEmbedTtsSync(); }
        });
        __embedTtsBtn.addEventListener('mousedown', function (ev) { try { ev.stopPropagation(); } catch (e2) {} }, true);
        (document.body || document.documentElement).appendChild(__embedTtsBtn);
        livedubEmbedTtsSync();
    }
    if (IS_EMBED) { setInterval(livedubEmbedTtsBtn, 1000); livedubEmbedTtsBtn(); }
    // Top: przycisk STOP preview — wysyla komende do ramki Hover.
    function livedubHoverCtl(cmd) {
        try { if (__hoverCtlBC) __hoverCtlBC.postMessage({ __livedubHoverCtl: 1, cmd: cmd }); } catch (e) {}
    }
    window.addEventListener('message', function (ev) {
        if (ev.origin !== location.origin) return;
        var d = ev.data || {};
        if (!d || d.__livedubDuck !== 1) return;
        if (d.on) {
            applyDuck();
            var hold = Math.max(1500, (d.len || 0) * 65) + 400; // przybliżony czas kwestii
            clearTimeout(__duckRestoreTimer);
            __duckRestoreTimer = setTimeout(restoreVolume, hold);
        } else { clearTimeout(__duckRestoreTimer); restoreVolume(); }
    });

    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        if (msg && msg.action === 'FIND_SUB_CONTAINER') {
            if (IS_EMBED) return;
            var lk = imtSearchOnDemand();
            sendResponse(lk ? { ok: true, found: true, where: (imtHint && imtHint.host ? '<' + imtHint.host + '> ' : '') + lk.sel }
                            : { ok: true, found: false });
            return true;
        }
        if (msg && (msg.action === 'YT_LOAD_FULL_SUBS' || msg.action === 'LOAD_FULL_SUBS')) {
            if (IS_EMBED) return; // tylko strona główna
            // [AGENT-EXP] 2026-11-14: pobieranie NIE zależy od lektora — te same napisy czyta lektor i cenzor,
            // więc przy wyłączonym lektorze też ściągamy (cenzor ich potrzebuje).
            var vidOD = ttGetVideoId();
            if (!vidOD) { sendResponse({ ok: false, error: 'Brak filmu na tej karcie' }); return true; }
            onDemandVid = vidOD;
            USE_TIMEDTEXT = true;
            ttVideoId = ''; autoFailVid = '';
            stopSpeechSilently();
            ttMaybeReload();
            sendResponse({ ok: true, vid: vidOD });
            return true;
        }
        if (msg && (msg.action === 'YT_FULL_SUBS_STATUS' || msg.action === 'FULL_SUBS_STATUS')) {
            if (IS_EMBED) return;
            sendResponse({ ok: true, onDemand: !!onDemandVid && onDemandVid === ttGetVideoId(), cues: ttSubs.length, busy: autoBusy, status: autoStatusText });
            return true;
        }
        if (msg && msg.action === 'GET_SUB_STATUS') {
            var hoverActive = false;
            try { hoverActive = !!document.querySelector(HOVER_CONTAINER_SEL); } catch (e) {}
            sendResponse({ queueLength: lastSubtitle ? 1 : 0, engine: engine, focused: tabFocused, hoverActive: hoverActive, embed: IS_EMBED });
            return true;
        }
    });

    // --- Przycisk Stop/Play lektora w pasku odtwarzacza ---
    var livedubFloat = null;
    var LIVEDUB_ICON_ON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="#fff"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/><path d="M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
    var LIVEDUB_ICON_OFF = '<svg viewBox="0 0 24 24" width="24" height="24" fill="#fff"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16 8.5L14.5 7 12 9.5 9.5 7 8 8.5 10.5 11 8 13.5 9.5 15 12 12.5 14.5 15 16 13.5 13.5 11z"/></svg>';
    function livedubMakeButton() {
        var b = document.createElement('button');
        b.id = 'livedub-yt-btn';
        b.className = 'ytp-button livedub-yt-button';
        b.style.cssText = 'width:48px;height:100%;display:flex;align-items:center;justify-content:center;border:none;background:transparent;cursor:pointer;padding:0;min-width:0;';
        b.addEventListener('click', function (ev) {
            ev.preventDefault(); ev.stopPropagation();
            chrome.storage.local.set({ enabled: !enabled });
        });
        b.addEventListener('keydown', function (ev) { ev.stopPropagation(); });
        return b;
    }
    function livedubApplyState(btn) {
        // [AGENT-EXP] 2026-10-28: ikonę podmieniamy tylko przy zmianie stanu — co 1 s nowe innerHTML między
        // naciśnięciem a puszczeniem myszy kasowało klik (Chrome nie wysyła click, gdy element spod myszy zniknął)
        if (btn.dataset.on === String(enabled)) return;
        btn.dataset.on = String(enabled);
        btn.innerHTML = enabled ? LIVEDUB_ICON_ON : LIVEDUB_ICON_OFF;
        btn.title = enabled ? 'Lektor: w\u0142\u0105czony (klik = STOP)' : 'Lektor: wy\u0142\u0105czony (klik = START)';
        btn.style.opacity = enabled ? '1' : '0.55';
    }
    function livedubEnsureButton() {
        if (IS_EMBED) return; // ramka Hover: zero UI, tylko TTS
        var right = document.querySelector('.ytp-right-controls');
        var btn = document.getElementById('livedub-yt-btn');
        // Przycisk na topie USUNIETY: zjazd mysza poza ramke zamyka Hover,
        // wiec byl nieklikany. Sterowanie tylko z ramki (STOP w rogu) + Esc.
        var _gone = document.getElementById('livedub-hover-stop');
        try { if (_gone && _gone.parentNode) _gone.parentNode.removeChild(_gone); } catch (eG) {}
        var stopBtn = null;
        if (right) {
            if (!btn) {
                btn = livedubMakeButton();
                var gear = right.querySelector('.ytp-settings-button');
                if (gear && gear.parentNode === right) right.insertBefore(btn, gear);
                else right.appendChild(btn);
            } else if (!right.contains(btn)) {
                right.insertBefore(btn, right.querySelector('.ytp-settings-button') || right.firstChild);
            }
            livedubApplyState(btn);
            if (livedubFloat && livedubFloat.isConnected) { livedubFloat.remove(); livedubFloat = null; }
            return;
        }
        var video = document.querySelector('video');
        if (video) {
            if (!livedubFloat || !livedubFloat.isConnected) {
                livedubFloat = livedubMakeButton();
                livedubFloat.id = 'livedub-yt-btn-float';
                livedubFloat.style.cssText = 'position:fixed;z-index:2147483646;width:44px;height:44px;border-radius:50%;background:rgba(18,18,22,0.85);border:1px solid rgba(255,255,255,0.25);display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer;';
                (document.body || document.documentElement).appendChild(livedubFloat);
            }
            var r = video.getBoundingClientRect();
            livedubFloat.style.top = Math.max(8, r.top + 12) + 'px';
            livedubFloat.style.left = Math.min(window.innerWidth - 56, Math.max(8, r.right - 56)) + 'px';
            livedubApplyState(livedubFloat);
        }
    }
    setInterval(function () { if (document.visibilityState === 'visible') livedubEnsureButton(); }, 1000);

    // --- Telemetria dla popupu (tylko top; ramka Hover nie spamuje) ---
    if (!IS_EMBED) setInterval(function () {
        if (!enabled || document.visibilityState !== 'visible') return; // wyłączony / w tle: cisza
        try {
            var yv = document.querySelector('video');   // [AGENT-EXP] 2026-11-16: pozycja i długość filmu dla karty „zapas do przodu”
            chrome.runtime.sendMessage({
                action: 'REC_TELEMETRY',
                platform: 'youtube',
                nowMs: yv ? Math.round(yv.currentTime * 1000) : null,
                durMs: yv && isFinite(yv.duration) ? Math.round(yv.duration * 1000) : 0,
                aheadMs: 0,
                aheadWords: 0,
                spokenWords: spokenWords,
                totalWords: 0,
                preloaded: 0,
                total: spokenCues,
                recent: recentSpoken.slice()
            });
        } catch (e) {}
    }, 2000);

    // --- Napisy z pliku (tylko strona GŁÓWNA; w EMBED ignorowane) ---

    // [AGENT-EXP] 2026-10-17: napisy z pliku należą do FILMU (adres strony karty). Background (LEKTOR_FILE_FOR_ME)
    // oddaje plik tylko, gdy karta jest na tym filmie — także po powrocie do niego (pamięć fileSubsMem).
    // Wcześniej plik wisiał w chrome.storage dla WSZYSTKICH kart i filmów i zagłuszał napisy filmu.
    // Zmiana adresu karty → background wysyła LEKTOR_FILE_RECHECK. Te same napisy drugi raz = bez resetu.
    var fileMyLast = null;
    function fileForMe(cb) {
        try {
            chrome.runtime.sendMessage({ action: 'LEKTOR_FILE_FOR_ME' }, function (r) {
                void chrome.runtime.lastError;
                var f = r && r.file && Array.isArray(r.file.cues) && r.file.cues.length ? r.file : null;
                var sig = f ? (f.page || '') + '|' + (f.loadedAt || 0) + '|' + f.cues.length : '';
                if (sig === fileMyLast) return;
                fileMyLast = sig;
                cb(f);
            });
        } catch (e) {}
    }
    try { chrome.runtime.onMessage.addListener(function (m) { if (m && m.action === 'LEKTOR_FILE_RECHECK') fileForMe(fileApply); }); } catch (e) {}
    var fileSrcName = 'plik napisów', fileSrcSent = '', filePausedAt = -1;   // [FIX 2026-11-02] „czytam z: …”, pauza
    function fileApply(f) {
        if (IS_EMBED) return;
        if (f && Array.isArray(f.cues) && f.cues.length) {
            fileSrcName = /^🌐/.test(String(f.name || '')) ? 'bazy napisów: ' + String(f.name).replace(/^🌐\s*/, '') : 'plik napisów: ' + String(f.name || 'bez nazwy');
            fileSubs = f.cues.map(function (c, i) {
                var t = cleanTranslationJunk(c.text);
                if (!t || isBlockedPhrase(t)) return null;
                return { id: 'file_' + i, text: t, startMs: c.startMs, endMs: c.endMs };
            }).filter(Boolean);
            filePreloaded.clear();
            filePlayed.clear();
            startFileLoop();
        } else {
            fileSubs = [];
            if (fileTimer) { clearInterval(fileTimer); fileTimer = null; }
        }
    }
    function startFileLoop() {
        if (fileTimer) return;
        fileTimer = setInterval(function () {
            if (!enabled || fileSubs.length === 0) return;
            var wTle = document.visibilityState !== 'visible';   // [AGENT-EXP] karta w tle: tylko buforowanie
            if (wTle && window.__lektorBufTlo === false) return;
            var v = getVideo();
            if (!v) return;
            // [FIX 2026-11-02] wspólny harmonogram: także okno kwestii i tempo filmu (auto-nadrabianie) — wcześniej plik na
            // YouTube ich nie miał — i bez czytania przy zatrzymanym filmie (po przewinięciu w pauzie lektor zaczynał mówić)
            var S = window.__LektorSched;
            if (fileSrcSent !== fileSrcName + fileSubs.length) { fileSrcSent = fileSrcName + fileSubs.length; S.setSource(fileSrcName, fileSubs.length); }
            S.tick({
                list: fileSubs, nowMs: v.currentTime * 1000, off: getOff(), rate: v.playbackRate || 1, lookaheadMs: fileLookahead,
                budget: S.budgetFor(v), canPlay: S.canPlay(v), preloaded: filePreloaded, played: filePlayed,
                onPlay: function (sub) {
                    pushSpoken(sub.text);
                    var w = String(sub.text || '').trim().split(/\s+/).filter(Boolean).length;
                    spokenWords += w;
                    spokenCues++;
                    recentSpoken.push({ t: sub.text, w: w });
                    if (recentSpoken.length > 5) recentSpoken.shift();
                    applyDuck();
                    if (isBlockedPhrase(sub.text)) return false;
                }
            });
        }, 50);
    }
    try {
        chrome.storage.local.get(['fileSubs', 'lookaheadMin'], function (r) {
            var m = Number(r && r.lookaheadMin);
            if (!isNaN(m) && r.lookaheadMin !== undefined) fileLookahead = m > 0 ? m * 60000 : 0;
            fileForMe(fileApply);   // [AGENT-EXP] tylko plik tego filmu
        });
        chrome.storage.onChanged.addListener(function (ch, area) {
            if (area !== 'local') return;
            if (ch.fileSubs !== undefined || ch.fileSubsMem !== undefined) fileForMe(fileApply);   // [AGENT-EXP]
            if (ch.lookaheadMin !== undefined) {
                var m2 = Number(ch.lookaheadMin.newValue);
                if (!isNaN(m2)) { fileLookahead = m2 > 0 ? m2 * 60000 : 0; try { filePreloaded.clear(); ttPreloaded.clear(); } catch (e) {} }   // [AGENT-EXP] 2026-10-25: nowy zapas → wyślij okno jeszcze raz (gotowe idą z pamięci)
            }
        });
    } catch (e) {}

    // =========================================================================
    // OŚ CZASU (timedtext json3 + auto-tłumaczenie tlang=pl).
    //  - STRONA GŁÓWNA: ZGASZONA (USE_TIMEDTEXT=false) — lektor czyta tylko z IMT.
    //  - EMBED: ZAWSZE AKTYWNA — to plan A dla podglądu (idealna synchronizacja),
    //    a live IMT w ramce jest fallbackiem, gdyby oś czasu nie weszła.
    // =========================================================================
    var ttSubs = [], ttTimer = null, ttVideoId = '', ttTried = 0, ttWatchTried = false;
    var ttPlayed = new Set(), ttPreloaded = new Set();
    // [AGENT-EXP] 2026-10-26: co lektor już przeczytał (czas kwestii w filmie, bez przesunięcia). Start filmu („play”),
    // podmiana listy (pamięć → YouTube → tłumaczenie) i LIVE przed wczytaniem napisów czyściły ttPlayed — bieżące
    // zdanie szło drugi raz. Kasowane tylko przy przewinięciu i pauzie, która przerwała mowę.
    var ttSpoken = [], ttLastList = null;
    function ttSpokenAdd(a, b) {
        ttSpoken.push({ a: a, b: b, at: Date.now() });
        if (ttSpoken.length > 20) ttSpoken.shift();
    }
    function ttRestorePlayed(nowMs, off) {
        var old = Date.now() - 120000;
        ttSpoken = ttSpoken.filter(function (r) { return r.at > old; });
        if (!ttSpoken.length) return;
        for (var i = 0; i < ttSubs.length; i++) {
            var c = ttSubs[i];
            if (c.startMs + off > nowMs) break;
            if (nowMs >= c.endMs + off) continue;
            for (var j = 0; j < ttSpoken.length; j++) {
                if (ttSpoken[j].a <= c.endMs && ttSpoken[j].b >= c.startMs - 500) { ttPlayed.add(c); break; }
            }
        }
    }

    function ttGetVideoId() {
        try {
            var u = new URL(location.href);
            if (u.searchParams && u.searchParams.get('v')) return u.searchParams.get('v');
            var m = location.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{5,})/);
            if (m) return m[1];
        } catch (e) {}
        return '';
    }

    function ttExtractCaptionTracks() {
        // 1) ytInitialPlayerResponse (embed czasem ma go jako global, nie inline <script>)
        try {
            var ir = window.ytInitialPlayerResponse;
            var tl = ir && ir.captions && ir.captions.playerCaptionsTracklistRenderer;
            if (tl && tl.captionTracks && tl.captionTracks.length) return tl.captionTracks;
        } catch (e) {}
        try {
            var scripts = document.querySelectorAll('script');
            for (var i = scripts.length - 1; i >= 0; i--) {
                var txt = scripts[i].textContent || '';
                var idx = txt.indexOf('"captionTracks":');
                if (idx === -1) continue;
                var arrStart = txt.indexOf('[', idx);
                if (arrStart === -1) continue;
                var depth = 0;
                for (var j = arrStart; j < txt.length; j++) {
                    var c = txt[j];
                    if (c === '[') depth++;
                    else if (c === ']') {
                        depth--;
                        if (depth === 0) {
                            var tracks = JSON.parse(txt.slice(arrStart, j + 1));
                            if (Array.isArray(tracks) && tracks.length) return tracks;
                            break;
                        }
                    }
                }
            }
        } catch (e) {}
        return [];
    }

    function ttPickTrack(tracks) {
        for (var i = 0; i < tracks.length; i++) {
            if (/^pl/i.test(String(tracks[i].languageCode || ''))) return { url: tracks[i].baseUrl, nativePl: true };
        }
        return tracks.length ? { url: tracks[0].baseUrl, nativePl: false } : null;
    }

    function ttParseJson3(data) {
        var evs = (data && data.events) || [];
        var cues = [];
        var pending = null; // bufor dopiskow aAppend=1 (YT rozbija poczatek kwestii)
        function flushPending() {
            if (!pending) return;
            var t = cleanTranslationJunk(pending.text);
            if (t && !isBlockedPhrase(t) && !(window.__LIVEDUB_IS_BLOCKED__ && window.__LIVEDUB_IS_BLOCKED__(t))) {
                cues.push({ text: t, startMs: pending.startMs, endMs: pending.endMs });
            }
            pending = null;
        }
        for (var i = 0; i < evs.length; i++) {
            var e = evs[i];
            if (!e || !e.segs || !e.segs.length) continue;
            var parts = [];
            for (var j = 0; j < e.segs.length; j++) if (e.segs[j] && e.segs[j].utf8) parts.push(e.segs[j].utf8);
            var raw = parts.join(' ');
            var startMs = e.tStartMs | 0;
            var endMs = startMs + ((e.dDurationMs | 0) || 2000);
            if (endMs <= startMs) endMs = startMs + 2000;
            if (e.aAppend === 1 && pending) {
                pending.text += ' ' + raw;
                pending.endMs = endMs;
                // Dopiski nie rozjezdzaja sie w czasie: flush po ~2.5 s ciagu.
                if (pending.endMs - pending.startMs > 2500) flushPending();
                continue;
            }
            flushPending();
            pending = { text: raw, startMs: startMs, endMs: endMs };
            // Pelny event bez dopiskow tez musi trafic do cues — bedzie sflushowany
            // przy nastepnym pelnym evencie albo na koncu petli.
            if (i + 1 >= evs.length || !evs[i + 1] || evs[i + 1].aAppend !== 1) flushPending();
        }
        flushPending();
        cues.sort(function (a, b) { return a.startMs - b.startMs; });
        return cues;
    }

    function ttApply(cues) {
        ttSubs = cues;
        ttPlayed.clear();
        ttPreloaded.clear();
        startTtLoop();
    }

    // Wspolna sciezka: captionTracks -> json3 (z tlang=pl, fallback czysty), uzywana
    // przez ttLoad() i przez jednorazowy fallback ze strony /watch.
    function ttApplyFromTracks(tracks) {
        var pick = null;
        // Ramka moze dostac juz wybrany {url, nativePl} zamiast surowych captionTracks.
        if (tracks && tracks.length === 1 && tracks[0] && tracks[0].url && !tracks[0].baseUrl) pick = tracks[0];
        else pick = ttPickTrack(tracks || []);
        if (!pick || !pick.url) return;
        var url = pick.url + (pick.url.indexOf('?') === -1 ? '?' : '&') + 'fmt=json3' + (pick.nativePl ? '' : '&tlang=pl');
        var apply = function (cues) { ttApply(cues); };
        fetch(url, { credentials: 'omit' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
            var cues = ttParseJson3(data);
            if (cues.length) { apply(cues); return null; }
            if (pick.nativePl) return null;
            var url2 = pick.url + (pick.url.indexOf('?') === -1 ? '?' : '&') + 'fmt=json3';
            return fetch(url2, { credentials: 'omit' }).then(function (r2) { return r2.ok ? r2.json() : null; }).then(function (d2) {
                apply(ttParseJson3(d2));
            });
        }).catch(function () { /* brak osi czasu -> fallback live */ });
    }

    function ttLoad(videoId, attempt) {
        if (!videoId) return;
        var pick = ttPickTrack(ttExtractCaptionTracks());
        if (!pick || !pick.url) {
            // Strona /embed/ jest minimalistyczna: dociagnij captionTracks ze strony watch.
            if (IS_EMBED && !ttWatchTried && (attempt || 0) >= 2) {
                ttWatchTried = true;
                fetch('https://www.youtube.com/watch?v=' + encodeURIComponent(videoId), { credentials: 'omit' }).then(function (r) { return r.ok ? r.text() : ''; }).then(function (html) {
                    var idx = html.indexOf('"captionTracks":');
                    if (idx !== -1) {
                        var s = html.indexOf('[', idx);
                        var depth = 0;
                        for (var j = s; j < html.length; j++) {
                            if (html[j] === '[') depth++;
                            else if (html[j] === ']') { depth--; if (depth === 0) {
                                try { var tr = JSON.parse(html.slice(s, j + 1)); if (tr.length) ttApplyFromTracks(tr); } catch (e) {}
                                break;
                            } }
                        }
                    }
                    if (!ttSubs.length) ttLoad(videoId, (attempt || 0) + 1);
                }).catch(function () { ttLoad(videoId, (attempt || 0) + 1); });
                return;
            }
            if ((attempt || 0) < 10) setTimeout(function () { ttLoad(videoId, (attempt || 0) + 1); }, 2000);
            return;
        }
        ttApplyFromTracks([pick]);
    }

    // Bramka: strona główna szanuje USE_TIMEDTEXT; EMBED ładuje oś czasu ZAWSZE (plan A podglądu).
    function ttMaybeReload() {
        if (!IS_EMBED && document.visibilityState !== 'visible') return; // karta w tle: nic nie robimy
        if (optAsleepNow()) return;   // [FIX 2026-11-02] 📋 domena poza listą: bez pobierania i tłumaczenia napisów
        try { var _pv = ttGetVideoId(); if (_pv) optCheckPolish(_pv); } catch (e) {} // OPTIONS-PAGE
        if (!IS_EMBED) USE_TIMEDTEXT = calcTimedtext(); // nowy film = koniec trybu „na żądanie”
        if (!USE_TIMEDTEXT && !IS_EMBED) {
            if (ttSubs.length || autoBusy) autoCancel();
            ttSubs = []; ttPlayed.clear(); ttPreloaded.clear(); return;
        }
        var vid = ttGetVideoId();
        if (!vid) { ttSubs = []; return; }
        if (vid === ttVideoId && (ttSubs.length || autoBusy)) return;
        if (!IS_EMBED && vid === autoFailVid) return;
        ttVideoId = vid;
        ttSubs = [];
        ttPlayed.clear();
        ttPreloaded.clear();
        if (IS_EMBED) ttLoad(vid, 0); else autoLoad(vid, 0);
    }

    // =========================================================================
    // WŁASNE NAPISY (strona główna): bridge w świecie strony → SRT → parser → Translator Chrome.
    // Do tłumaczenia idą same zdania {idx, text}; czasy zostają w ttSubs, a wynik wpada pod ten sam idx.
    // =========================================================================
    var BRIDGE_TAG = '__lektorYt';
    var bridgeSeq = 0, bridgePending = {};
    var autoBusy = false, autoToken = 0, autoDone = 0, autoStatusText = '', autoFailVid = '';

    function setStatus(t) {
        autoStatusText = t;
        try { document.documentElement.setAttribute('data-livedub-auto', t); } catch (e) {}
        try { if (window.__LivedubPanel && window.__LivedubPanel.status) window.__LivedubPanel.status(t); } catch (e) {}
    }
    function bridgeCall(cmd, payload, onMsg) {
        var id = 'r' + (++bridgeSeq) + '_' + Date.now();
        bridgePending[id] = onMsg;
        var msg = { reqId: id, cmd: cmd };
        msg[BRIDGE_TAG] = 'req';
        for (var k in payload) msg[k] = payload[k];
        window.postMessage(msg, location.origin);
        return id;
    }
    window.addEventListener('message', function (ev) {
        if (ev.source !== window || ev.origin !== location.origin) return;
        var d = ev.data;
        if (!d || d[BRIDGE_TAG] !== 'res') return;
        var h = bridgePending[d.reqId];
        if (!h) return;
        if (d.done) delete bridgePending[d.reqId];
        try { h(d); } catch (e) {}
    });
    function autoCancel() {
        autoToken++;
        autoBusy = false;
        bridgePending = {};
        try { bridgeCall('cancel', {}, function () {}); } catch (e) {}
        try { autoCancelExt(); } catch (e) {} // EXT-TRANSLATE: ubij kolejke porcji w SW
        setStatus('');
    }

    // SRT → kwestie. Zdejmuje numer, linię czasu i tagi; zostaje czysty tekst.
    function parseSrt(srt) {
        var cues = [];
        // Brak pustych linii między blokami — wstaw je przed „numer + czas”, żeby kwestie się nie sklejały.
        var blocks = String(srt || '').replace(/\r/g, '').replace(/(?<!\n|(?:^|\n)\d+)\n(\d+\n)?(?=[^\n]*-->)/g,'\n\n$1').split(/\n{2,}/);
        var tre = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/;
        var ms = function (h, m, s, f) { return ((+h) * 3600 + (+m) * 60 + (+s)) * 1000 + parseInt(String(f).padEnd(3, '0').slice(0, 3), 10); };
        for (var i = 0; i < blocks.length; i++) {
            var lines = blocks[i].split('\n');
            var ti = -1;
            for (var j = 0; j < lines.length; j++) if (tre.test(lines[j])) { ti = j; break; }
            if (ti < 0) continue;
            var t = lines[ti].match(tre);
            var txt = lines.slice(ti + 1).join(' ')
                .replace(/\{\\[^}]*\}/g, ' ').replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
            txt = cleanTranslationJunk(txt);
            if (!txt || isBlockedPhrase(txt)) continue;
            cues.push({ startMs: ms(t[1], t[2], t[3], t[4]), endMs: ms(t[5], t[6], t[7], t[8]), src: txt, text: null });
        }
        cues.sort(function (a, b) { return a.startMs - b.startMs; });
        return cues;
    }

    // OPTIONS-PAGE: pytamy bridge, czy film jest polski (opcja „polskie kanały")
    function optCheckPolish(vid) {
        if (IS_EMBED || optPolishVideoId === vid) return;
        optPolishVideoId = vid; optPolishVideo = false;
        try { bridgeCall('meta', {}, function (r) { if (!r || !r.ok || optPolishVideoId !== vid) return; if (r.videoId === vid) optPolishVideo = !!r.polish; else optPolishVideoId = ''; /* player niegotowy — ponów */ }); } catch (e) {}
    }
    // ===== Pamięć napisów (90 dni, service worker → IndexedDB) =====
    // Po powrocie do filmu napisy (już po polsku) biorą się z pamięci — bez pobierania i tłumaczenia.
    function ytMemLoad(vid, cb) {
        try {
            chrome.runtime.sendMessage({ action: 'PAMIEC_VIDEO_GET', key: 'yt|' + vid }, function (r) {
                void chrome.runtime.lastError;
                cb(r && r.ok && r.data && Array.isArray(r.data.cues) && r.data.cues.length ? r.data : null);
            });
        } catch (e) { cb(null); }
    }
    function ytMemSave(vid, lang, cues) {
        if (!vid || !cues || !cues.length) return;
        try {
            chrome.runtime.sendMessage({
                action: 'PAMIEC_VIDEO_PUT', key: 'yt|' + vid,
                data: { site: 'youtube', lang: lang || '', id: vid, title: document.title, zd: zdOn ? 1 : 0,   // [AGENT-EXP] zd: całe zdania
                    cues: cues.map(function (c) { return [c.startMs, c.endMs, c.src, c.text || '']; }) }
            }, function () { void chrome.runtime.lastError; });
        } catch (e) {}
    }

    function autoLoad(vid, attempt, skipMem, noYtTr) {
        if (!attempt && !skipMem) {
            var memToken = ++autoToken;
            autoBusy = true;
            setStatus('Sprawdzam pamięć napisów…');
            ytMemLoad(vid, function (mem) {
                if (memToken !== autoToken) return;
                if (!mem) { autoLoad(vid, 0, true); return; }
                // [AGENT-EXP] zapis sprzed „całych zdań” (tłumaczone kawałki) — pobierz i przetłumacz jeszcze raz
                if (zdOn && !mem.zd && !/^pl/i.test(mem.lang || '')) { autoLoad(vid, 0, true); return; }
                var cues = mem.cues.map(function (c) { return { startMs: c[0], endMs: c[1], src: c[2], text: c[3] || null }; });
                ttSubs = cues;
                ttSrcLabel = 'pamięć napisów (napisy YouTube)';   // [FIX 2026-11-02] „czytam z: …"
                ttPlayed.clear(); ttPreloaded.clear();
                var missing = cues.filter(function (c) { return !c.text; }).length;
                if (!missing || /^pl/i.test(mem.lang || '')) {
                    autoBusy = false;
                    startTtLoop();
                    setStatus('Z pamięci — napisy PL: ' + cues.length + ' kwestii, lektor czyta');
                    return;
                }
                autoTranslate(cues, mem.lang, memToken); // dokończ tylko brakujące
            });
            return;
        }
        var token = ++autoToken;
        autoBusy = true;
        // [AGENT-EXP] 2026-10-21: najpierw polska wersja od YouTube („Automatyczne tłumaczenie”, tlang=pl — jak Live Dubbing):
        // tłumaczy serwer YouTube, bez limitu. Nie wyszło (ścieżka nieprzetłumaczalna, pusto, błąd) → stara droga niżej.
        if (!noYtTr && opt('ytTlangPl', true)) {
            setStatus('Pobieram polskie napisy z YouTube…');
            bridgeCall('get', { videoId: vid, tlang: 'pl' }, function (r) {
                if (token !== autoToken) return;
                if (!r.ok && /nie gotowy/i.test(r.error || '') && (attempt || 0) < 8) {
                    setTimeout(function () { if (token === autoToken) autoLoad(vid, (attempt || 0) + 1, true); }, 2000);
                    return;
                }
                var yc = r.ok && /^pl/i.test(r.lang || '') ? parseSrt(r.srt) : [];
                if (!yc.length) { autoLoad(vid, attempt, true, true); return; }
                // auto-napisy to kawałki zdań — przy „całych zdaniach” sklejamy je jak przy tłumaczeniu
                yc = zdMerge(yc, 'src').map(function (c) { return { startMs: c.startMs, endMs: c.endMs, src: c.src, text: c.src }; });
                ttSubs = yc;
                ttSrcLabel = r.ytTr ? 'napisy YouTube — tłumaczenie YouTube' : 'polskie napisy YouTube';   // [FIX 2026-11-02]
                ttPlayed.clear(); ttPreloaded.clear();
                ytMemSave(vid, 'pl', yc);
                autoBusy = false;
                startTtLoop();
                setStatus('Napisy PL' + (r.ytTr ? ' (tłumaczenie YouTube)' : '') + ': ' + yc.length + ' kwestii');
            });
            return;
        }
        setStatus('Pobieram napisy…');
        bridgeCall('get', { videoId: vid }, function (r) {
            if (token !== autoToken) return;
            if (!r.ok) {
                if ((attempt || 0) < 8 && !/nie ma napis/i.test(r.error || '')) { setTimeout(function () { if (token === autoToken) autoLoad(vid, (attempt || 0) + 1); }, 2000); return; }
                autoBusy = false;
                autoFailVid = vid; // nie ponawiamy co 3 s dla filmu bez napisów
                setStatus('Napisy: ' + (r.error || 'błąd'));
                return;
            }
            var cues = parseSrt(r.srt);
            if (!cues.length) { autoBusy = false; setStatus('Napisy: brak zdań do przeczytania'); return; }
            // [AGENT-EXP] do tłumaczenia idą całe zdania (sklejone kwestie), nie kawałki
            if (!/^pl/i.test(r.lang || '')) cues = zdMerge(cues, 'src').map(function (c) { return { startMs: c.startMs, endMs: c.endMs, src: c.src, text: null }; });
            ttSubs = cues;
            ttSrcLabel = /^pl/i.test(r.lang || '') ? 'polskie napisy YouTube' : 'napisy YouTube → tłumaczenie';   // [FIX 2026-11-02]
            ttPlayed.clear(); ttPreloaded.clear();
            if (/^pl/i.test(r.lang || '')) { // natywne polskie — bez tłumaczenia
                cues.forEach(function (c) { c.text = c.src; });
                ytMemSave(vid, r.lang, cues);
                autoBusy = false;
                startTtLoop();
                setStatus('Napisy PL: ' + cues.length + ' kwestii');
                return;
            }
            ytMemSave(vid, r.lang, cues); // plik w pamięci — przy powrocie bez pobierania
            autoTranslate(cues, r.lang, token);
        });
    }

  // [AGENT-EXP] 2026-10-17: kontekst dla tłumacza — true = tu zaczyna się nowy blok (pauza >= 2 s albo nie-sąsiednia kwestia)
  function ctxBrk(list, batch) {
    return batch.map(function (ix, j) {
      if (!j || ix !== batch[j - 1] + 1) return true;
      var a = list[batch[j - 1]], b = list[ix];
      return !a || !b || !(b.startMs - a.endMs < 2000);
    });
  }
    function autoTranslate(cues, lang, token) {
        // EXT-TRANSLATE (eksperyment): gdy extTrOn === true, kwestie ida porcjami
        // do SW (Google/Bing/DeepL rotacyjnie) zamiast do lokalnego Translatora Chrome.
        // Lokalna sciezka ponizej — NIETKNIETA, dziala jak dotad.
        // [AGENT-EXP] 2026-10-17: silnik z ustawień (domyślnie „lokalny” = angielski Translatorem Chrome); bez wymuszania
        if (opt('extTrOn', false)) { ttSrcLabel = 'napisy YouTube → tłumaczenie sieciowe'; autoTranslateExt(cues, lang, token); return; }   // [FIX 2026-11-02] źródło
        // [AGENT-EXP] 2026-10-15: „Angielski lokalnie, inne języki w chmurze” — nieangielskie napisy idą paczkami
        // do SW (EXT_TR_LIST → Bing; gdy zawiedzie — Google / DeepL) zamiast do lokalnego Translatora Chrome.
        if (opt('extTrNonEnCloud', true) && !/^(a\.)?en\b/i.test(String(lang || ''))) { ttSrcLabel = 'napisy YouTube → tłumacz w chmurze (Bing)'; autoTranslateCloud(cues, lang, token); return; }   // [FIX 2026-11-02] źródło
        ttSrcLabel = 'napisy YouTube → Translator Chrome';   // [FIX 2026-11-02] źródło
        // Na bieżąco: od okolic bieżącego czasu w przód, potem to, co było wcześniej; lektor czyta już w trakcie tłumaczenia.
        // Do tłumacza idzie samo zdanie + idx; czasy zostają w cues.
        var v = getVideo();
        var nowMs = v ? v.currentTime * 1000 : 0;
        var first = 0, i, order = [];
        while (first < cues.length && cues[first].endMs < nowMs) first++;
        for (i = first; i < cues.length; i++) order.push(i);
        for (i = 0; i < first; i++) order.push(i);
        order = order.filter(function (idx) { return !cues[idx].text; }); // z pamięci — tylko brakujące
        startTtLoop();
        var memVid = ttVideoId;
        if (!order.length) { autoBusy = false; ytMemSave(memVid, lang, cues); setStatus('Z pamięci — napisy PL: ' + cues.length + ' kwestii'); return; }
        var obrk = ctxBrk(cues, order);   // [AGENT-EXP] kontekst: bloki do pauzy w mowie
        var items = order.map(function (idx, j) { return { idx: idx, text: cues[idx].src, brk: obrk[j] }; });
        autoDone = cues.length - order.length;
        setStatus('Tłumaczę (' + lang + '→pl): 0/' + cues.length);
        bridgeCall('translate', { lang: lang, items: items, context: opt('extTrContext', true) !== false }, function (r) {
            if (token !== autoToken) return;
            if (r.part) {
                var c = cues[r.idx];
                if (!c) return;
                var t = cleanTranslationJunk(r.text || '');
                c.text = t || ''; // pusty wynik = kwestia pominięta (nie zostaje null)
                autoDone++;
                if (autoDone % 10 === 0) setStatus('Tłumaczę (' + lang + '→pl): ' + autoDone + '/' + cues.length);
                if (autoDone % 50 === 0) ytMemSave(memVid, lang, cues);
            } else if (r.done) {
                autoBusy = false;
                if (r.ok) {
                    ytMemSave(memVid, lang, cues);
                    setStatus('Gotowe — napisy PL (Translator Chrome): ' + cues.length + ' kwestii, lektor czyta');
                    startTtLoop();
                } else {
                    ttSubs = []; // brak/niepełne tłumaczenie → lektor milczy
                    autoFailVid = ttVideoId; // bez ponawiania co 3 s
                    setStatus('Tłumaczenie: ' + (r.error || 'błąd'));
                }
            }
        });
    }

    // [AGENT-EXP] 2026-10-15: nieangielskie napisy przy silniku „lokalny” — paczki po 60 kwestii (2500 znaków)
    // do SW (EXT_TR_LIST; przy „lokalnym” SW tłumaczy je Bingiem), od bieżącego miejsca filmu; lektor czyta w trakcie.
    function autoTranslateCloud(cues, lang, token) {
        var v = getVideo();
        var nowMs = v ? v.currentTime * 1000 : 0;
        var first = 0, i, order = [];
        while (first < cues.length && cues[first].endMs < nowMs) first++;
        for (i = first; i < cues.length; i++) order.push(i);
        for (i = 0; i < first; i++) order.push(i);
        order = order.filter(function (idx) { return !cues[idx].text; }); // z pamięci — tylko brakujące
        startTtLoop();
        var memVid = ttVideoId;
        if (!order.length) { autoBusy = false; ytMemSave(memVid, lang, cues); setStatus('Z pamięci — napisy PL: ' + cues.length + ' kwestii'); return; }
        autoDone = cues.length - order.length;
        setStatus('Tłumaczę w chmurze (' + lang + '→pl, Bing): ' + autoDone + '/' + cues.length);
        var fails = 0;
        var next = function () {
            if (token !== autoToken) return;
            if (!order.length) {
                autoBusy = false;
                ytMemSave(memVid, lang, cues);
                setStatus('Gotowe — napisy PL (chmura, Bing): ' + cues.length + ' kwestii, lektor czyta');
                return;
            }
            var batch = [], chars = 0;
            while (order.length && batch.length < 60 && chars < 2500) { var ix = order.shift(); batch.push(ix); chars += cues[ix].src.length + 1; }
            try {
                chrome.runtime.sendMessage({ action: 'EXT_TR_LIST', src: lang, brk: ctxBrk(cues, batch), texts: batch.map(function (ix) { return cues[ix].src; }) }, function (r) {   // [AGENT-EXP] brk: kontekst
                    void chrome.runtime.lastError;
                    if (token !== autoToken) return;
                    if (!r || !r.ok || !Array.isArray(r.texts)) {
                        if (++fails > 5) { autoBusy = false; setStatus('Tłumaczenie w chmurze przerwane (brak odpowiedzi tłumacza)'); return; }
                        order = batch.concat(order);
                        setTimeout(next, 5000);
                        return;
                    }
                    fails = 0;
                    batch.forEach(function (ix, j) { cues[ix].text = cleanTranslationJunk(r.texts[j] || '') || ''; });
                    autoDone += batch.length;
                    setStatus('Tłumaczę w chmurze (' + lang + '→pl, Bing): ' + autoDone + '/' + cues.length);
                    if (autoDone % 120 < batch.length) ytMemSave(memVid, lang, cues);
                    next();
                });
            } catch (e) { autoBusy = false; setStatus('Tłumaczenie w chmurze: ' + ((e && e.message) || e)); }
        };
        next();
    }

    // ===== EXT-TRANSLATE (eksperyment): tlumaczenie sieciowe porcjami =====
    // Kwestie ida do SW (EXT_TR_PUSH) w kolejnosci od biezacego czasu; SW tnie
    // na porcje wyrazowe (100/300/400/mieszane), tlumaczy rotacyjnie i odsyla
    // gotowe porcje (EXT_TR_PART) + koniec (EXT_TR_DONE). Lektor czyta na biezaco.
    var extTrJobSeq = 0, extTrJobId = null;
    function autoTranslateExt(cues, lang, token) {
        var v = getVideo();
        var nowMs = v ? v.currentTime * 1000 : 0;
        var first = 0, i, order = [];
        while (first < cues.length && cues[first].endMs < nowMs) first++;
        for (i = first; i < cues.length; i++) order.push(i);
        for (i = 0; i < first; i++) order.push(i);
        order = order.filter(function (idx) { return !cues[idx].text; }); // z pamięci — tylko brakujące
        startTtLoop();
        var memVid = ttVideoId;
        if (!order.length) { autoBusy = false; ytMemSave(memVid, lang, cues); setStatus('Z pamięci — napisy PL: ' + cues.length + ' kwestii'); return; }
        var items = order.map(function (idx) { return { idx: idx, text: cues[idx].src }; });
        autoDone = cues.length - order.length;
        extTrJobSeq++;
        extTrJobId = 'yt_' + ttVideoId + '_' + extTrJobSeq;
        var myJob = extTrJobId;
        var onExtMsg = function (msg) {
            if (!msg || msg.jobId !== myJob) return;
            if (token !== autoToken) { try { chrome.runtime.onMessage.removeListener(onExtMsg); } catch (e) {} return; }
            if (msg.action === 'EXT_TR_PART') {
                var c = cues[msg.idx];
                if (!c) return;
                var t = cleanTranslationJunk(msg.text || '');
                c.text = t || '';
                c.extEngine = msg.engine || '';
                autoDone++;
                if (autoDone % 10 === 0 || autoDone === cues.length) setStatus('Tłumaczę sieciowo (' + (msg.engine || '?') + '): ' + autoDone + '/' + cues.length);
                if (autoDone % 50 === 0) ytMemSave(memVid, lang, cues);
            } else if (msg.action === 'EXT_TR_DONE') {
                try { chrome.runtime.onMessage.removeListener(onExtMsg); } catch (e) {}
                autoBusy = false;
                ytMemSave(memVid, lang, cues);
                setStatus('Gotowe — napisy PL (sieciowo): ' + cues.length + ' kwestii, lektor czyta');
                startTtLoop();
            }
        };
        try { chrome.runtime.onMessage.addListener(onExtMsg); } catch (e) {}
        setStatus('Tłumaczę sieciowo (' + lang + '→pl): 0/' + cues.length);
        try {
            chrome.runtime.sendMessage({ action: 'EXT_TR_PUSH', jobId: myJob, lang: lang, items: items }, function () { void chrome.runtime.lastError; });
        } catch (e) {
            autoBusy = false;
            setStatus('Tłumaczenie sieciowe: ' + (e && e.message || e));
        }
    }
    function autoCancelExt() {
        if (extTrJobId) {
            try { chrome.runtime.sendMessage({ action: 'EXT_TR_CANCEL', jobId: extTrJobId }, function () { void chrome.runtime.lastError; }); } catch (e) {}
            extTrJobId = null;
        }
    }

    var lastTtTime = -1, ttResync = false;
    // [FIX 2026-11-02] skąd są kwestie osi czasu — wskaźnik „czytam z: …” (pasek 📊, arkusz ⚙, popup)
    var ttSrcLabel = '', ttSrcSent = '';
    function ttNoteSource() {
        var name = IS_EMBED ? 'oś czasu YouTube (podgląd Hover)' : (ttSrcLabel || 'napisy YouTube');
        if (name + ttSubs.length === ttSrcSent) return;
        ttSrcSent = name + ttSubs.length;
        try { window.__LektorSched.setSource(name, ttSubs.length); } catch (e) {}
    }
    var ttPolishStop = false;   // [FIX 2026-11-02] film po polsku: lektor uciszony (jednorazowo)
    function startTtLoop() {
        if (ttTimer) return;
        ttTimer = setInterval(function () {
            if (!enabled || ttSubs.length === 0) return;
            var wTle = document.visibilityState !== 'visible';   // [AGENT-EXP] karta w tle: tylko buforowanie
            if (wTle && window.__lektorBufTlo === false) return;
            if (!IS_EMBED && fileSubs.length) return; // plik ma pierwszeństwo (tylko strona główna)
            var v = getVideo();
            if (!v) return;
            var ttPauza = v.paused || __embedPausedByUser;   // [AGENT-EXP] pauza: tylko buforowanie, bez czytania
            if (ttPauza && window.__lektorBufPauza === false) return;
            // [FIX 2026-11-02] film po polsku (ścieżka audio / mowa) — lektor milczy także przy całych napisach. Wcześniej
            // sprawdzał to tylko skan „na żywo”, więc przy pełnych napisach (domyślnie WŁ.) lektor czytał polskie napisy
            // na polskiej mowie, a od 2026-10-28 dodatkowo bez ściszania filmu.
            if (!IS_EMBED && subScreenOnly) return;   // [AGENT-EXP] 2026-11-14: „Tylko Immersive Translate” = czytamy ekran
            if (!IS_EMBED && isPolishVideo()) {
                // [AGENT-EXP] 2026-11-14: polski film → lektor MILCZY (nie czytamy polskich napisów na polskiej mowie),
                // ale napisy są już pobrane (autoLoad działa niezależnie) i korzysta z nich cenzor.
                if (!ttPolishStop) { ttPolishStop = true; stopSpeechSilently(); }   // raz: ucisz to, co już zaczęło grać
                if (savedVolume !== null || duckMemGet() !== null) restoreVolume();
                return;
            }
            ttPolishStop = false;
            var nowMs = v.currentTime * 1000;
            // Przewinięcie / wznowienie po pauzie / skok >1.5 s → czytamy od nowa od bieżącej pozycji.
            if (ttResync || (lastTtTime >= 0 && Math.abs(nowMs - lastTtTime) > 1500)) { ttPlayed.clear(); ttPreloaded.clear(); ttResync = false; ttLastList = null; }
            if (ttLastList !== ttSubs) { ttLastList = ttSubs; ttRestorePlayed(nowMs, getOff()); }   // [AGENT-EXP] 2026-10-26: bez dubla bieżącego zdania
            lastTtTime = nowMs;
            var off = getOff();
            // [FIX 2026-11-02] wspólny harmonogram (assets/lektor_scheduler.js): nagrywanie do przodu, czytanie, okno kwestii
            // i tempo filmu — ta sama logika co na Netfliksie, stronach DOM i przy całych napisach.
            var S = window.__LektorSched;
            ttNoteSource();
            S.tick({
                list: ttSubs, nowMs: nowMs, off: off, rate: v.playbackRate || 1, lookaheadMs: fileLookahead,
                budget: S.budgetFor(v), canPlay: S.canPlay(v) && !__embedPausedByUser,
                preloaded: ttPreloaded, played: ttPlayed,
                keyOf: function (c) { return c; },
                idOf: function (c, i) { return (IS_EMBED ? 'em_tt_' : 'tt_') + i; },
                onPlay: function (sub) {
                    ttSpokenAdd(sub.startMs, sub.endMs);   // [AGENT-EXP] 2026-10-26
                    pushSpoken(sub.text);
                    var w = String(sub.text || '').trim().split(/\s+/).filter(Boolean).length;
                    spokenWords += w;
                    spokenCues++;
                    recentSpoken.push({ t: sub.text, w: w });
                    if (recentSpoken.length > 5) recentSpoken.shift();
                    applyDuck();
                    if (isBlockedPhrase(sub.text)) return false;
                    if (window.__LivedubPanel) {
                        if (window.__LivedubPanel.isBlocked(sub.text)) { window.__LivedubPanel.log(sub.text, 'blocked'); return false; }
                        window.__LivedubPanel.log(sub.text, 'spoken');
                    }
                    optPauseForLektor(); // OPTIONS-PAGE
                },
                afterPlay: function (sub) {
                    // === EMBED: ducking strony glownej na czas kwestii z osi czasu ===
                    if (!IS_EMBED) return;
                    try { window.top.postMessage({ __livedubDuck: 1, on: 1, len: String(sub.text).length }, location.origin); } catch (e) {}
                    livedubDuckBC('duck', String(sub.text).length);
                }
            });
        }, 50);
    }

    // [AGENT-EXP] 2026-10-17: 📊 pasek postępu lektora (assets/lektor_bar.js) — plik ma pierwszeństwo jak w czytaniu
    try {
        (window.__lektorBarProviders = window.__lektorBarProviders || {}).youtube = function () {
            var v = getVideo();
            // [FIX 2026-11-22] reklama gra w tym samym <video> — jej czas to nie czas filmu, pasek się chowa
            try { var pl = v && v.closest && v.closest('.html5-video-player'); if (pl && pl.classList.contains('ad-showing')) return null; } catch (eA) {}
            // [FIX 2026-11-22] off: przesunięcie napisów — to samo, którego używa harmonogram lektora
            if (!IS_EMBED && fileSubs.length) return { video: v, list: fileSubs, off: getOff, ready: function (c) { return !!c.text; }, spoken: function (c) { return filePlayed.has(c) || filePlayed.has(c.id); }, audioId: function (c) { return c.id; } };
            if (!ttSubs.length) return null;
            return { video: v, list: ttSubs, off: getOff, ready: function (c) { return !!c.text; }, spoken: function (c) { return ttPlayed.has(c); }, audioId: function (c, i) { return (IS_EMBED ? 'em_tt_' : 'tt_') + i; } };
        };
    } catch (e) {}

    // Zmiana filmu (SPA) + start.
    document.addEventListener('yt-navigate-finish', ttMaybeReload);

    // [AGENT-EXP] 2026-11-14: TE SAME napisy dla cenzora — także gdy lektor milczy (polski film) albo jest wyłączony.
    // Wcześniej cenzor dostawał tylko to, co sam złapał hookiem sieci (drugie obejrzenie z pamięci = nic).
    var czSig = '';
    setInterval(function () {
        if (IS_EMBED || !ttSubs.length) return;
        var sig = ttSubs.length + '|' + String((ttSubs[0] && (ttSubs[0].text || ttSubs[0].src)) || '').slice(0, 24);
        if (sig === czSig) return;
        czSig = sig;
        try {
            window.postMessage({ __lektorCenzor: 'cues', key: 'youtube', cues: ttSubs.map(function (c) {
                return { startMs: c.startMs, endMs: c.endMs, text: c.text || '', orig: c.src || '' };
            }) }, location.origin);
        } catch (e) {}
    }, 3000);
    setInterval(ttMaybeReload, 3000);
    ttMaybeReload();

    // --- Start ---
    loadSettings();
    initZeroLagObserver();
})();