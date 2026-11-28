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
// dom_content.js — Live-Dubbing content script
// Prime Video (primevideo.com / amazon.com/video i /gp/video) oraz iQIYI (iq.com / iqiyi.com).
// Czyta bieżące napisy renderowane w DOM playera (także w Shadow DOM),
// filtruje szumy UI, deduplikuje przez BroadcastChannel i przekazuje do Pipera
// (background -> offscreen) jako TTS_PLAY.
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

    // [AGENT-EXP] 2026-10-15: „Tłumacz całe zdania” na żywo — kwestia bez końca zdania czeka na dalszy ciąg:
    // następna kwestia z ekranu dokleja się do niej (zdContinues), a tłumacz dostaje całe zdanie. Czekamy, póki
    // napis jest na ekranie, a po jego zniknięciu jeszcze ZD_LIVE_GAP_MS; nigdy dłużej niż ZD_LIVE_MAX_AGE_MS.
    // Przewijane napisy (dwie linijki, górna = dolna z poprzedniego widoku, np. automatyczne YouTube): z nowego
    // widoku doklejamy tylko nowe słowa (h.k = ile słów z początku widoku już mamy).
    // Hold: text = całość do tłumaczenia, last = ostatni widok z ekranu, base = część sprzed tego widoku.
    var ZD_LIVE_GAP_MS = 1200, ZD_LIVE_MAX_AGE_MS = 6000;
    var zdHold = null;
    function zdSimilar(a, b) {
        if (!a || !b) return false;
        if (a === b) return true;
        if (a.indexOf(b) === 0 || b.indexOf(a) === 0) return true;
        if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return Math.abs(a.length - b.length) <= 30;
        return false;
    }
    function zdRollOverlap(prev, toks) {
        var p = String(prev || '').split(' ');
        var nk = function (w) { return String(w || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); };
        for (var k = Math.min(p.length - 1, toks.length); k >= 4; k--) {
            var ok = true;
            for (var i = 0; i < k; i++) if (nk(p[p.length - k + i]) !== nk(toks[i])) { ok = false; break; }
            if (ok) return k;
        }
        return 0;
    }
    function zdArm(h) {
        clearTimeout(h.timer);
        var ms = h.settle;
        if (zdOn && !zdEnds(h.text) && h.text.length < ZD_MAX_CHARS) {
            var left = h.born + ZD_LIVE_MAX_AGE_MS - Date.now();
            ms = Math.max(h.settle, Math.min(left, h.goneAt ? ZD_LIVE_GAP_MS : ZD_LIVE_MAX_AGE_MS));
        }
        h.timer = setTimeout(zdRelease, ms);
    }
    function zdRelease() {
        var h = zdHold;
        zdHold = null;
        if (!h) return;
        clearTimeout(h.timer);
        if (h.text) { try { h.out(h.text); } catch (e) {} }
    }
    // napis zniknął z ekranu — niedokończone zdanie czeka już tylko chwilę na dalszy ciąg
    function zdLiveGone() {
        var h = zdHold;
        if (!h || h.goneAt || zdEnds(h.text)) return;
        h.goneAt = Date.now();
        zdArm(h);
    }
    // text = to, co teraz na ekranie; out(całość) = tłumacz i czytaj; settle = ms na „uspokojenie” narastającego napisu
    function zdLiveFeed(text, out, settle) {
        text = String(text || '').replace(/\s+/g, ' ').trim();
        if (!text) return;
        var h = zdHold, k = 0, add = text;
        if (h) {
            if (zdSimilar(h.last, text) || zdSimilar(h.text, text)) {   // ten sam napis urósł / wrócił
                if (zdSimilar(h.last, text)) {
                    if (text.length >= h.last.length) {
                        h.last = text;
                        var a2 = h.k ? text.split(' ').slice(h.k).join(' ') : text;
                        h.text = h.base ? zdJoin(h.base, a2) : a2;
                    }
                } else if (text.length >= h.text.length) { h.text = h.last = text; h.base = ''; h.k = 0; }
                h.goneAt = 0;
                zdArm(h);
                return;
            }
            var toks = text.split(' ');
            k = zdOn ? zdRollOverlap(h.last, toks) : 0;
            add = k ? toks.slice(k).join(' ') : text;
            var gap = h.goneAt ? Date.now() - h.goneAt : 0;
            if (zdOn && (!add || (Date.now() - h.born <= ZD_LIVE_MAX_AGE_MS && zdContinues(h.text, add, gap)))) {
                h.base = h.text;
                if (add) h.text = zdJoin(h.text, add);
                h.last = text; h.k = k; h.goneAt = 0;
                zdArm(h);
                return;
            }
            zdRelease();   // poprzednie zdanie skończone — tłumacz je od razu
        }
        zdHold = { text: add, last: text, base: '', k: k, born: Date.now(), goneAt: 0, settle: settle || 450, out: out, timer: 0 };
        zdArm(zdHold);
    }


    // ===== Rozpoznanie serwisu =====
    var hostName = (window.location.hostname || '').toLowerCase();
    var isIqiyi = hostName.indexOf('iq.com') !== -1 || hostName.indexOf('iqiyi.com') !== -1;

    // ===== Selektory Immersive Translate (tłumaczenie DOCELOWE = PL) =====
    var IT_SELECTORS = [
        '[data-immersive-translate-translation-element="target"]',
        '.immersive-translate-target-inner',
        '.immersive-translate-target-translation',
        '[class*="immersive-translate-target-"]',
        '[class*="imt-target-"]',
        '.imt-captions-text',
        '.imt-cue',
        'font.immersive-translate-target-inner',
        '[class*="imt-"]',
        '[class*="immersive-translate"]'
    ];
    var IT_GROUP = IT_SELECTORS.join(', ');
    // [FIX 2026-11-02] własne źródła z Kreatora osobno: ich linie jednego napisu czytamy RAZEM (customHits → customJoined),
    // a obcojęzyczne przy tłumaczeniu sieciowym idą do tłumacza (dawniej czytana była tylko ostatnia linia napisu,
    // a angielski z własnego źródła był pomijany nawet z włączonym tłumaczeniem)
    var CUSTOM_GROUP = '', customHits = [];
    // OPTIONS-PAGE: selektory z Kreatora napisów + listy domen (white/black) z options_hooks.js
    function optAsleep() { try { return !!(window.__LivedubOpts && window.__LivedubOpts.asleep()); } catch (e) { return false; } }
    try { if (window.__LivedubOpts) window.__LivedubOpts.onChange(function () {
        try { var cs = window.__LivedubOpts.customSelectors(); IT_GROUP = IT_SELECTORS.concat(cs).join(', '); CUSTOM_GROUP = cs.join(', '); } catch (e) {}
        try { if (optAsleep() && typeof enabled !== 'undefined' && enabled) { enabled = false; if (typeof stopSpeech === 'function') stopSpeech(); } } catch (e) {}
    }); } catch (e) {}
    // [FIX 2026-11-02] 📋 lista domen zmieniona na otwartej karcie: uśpij albo obudź ze stanem z popupu (dawniej raz uśpiony
    // lektor wracał dopiero po odświeżeniu strony). Uśpiony = obserwator napisów nic nie skanuje (sprawdza enabled).
    try { if (window.__LivedubOpts && window.__LivedubOpts.onSleep) window.__LivedubOpts.onSleep(function (a) {
        if (a) { if (enabled) { enabled = false; stopSpeech(); } return; }
        chrome.storage.local.get('enabled', function (r) {
            enabled = !r || r.enabled === undefined ? true : !!r.enabled;
            if (optAsleep()) enabled = false;
            if (enabled && document.visibilityState === 'visible') applyDuck();
        });
    }); } catch (e) {}

    // ===== Węzły ŹRÓDŁOWE IT (oryginał, np. EN) — MUSIMY JE POMIJAĆ =====
    // Bez tego na iq.com lektor czytał angielski oryginał obok polskiego tłumaczenia.
    var ORIGIN_SELECTORS = [
        '[data-immersive-translate-translation-element="origin"]',
        '.immersive-translate-origin-text',
        '[class*="imt-origin"]',
        '[class*="immersive-translate-origin"]'
    ];
        var ORIGIN_GROUP = ORIGIN_SELECTORS.join(', ');

    // Czy węzeł (lub któryś przodek, także przez shadow host) jest węzłem źródłowym?
    function isOriginNode(el) {
        if (!el || el.nodeType !== 1) return false;
        var n = el;
        while (n && n.nodeType === 1) {
            try { if (n.matches && n.matches(ORIGIN_GROUP)) return true; } catch (e) {}
            n = n.parentElement || n.parentNode;
            if (n && n.nodeType === 11) n = n.host || null; // przejście przez shadow host
        }
        return false;
    }

    // Czy tekst wygląda na polski (diakrytyki / typowe polskie zbitki)?
    function looksPolish(text) {
        return /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(String(text));
    }

    // Typowe polskie słowa BEZ diakrytyków — pozwalają rozpoznać polski, gdy tłumaczenie
    // IT nie zawiera ą/ć/ę itd. (np. "Czesc co robisz", "Nie wiem o co chodzi").
    // Celowo pomijamy słowa kolidujące z angielskim: to, on, my, one, go, i, a, no, so, be, me, we, do, at.
    var PL_WORDS_RE = /\b(?:się|sie|jest|jestem|jesteś|jestes|nie|już|juz|czy|tylko|coś|cos|nic|wszystko|bardzo|teraz|tutaj|dlaczego|dlatego|bo|ale|że|ze|tego|tej|tym|ten|ta|te|ci|tu|tam|ciebie|mnie|siebie|chcę|chce|może|moze|możesz|mozesz|wiem|wiesz|przecież|przeciez|chyba|naprawdę|naprawde|widzę|widze|widzisz|słyszę|slysze|idź|idz|chodź|chodz|czekaj|dobra|dobrze|okej|co|kto|jak|gdzie|kiedy|wtedy|zawsze|nigdy|jeszcze|raczej|trochę|troche|dużo|duzo|mało|malo|wszyscy|nikt|ktoś|ktos|czym|kim|znowu|znów|znow|moja|moje|twój|twoj|twoje|nasz|nasze|jej|jego|daj|dajcie|pójdź|pojdz)\b/i;

    // Czy tekst wygląda na ANGIELSKI (oryginał z IT / napisy wbudowane EN)?
    // Uwaga na kolizje z polskimi słowami: NIE używamy "to", "on", "my", "one",
    // "go", "i", "a" — to polskie słowa! Używane do odrzucania oryginału EN,
    // którego węzły nie zawsze łapie isOriginNode (struktura IT na iq.com).
    var EN_WORDS_RE = /\b(?:the|and|you|your|yours|for|with|that|this|these|those|what|when|where|who|whom|how|why|not|but|was|were|are|is|am|be|been|being|have|has|had|will|would|can|could|should|shall|may|might|must|just|about|from|they|them|their|there|then|than|now|here|into|onto|out|off|over|under|up|down|back|again|get|got|getting|goes|going|went|gone|want|wants|know|knew|known|think|thought|really|very|please|thank|thanks|hello|hey|sorry|yeah|yes|okay|ok|come|comes|came|coming|look|looks|looked|wait|waits|stop|stopped|start|started|let|lets|because|which|while|else|also|too|some|any|all|only|even|ever|never|always|still|already|done|make|makes|made|say|says|said|tell|told|ask|asked|take|took|give|gave|find|found|need|needs|good|bad|best|right|wrong|new|old|great|little|much|more|most|other|another|same|such|each|every|enough|own|his|her|him|she|we|our|us|don't|doesn't|didn't|can't|won't|it's|i'm|we're|they're|you're|that's|what's)\b/gi;

    function looksEnglish(text) {
        var t = String(text);
        if (looksPolish(t)) return false; // diakrytyki → na pewno nie odrzucamy
        if (PL_WORDS_RE.test(t)) return false; // polskie słowo bez diakrytyków → nie odrzucamy
        var words = t.trim().split(/\s+/).filter(Boolean);
        if (words.length < 2) return false;
        var m = t.match(EN_WORDS_RE);
        var hits = m ? m.length : 0;
        if (hits === 0) return false;
        // Krótkie linie: 1 typowe słowo EN wystarczy; długie: co najmniej ~1/3 słów.
        return words.length <= 4 || hits * 3 >= words.length;
    }


    // ===== Selektory napisów WŁASNYCH playera (native) =====
    var NATIVE_SELECTORS = [
        // Prime Video
        '.atvwebplayersdk-captions-text',
        '.timedTextOverlay span',
        'div[class*="rendererContainer"] span',
        // iQIYI
        '.iqp-subtitle-item',
        '.iqp-subtitle-content',
        '.dss-subtitle-text',
        // HTML5 / Shaka / video.js / JW
        '.shaka-text-wrapper',
        '.vjs-text-track-display',
        '.jw-text-track-container',
        '.bump-subtitle-container',
        // OGÓLNE (fallback)
        '[class*="subtitle-text"]',
        '[class*="caption-text"]',
        '[class*="caption-window"]',
        '[class*="subtitle"]',
        '[class*="caption"]'
    ];

    // Elementy sterujące / UI — NIE czytamy ich (także jako przodków).
    var CONTROL_SELECTOR = 'button, input, select, textarea, [role="button"], [role="menuitem"], [role="menu"], [role="slider"], [class*="control-bar"], [class*="controls"], [class*="buttons"], [class*="settings-menu"], [class*="menu"], [class*="toolbar"], [class*="header"], [class*="navigation"], [class*="next-up"], [class*="info-panel"], [class*="recommend"], [role="dialog"], [aria-modal="true"]';

    // ===== Filtry śmieci (port ze skryptu "Piper Lektor PL (Zero-Lag)") =====
    var JUNK_VOCAB_RE = /\b(?:immersive|translate|translated|translating|translation|translator|translators|tłumacz|tłumacze|tłumaczenie|tłumaczenia|tłumaczono|przetłumaczono|przetłumaczone|tłumaczone|tlumacz|tlumaczenie|tlumaczenia|tlumaczono|przetlumaczono|przetlumaczone|tlumaczone|google|deepl|microsoft|bing|yandex|openai|chatgpt|claude|using|powered|via|subtitles?|captions?|napisy|napisów|napisow|settings)\b/gi;
    var TRANSLATOR_STUFF = [
        'immersive translate', 'google translate', 'deepl translate', 'translated by',
        'use translate', 'click to translate', 'włącz tłumaczenie napisów',
        'włacz tlumaczenie napisow', 'przełącz tłumaczenie', 'przelacz tlumaczenie',
        'tłumaczenie napisów', 'tlumaczenie napisow', 'subtitle translation',
        'download subtitle translation', 'enable subtitles translation',
        'enable subtitle translation', 'enable subtitle settings',
        'enable subtitles settings', 'enable subtitles', 'click to enable subtitles',
        'click to enable subtitle translation', 'click to enable subtitles translation',
        'enable subtitles translation for this video', 'enable subtitle settings for this video',
        'enable subtitles settings for this video', 'select subtitle settings',
        'show subtitle settings', 'open subtitle settings', 'subtitles settings',
        'subtitle settings menu', 'napisy tłumaczone', 'napisy tlumaczone',
        'przetłumaczone za pomocą', 'przetlumaczone za pomoca',
        'for this video', 'on this video', 'in this video', 'of this video',
        'this video', 'this film', 'this movie', 'this episode', 'click here'
    ];
    var JUNK_PHRASES = [
        'Prime Video', 'Amazon Prime', 'iQIYI', 'Subtitles', 'Subtitle settings',
        'Enable subtitle settings', 'Enable subtitles settings', 'Subtitle translation',
        'Audio', 'Settings', 'Quality', 'Speed', 'Playback speed',
        'Next episode', 'Skip intro', 'Skip recap', 'Watch credits', 'Up Next',
        'Pause', 'Play', 'Rewind', 'Forward', 'Mute',
        'Download subtitle translation', 'Download subtitles', 'Download subtitle',
        'Sign in', 'Sign up', 'Watch now', 'Add to Watchlist'
    ];

    var POLL_MS = 150, OBSERVER_DEBOUNCE_MS = 30, FRAME_SETTLE_MS = 10;

    // ===== Stan =====
    var enabled = true, duckLevel = 20, savedVolume = null, video = null;
    var primeSubtitleSource = 'both'; // 'both' | 'immersive' | 'native' (Prime Video)
    var lastSubtitle = '';
    var lastSubtitleAt = 0;
    var liveEver = false;   // [FIX 2026-11-16] lektor przeczytał z ekranu choć jedną kwestię (pasek 📊 ma się wtedy pokazać)
    var observer = null, pollTimer = null, scanTimer = null, speakTimer = null, pendingKey = null;
    var tabFocused = document.visibilityState === 'visible';
    var spokenKey = {}; // hash -> timestamp ostatniego wystąpienia (w obrębie 3 s)
    var userBlockedPhrases = []; // frazy blokowane przez użytkownika (panel podglądu)
    var panelVisible = true; // czy panel podglądu lektora jest widoczny
    var panelOn = true; // [AGENT-EXP] opcja „lektorPanelOn” z Ustawień: wył. = panel i pigułka całkiem ukryte
    var netTr = false; // tłumaczenie sieciowe włączone (silnik ≠ lokalny) — napisy strony tłumaczone na żywo

    var bc = null;
    try { bc = new BroadcastChannel('livedub-streaming'); } catch (e) { bc = null; }

    function hashStr(s) {
        var h = 0;
        for (var i = 0; i < s.length; i++) {
            h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        }
        return String(h);
    }

    // ===== Ustawienia =====
    function loadSettings() {
        chrome.storage.local.get(['enabled', 'duckLevel', 'primeSubtitleSource', 'userBlockedPhrases', 'panelVisible', 'extTrOn', 'lektorPanelOn'], function (res) {
            if (res.lektorPanelOn !== undefined) panelOn = res.lektorPanelOn !== false; // [AGENT-EXP]
            netTr = res.extTrOn === true;
            if (res.enabled !== undefined) enabled = !!res.enabled;
            if (optAsleep()) enabled = false; // OPTIONS-PAGE
            if (res.duckLevel !== undefined) duckLevel = clampPct(res.duckLevel);
            if (res.primeSubtitleSource !== undefined) primeSubtitleSource = res.primeSubtitleSource;
            if (screenOnlyMode()) dropFileSubs();   // [AGENT-EXP] 2026-11-14: plik pobrany zanim wczytaliśmy ustawienie nie może zostać
            if (Array.isArray(res.userBlockedPhrases)) userBlockedPhrases = res.userBlockedPhrases;
            if (res.panelVisible !== undefined) panelVisible = !!res.panelVisible;
            duckReady = true;   // [AGENT-EXP] 2026-10-20: nie ściszaj filmu, zanim wczytamy ustawienia (start z enabled=true) ani przy wyłączonym lektorze
            if (enabled && document.visibilityState === 'visible') applyDuck();
            else if (!enabled) duckRestoreWhenVideo();   // [AGENT-EXP] 2026-10-20
            renderBlockedChips();
            applyPanelVisibility();
        });
    }
    chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        if (changes.enabled !== undefined) {
            enabled = !!changes.enabled.newValue;
            if (optAsleep()) enabled = false; // OPTIONS-PAGE
            if (enabled && document.visibilityState === 'visible') applyDuck();
            else stopSpeech();
        }
        if (changes.duckLevel !== undefined) {
            duckLevel = clampPct(changes.duckLevel.newValue);
            if (enabled && document.visibilityState === 'visible') applyDuck();
        }
        if (changes.primeSubtitleSource !== undefined) {
            primeSubtitleSource = changes.primeSubtitleSource.newValue || 'both';
            if (screenOnlyMode()) dropFileSubs();   // [AGENT-EXP] 2026-11-14: przełączenie na „Tylko Immersive Translate” od razu oddaje głos ekranowi
        }
        if (changes.userBlockedPhrases !== undefined) {
            userBlockedPhrases = Array.isArray(changes.userBlockedPhrases.newValue) ? changes.userBlockedPhrases.newValue : [];
            renderBlockedChips();
        }
        if (changes.panelVisible !== undefined) {
            panelVisible = !!changes.panelVisible.newValue;
            applyPanelVisibility();
        }
        if (changes.lektorPanelOn !== undefined) { panelOn = changes.lektorPanelOn.newValue !== false; applyPanelVisibility(); } // [AGENT-EXP]
        if (changes.extTrOn !== undefined) netTr = changes.extTrOn.newValue === true;
    });

    function clampPct(v) { v = Number(v); if (!isFinite(v)) return 20; return Math.max(0, Math.min(100, v)); }
// ===== Wideo + ducking =====
    function getVideo() {
        if (video && video.isConnected) return video;
        video = document.querySelector('video');
        if (video) {
            video.addEventListener('seeked', function () { try { filePlayed.clear(); } catch (e) {} stopSpeech(); });   // [AGENT-EXP] cofnięcie → kwestie czytane jeszcze raz
            video.addEventListener('pause', function () { pausedAtMs = video.currentTime * 1000; pauseSpeech(); }); // pauza filmu zawsze pauzuje lektora   // [FIX 2026-11-02] pausedAtMs
            video.addEventListener('play', function () { if (enabled) { applyDuck(); rereadInterrupted(); } else if (duckReady && duckMemGet() !== null) restoreVolume(); });   // [AGENT-EXP] 2026-10-20   // [FIX 2026-11-02] rereadInterrupted
            video.addEventListener('volumechange', function () { if (enabled && tabFocused) applyDuck(); });
            if (enabled && tabFocused) applyDuck();
        }
        return video;
    }
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
        if (!duckReady || !enabled) return;   // [AGENT-EXP] 2026-10-20: nie ściszaj filmu, zanim wczytamy ustawienia (start z enabled=true) ani przy wyłączonym lektorze
        var LS = window.__LektorSched; if (LS && LS.duckAllowed && !LS.duckAllowed()) { restoreVolume(); return; }   // [FIX 2026-11-16] lektor milczy → film gra PEŁNĄ głośnością (dotąd zostawał na 20%)
        var v = getVideo(); if (!v) return;
        var target = duckLevel / 100;
        duckOrig(v);   // [AGENT-EXP] 2026-10-20
        if (savedVolume === null && __mlVolNow(v) > target) savedVolume = __mlVolNow(v);   // [FIX 2026-11-22]
        if (savedVolume !== null) duckMemSet(savedVolume);   // [AGENT-EXP] 2026-10-20
        // Fix: po zwiększeniu duckLevel (np. z 0% na wyższy) głośność filmu ma WRACAĆ.
        // Wcześniej było tylko obniżanie (if v.volume > target) i po wyciszeniu na 0%
        // głos już nigdy nie wracał. Ustawiamy min(target, savedVolume), żeby nigdy
        // nie przekroczyć pierwotnej głośności ustawionej przez użytkownika.
        if (savedVolume !== null) {
            setV(v, Math.min(target, savedVolume));
        } else if (v.volume > target) {
            setV(v, target);
        }
    }
    function setV(v, x) { var S = window.__LektorSched; if (S && S.setVol) S.setVol(v, x); else v.volume = x; }   // [FIX 2026-11-02] płynnie w trybie „tylko gdy mówi”
    function restoreVolume() {
        var v = getVideo();
        if (v) { duckOrig(v); duckMemSet(null); }   // [AGENT-EXP] 2026-10-20
        if (!v) return;
        if (savedVolume !== null) { setV(v, savedVolume); savedVolume = null; return; }
        // [FIX 2026-11-16] Brak zapisanej głośności, a film stoi dokładnie na poziomie duckingu — oddajemy pełną głośność.
        var LS = window.__LektorSched;
        if (LS && LS.duckWhileOn && LS.duckWhileOn() && duckLevel >= 5 && v.volume > 0
            && Math.abs(v.volume - duckLevel / 100) <= 0.02) setV(v, 1);
    }
    try { window.__LektorSched.onDuck(function () { if (enabled) applyDuck(); }, function () { restoreVolume(); }); } catch (e) {}   // [FIX 2026-11-02] 🔉
    // [FIX 2026-11-02] Kwestia z pliku / całych napisów przerwana pauzą (bez „Czytaj zawsze do końca”) — po wznowieniu
    // czytana od początku (wspólna funkcja harmonogramu). Wcześniej zostawała oznaczona jako przeczytana i jej reszta przepadała.
    var pausedAtMs = -1;
    function rereadInterrupted() {
        var at = pausedAtMs;
        pausedAtMs = -1;
        var S = window.__LektorSched, v = getVideo();
        if (!S || !v || !fileSubs.length || S.readToEndOn()) return;
        S.rearmAfterPause(fileSubs, filePlayed, null, at, v.currentTime * 1000, getOff());
    }
    function pauseSpeech() {
        try { chrome.runtime.sendMessage({ action: 'TTS_PAUSE', reason: 'pause' }); } catch (e) {}   // [AGENT-EXP] 2026-10-22: woła ją tylko pauza filmu — „Czytaj zawsze do końca” dokańcza zdanie
        try { filePreloaded.clear(); } catch (e) {}   // [AGENT-EXP] preload jeszcze raz (gotowe — z pamięci / dysku)
    }
    function stopSpeech() {
        try { chrome.runtime.sendMessage({ action: 'TTS_CLEAR_BUFFER' }); } catch (e) {}
        try { filePreloaded.clear(); } catch (e) {}   // [AGENT-EXP]
        clearTimeout(speakTimer); speakTimer = null; pendingKey = null;
        restoreVolume();
    }

    // ===== Filtrowanie śmieci (port z Zero-Lag) =====
    function isJunkDense(text) {
        var words = String(text).trim().split(/\s+/).filter(Boolean);
        if (!words.length) return true;
        var junk = (String(text).match(JUNK_VOCAB_RE) || []).length;
        return junk * 2 >= words.length;
    }

    function stripPhrases(text, arr) {
        for (var i = 0; i < arr.length; i++) {
            var esc = arr[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            var re = new RegExp('(?:^|\\s)' + esc + '(?=$|\\s|[.,!?;:])', 'gi');
            text = text.replace(re, ' ');
        }
        return text;
    }

    function cleanTranslationJunk(text) {
        if (!text) return '';
        var raw = String(text);
        // Twarda blokada na SUROWYM tekście — banery typu "Enable subtitle
        // settings (for this video)" są odrzucane w całości, zanim cokolwiek
        // zdąży dotrzeć do lektora i go przerwać.
        if (HARD_BLOCK_RE.test(normalizeForCheck(raw)) ||
            HARD_BLOCK_RE.test(normalizeForCheck(splitConcatenated(raw)))) return '';
        // Blokady użytkownika z panelu podglądu (zapisywane w chrome.storage).
        if (isUserBlocked(raw)) return '';
        var cleaned = raw;
        // Opisy dźwięków w nawiasach — nieczytane przez lektora
        cleaned = cleaned.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/（[^）]*）/g, ' ').replace(/【[^】]*】/g, ' ').replace(/\s{2,}/g, ' ').trim();
        if (!cleaned) return '';
        cleaned = cleaned.replace(/\b(?:www\.|https?:\/\/)\S+/gi, ' ');
        var junkBefore = (cleaned.match(JUNK_VOCAB_RE) || []).length;

        cleaned = stripPhrases(cleaned, JUNK_PHRASES);
        cleaned = stripPhrases(cleaned, TRANSLATOR_STUFF);

        if (isJunkDense(cleaned)) {
            cleaned = cleaned.replace(JUNK_VOCAB_RE, ' ');
        }

        cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
        var wordsLeft = cleaned.split(/\s+/).filter(Boolean).length;
        if ((junkBefore >= 2 && wordsLeft <= 2) || (junkBefore >= 1 && wordsLeft <= 1)) return '';
        return cleaned;
    }

    // Rozdziela sklejenia camelCase (np. "subtitleSubtitle" -> "subtitle Subtitle")
    // tylko na potrzeby detekcji śmieci — jak w Zero-Lag (stripPlayerUiJunk).
    function splitConcatenated(text) {
        return String(text).replace(/([a-ząćęłńóśźż0-9])([A-ZĄĆĘŁŃÓŚŹŻ])/g, '$1 $2');
    }

    // Twarde blokady — jeśli tekst ZAWIERA frazę systemową (nawet w środku
    // dłuższego zdania banera), jest odrzucany bez wyjątków. Banery iQIYI /
    // Immersive Translate bywają dłuższe niż sama fraza (np. "Enable subtitle
    // settings for this video…"), dlatego zwykłe dopasowanie całości nie działa.
    var HARD_BLOCK_RE = new RegExp(
        '(?:' + [
            'enable\\s*subtitles?',
            'request\\s*ai\\s*subtitles?',
            'translat\\w*\\s+using',
            'free\\s+translation',
            'translation\\s+service',
            'enable\\s*captions?',
            'turn\\s+on\\s+(?:the\\s+)?subtitles?',
            'click\\s*to\\s*enable',
            'kliknij[^.!?]{0,20}napis',
            'w[lł]acz\\s*napis',
            'subtitles?\\s*settings',
            'captions?\\s*settings',
            'subtitle\\s*translation',
            'subtitles?\\s*translation',
            'download\\s*subtitles?',
            'pobierz\\s*napis',
            'immersive\\s*translate',
            'google\\s*translate',
            'deepl',
            'translated?\\s*by',
            't[lł]umaczen\\w*\\s+za\\s+pomoc',
            'for\\s+this\\s+video',
            'for\\s+this\\s+film',
            'na\\s+tym\\s+filmie',
            'dla\\s+tego\\s+filmu'
        ].join('|') + ')',
        'i'
    );

    // [FIX 2026-11-02] Wulgaryzmy wycina teraz WYŁĄCZNIE jeden cenzor (assets/censor.js) zgodnie z ustawieniami
    // (wł./wył., usuń / beep / gwiazdki, własne słowa). Ten stały wzorzec wycinał je zawsze — wbrew wyłączonemu cenzorowi,
    // tryby beep / gwiazdki nie miały czego zamienić, a rdzenie łapały też niewinne słowa (np. „szmatka”).

    // Normalizacja do testów: usuwa znaki zero-width i sprowadza wszystkie
    // białe znaki (w tym niełamliwe, nowe linie między <span>ami banera)
    // do pojedynczych spacji — żeby frazy typu "Enable subtitle settings"
    // były wykrywalne nawet gdy HTML rozbija je na wiele elementów.
    function normalizeForCheck(text) {
        return String(text)
            .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, ' ')
            .replace(/[\s\u00A0]+/g, ' ')
            .trim();
    }

    function isSystemPrompt(text) {
        if (!text) return true;
        var clean = text.trim().toLowerCase();
        if (clean.length < 2) return true;
        // 1) TWARDA BLOKADA: substring w znormalizowanym tekście.
        var norm = normalizeForCheck(text);
        if (HARD_BLOCK_RE.test(norm)) return true;
        // 1b) To samo po rozklejeniu camelCase ("EnableSubtitleSettings").
        var expandedNorm = normalizeForCheck(splitConcatenated(text.trim()));
        if (HARD_BLOCK_RE.test(expandedNorm)) return true;
        if (/^(?:enable\s+subtitles(?:\s+translation)?|translation\s+subtitles|subtitles\s+translation|immersive\s+translate|translating|subtitles?|captions?|settings|subtitle\s+settings|audio\s+settings|language\s+settings|select\s+a?\s*(?:language|subtitle|audio)|audio\s*[&+]\s*subtitles?|audio\s+and\s+subtitles?|tłumaczenie\s+napisów|translator|translate|tłumacz|use\s+google\s+translate|use\s+translate|użyj\s+google\s+translate|enable|enabled|disabled)\.?$/i.test(clean)) {
            return true;
        }
        var remaining = clean.replace(JUNK_VOCAB_RE, ' ').replace(/[^a-ząćęłńóśźż0-9]/gi, '').trim();
        if (remaining.length < 2) return true;
        if (/^(?:en|ena|enab|enabl|enable|enabled|dis|disabl|disabled|use|set|settings|sel|select|choose|show|hide|click|tap|press|here|on|off|yes|no|ok|apply|cancel|done)$/i.test(remaining)) {
            return true;
        }
        var words = clean.split(/\s+/).filter(Boolean);
        var junkCount = (clean.match(JUNK_VOCAB_RE) || []).length;
        if (words.length <= 8 && junkCount * 2 >= words.length) return true;
        var expanded = splitConcatenated(text.trim()).toLowerCase();
        if (expanded !== clean) {
            var expWords = expanded.split(/\s+/).filter(Boolean);
            var expJunk = (expanded.match(JUNK_VOCAB_RE) || []).length;
            if (expWords.length <= 8 && expJunk * 2 >= expWords.length) return true;
        }
        return false;
    }

    function isVisibleElement(el) {
        try {
            if (!el) return false;
            if (el.hidden) return false;
            var style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            if (el.closest && el.closest('[hidden], [aria-hidden="true"], [style*="display: none"], [style*="visibility: hidden"]')) return false;
            if (el.closest && el.closest('[data-lektor-ocr]')) return false; // [AGENT-EXP] most OCR → tłumacz strony: czyta go sam OCR
            var rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return false;
            return true;
        } catch (e) {
            return true;
        }
    }

    function isControl(el) {
        var n = el;
        while (n && n.nodeType === 1) {
            try {
                if (n.matches && n.matches(CONTROL_SELECTOR)) return true;
            } catch (e) { /* ignore */ }
            n = n.parentElement;
        }
        return false;
    }

    // Czy dwa teksty napisów są "takie same w przybliżeniu" (jeden zawiera drugi).
    // Używane do pomijania duplikatów między Immersive Translate a napisami
    // wbudowanymi (np. "Cześć" i "Cześć.") — jak w Zero-Lag (similarToPrevious).
    function isSimilar(a, b) {
        if (!a || !b) return false;
        if (a === b) return true;
        var lo = a.length < b.length ? a : b;
        var hi = a.length < b.length ? b : a;
        return hi.indexOf(lo) !== -1 && (hi.length - lo.length) <= 18;
    }

    // Zbieranie napisów z Immersive Translate (tylko liście / tłumaczenie docelowe).
    // [AGENT-EXP] 2026-10-24: iQIYI jak stary „Lektor Multilanguage YT” (który tam czyta): przy każdym sprawdzeniu cała
    // strona + każdy Shadow DOM, bez zapamiętanego miejsca (ENERGIA). Zapamiętane miejsce na iq.com nie trafiało w napisy IT.
    function collectITDeep(root, results) {
        collectITIn(root, results);
        var all = [];
        try { all = root.querySelectorAll('*'); } catch (e) { all = []; }
        for (var k = 0; k < all.length; k++) {
            try { if (all[k].shadowRoot) collectITDeep(all[k].shadowRoot, results); } catch (e) {}
        }
        return results;
    }
    function collectIT(root, results) {
        if (root === document && isIqiyi) return collectITDeep(document, results);   // [AGENT-EXP] 2026-10-24
        if (root === document) { var rs = subRoots(); for (var r = 0; r < rs.length; r++) collectITIn(rs[r], results); return results; }
        return collectITIn(root, results);
    }
    function collectITIn(root, results) {
        if (!root || !root.querySelectorAll) return results;
        try {
            var nodes = root.querySelectorAll(IT_GROUP);
            for (var i = 0; i < nodes.length; i++) {
                var node = nodes[i];
                if (!isVisibleElement(node)) continue;
                if (isControl(node)) continue;
                if (isOriginNode(node)) continue; // oryginał (EN) — nigdy nie czytamy
                if (node.querySelector && node.querySelector(IT_GROUP)) continue; // tylko liście
                var rawTxt = node.getAttribute && node.getAttribute('data-lkc-raw');   // [AGENT-EXP] 2026-11-17: napisy z kreskami (tryb „dashes”) — czytamy oryginał
                var text = cleanTranslationJunk(String(rawTxt != null ? rawTxt : (node.innerText || node.textContent || '')).replace(/\s+/g, ' ').trim());
                if (text.length >= 2 && !isSystemPrompt(text)) {
                    var own = false;
                    if (CUSTOM_GROUP) { try { own = node.matches(CUSTOM_GROUP); } catch (e) {} }
                    if (looksEnglish(text) && !(own && netTr)) continue; // oryginał EN (IT) — nigdy nie czytamy (własne źródło: po tłumaczeniu)
                    results.push(text);
                    if (own) customHits.push(text);
                    subFoundNode = node;
                }
            }
        } catch (e) {}
        return results;
    }

    // Zbieranie napisów WŁASNYCH playera (native) — z pomijaniem duplikatów względem IT.
    function collectNative(root, results, itTexts) {
        if (root === document) { var rs = subRoots(); for (var r = 0; r < rs.length; r++) collectNativeIn(rs[r], results, itTexts); return results; }
        return collectNativeIn(root, results, itTexts);
    }
    function collectNativeIn(root, results, itTexts) {
        if (!root || !root.querySelectorAll) return results;
        try {
            for (var i = 0; i < NATIVE_SELECTORS.length; i++) {
                var nodes = [];
                try { nodes = root.querySelectorAll(NATIVE_SELECTORS[i]); } catch (e) { nodes = []; }
                for (var j = 0; j < nodes.length; j++) {
                    var node = nodes[j];
                    if (!isVisibleElement(node)) continue;
                    if (isControl(node)) continue;
                    if (node.closest && node.closest(IT_GROUP)) continue; // to węzeł IT
                    var rawTxtN = node.getAttribute && node.getAttribute('data-lkc-raw');   // [AGENT-EXP] 2026-11-17: napisy z kreskami (tryb „dashes”) — czytamy oryginał
                    var text = cleanTranslationJunk(String(rawTxtN != null ? rawTxtN : (node.innerText || node.textContent || '')).replace(/\s+/g, ' ').trim());
                    if (text.length < 2 || isSystemPrompt(text)) continue;
                    var dup = false;
                    for (var d = 0; d < itTexts.length; d++) {
                        if (isSimilar(itTexts[d], text)) { dup = true; break; }
                    }
                    if (dup) continue;
                    results.push(text);
                    if (!subFoundNode) subFoundNode = node;
                }
            }
        } catch (e) {}
        return results;
    }

    // =========================================================================
    // ENERGIA: ZAPAMIĘTANE MIEJSCE NAPISÓW
    // * Raz znaleziony kontener → czytamy i obserwujemy TYLKO jego (nie całą stronę).
    // * Shadow DOM (np. Immersive Translate) — globalne szukanie WYŁĄCZNIE na żądanie
    //   (przycisk „🔍 Znajdź napisy” w popupie); znaczniki hostów zapisujemy w pamięci strony,
    //   więc następnym razem trafiamy od razu (getElementsByTagName), bez przeszukiwania.
    // * Bez zapisu w pamięci NIC nie szukamy — lektor czeka na kliknięcie 🔍 (oszczędność energii).
    // * Zapisane miejsce (host Shadow DOM albo ścieżka kontenera) odnajdujemy celowanym zapytaniem.
    // =========================================================================
    var SUB_HINT_KEY = 'livedub_subHint';
    var subHint = { hosts: [] }, subLock = null, subFoundNode = null, subLastRelock = 0;
    // [FIX 2026-11-22] skąd jest zamek: 'it' (Immersive Translate / Kreator), 'native' (wbudowane napisy serwisu),
    // 'hint' (miejsce z pamięci strony — nie wiadomo jakie). Zamek inny niż 'it' sprawdzamy co jakiś czas, czy nie
    // pojawiły się napisy IT (np. użytkownik włączył Immersive Translate później) — wtedy przechodzimy na nie.
    var subLockKind = '';
    try { subHint = JSON.parse(localStorage.getItem(SUB_HINT_KEY) || 'null') || { hosts: [] }; } catch (e) { subHint = { hosts: [] }; }
    function subLockAlive() {
        if (!subLock) return false;
        if (subLock.nodeType === 11) return !!(subLock.host && subLock.host.isConnected);
        return subLock.isConnected;
    }
    function subRoots() { return subLockAlive() ? [subLock] : []; }
    function subBoxFor(node) {
        var r = node.getRootNode ? node.getRootNode() : document;
        if (r && r.nodeType === 11) return r;               // Shadow DOM: cały shadow root
        var box = node, up = 0;
        while (box.parentElement && box.parentElement !== document.body && up < 3) { box = box.parentElement; up++; }
        return box;
    }
    function subCssPath(el) { // krótka ścieżka CSS do kontenera (id albo znacznik+klasy), do zapisu w pamięci
        var parts = [], cur = el, depth = 0;
        while (cur && cur.nodeType === 1 && cur !== document.body && depth < 5) {
            if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
            var part = cur.tagName.toLowerCase();
            for (var i = 0; i < cur.classList.length && i < 2; i++) part += '.' + CSS.escape(cur.classList[i]);
            parts.unshift(part); cur = cur.parentElement; depth++;
        }
        return parts.join(' > ');
    }
    // Odnajdź zapamiętane miejsce (celowane zapytania — nie przeszukiwanie strony), max raz na sekundę.
    // [AGENT-EXP] 2026-10-24: WSPÓLNA pamięć miejsca napisów Immersive Translate (chrome.storage.local, wszystkie strony).
    // Immersive Translate wszędzie rysuje napisy tak samo: albo własnymi klasami w zwykłym DOM (IT_SELECTORS, np.
    // .imt-captions-text, #immersive-translate-caption-window), albo w Shadow DOM swojego elementu (znacznik zapamiętany
    // raz — na dowolnej stronie — w IMT_KNOWN_KEY). Lektor sprawdza te znane miejsca celowanymi zapytaniami, zamiast
    // przeszukiwać stronę; pełne szukanie (subAutoSearchIT) zostaje tylko na wypadek, gdyby IT zmienił budowę.
    var IMT_KNOWN_KEY = 'imtKnownPlaces';
    var imtKnownHosts = [];
    try { chrome.storage.local.get(IMT_KNOWN_KEY, function (r) { var k = r && r[IMT_KNOWN_KEY]; if (k && Array.isArray(k.hosts)) imtKnownHosts = k.hosts.slice(0, 8); }); } catch (e) {}
    try { chrome.storage.onChanged.addListener(function (ch, area) { if (area === 'local' && ch[IMT_KNOWN_KEY] && ch[IMT_KNOWN_KEY].newValue && Array.isArray(ch[IMT_KNOWN_KEY].newValue.hosts)) imtKnownHosts = ch[IMT_KNOWN_KEY].newValue.hosts.slice(0, 8); }); } catch (e) {}
    function imtRememberHost(host) {
        if (!host || imtKnownHosts.indexOf(host) === 0) return;
        imtKnownHosts = [host].concat(imtKnownHosts.filter(function (h) { return h !== host; })).slice(0, 8);
        try { var o = {}; o[IMT_KNOWN_KEY] = { hosts: imtKnownHosts }; chrome.storage.local.set(o); } catch (e) {}
    }
    function subTryKnownIT() {   // znane miejsca IT: Shadow DOM zapamiętanych znaczników + klasy IT w zwykłym DOM
        if (!getVideo()) return null;   // bez filmu w tej ramce nie ma napisów do czytania (energia)
        for (var i = 0; i < imtKnownHosts.length; i++) {
            var hs;
            try { hs = document.getElementsByTagName(imtKnownHosts[i]); } catch (e) { continue; }
            for (var j = 0; j < hs.length; j++) {
                if (!hs[j].shadowRoot) continue;
                subFoundNode = null; collectITIn(hs[j].shadowRoot, []);
                if (subFoundNode) { subFoundNode = null; return hs[j].shadowRoot; }
            }
        }
        subFoundNode = null; collectITIn(document, []);
        var n = subFoundNode; subFoundNode = null;
        return n ? subBoxFor(n) : null;
    }
    function subRelock() {
        var now = Date.now();
        if (now - subLastRelock < 1000) return;
        subLastRelock = now;
        var known = subTryKnownIT();   // [AGENT-EXP] 2026-10-24: najpierw wspólna pamięć IT
        if (known) {
            var kh = known.nodeType === 11 && known.host ? known.host.tagName.toLowerCase() : '';
            subHint = kh ? { hosts: [kh], box: '' } : { hosts: [], box: subCssPath(known) };
            try { localStorage.setItem(SUB_HINT_KEY, JSON.stringify(subHint)); } catch (e) {}
            subSetLock(known);
            subLockKind = 'it';
            return;
        }
        var hosts = subHint.hosts || [];
        for (var i = 0; i < hosts.length; i++) {
            var hs;
            try { hs = document.getElementsByTagName(hosts[i]); } catch (e) { continue; }
            for (var j = 0; j < hs.length; j++) if (hs[j].shadowRoot) { subSetLock(hs[j].shadowRoot); subLockKind = 'hint'; return; }
        }
        if (subHint.box) {
            var el = null;
            try { el = document.querySelector(subHint.box); } catch (e) {}
            if (el) { subSetLock(el); subLockKind = 'hint'; }
        }
    }
    function subSetLock(box) {
        subLock = box;
        if (observer) {
            observer.disconnect();
            if (box) { try { observer.observe(box, { childList: true, subtree: true, characterData: true }); } catch (e) {} }
        }
    }
    // Po skanie: zapamiętaj kontener albo zwolnij go, gdy długo milczy przy grającym filmie.
    function subAfterScan() { subFoundNode = null; } // miejsce zmienia tylko przycisk 🔍 (na żądanie)
    // NA ŻĄDANIE: jednorazowe globalne szukanie (cała strona + Shadow DOM) → zapis w pamięci.
    // Zapis ZASTĘPUJE poprzedni — w pamięci jest zawsze JEDNO miejsce (najnowsze), nigdy stare + nowe.
    function subOverVideo(node) {
        var v = getVideo();
        if (!v || !node || !node.getBoundingClientRect) return false;
        var a, b;
        try { a = v.getBoundingClientRect(); b = node.getBoundingClientRect(); } catch (e) { return false; }
        if (!(a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0)) return false;
        var cx = b.left + b.width / 2, cy = b.top + b.height / 2, mx = a.width * 0.1, my = a.height * 0.1;
        return cx >= a.left - mx && cx <= a.right + mx && cy >= a.top - my && cy <= a.bottom + my;
    }
    function subSearchOnDemand(itOnly, nativeOnly) {   // [AGENT-EXP] 2026-10-24: itOnly — samo-szukanie tylko napisów Immersive Translate
        // [FIX 2026-11-22] nativeOnly — tylko wbudowane napisy serwisu (źródło „native” w ustawieniach)
        var found = null;
        function walk(root) {
            if (found) return; // pierwsze trafienie wystarcza — dalej nie szukamy
            subFoundNode = null;
            var it = nativeOnly ? [] : collectITIn(root, []);
            if (!itOnly) collectNativeIn(root, [], it);
            if (subFoundNode) { found = subFoundNode; return; }
            var all;
            try { all = root.querySelectorAll('*'); } catch (e) { return; }
            for (var k = 0; k < all.length && !found; k++) { try { if (all[k].shadowRoot) walk(all[k].shadowRoot); } catch (e) {} }
        }
        walk(document);
        subFoundNode = null;
        if (!found) return null; // nic nie znaleziono — dotychczasowy zapis zostaje bez zmian
        var isIT = false;
        try { isIT = !!(found.matches && found.matches(IT_GROUP)); } catch (e) {}
        // [FIX 2026-11-22] wbudowane napisy łapiemy też przez ogólne selektory ([class*="caption"] itp.) — teraz szukamy
        // ich SAMI, więc bierzemy tylko tekst leżący na filmie (inaczej mógłby się złapać np. podpis pod zdjęciem)
        if (!isIT && !subOverVideo(found)) return null;
        var box = subBoxFor(found);
        var host = box.nodeType === 11 && box.host ? box.host.tagName.toLowerCase() : '';
        try { if (host && isIT) imtRememberHost(host); } catch (e) {}   // [AGENT-EXP] 2026-10-24: do wspólnej pamięci
        subHint = host ? { hosts: [host], box: '' } : { hosts: [], box: subCssPath(box) };
        try { localStorage.setItem(SUB_HINT_KEY, JSON.stringify(subHint)); } catch (e) {}
        subSetLock(box);
        subLockKind = isIT ? 'it' : 'native';
        return { hosts: host ? [host] : [], kind: subLockKind };
    }

    // [AGENT-EXP] 2026-10-24: Immersive Translate SAM — bez przycisku 🔍. Gdy nie ma zapamiętanego miejsca, a film
    // w tej ramce gra, co 2 s szukamy napisów Immersive Translate (cała strona + Shadow DOM); po 2 min bez skutku
    // co 10 s (energia). Znalezione miejsce trafia do pamięci strony jak po 🔍, więc dalej działa zwykły tryb.
    // Szukanie jest przed wyborem silnika — działa dla każdego lektora (Sherpa, Matcha, Supertonic, głos przeglądarki…).
    var subAutoLast = 0, subAutoTries = 0;
    function subAutoSearchIT() {
        var v = getVideo();
        if (!v || v.paused) return;
        var now = Date.now();
        if (now - subAutoLast < (subAutoTries < 60 ? 2000 : 10000)) return;
        subAutoLast = now;
        subAutoTries++;
        // [FIX 2026-11-22] najpierw IT / Kreator, potem WBUDOWANE napisy serwisu — dawniej wbudowane lektor czytał dopiero
        // po kliknięciu 🔍 w popupie (bez tego milczał, nic o tym nie mówiąc). Źródło z ustawień decyduje o kolejności.
        var src = primeSubtitleSource || 'both';
        var hit = src === 'native'
            ? (subSearchOnDemand(false, true) || subSearchOnDemand(true))
            : (subSearchOnDemand(true) || (src !== 'immersive' ? subSearchOnDemand(false, true) : null));
        if (hit) subAutoTries = 0;
    }
    // [FIX 2026-11-22] zamek nie z IT (wbudowane albo z pamięci strony): co 5 s przy grającym filmie sprawdzamy, czy nie ma
    // napisów IT / Kreatora — mają pierwszeństwo (chyba że w ustawieniach źródło = tylko wbudowane)
    var subUpgradeAt = 0;
    function subMaybeUpgradeIT() {
        if (isIqiyi || subLockKind === 'it' || primeSubtitleSource === 'native') return;
        var v = getVideo();
        if (!v || v.paused) return;
        var now = Date.now();
        if (now - subUpgradeAt < 5000) return;
        subUpgradeAt = now;
        subSearchOnDemand(true);
    }
    // [FIX 2026-11-22] „↺ od nowa” z popupu: zapomnij zapamiętane miejsce (mogło być złe albo nieaktualne)
    function subResetHint() {
        subHint = { hosts: [] };
        try { localStorage.removeItem(SUB_HINT_KEY); } catch (e) {}
        subSetLock(null);
        subLockKind = '';
        subAutoLast = 0; subAutoTries = 0;
    }

    // Bieżący napis — zależnie od serwisu i opcji źródła.
    // - iQIYI: WYŁĄCZNIE Immersive Translate (PL) — bez fallbacku do wbudowanych
    //   (wbudowane to oryginał EN/CN; fallback czytał angielskie zdania).
    // - Prime Video: wg ustawienia primeSubtitleSource ('both' domyślnie = IT + wbudowane).
    function getCurrentCaption() {
        var itTexts = collectITJoined();
        var natTexts = collectNative(document, [], itTexts);

        var useIT = true;
        var useNative = false;

        if (isIqiyi) {
            useIT = true;
            useNative = false; // iQ: WYŁĄCZNIE Immersive Translate. Wbudowane napisy to oryginał
                               // (EN/CN) — ich fallback czytał angielski, gdy IT się wleczał.
        } else if (primeSubtitleSource === 'immersive') {
            useIT = true;
            useNative = false;
        } else if (primeSubtitleSource === 'native') {
            useIT = false;
            useNative = true;
        } else {
            useIT = true;
            useNative = true;
        }

        var candidates = [];
        if (useIT) { for (var a = 0; a < itTexts.length; a++) candidates.push(itTexts[a]); }
        if (useNative) { for (var b = 0; b < natTexts.length; b++) candidates.push(natTexts[b]); }

        // "Oba": jeśli IT coś znalazł — czytamy tłumaczenie; inaczej wbudowane.
        if (useIT && useNative && itTexts.length > 0) candidates = itTexts.slice();
        if (useIT && useNative && itTexts.length === 0) candidates = natTexts.slice();

        if (!candidates.length) return null;
        var uniq = [];
        for (var i = 0; i < candidates.length; i++) {
            if (uniq.indexOf(candidates[i]) === -1) uniq.push(candidates[i]);
        }
        // Preferencja polskiego: gdy wśród kandydatów jest linia z polskimi
        // diakrytykami, czytamy TYLKO polskie (to odfiltrowuje angielski oryginał,
        // który na iq.com bywa widoczny obok tłumaczenia Immersive Translate).
        var pl = [];
        for (var p = 0; p < uniq.length; p++) {
            if (looksPolish(uniq[p]) || PL_WORDS_RE.test(uniq[p])) pl.push(uniq[p]);
        }
        if (pl.length) uniq = pl;
        else {
            // Bez diakrytyków: odrzucamy linie wyglądające na angielskie
            // (np. "Hello.", "Yes." — oryginał IT albo napisy wbudowane EN).
            var notEn = [];
            for (var q = 0; q < uniq.length; q++) {
                if (!looksEnglish(uniq[q])) notEn.push(uniq[q]);
            }
            if (notEn.length) uniq = notEn;
            else return null; // tylko EN w tym skanie → milczymy, nigdy nie czytamy angielskiego
        }
        return uniq[uniq.length - 1] || null;
    }

    // ===== Emisja do TTS (z dedupem między ramkami/kartami) =====
    var spokenWords = 0, spokenCues = 0;   // telemetria: wyrazy/kwestie wypowiedziane
    var recentSpoken = [];                 // telemetria: ostatnie kwestie {t, w}
    var fileSubs = [], fileTimer = null, fileLookahead = 180000; // napisy z pliku
    var filePreloaded = new Set(), filePlayed = new Set();

    // [FIX 2026-11-25] NAPISY NALEŻĄ DO FILMU. Po przejściu na inny film bez odświeżenia karty lektor (i cenzor, który
    // dostaje od nas tę listę) dalej używał napisów poprzedniego filmu — cisza padała w losowych miejscach, po F5 znikała.
    // Lista pamięta stronę (klucz jak w background fileSubsPageKey) i długość <video>, przy których ją wczytano.
    // Inna strona albo film o innej długości w tym samym odtwarzaczu = lektor tej listy nie czyta, a cenzor jej nie bierze.
    function czPageKey(href) {
        try {
            var u = new URL(href || location.href), keep = [];
            ['v', 'id', 'video', 'vid', 'video_id', 'episode', 'ep', 'watch', 'movie', 'film', 'p'].forEach(function (k) { var x = u.searchParams.get(k); if (x) keep.push(k + '=' + x); });
            return u.origin + u.pathname + '?' + keep.join('&');
        } catch (e) { return String(href || ''); }
    }
    function czDur(v) { var d = v ? Number(v.duration) : NaN; return isFinite(d) && d > 0 ? d : 0; }
    function czSameFilm(a, b) { return !a || !b || Math.abs(a - b) <= 2; }
    var fileOwner = { page: '', key: '', dur: 0 }, otherFilm = { dur: 0, since: 0, done: false };
    function setFileOwner() {
        var v = null; try { v = getVideo(); } catch (e) {}
        fileOwner = { page: location.href.split('#')[0], key: czPageKey(), dur: czDur(v) };
        otherFilm = { dur: 0, since: 0, done: false };
    }
    // true = lista pasuje do filmu, który teraz gra (albo nie ma listy / nie da się tego sprawdzić)
    function fileOwnerOk() {
        if (!fileSubs.length || !fileOwner.key) return true;
        if (fileOwner.key !== czPageKey()) return false;
        var v = null; try { v = getVideo(); } catch (e) {}
        var d = czDur(v);
        if (d && !fileOwner.dur) fileOwner.dur = d;   // długość znana dopiero teraz — lista należy do tego filmu
        return czSameFilm(fileOwner.dur, d);
    }
    // Inny film (nie reklama: > 90 s) gra w tym samym odtwarzaczu dłużej niż 6 s → stare napisy precz i Łowca szuka od nowa.
    function checkOtherFilm() {
        if (!fileSubs.length || !fileOwner.key || fileOwner.key !== czPageKey()) return;
        var v = null; try { v = getVideo(); } catch (e) {}
        var d = czDur(v);
        if (!d || czSameFilm(fileOwner.dur, d) || d < 90) { otherFilm = { dur: 0, since: 0, done: false }; return; }
        if (!czSameFilm(otherFilm.dur, d) || !otherFilm.since) { otherFilm = { dur: d, since: Date.now(), done: false }; return; }
        if (otherFilm.done || Date.now() - otherFilm.since < 6000) return;
        otherFilm.done = true;
        try { console.log('[Lektor] inny film w odtwarzaczu (' + Math.round(d) + ' s ≠ ' + Math.round(fileOwner.dur) + ' s) — usuwam stare napisy, szukam nowych'); } catch (e) {}
        autoSubs = null; manualFile = false; lastFile = null; fileMyLast = null;
        dropFileSubs();
        try { window.postMessage({ __lowca: 'cmd', cmd: 'reset' }, '*'); } catch (e) {}   // Łowca: bufor od nowa (lowca_napisow.js)
    }

    // --- Offset napisów: global z panelu ⚙ + fallback z storage (gwarancja przy starcie strony) ---
    var storageOffsetMs = 0;
    function getOff() {
        var g = window.__LIVEDUB_OFFSET_MS__;
        return (typeof g === 'number') ? g : (storageOffsetMs || 0);
    }
    // Hook na zmianę offsetu: czyści kolejkę audio (stare kwestie brzmiałyby nieaktualnie)
    // i pomija kwestie z pliku, które przy nowym przesunięciu już minęły.
    try {
        window.__LIVEDUB_OFFSET_HOOKS__ = window.__LIVEDUB_OFFSET_HOOKS__ || [];
        window.__LIVEDUB_OFFSET_HOOKS__.push(function (newOff) {
            try { if (enabled) chrome.runtime.sendMessage({ action: 'TTS_CLEAR_BUFFER' }); } catch (e) {}
            try {
                var v = getVideo();
                if (!v) return;
                var nowMs = v.currentTime * 1000;
                for (var j = 0; j < fileSubs.length; j++) {
                    var s2 = fileSubs[j];
                    if (!filePlayed.has(s2) && (s2.endMs + newOff) < nowMs) filePlayed.add(s2);
                }
            } catch (e) {}
        });
    } catch (e) {}

    // --- Log wypowiedzianych tekstów (sekcja „🗣️ Wypowiedziane” w panelu ⚙️) ---
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
    } catch (e) {}

    // Tryb lektora na tej stronie (Prime/iQ/Dailymotion/Rumble: na żywo albo plik).
    try {
        window.__LIVEDUB_GET_MODE__ = function () {
            if (fileSubs.length) return { mode: 'file', cues: fileSubs.length };
            return { mode: 'live', cues: 0 };
        };
    } catch (e) {}

    // ===== Blokowane frazy =====
    // Lektor przestaje je czytać. Porównanie nieczułe na wielkość liter.
    var BLOCKED_PHRASES = [
        'only the translation',
        'only the translation ,,'
    ];
    function isBlockedPhrase(text) {
        var t = String(text || '').toLowerCase();
        for (var i = 0; i < BLOCKED_PHRASES.length; i++) {
            if (t.indexOf(BLOCKED_PHRASES[i]) !== -1) return true;
        }
        return false;
    }

    function liveSrc(n) { try { var S = window.__LektorSched, g = S && S.getSource(); if (S && (!g || g.name !== n)) S.setSource(n, 0); } catch (e) {} }   // [FIX 2026-11-02] „czytam z: …”
    function emitIfNew(text) {
        if (!enabled) return;
        if (fileSubs.length) return; // tryb napisów z pliku — żywe czytanie wyłączone
        if (document.visibilityState !== 'visible') return;
        // Bezpiecznik: NIGDY nie czytamy śmieci UI (bannery Immersive Translate
        // typu "Enable subtitle settings" na iQIYI), nawet gdyby przedostały się
        // przez selektory. Przerywają one lektora, dlatego blokujemy je tuż przed TTS.
        var cleanAgain = cleanTranslationJunk(text);
        if (!cleanAgain || isSystemPrompt(cleanAgain) || isBlockedPhrase(cleanAgain)) { panelLog(text, 'blocked'); return; }
        var v = getVideo(); if (!v || v.paused) return;
        var now = Date.now();
        var key = hashStr(text);
        if (spokenKey[key] && now - spokenKey[key] < 3000) return;
        spokenKey[key] = now;
        pendingKey = key;
        if (bc) bc.postMessage({ cmd: 'candidate', key: key, ts: now });
        clearTimeout(speakTimer);
        speakTimer = setTimeout(function () {
            speakTimer = null;
            if (pendingKey !== key) return; // inna ramka/karta zgłosiła ten sam tekst
            pendingKey = null;
            if (!enabled || document.visibilityState !== 'visible') return;
            var vNow = getVideo(); if (!vNow || vNow.paused) return;
            applyDuck();
            var id = 'stream_' + Date.now() + '_' + key;
            panelLog(cleanAgain, 'spoken');
            liveSrc(netTr ? 'na żywo: napisy ze strony → tłumacz' : 'na żywo: napisy ze strony');
            chrome.runtime.sendMessage({
                action: 'TTS_PLAY', id: id, text: cleanAgain, durationMs: 0,
                videoTimeMs: vNow ? Math.round(vNow.currentTime * 1000) : 0
            });
            // Telemetria: liczymy wypowiedziane wyrazy (napisy czytane na żywo).
            var w = String(cleanAgain || '').trim().split(/\s+/).filter(Boolean).length;
            spokenWords += w;
            spokenCues++;
            recentSpoken.push({ t: cleanAgain, w: w });
            if (recentSpoken.length > 5) recentSpoken.shift();
            pushSpoken(cleanAgain);
            liveEver = true;   // [FIX 2026-11-16] odtąd pasek 📊 pokazuje czytanie z ekranu
        }, FRAME_SETTLE_MS + Math.max(0, getOff()));
    }

    // ===== Tłumaczenie sieciowe na żywo (iq.com, Prime, Dailymotion, Rumble…) =====
    // Gdy w ustawieniach wybrany jest silnik sieciowy: polski napis (np. z Immersive Translate)
    // czytamy od razu, a napis w innym języku tłumaczy service worker wybranym silnikiem.
    // [FIX 2026-11-02] własne źródło złapane linia po linii (≥2 trafienia) = jeden napis: linie w kolejności na stronie
    function customText(min) {
        var u = [];
        for (var i = 0; i < customHits.length; i++) if (u.indexOf(customHits[i]) === -1) u.push(customHits[i]);
        return u.length >= (min || 1) ? u.join(' ') : '';
    }
    function customJoined() { return customText(2); }
    function collectITJoined() {
        customHits = [];
        var it = collectIT(document, []);
        var joined = customJoined();
        if (joined) { it = it.filter(function (t) { return customHits.indexOf(t) === -1; }); it.push(joined); }
        return it;
    }
    function getNetCaption() {
        var itTexts = collectITJoined();
        var own = customText(1);   // [FIX 2026-11-02] własne źródło z Kreatora ma pierwszeństwo (cały napis, obcy → tłumacz)
        if (own) return { text: own, needTr: !(looksPolish(own) || PL_WORDS_RE.test(own)) };
        var natTexts = collectNative(document, [], itTexts);
        var all = itTexts.concat(natTexts);
        for (var i = all.length - 1; i >= 0; i--) {
            if (looksPolish(all[i]) || PL_WORDS_RE.test(all[i])) return { text: all[i], needTr: false };
        }
        var src = natTexts.length ? natTexts : itTexts;
        if (!src.length) return null;
        return { text: src[src.length - 1], needTr: true };
    }
    function translateLive(text) {
        var t0 = Date.now();
        try {
            chrome.runtime.sendMessage({ action: 'EXT_TR_LIVE', text: text }, function (r) {
                void chrome.runtime.lastError;
                if (!r || !r.ok || !r.text) return;
                if (Date.now() - t0 > 8000) return; // tłumaczenie przyszło za późno — kwestia już minęła
                emitIfNew(r.text);
            });
        } catch (e) {}
    }

    function scanCaptions() {
        if (!enabled) return;
        if (document.visibilityState !== 'visible') return;
        // ENERGIA: czytamy TYLKO z zapamiętanego miejsca; brak → szukamy sami przy grającym filmie (IT, Kreator, wbudowane)
        if (!isIqiyi && !subLockAlive()) { subRelock(); if (!subLockAlive()) subAutoSearchIT(); if (!subLockAlive()) return; }   // [AGENT-EXP] 2026-10-24: IT samo; iQIYI — cała strona (collectITDeep)
        else if (!isIqiyi) subMaybeUpgradeIT();   // [FIX 2026-11-22]
        if (netTr && !fileSubs.length) {
            var c = getNetCaption();
            subAfterScan(!!c);
            if (!c) { zdLiveGone(); return; }   // [AGENT-EXP] napis zniknął — niedokończone zdanie czeka już tylko chwilę
            if (c.text === lastSubtitle) return;
            // [AGENT-EXP] całe zdania: obcy napis czeka na dalszy ciąg zdania (i na koniec narastania), potem tłumacz
            if (c.needTr && zdOn) { lastSubtitleAt = Date.now(); lastSubtitle = c.text; zdLiveFeed(c.text, translateLive, 450); return; }
            if (lastSubtitleAt && isSimilar(c.text, lastSubtitle) && Date.now() - lastSubtitleAt < 2500) return;
            lastSubtitleAt = Date.now();
            lastSubtitle = c.text;
            if (c.needTr) translateLive(c.text); else { zdRelease(); emitIfNew(c.text); }
            return;
        }
        var text = getCurrentCaption();
        subAfterScan(!!text);
        if (!text) return;
        var now = Date.now();
        if (text === lastSubtitle) return;
        // Blokada podobnych duplikatów w <2,5 s (jak w Zero-Lag) — np. ta sama kwestia
        // wykryta jednocześnie w Immersive Translate i w napisach wbudowanych.
        if (lastSubtitleAt && isSimilar(text, lastSubtitle) && now - lastSubtitleAt < 2500) return;
        lastSubtitleAt = now;
        lastSubtitle = text;
        emitIfNew(text);
    }
    function scheduleScan() {
        if (scanTimer) return;
        scanTimer = setTimeout(function () { scanTimer = null; scanCaptions(); }, OBSERVER_DEBOUNCE_MS);
    }

    // ===== MutationObserver =====
    function initObserver() {
        if (typeof MutationObserver === 'undefined') return;
        if (observer) observer.disconnect();
        observer = new MutationObserver(function () {
            if (enabled) scheduleScan();
        });
        // ENERGIA: obserwujemy TYLKO zapamiętany kontener napisów; bez niego wystarczy poll
        if (isIqiyi) { try { observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true }); } catch (e) {} return; }   // [AGENT-EXP] 2026-10-24: jak stary lektor
        if (subLockAlive()) { try { observer.observe(subLock, { childList: true, subtree: true, characterData: true }); } catch (e) {} }
    }

    // ===== Focus / wiele kart =====
    function onFocus() {
        tabFocused = true;
        if (bc) bc.postMessage({ cmd: 'active' });
        if (enabled) applyDuck();
    }
    function onBlur() {
        // Utrata fokusu okna (np. otwarcie popupu rozszerzenia) NIE zatrzymuje lektora;
        // zatrzymanie następuje dopiero przy ukryciu karty (visibilitychange poniżej).
        tabFocused = false;
        if (bc) bc.postMessage({ cmd: 'inactive' });
    }
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') onFocus();
        else { tabFocused = false; stopSpeech(); if (bc) bc.postMessage({ cmd: 'inactive' }); } // ukrycie karty nadal zatrzymuje lektora
    });
    if (bc) bc.onmessage = function (ev) {
        var d = ev.data || {};
        if (d.cmd === 'active' && !tabFocused) { stopSpeech(); }
        if (d.cmd === 'candidate') {
            if (d.key) spokenKey[d.key] = Date.now();
            if (pendingKey === d.key) {
                clearTimeout(speakTimer); speakTimer = null; pendingKey = null;
            }
        }
    };

    // ===== Status dla popupu =====
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        if (msg && msg.action === 'GET_SUB_STATUS') {
            sendResponse({ queueLength: lastSubtitle ? 1 : 0, focused: tabFocused });
            return true;
        }
        if (msg && msg.action === 'FIND_SUB_CONTAINER') {
            // [FIX 2026-11-22] „↺ Szukaj miejsca napisów od nowa”: najpierw zapominamy stare miejsce (we wszystkich ramkach),
            // potem szukamy jak automat (IT / Kreator przed wbudowanymi)
            if (msg.reset) subResetHint();
            var res = (primeSubtitleSource === 'native')
                ? (subSearchOnDemand(false, true) || subSearchOnDemand(true))
                : (subSearchOnDemand(true) || (primeSubtitleSource !== 'immersive' ? subSearchOnDemand(false, true) : null));
            if (!res) return; // ta ramka nic nie znalazła — odpowie inna (albo popup pokaże „nie znaleziono”)
            sendResponse({ ok: true, found: true, kind: res.kind, where: (res.kind === 'it' ? 'Immersive Translate / Kreator' : 'napisy serwisu') + ', ' + (res.hosts.length ? 'Shadow DOM: <' + res.hosts.join('>, <') + '>' : 'zwykły DOM strony') });
            return true;
        }
    });

    // ===== Panel podglądu lektora + filtrowanie fraz przez użytkownika =====
    var panelBox = null, panelList = null, panelInput = null, panelBlocked = null, panelPill = null;

    function mkBtn(label, title, onClick) {
        var b = document.createElement('button');
        b.textContent = label;
        b.title = title;
        b.style.cssText = 'flex:0 0 auto;background:rgba(255,255,255,0.12);color:#eee;border:1px solid rgba(255,255,255,0.2);border-radius:5px;padding:1px 6px;font:10px system-ui,sans-serif;cursor:pointer;';
        b.addEventListener('click', onClick);
        return b;
    }

    function addUserPhrase(phrase) {
        phrase = normalizeForCheck(phrase).toLowerCase();
        if (!phrase || phrase.length < 2) return;
        if (userBlockedPhrases.indexOf(phrase) === -1) {
            userBlockedPhrases.push(phrase);
            try { chrome.storage.local.set({ 'userBlockedPhrases': userBlockedPhrases.slice() }); } catch (e) {}
        }
        renderBlockedChips();
    }

    function removeUserPhrase(phrase) {
        var i = userBlockedPhrases.indexOf(phrase);
        if (i !== -1) {
            userBlockedPhrases.splice(i, 1);
            try { chrome.storage.local.set({ 'userBlockedPhrases': userBlockedPhrases.slice() }); } catch (e) {}
        }
        renderBlockedChips();
    }

    // [FIX 2026-11-02] blokada pasuje do CAŁYCH słów (granice liter/cyfr): „tak” nie wycisza już zdań z „także”, „takiego”.
    // Brzeg wpisu, który sam nie jest literą (np. „only the translation ,,”), sprawdzany jest jak dawniej (podciąg).
    function phraseHit(text, phrase) {
        if (!phrase) return false;
        var w = /[\p{L}\p{N}]/u, i = text.indexOf(phrase);
        var needL = w.test(phrase.charAt(0)), needR = w.test(phrase.charAt(phrase.length - 1));
        while (i !== -1) {
            var okL = !needL || i === 0 || !w.test(text.charAt(i - 1));
            var okR = !needR || i + phrase.length >= text.length || !w.test(text.charAt(i + phrase.length));
            if (okL && okR) return true;
            i = text.indexOf(phrase, i + 1);
        }
        return false;
    }
    function isUserBlocked(text) {
        if (!userBlockedPhrases.length) return false;
        var norm = normalizeForCheck(text).toLowerCase();
        for (var i = 0; i < userBlockedPhrases.length; i++) {
            if (phraseHit(norm, String(userBlockedPhrases[i] || '').toLowerCase())) return true;
        }
        return false;
    }

    function renderBlockedChips() {
        if (!panelBlocked) return;
        try {
            panelBlocked.textContent = '';
            for (var i = 0; i < userBlockedPhrases.length; i++) {
                (function (ph) {
                    var chip = document.createElement('span');
                    chip.style.cssText = 'display:inline-flex;align-items:center;gap:3px;background:rgba(255,90,90,0.18);border:1px solid rgba(255,90,90,0.35);border-radius:999px;padding:1px 6px;margin:1px 3px 1px 0;font-size:9px;';
                    chip.textContent = ph;
                    var x = document.createElement('span');
                    x.textContent = '✕';
                    x.title = 'Usuń z blokad';
                    x.style.cssText = 'cursor:pointer;opacity:0.8;';
                    x.addEventListener('click', function () { removeUserPhrase(ph); });
                    chip.appendChild(x);
                    panelBlocked.appendChild(chip);
                })(userBlockedPhrases[i]);
            }
        } catch (e) {}
    }

    function panelLog(text, status) {
        if (!panelList) return;
        try {
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:5px;align-items:flex-start;padding:2px 8px;border-bottom:1px solid rgba(255,255,255,0.06);';
            var icon = document.createElement('span');
            icon.textContent = status === 'spoken' ? '🔊' : '🚫';
            icon.title = status === 'spoken' ? 'Wypowiedziane' : 'Zablokowane przez filtr';
            icon.style.cssText = 'flex:0 0 auto;';
            var tx = document.createElement('span');
            tx.textContent = normalizeForCheck(text);
            tx.style.cssText = 'flex:1;word-break:break-word;' + (status === 'spoken' ? '' : 'opacity:0.55;text-decoration:line-through;');
            var bx = mkBtn('🚫', 'Zablokuj tę frazę', function () { addUserPhrase(text); });
            row.appendChild(icon); row.appendChild(tx); row.appendChild(bx);
            panelList.insertBefore(row, panelList.firstChild);
            while (panelList.childNodes.length > 30) panelList.removeChild(panelList.lastChild);
        } catch (e) {}
    }

    function applyPanelVisibility() {
        try {
            if (panelBox) panelBox.style.display = panelOn && panelVisible ? 'flex' : 'none';
            if (panelPill) panelPill.style.display = panelOn && !panelVisible ? 'flex' : 'none'; // [AGENT-EXP] panelOn
        } catch (e) {}
    }

    function setPanelVisible(vis) {
        panelVisible = vis;
        try { chrome.storage.local.set({ 'panelVisible': vis }); } catch (e) {}
        applyPanelVisibility();
    }

    // [AGENT-EXP] 2026-11-26: panel przesuwany — chwyć za nagłówek i przeciągnij; miejsce zapamiętane (lektorPanelPos, wspólne dla stron).
    // Pigułka (panel zwinięty) stoi w tym samym miejscu i też się przeciąga; klik bez przesunięcia = rozwiń.
    function makeDraggable(pairs) {   // pairs: [[element, uchwyt], ...] — wszystkie elementy dostają tę samą pozycję
        var d = null, moved = false;
        // zakotwiczenie od DOŁU (left + bottom): panel rozwija się z pigułki do góry
        function place(x, b) {
            x = Math.max(0, Math.min(window.innerWidth - 60, x));
            b = Math.max(0, Math.min(window.innerHeight - 30, b));
            pairs.forEach(function (p) { p[0].style.left = x + 'px'; p[0].style.bottom = b + 'px'; p[0].style.top = 'auto'; });
        }
        pairs.forEach(function (p) {
            var el = p[0], h = p[1];
            h.style.cursor = 'move';
            h.addEventListener('mousedown', function (e) {
                var c = e.target.closest && e.target.closest('button,input');
                if (e.button !== 0 || (c && c !== h)) return;
                d = { x0: e.clientX, y0: e.clientY, left: el.offsetLeft, bottom: window.innerHeight - el.offsetTop - el.offsetHeight };   // offset* = bez skali uiScale
                moved = false;
                e.preventDefault(); e.stopPropagation();
            });
            // po przeciągnięciu pigułki nie rozwijamy panelu
            el.addEventListener('click', function (e) { if (moved) { moved = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
        });
        window.addEventListener('mousemove', function (e) {
            if (!d) return;
            if (!moved && Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) < 4) return;
            moved = true;
            place(d.left + e.clientX - d.x0, d.bottom - (e.clientY - d.y0));
        }, true);
        window.addEventListener('mouseup', function () {
            if (!d) return;
            d = null;
            if (!moved) return;
            setTimeout(function () { moved = false; }, 0);   // „click” zaraz po puszczeniu jest połknięty, następne kliknięcia działają
            var s = pairs[0][0].style;
            try { chrome.storage.local.set({ lektorPanelPos: { x: parseInt(s.left, 10), b: parseInt(s.bottom, 10) } }); } catch (e) {}
        }, true);
        try {
            chrome.storage.local.get(['lektorPanelPos'], function (r) {
                var p = r && r.lektorPanelPos;
                if (p && isFinite(p.x) && isFinite(p.b)) place(p.x, p.b);   // stary zapis {x,y} (od góry) pomijamy
            });
        } catch (e) {}
    }

    function createPanel() {
        if (panelBox) return;
        var root = document.body || document.documentElement;
        if (!root) return;
        panelBox = document.createElement('div');
        panelBox.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147483647;width:272px;max-height:40vh;display:flex;flex-direction:column;background:rgba(18,18,22,0.94);color:#e8e8e8;font:11px/1.35 system-ui,sans-serif;border:1px solid rgba(255,255,255,0.15);border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,0.5);overflow:hidden;';
        var head = document.createElement('div');
        head.style.cssText = 'display:flex;align-items:center;gap:5px;padding:5px 8px;border-bottom:1px solid rgba(255,255,255,0.12);font-weight:600;';
        var title = document.createElement('span');
        title.textContent = '🎤 Lektor — co mówię';
        title.style.cssText = 'flex:1;';
        head.appendChild(title);
        head.appendChild(mkBtn('🗑', 'Wyczyść podgląd', function () { if (panelList) panelList.textContent = ''; }));
        head.appendChild(mkBtn('—', 'Minimalizuj panel', function () { setPanelVisible(false); }));
        panelBox.appendChild(head);
        var filterRow = document.createElement('div');
        filterRow.style.cssText = 'display:flex;gap:5px;padding:5px 8px;border-bottom:1px solid rgba(255,255,255,0.12);';
        panelInput = document.createElement('input');
        panelInput.type = 'text';
        panelInput.placeholder = 'Fraza do zablokowania…';
        panelInput.style.cssText = 'flex:1;min-width:0;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);border-radius:5px;color:#eee;padding:2px 6px;font:10px system-ui,sans-serif;outline:none;';
        panelInput.addEventListener('keydown', function (ev) {
            ev.stopPropagation();
            if (ev.key === 'Enter') { addUserPhrase(panelInput.value); panelInput.value = ''; }
        });
        filterRow.appendChild(panelInput);
        filterRow.appendChild(mkBtn('＋ Blokuj', 'Dodaj frazę do blokad', function () { addUserPhrase(panelInput.value); panelInput.value = ''; }));
        panelBox.appendChild(filterRow);
        // [AGENT-EXP] 2026-11-26: rząd przesunięcia jak w sub_panel.js (YouTube) — ten sam klucz subtitleOffsetMs, 👁 = cenzorPreview
        var offRow = document.createElement('div');
        offRow.style.cssText = 'display:flex;gap:4px;align-items:center;padding:5px 8px;border-bottom:1px solid rgba(255,255,255,0.12);';
        var offVal = document.createElement('span');
        offVal.style.cssText = 'flex:1;text-align:center;font-weight:700;color:#7ee0ff;';
        var offMs = 0;
        function showOff() { offVal.textContent = '🕒 ' + (offMs >= 0 ? '+' : '−') + (Math.abs(offMs) / 1000).toFixed(1).replace('.', ',') + ' s'; }
        function setOff(ms) {
            offMs = Math.max(-10000, Math.min(10000, Math.round(ms)));
            showOff();
            try { chrome.storage.local.set({ subtitleOffsetMs: offMs }); } catch (e) {}
        }
        offRow.appendChild(mkBtn('−1 s', 'Napisy 1 s wcześniej', function () { setOff(offMs - 1000); }));
        offRow.appendChild(mkBtn('−0,1', 'Napisy 0,1 s wcześniej', function () { setOff(offMs - 100); }));
        offRow.appendChild(offVal);
        offRow.appendChild(mkBtn('+0,1', 'Napisy 0,1 s później', function () { setOff(offMs + 100); }));
        offRow.appendChild(mkBtn('+1 s', 'Napisy 1 s później', function () { setOff(offMs + 1000); }));
        offRow.appendChild(mkBtn('0', 'Wyzeruj przesunięcie', function () { setOff(0); }));
        var pvBtn = mkBtn('👁', 'Podgląd napisów na filmie (sprawdź przesunięcie)', function () {
            try { chrome.storage.local.set({ cenzorPreview: pvBtn.dataset.on !== '1' }); } catch (e) {}
        });
        function showPv(on) { pvBtn.dataset.on = on ? '1' : ''; pvBtn.style.background = on ? 'rgba(255,212,0,0.45)' : 'rgba(255,255,255,0.12)'; }
        offRow.appendChild(pvBtn);
        panelBox.appendChild(offRow);
        try { var lcRow = window.__LektorControlsRow && window.__LektorControlsRow(); if (lcRow) panelBox.appendChild(lcRow); } catch (e) {}   // [AGENT-EXP] 2026-11-26: ◄ − 1.0x + ► z lektor-controls.js — jeden panel
        showOff();
        try {
            chrome.storage.local.get(['subtitleOffsetMs', 'cenzorPreview'], function (r) {
                offMs = Number(r && r.subtitleOffsetMs) || 0; showOff(); showPv(!!(r && r.cenzorPreview));
            });
            chrome.storage.onChanged.addListener(function (ch, area) {
                if (area !== 'local') return;
                if (ch.subtitleOffsetMs) { offMs = Number(ch.subtitleOffsetMs.newValue) || 0; showOff(); }
                if (ch.cenzorPreview) showPv(!!ch.cenzorPreview.newValue);
            });
        } catch (e) {}
        panelBlocked = document.createElement('div');
        panelBlocked.style.cssText = 'padding:3px 8px;border-bottom:1px solid rgba(255,255,255,0.12);max-height:54px;overflow-y:auto;';
        panelBox.appendChild(panelBlocked);
        panelList = document.createElement('div');
        panelList.style.cssText = 'overflow-y:auto;flex:1;min-height:0;';
        panelBox.appendChild(panelList);
        root.appendChild(panelBox);
        panelPill = document.createElement('button');
        panelPill.textContent = '🎤 Lektor';
        panelPill.title = 'Pokaż podgląd lektora';
        panelPill.style.cssText = 'position:fixed;left:10px;bottom:130px;z-index:2147483647;display:none;align-items:center;gap:5px;background:rgba(18,18,22,0.94);color:#eee;border:1px solid rgba(255,255,255,0.25);border-radius:999px;padding:4px 10px;font:10px system-ui,sans-serif;cursor:pointer;';   // [AGENT-EXP] 2026-11-26: pigułka nad paskiem odtwarzacza
        panelPill.addEventListener('click', function () { setPanelVisible(true); });
        root.appendChild(panelPill);
        makeDraggable([[panelBox, head], [panelPill, panelPill]]);   // [AGENT-EXP] 2026-11-26
        renderBlockedChips();
        applyPanelVisibility();
    }

    // --- Telemetria dla popupu: wypowiedziane wyrazy (napisy na żywo, brak „do przodu") ---
    setInterval(function () {
        if (!enabled || document.visibilityState !== 'visible') return; // wyłączony / w tle: cisza
        try {
            var vv = getVideo();   // [AGENT-EXP] 2026-11-16: pozycja i długość filmu dla karty „zapas do przodu”
            chrome.runtime.sendMessage({
                action: 'REC_TELEMETRY',
                platform: 'dom',
                nowMs: vv ? Math.round(vv.currentTime * 1000) : null,
                durMs: vv && isFinite(vv.duration) ? Math.round(vv.duration * 1000) : 0,
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

    // --- Napisy z pliku (popup) — scheduler preload+play wg czasu wideo ---
    // Napisy pobrane automatycznie (auto_subs.js: iQIYI, WeTV, Viki, Bilibili). Obiekty są
    // współdzielone — tłumaczenie dopisuje .text na bieżąco. Ręczny plik z popupu ma pierwszeństwo.
    var autoSubs = null, manualFile = false, lastFile = null;   // [AGENT-EXP] lastFile: plik pod spodem napisów auto
    // [AGENT-EXP] 2026-10-17: 📊 pasek postępu lektora (assets/lektor_bar.js): plik / napisy Łowcy / całe napisy
    try {
        (window.__lektorBarProviders = window.__lektorBarProviders || {}).dom = function () {
            var v = getVideo();
            if (fileSubs.length) return { video: v, list: fileSubs, off: getOff, ready: function (c) { return !!c.text; }, spoken: function (c) { return filePlayed.has(c.id); }, audioId: function (c) { return c.id; } };
            // [FIX 2026-11-16] lektor czyta z EKRANU (Prime, iQ, HBO przed pełnym plikiem, Dailymotion…) — nie ma listy
            // kwestii, więc pasek znikał, choć lektor mówił. Od pierwszej przeczytanej kwestii pokazujemy samą pozycję
            // i źródło („📍 czytam z: …”). Gdy lektor jest wyłączony/uśpiony — paska nie ma.
            if (!enabled || optAsleep() || !liveEver || !v) return null;
            return { video: v, list: [], live: true };
        };
    } catch (e) {}

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
    function autoApplyNow(keep) {
        fileSubs = autoSubs.slice();
        if (!keep) {   // [AGENT-EXP] 2026-10-25: keep = ta sama lista urosła (dobrane części napisów) — przeczytane zostają przeczytane
            filePreloaded.clear();
            filePlayed.clear();
        }
        if (!keep || !fileOwner.key) setFileOwner();   // [FIX 2026-11-25] napisy należą do TEGO filmu
        restoreVolume();
        startFileLoop();
    }
    try {
        window.__LIVEDUB_AUTO_APPLY__ = function (cues, keep, label) {   // [AGENT-EXP] 2026-10-25: keep   // [FIX 2026-11-02] label: „czytam z: …”
            // [AGENT-EXP] 2026-11-14: „Tylko Immersive Translate” / „Tylko wbudowane” = czytamy WYŁĄCZNIE z ekranu.
            // Wcześniej pobrany plik (Łowca / ⬇ / HBO) przykrywał wybór użytkownika i lektor czytał plik, a nie ekran.
            if (screenOnlyMode()) { autoSubs = null; manualFile = false; lastFile = null; dropFileSubs(); return; }
            autoSubs = Array.isArray(cues) && cues.length ? cues : null;
            if (label) autoSrcName = String(label);
            // [AGENT-EXP] 2026-10-17: wygrywają NAJNOWSZE napisy — Łowca / „Pobierz całe napisy” przykrywają
            // wcześniej wczytany plik (wcześniej plik blokował je na zawsze); ich koniec → wraca plik tej karty
            if (autoSubs) { manualFile = false; autoApplyNow(!!keep); }
            else if (lastFile) fileApply(lastFile);
            else { fileSubs = []; if (fileTimer) { clearInterval(fileTimer); fileTimer = null; } }
        };
    } catch (e) {}

    var fileSrcName = 'plik napisów', autoSrcName = '', domSrcSent = '';   // [FIX 2026-11-02] „czytam z: …”
    // [AGENT-EXP] 2026-11-14: „Tylko Immersive Translate” / „Tylko wbudowane” — plik nie ma pierwszeństwa nad ekranem.
    function screenOnlyMode() { return primeSubtitleSource === 'immersive' || primeSubtitleSource === 'native'; }
    function dropFileSubs() {
        fileSubs = [];
        if (fileTimer) { clearInterval(fileTimer); fileTimer = null; }
        try { applyScanState(); } catch (e) {}   // od razu wracamy do czytania z ekranu
    }
    function fileApply(f) {
        if (screenOnlyMode()) { lastFile = null; autoSubs = null; dropFileSubs(); return; }
        manualFile = !!(f && Array.isArray(f.cues) && f.cues.length);
        if (manualFile) fileSrcName = /^🌐/.test(String(f.name || '')) ? 'bazy napisów: ' + String(f.name).replace(/^🌐\s*/, '') : 'plik napisów: ' + String(f.name || 'bez nazwy');
        lastFile = manualFile ? f : null;   // [AGENT-EXP]
        if (!manualFile && autoSubs) { autoApplyNow(); return; }
        if (f && Array.isArray(f.cues) && f.cues.length) {
            fileSubs = f.cues.map(function (c, i) {
                var t = cleanTranslationJunk(c.text);
                if (!t) return null;
                // Blokady użytkownika (z panelu ⚙) — działają też dla napisów z pliku.
                if (window.__LIVEDUB_IS_BLOCKED__ && window.__LIVEDUB_IS_BLOCKED__(t)) return null;
                if (isBlockedPhrase(t) || isUserBlocked(t)) return null;
                return { id: 'file_' + i, text: t, startMs: c.startMs, endMs: c.endMs };
            }).filter(Boolean);
            filePreloaded.clear();
            filePlayed.clear();
            setFileOwner();   // [FIX 2026-11-25]
            restoreVolume();
            startFileLoop();
        } else {
            fileSubs = [];
            if (fileTimer) { clearInterval(fileTimer); fileTimer = null; }
        }
    }
    // [AGENT-EXP] 2026-10-25: 🤐 Cenzor dostaje te same napisy co lektor (plik, bazy, Łowca, ⬇ całe napisy, auto_subs):
    // kwestie z czasami → cenzor_main.js (świat MAIN) przez postMessage. Wysyłane, gdy lista się zmieni (dochodzą
    // tłumaczenia) i co 15 s (cenzor mógł wystartować później albo zmienić się film). `orig` = tekst oryginału.
    var czSig = '', czAt = 0;
    setInterval(function () {
        try { checkOtherFilm(); } catch (e) {}   // [FIX 2026-11-25] inny film w tym samym odtwarzaczu
        // [FIX 2026-11-25] lista z poprzedniego filmu / innej strony → cenzor dostaje PUSTĄ listę (nie tnie ze starych napisów)
        var mine = fileOwnerOk(), list = mine ? fileSubs : [];
        var n = 0;
        for (var i = 0; i < list.length; i++) if (list[i] && list[i].text) n++;
        var sig = list.length + '|' + n + '|' + (list[0] ? list[0].id : '') + '|' + fileOwner.key + '|' + Math.round(fileOwner.dur);
        if (sig === czSig && Date.now() - czAt < 15000) return;
        if (!list.length && !czSig) return;
        czSig = list.length ? sig : ''; czAt = Date.now();
        try {
            window.postMessage({ __lektorCenzor: 'cues', key: 'lektor', page: list.length ? fileOwner.page : '', dur: list.length ? fileOwner.dur : 0,
                cues: list.map(function (c) {
                    return { startMs: c.startMs, endMs: c.endMs, text: c.text || '', orig: typeof c.src === 'string' ? c.src : '' };
                }) }, location.origin);
        } catch (e) {}
    }, 2000);

    function startFileLoop() {
        if (fileTimer) return;
        fileTimer = setInterval(function () {
            if (!enabled || fileSubs.length === 0) return;
            var v = getVideo();
            if (!v) return;
            if (!fileOwnerOk()) return;   // [FIX 2026-11-25] napisy innego filmu / innej strony — lektor ich nie czyta
            if (v.paused && window.__lektorBufPauza === false) return;   // [AGENT-EXP] pauza: tylko buforowanie, bez czytania
            // [FIX 2026-11-02] wspólny harmonogram (assets/lektor_scheduler.js): okno kwestii, tempo filmu, czytanie tylko na
            // widocznej karcie z grającym filmem (wcześniej plik czytał też w karcie w tle)
            var S = window.__LektorSched;
            var srcName = manualFile ? fileSrcName : (autoSrcName || 'całe napisy');
            if (domSrcSent !== srcName + fileSubs.length) { domSrcSent = srcName + fileSubs.length; S.setSource(srcName, fileSubs.length); }
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
                    if (isBlockedPhrase(sub.text)) return false; // blokujemy "Only the translation ,,"
                }
            });
        }, 50);
    }
    try {
        chrome.storage.local.get(['fileSubs', 'lookaheadMin', 'subtitleOffsetMs'], function (r) {
            var m = Number(r && r.lookaheadMin);
            if (!isNaN(m) && r.lookaheadMin !== undefined) fileLookahead = m > 0 ? m * 60000 : 0;
            if (typeof (r && r.subtitleOffsetMs) === 'number') storageOffsetMs = r.subtitleOffsetMs;
            fileForMe(fileApply);   // [AGENT-EXP] tylko plik tego filmu
        });
        chrome.storage.onChanged.addListener(function (ch, area) {
            if (area !== 'local') return;
            if (ch.fileSubs !== undefined || ch.fileSubsMem !== undefined) fileForMe(fileApply);   // [AGENT-EXP]
            if (ch.subtitleOffsetMs !== undefined) storageOffsetMs = Number(ch.subtitleOffsetMs.newValue) || 0;
            if (ch.lookaheadMin !== undefined) {
                var m2 = Number(ch.lookaheadMin.newValue);
                if (!isNaN(m2)) { fileLookahead = m2 > 0 ? m2 * 60000 : 0; filePreloaded.clear(); }   // [AGENT-EXP] 2026-10-25: nowy zapas → wyślij okno jeszcze raz (gotowe idą z pamięci)
            }
        });
    } catch (e) {}

    // ===== Start =====
    createPanel();
    loadSettings();
    // ENERGIA: skan strony tylko do czytania w locie. Gdy są całe napisy (plik / na żądanie),
    // czyta harmonogram czasowy — obserwator i pętla stoją; tak samo gdy lektor wyłączony / karta w tle.
    function wantScan() { return enabled && document.visibilityState === 'visible' && !fileSubs.length; }
    function applyScanState() {
        if (wantScan()) {
            if (!observer) initObserver();
            if (!pollTimer) pollTimer = setInterval(scanCaptions, POLL_MS);
        } else {
            if (observer) { observer.disconnect(); observer = null; }
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
        }
    }
    applyScanState();
    setInterval(applyScanState, 1000); // tani strażnik stanu (bez dotykania DOM)
    if (bc && tabFocused) bc.postMessage({ cmd: 'active' });
})();