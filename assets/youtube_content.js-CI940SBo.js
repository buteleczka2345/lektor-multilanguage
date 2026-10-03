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

    // === Sonda: znacznik życia pliku (widoczny ze zwykłej konsoli) ===
    try { document.documentElement.setAttribute('data-livedub-loaded', '1'); } catch (e) {}

    // === EMBED: czy to ramka podglądu userscripta (/embed/<ID>)? ===
    var IS_EMBED = /^\/embed\//.test(location.pathname);
    try { document.documentElement.setAttribute('data-livedub-mode', IS_EMBED ? 'embed' : 'page'); } catch (e) {}

    // =========================================================================
    // SELEKTORY IMMERSIVE TRANSLATE
    // =========================================================================
    var TARGET_SELECTORS = ['.imt-captions-text', '.imt-cue', '[class*="imt-"]', '[class*="immersive-translate"]'];
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
    var USE_TIMEDTEXT = false;       // strona główna: czyta WYŁĄCZNIE z IMT (w EMBED oś czasu działa zawsze)
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

    // Mocne wulgaryzmy PL+EN — wycinane z mowy lektora.
    var LIVEDUB_PROFANITY_RE = /(\b\p{L}*(?:kurw|chuj|huj|jeb|pizd|pierdol|pierdal|cipk|cip[aeęyiu]|dziwk|szmat|g[óo]wn|fuck|motherfuck|cunt|cocksuck|wank|whore|slut|pussy|shit)[^\s]*)/giu;

    var IMMT_POLL_MS = 50, DEBOUNCE_MS = 30;

    // --- Stan ---
    var enabled = true, engine = 'offline', duckLevel = 20, savedVolume = null, video = null;
    var lastSubtitle = '', playingIds = new Set();
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
        chrome.storage.local.get(['enabled', 'duckLevel', 'engine', 'subtitleOffsetMs'], function (res) {
            if (res.enabled !== undefined) enabled = !!res.enabled;
            if (res.duckLevel !== undefined) duckLevel = clampPct(res.duckLevel);
            if (res.engine !== undefined) engine = res.engine;
            if (typeof res.subtitleOffsetMs === 'number') storageOffsetMs = res.subtitleOffsetMs;
            if (engine !== 'offline') console.warn('[LiveDub] Silnik != offline. Tryb Immersive→Piper wymaga "Offline (Piper)" w popupie.');
            if (enabled && document.visibilityState === 'visible' && !IS_EMBED) applyDuck();
        });
    }
    chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        if (changes.enabled !== undefined) { enabled = !!changes.enabled.newValue; if (enabled) { lastSubtitle = ''; lastMainSubtitle = ''; lastHoverSubtitle = ''; if (document.visibilityState === 'visible' && !IS_EMBED) applyDuck(); } else stopSpeechSilently(); }
        if (changes.duckLevel !== undefined) { duckLevel = clampPct(changes.duckLevel.newValue); if (enabled && document.visibilityState === 'visible') { if (!IS_EMBED) applyDuck(); else if (__embDuckSaved !== null) { try { var vD = getVideo(); if (vD) vD.volume = Math.min(__embDuckSaved, duckLevel / 100); } catch (eD) {} } } }
        if (changes.engine !== undefined) engine = changes.engine.newValue;
        if (changes.subtitleOffsetMs !== undefined) storageOffsetMs = Number(changes.subtitleOffsetMs.newValue) || 0;
    });

    function clampPct(v) { v = Number(v); if (!isFinite(v)) return 20; return Math.max(0, Math.min(100, v)); }

    // --- Element wideo + ducking ---
    function getVideo() {
        if (video && video.isConnected) return video;
        video = document.querySelector('video.html5-main-video') || document.querySelector('video');
        if (video) {
            video.addEventListener('seeked', function () { playingIds.clear(); stopSpeechSilently(); });
            video.addEventListener('pause', function () { stopSpeechSilently(); });
            video.addEventListener('volumechange', function () {
                // Nie walczymy z suwakiem usera: dokrecanie max raz na 2 s.
                if (!enabled || !tabFocused || IS_EMBED) return;
                var now = Date.now();
                if (now - __duckLastApply < 2000) return;
                __duckLastApply = now;
                applyDuck();
            });
            video.addEventListener('play', function () { if (enabled && !IS_EMBED) applyDuck(); });
            if (enabled && tabFocused && !IS_EMBED) applyDuck();
        }
        return video;
    }
    // === EMBED: w ramce NIE duckujemy (mute oryginału załatwia sprawę); duck robi strona główna ===
    function applyDuck() {
        if (IS_EMBED) return;
        var v = getVideo(); if (!v) return;
        var target = duckLevel / 100;
        if (savedVolume === null && v.volume > target) savedVolume = v.volume;
        if (savedVolume !== null) {
            v.volume = Math.min(target, savedVolume);
        } else if (v.volume > target) {
            v.volume = target;
        }
    }
    function restoreVolume() { var v = getVideo(); if (v && savedVolume !== null) v.volume = savedVolume; savedVolume = null; }

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
    function emitTTS(text, source) {
        if (!text || isBlockedPhrase(text) || engine !== 'offline') return;
        if (!IS_EMBED && document.visibilityState !== 'visible') return;
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
    function stopSpeechSilently() {
        if (engine === 'offline') chrome.runtime.sendMessage({ action: 'TTS_CLEAR_BUFFER' });
        playingIds.clear(); if (!IS_EMBED) restoreVolume();
    }

    // --- Czyszczenie tekstu ---
    function cleanTranslationJunk(text) {
        if (!text) return '';
        text = text.replace(/^\s*[>›»]+ ?/g, ' '); // znaczniki „>> co to jest" z napisow YT
        text = text.replace(/^\s*[♪♫]+ ?/g, ' '); // oznaczenia muzyki
        text = text.replace(/^\s*[-–—]+ ?/g, ' '); // myslniki dialogowe
        text = text.replace(/\s+/g, ' ').trim();
        text = text.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/（[^）]*）/g, ' ').replace(/【[^】]*】/g, ' ').replace(/\s{2,}/g, ' ').trim();
        if (text && LIVEDUB_HARD_BLOCK_RE.test(text)) return '';
        text = text.replace(LIVEDUB_PROFANITY_RE, ' ').replace(/\s{2,}/g, ' ').trim();
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

    // Rekurencyjny scraper: DOM + Shadow DOM, tylko tekst DOCZELOWY (tagowany {text, hover}).
    function collectTextFromRoot(root, results) {
        if (!root) return results;
        results = results || [];
        for (var i = 0; i < TARGET_SELECTORS.length; i++) {
            var sel = TARGET_SELECTORS[i];
            try {
                var nodes = root.querySelectorAll(sel);
                for (var j = 0; j < nodes.length; j++) {
                    var node = nodes[j];
                    if (isOriginNode(node)) continue;
                    var text = cleanTranslationJunk(node.innerText || node.textContent || '');
                    if (text.length >= 2 && !/^\d+:\d+/.test(text)) results.push({ text: text, hover: isHoverNode(node) });
                }
            } catch (e) {}
        }
        var all;
        try { all = root.querySelectorAll('*'); } catch (e) { all = []; }
        for (var k = 0; k < all.length; k++) {
            var sr = null;
            try { sr = all[k].shadowRoot; } catch (e) { sr = null; }
            if (sr) collectTextFromRoot(sr, results);
        }
        return results;
    }

    // Podział na kanały: najświeższy main + najświeższy hover (osobno).
    function getImtSubtitles() {
        var items = collectTextFromRoot(document);
        var main = null, hover = null;
        for (var i = items.length - 1; i >= 0; i--) {
            if (!hover && items[i].hover) hover = items[i].text;
            if (!main && !items[i].hover) main = items[i].text;
            if (main && hover) break;
        }
        return { main: main, hover: hover };
    }

    // Auto-wyłącz: natywna polska ścieżka audio → nie dublujemy (tylko strona główna).
    function detectPolishAudioTrack() {
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
                var txt = rows[i].innerText || rows[i].textContent || '';
                if (/polski/i.test(txt) && /selected|active/i.test(rows[i].className || '')) return true;
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
        if (!IS_EMBED && document.visibilityState !== 'visible') return;
        if (IS_EMBED) { embedScan(); return; }
        if (detectPolishAudioTrack()) { stopSpeechSilently(); return; }
        muteHoverPreview();
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
        if (USE_TIMEDTEXT && ttSubs.length) return;
        if (!s.main || s.main === lastMainSubtitle) return;
        lastMainSubtitle = s.main;
        lastSubtitle = s.main;
        clearTimeout(mainDebounceTimer);
        mainDebounceTimer = setTimeout(function () { applyDuck(); emitTTS(s.main, 'main'); }, DEBOUNCE_MS + Math.max(0, getOff()));
    }

    // === ZERO-LAG: MutationObserver + poll 50 ms ===
    function initZeroLagObserver() {
        if (typeof MutationObserver === 'undefined') return;
        if (observer) observer.disconnect();
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }

        observer = new MutationObserver(function () {
            if (!enabled) return;
            scanImmersiveSubtitles();
        });

        try {
            observer.observe(document.body || document.documentElement, {
                childList: true,
                subtree: true,
                characterData: true
            });
        } catch (e) {}

        pollTimer = setInterval(function () {
            if (enabled) scanImmersiveSubtitles();
        }, IMMT_POLL_MS);
    }

    // --- Focus / cross-tab audio-focus ---
    function onFocus() { tabFocused = true; if (bc) bc.postMessage({ cmd: 'active' }); if (enabled && !IS_EMBED) applyDuck(); }
    function onBlur() { tabFocused = false; if (bc) bc.postMessage({ cmd: 'inactive' }); }
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') { tabFocused = true; if (enabled && !IS_EMBED) applyDuck(); }
        else { tabFocused = false; stopSpeechSilently(); }
    });
    if (bc) bc.onmessage = function (ev) {
        var d = ev.data || {};
        if (d.cmd === 'active' && !tabFocused) stopSpeechSilently();
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
            else if (d.cmd === 'play') { livedubEmbedSetPaused(false); try { if (__embedStopBtn && __embedStopBtn._sync) __embedStopBtn._sync(); } catch (eS2) {} } if (false) livedubEmbedSetPaused(false);
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
        if (false) {
        var stopBtn2 = document.getElementById('livedub-hover-stop');
        if (!stopBtn) {
            stopBtn = document.createElement('button');
            stopBtn.id = 'livedub-hover-stop';
            stopBtn.title = 'Lektor: STOP podglądu Hover (pauza ramki)';
            stopBtn.textContent = '⏹▶';
            stopBtn.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:2147483646;background:rgba(18,18,22,0.85);color:#eee;border:1px solid rgba(255,255,255,0.25);border-radius:999px;padding:5px 10px;font:11px system-ui,sans-serif;cursor:pointer;display:none;';
            stopBtn.addEventListener('click', function (ev) {
                ev.preventDefault(); ev.stopPropagation();
                __embedPausedByUser = !__embedPausedByUser;
                livedubHoverCtl(__embedPausedByUser ? 'pause' : 'play');
                stopBtn.textContent = __embedPausedByUser ? '▶ Wznów preview' : '⏹▶';
                try { chrome.runtime.sendMessage({ action: 'TTS_CLEAR_BUFFER' }); } catch (e) {}
            });
            (document.body || document.documentElement).appendChild(stopBtn);
        }
        // Ramka Hover siedzi w closed shadow - querySelector jej nie znajdzie.
        // Na /watch pokazuj Stop zawsze: pauza preview dziala przez BC niezaleznie od TTS.
        try {
            var onWatch = /\/watch/.test(location.pathname || '');
            stopBtn.style.display = onWatch ? 'block' : 'none';
        } catch (e) {}
        } // koniec if(false) - przycisk topu usuniety
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
    setInterval(livedubEnsureButton, 1000);

    // --- Telemetria dla popupu (tylko top; ramka Hover nie spamuje) ---
    if (!IS_EMBED) setInterval(function () {
        try {
            chrome.runtime.sendMessage({
                action: 'REC_TELEMETRY',
                platform: 'youtube',
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
    function fileApply(f) {
        if (IS_EMBED) return;
        if (f && Array.isArray(f.cues) && f.cues.length) {
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
            var v = getVideo();
            if (!v) return;
            var nowMs = v.currentTime * 1000;
            var off = getOff();
            var preBudget = 4;
            for (var i = 0; i < fileSubs.length; i++) {
                var sub = fileSubs[i];
                var startT = sub.startMs + off;
                var endT = sub.endMs + off;
                if (nowMs > endT + 1000) continue;
                if (!filePreloaded.has(sub.id) && startT >= nowMs && startT <= nowMs + fileLookahead && preBudget > 0) {
                    preBudget--;
                    filePreloaded.add(sub.id);
                    chrome.runtime.sendMessage({ action: 'TTS_PRELOAD', id: sub.id, text: sub.text, startMs: startT, endMs: endT });
                }
                if (!filePlayed.has(sub.id) && nowMs >= startT && nowMs < endT) {
                    filePlayed.add(sub.id);
                    pushSpoken(sub.text);
                    var w = String(sub.text || '').trim().split(/\s+/).filter(Boolean).length;
                    spokenWords += w;
                    spokenCues++;
                    recentSpoken.push({ t: sub.text, w: w });
                    if (recentSpoken.length > 5) recentSpoken.shift();
                    applyDuck();
                    if (isBlockedPhrase(sub.text)) continue;
                    chrome.runtime.sendMessage({
                        action: 'TTS_PLAY', id: sub.id, text: sub.text,
                        durationMs: sub.endMs - sub.startMs,
                        startMs: startT, endMs: endT
                    });
                }
                if (startT > nowMs + fileLookahead) break;
            }
        }, 50);
    }
    try {
        chrome.storage.local.get(['fileSubs', 'lookaheadMin'], function (r) {
            var m = Number(r && r.lookaheadMin);
            if (!isNaN(m) && r.lookaheadMin !== undefined) fileLookahead = m > 0 ? m * 60000 : 0;
            fileApply(r && r.fileSubs);
        });
        chrome.storage.onChanged.addListener(function (ch, area) {
            if (area !== 'local') return;
            if (ch.fileSubs !== undefined) fileApply(ch.fileSubs.newValue);
            if (ch.lookaheadMin !== undefined) {
                var m2 = Number(ch.lookaheadMin.newValue);
                if (!isNaN(m2)) fileLookahead = m2 > 0 ? m2 * 60000 : 0;
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
        if (!USE_TIMEDTEXT && !IS_EMBED) { ttSubs = []; ttPlayed.clear(); ttPreloaded.clear(); return; }
        var vid = ttGetVideoId();
        if (!vid) { ttSubs = []; return; }
        if (vid === ttVideoId && ttSubs.length) return;
        ttVideoId = vid;
        ttSubs = [];
        ttPlayed.clear();
        ttPreloaded.clear();
        ttLoad(vid, 0);
    }

    var lastTtTime = -1;
    function startTtLoop() {
        if (ttTimer) return;
        ttTimer = setInterval(function () {
            if (!enabled || ttSubs.length === 0) return;
            if (!IS_EMBED && fileSubs.length) return; // plik ma pierwszeństwo (tylko strona główna)
            var v = getVideo();
            if (!v || v.paused || __embedPausedByUser) return;
            var nowMs = v.currentTime * 1000;
            if (lastTtTime >= 0 && Math.abs(nowMs - lastTtTime) > 1500) { ttPlayed.clear(); ttPreloaded.clear(); }
            lastTtTime = nowMs;
            var off = getOff();
            var preBudget = 4;
            for (var i = 0; i < ttSubs.length; i++) {
                var sub = ttSubs[i];
                var startT = sub.startMs + off;
                var endT = sub.endMs + off;
                if (nowMs > endT + 1000) continue;
                if (!ttPreloaded.has(sub) && startT >= nowMs && startT <= nowMs + fileLookahead && preBudget > 0) {
                    preBudget--;
                    ttPreloaded.add(sub);
                    chrome.runtime.sendMessage({ action: 'TTS_PRELOAD', id: (IS_EMBED ? 'em_tt_' : 'tt_') + i, text: sub.text, startMs: startT, endMs: endT });
                }
                if (!ttPlayed.has(sub) && nowMs >= startT && nowMs < endT) {
                    ttPlayed.add(sub);
                    pushSpoken(sub.text);
                    var w = String(sub.text || '').trim().split(/\s+/).filter(Boolean).length;
                    spokenWords += w;
                    spokenCues++;
                    recentSpoken.push({ t: sub.text, w: w });
                    if (recentSpoken.length > 5) recentSpoken.shift();
                    applyDuck();
                    if (isBlockedPhrase(sub.text)) continue;
                    chrome.runtime.sendMessage({
                        action: 'TTS_PLAY', id: (IS_EMBED ? 'em_tt_' : 'tt_') + i, text: sub.text,
                        durationMs: sub.endMs - sub.startMs,
                        startMs: startT, endMs: endT
                    });
                    // === EMBED: ducking strony glownej na czas kwestii z osi czasu ===
                    if (IS_EMBED) {
                        try { window.top.postMessage({ __livedubDuck: 1, on: 1, len: String(sub.text).length }, location.origin); } catch (e) {}
                        livedubDuckBC('duck', String(sub.text).length);
                    }
                }
                if (startT > nowMs + fileLookahead) break;
            }
        }, 50);
    }

    // Zmiana filmu (SPA) + start.
    document.addEventListener('yt-navigate-finish', ttMaybeReload);
    setInterval(ttMaybeReload, 3000);
    ttMaybeReload();

    // --- Start ---
    loadSettings();
    initZeroLagObserver();
})();