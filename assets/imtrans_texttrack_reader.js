// imtrans_texttrack_reader.js — MAIN world (strona z filmem), document_start
// Czyta napisy na żywo z video.textTracks (HTML5 video) i przekazuje je do Multilektora (TTS_PLAY).
// CENZOR DZIAŁA NIEZALEŻNIE OD LEKTORA — wycisza wideo przy przekleństwach z napisów na ekranie.

(function () {
    'use strict';
    if (window.__lektorTextTrackReader) return;
    window.__lektorTextTrackReader = true;

    var enabled = true;
    var censorLive = true;
    var censorBufferMs = 500;   // cisza przed słowem (ms)
    var censorHoldMs = 1000;    // cisza po słowie (ms)
    var lastText = '';
    var lastDomText = '';
    var lastTime = 0;
    var debounceMinMs = 250;
    var videos = new Map();
    var muteTimers = new Map();
    var hasFileSubs = false;
    var NO_TTS = /(^|\.)facebook\.com$/.test(location.hostname || '');   // [FIX 2026-11-16] Facebook: cenzor tak, lektor nie

    function loadSettings() {
        try {
            chrome.storage.local.get(['imtransTextTrackReader', 'cenzorLive', 'cenzorBufferMs', 'cenzorHoldMs'], function (r) {
                if (r && Object.prototype.hasOwnProperty.call(r, 'imtransTextTrackReader')) {
                    enabled = r.imtransTextTrackReader !== false;
                }
                if (r && Object.prototype.hasOwnProperty.call(r, 'cenzorLive')) {
                    censorLive = r.cenzorLive !== false;
                }
                if (r && Object.prototype.hasOwnProperty.call(r, 'cenzorBufferMs')) {
                    censorBufferMs = Number(r.cenzorBufferMs) || 500;
                }
                if (r && Object.prototype.hasOwnProperty.call(r, 'cenzorHoldMs')) {
                    censorHoldMs = Number(r.cenzorHoldMs) || 1000;
                }
            });
            chrome.storage.onChanged.addListener(function (changes) {
                if (changes.imtransTextTrackReader) {
                    enabled = changes.imtransTextTrackReader.newValue !== false;
                }
                if (changes.cenzorLive) {
                    censorLive = changes.cenzorLive.newValue !== false;
                }
                if (changes.cenzorBufferMs) {
                    censorBufferMs = Number(changes.cenzorBufferMs.newValue) || 500;
                }
                if (changes.cenzorHoldMs) {
                    censorHoldMs = Number(changes.cenzorHoldMs.newValue) || 1000;
                }
            });
        } catch (e) {}
    }
    loadSettings();

    function sendTTS(text) {
        if (!enabled) return;
        if (NO_TTS) return;   // [FIX 2026-11-16] na Facebooku tylko wyciszamy — nic nie czytamy
        if (!text || typeof text !== 'string') return;
        text = text.replace(/\s+/g, ' ').trim();
        if (!text || text === lastText) return;
        var now = Date.now();
        if (now - lastTime < debounceMinMs) return;
        lastText = text;
        lastTime = now;
        try {
            chrome.runtime.sendMessage({
                action: 'TTS_PLAY',
                id: 'tt_' + now + '_' + Math.random().toString(36).slice(2, 8),
                text: text,
                durationMs: 0,
                source: 'imtrans-texttrack'
            });
        } catch (e) {}
    }
    function checkFileSubs() {
        try {
            chrome.storage.local.get('fileSubs', function (r) {
                if (r && r.fileSubs && r.fileSubs.cues && r.fileSubs.cues.length > 0) {
                    hasFileSubs = true;
                } else {
                    hasFileSubs = false;
                }
            });
        } catch (e) { hasFileSubs = false; }
    }
    checkFileSubs();
    setInterval(checkFileSubs, 5000);

    function hasProfanity(text) {
        if (!text || typeof text !== 'string') return false;
        var engine = window.__lektorCensor || null;
        if (!engine || !engine.findMatches) return false;
        try {
            var matches = engine.findMatches(text);
            return matches && matches.length > 0;
        } catch (e) { return false; }
    }

    function applyMute(video, want) {
        if (!video) return;
        var oldTimer = muteTimers.get(video);
        if (oldTimer) {
            clearTimeout(oldTimer);
            muteTimers.delete(video);
        }
        if (want) {
            try { video.muted = true; } catch (e) {}
            // Całkowity czas wyciszenia = bufor przed + trzymanie po (tak jak w czasy ciszy cenzora)
            var restoreAfter = censorBufferMs + censorHoldMs;
            var timer = setTimeout(function () {
                try {
                    if (video && video.muted) video.muted = false;
                } catch (e) {}
                muteTimers.delete(video);
            }, restoreAfter);
            muteTimers.set(video, timer);
        } else {
            try { video.muted = false; } catch (e) {}
        }
    }

    // [FIX 2026-11-16] PLIK MA PIERWSZEŃSTWO: przy wczytanym pliku napisów ciszę planuje główny cenzor
    // (cenzor_main.js — okna z pliku), więc ten tor live w ogóle nie wycisza.
    function fileCensorRules() {
        try {
            var s = window.lektorCenzor && window.lektorCenzor.status ? window.lektorCenzor.status() : null;
            return !!(s && s.on && s.cueMode && s.cues > 0 && s.priority !== 'live');   // [FIX 2026-11-16] priorytet „live” = ekran tnie także tutaj
        } catch (e) { return false; }
    }

    function handleSubtitleText(video, text) {
        if (!text || typeof text !== 'string') return;
        text = text.replace(/\s+/g, ' ').trim();
        if (!text) return;

        sendTTS(text);

        if (enabled && censorLive && video && !fileCensorRules() && hasProfanity(text)) {
            applyMute(video, true);
        }
    }
    function setupVideo(video) {
        if (!video || videos.has(video)) return;
        if (!video.textTracks || typeof video.textTracks !== 'object') return;

        var info = { track: null, handler: null };

        function pickTrack() {
            var tracks = video.textTracks;
            for (var i = 0; i < tracks.length; i++) {
                var t = tracks[i];
                if (t && (t.kind === 'subtitles' || t.kind === 'captions')) {
                    return t;
                }
            }
            return null;
        }

        var track = pickTrack();
        if (!track) return;

        info.track = track;

        info.handler = function () {
            if (!enabled) return;
            try {
                var cues = track.activeCues;
                if (cues && cues.length > 0) {
                    var text = String(cues[0].text || '').trim();
                    if (text) handleSubtitleText(video, text);
                }
            } catch (e) {}
        };

        track.addEventListener('cuechange', info.handler, { passive: true });

        if (track.activeCues && track.activeCues.length > 0) {
            info.handler();
        }

        videos.set(video, info);
    }

    function startObserver() {
        var observer = new MutationObserver(function (mutations) {
            for (var m = 0; m < mutations.length; m++) {
                var nodes = mutations[m].addedNodes;
                for (var n = 0; n < nodes.length; n++) {
                    var node = nodes[n];
                    if (node && node.nodeType === 1) {
                        if (node.tagName === 'VIDEO') {
                            setupVideo(node);
                        }
                        if (node.querySelectorAll) {
                            try {
                                var vids = node.querySelectorAll('video');
                                for (var v = 0; v < vids.length; v++) {
                                    setupVideo(vids[v]);
                                }
                            } catch (e) {}
                        }
                    }
                }
            }
        });

        try {
            observer.observe(document.body, { childList: true, subtree: true });
        } catch (e) {}

        try {
            var existing = document.querySelectorAll('video');
            for (var i = 0; i < existing.length; i++) {
                setupVideo(existing[i]);
            }
        } catch (e) {}
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startObserver);
    } else {
        startObserver();
    }
    var TR_SELECTORS = [
        '.imt-captions-text',
        '.imt-cue',
        '.immersive-translate-subtitle',
        '[data-immersive-translate-translation-element="target"]',
        '.immersive-translate-target-inner',
        '.immersive-translate-target-translation',
        '#immersive-translate-caption-window'
    ];
    var domTimer = null;

    function domText(node) {
        // [AGENT-EXP] 2026-11-17: napis z kreskami (tryb „dashes” w cenzorze) trzyma oryginał w data-lkc-raw —
        // ten tor ma czytać prawdziwe słowo, a nie „----------”.
        if (node && node.nodeType === 1 && node.getAttribute) {
            var maskedRaw = node.getAttribute('data-lkc-raw');
            if (maskedRaw != null) return maskedRaw;
        }
        var out = '';
        for (var n = node.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 3) out += n.nodeValue;
            else if (n.nodeType === 1) out += String(n.nodeName).toUpperCase() === 'BR' ? ' ' : domText(n);
        }
        return out;
    }

    function readDomSubtitles() {
        if (!enabled) return;
        var found = [];
        for (var s = 0; s < TR_SELECTORS.length; s++) {
            try {
                var nodes = document.querySelectorAll(TR_SELECTORS[s]);
                for (var k = 0; k < nodes.length; k++) {
                    var tx = domText(nodes[k]).replace(/\s+/g, ' ').trim();
                    if (!tx) continue;
                    var r = nodes[k].getBoundingClientRect();
                    if (!(r.width > 0 && r.height > 0)) continue;
                    found.push({ text: tx, node: nodes[k] });
                }
            } catch (e) {}
            if (found.length) break;
        }
        if (found.length) {
            var item = found[0];
            if (item.text !== lastDomText) {
                lastDomText = item.text;
                var video = null;
                try {
                    var v = item.node;
                    while (v && v !== document.body) {
                        if (v.tagName === 'VIDEO') { video = v; break; }
                        v = v.parentElement;
                    }
                } catch (e) {}
                handleSubtitleText(video, item.text);
            }
        }
    }

    var domObserver = new MutationObserver(function (mutations) {
        if (domTimer) clearTimeout(domTimer);
        domTimer = setTimeout(readDomSubtitles, 150);
    });

    try {
        domObserver.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}

    setTimeout(readDomSubtitles, 1000);
    setInterval(readDomSubtitles, 3000);

    try {
        window.__lektorTTR = {
            status: function () {
                return {
                    enabled: enabled,
                    censorLive: censorLive,
                    hasFileSubs: hasFileSubs,
                    videos: videos.size,
                    lastText: lastText,
                    lastDomText: lastDomText
                };
            },
            enable: function () { enabled = true; },
            disable: function () { enabled = false; },
            enableCensor: function () { censorLive = true; },
            disableCensor: function () { censorLive = false; }
        };
    } catch (e) {}
})();