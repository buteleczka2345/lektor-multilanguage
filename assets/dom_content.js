// dom_content.js — Live-Dubbing content script
// Prime Video (primevideo.com / amazon.com/video) oraz iQIYI (iq.com / iqiyi.com).
// Czyta bieżące napisy renderowane w DOM playera (także w Shadow DOM),
// filtruje szumy UI, deduplikuje przez BroadcastChannel i przekazuje do Pipera
// (background -> offscreen) jako TTS_PLAY.
(function () {
    'use strict';

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
    var observer = null, pollTimer = null, scanTimer = null, speakTimer = null, pendingKey = null;
    var tabFocused = document.visibilityState === 'visible';
    var spokenKey = {}; // hash -> timestamp ostatniego wystąpienia (w obrębie 3 s)
    var userBlockedPhrases = []; // frazy blokowane przez użytkownika (panel podglądu)
    var panelVisible = true; // czy panel podglądu lektora jest widoczny

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
        chrome.storage.local.get(['enabled', 'duckLevel', 'primeSubtitleSource', 'userBlockedPhrases', 'panelVisible'], function (res) {
            if (res.enabled !== undefined) enabled = !!res.enabled;
            if (res.duckLevel !== undefined) duckLevel = clampPct(res.duckLevel);
            if (res.primeSubtitleSource !== undefined) primeSubtitleSource = res.primeSubtitleSource;
            if (Array.isArray(res.userBlockedPhrases)) userBlockedPhrases = res.userBlockedPhrases;
            if (res.panelVisible !== undefined) panelVisible = !!res.panelVisible;
            if (enabled && document.visibilityState === 'visible') applyDuck();
            renderBlockedChips();
            applyPanelVisibility();
        });
    }
    chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        if (changes.enabled !== undefined) {
            enabled = !!changes.enabled.newValue;
            if (enabled && document.visibilityState === 'visible') applyDuck();
            else stopSpeech();
        }
        if (changes.duckLevel !== undefined) {
            duckLevel = clampPct(changes.duckLevel.newValue);
            if (enabled && document.visibilityState === 'visible') applyDuck();
        }
        if (changes.primeSubtitleSource !== undefined) {
            primeSubtitleSource = changes.primeSubtitleSource.newValue || 'both';
        }
        if (changes.userBlockedPhrases !== undefined) {
            userBlockedPhrases = Array.isArray(changes.userBlockedPhrases.newValue) ? changes.userBlockedPhrases.newValue : [];
            renderBlockedChips();
        }
        if (changes.panelVisible !== undefined) {
            panelVisible = !!changes.panelVisible.newValue;
            applyPanelVisibility();
        }
    });

    function clampPct(v) { v = Number(v); if (!isFinite(v)) return 20; return Math.max(0, Math.min(100, v)); }
// ===== Wideo + ducking =====
    function getVideo() {
        if (video && video.isConnected) return video;
        video = document.querySelector('video');
        if (video) {
            video.addEventListener('seeked', function () { stopSpeech(); });
            video.addEventListener('pause', function () { pauseSpeech(); }); // pauza filmu zawsze pauzuje lektora
            video.addEventListener('play', function () { if (enabled) applyDuck(); });
            video.addEventListener('volumechange', function () { if (enabled && tabFocused) applyDuck(); });
            if (enabled && tabFocused) applyDuck();
        }
        return video;
    }
    function applyDuck() {
        var v = getVideo(); if (!v) return;
        var target = duckLevel / 100;
        if (savedVolume === null && v.volume > target) savedVolume = v.volume;
        // Fix: po zwiększeniu duckLevel (np. z 0% na wyższy) głośność filmu ma WRACAĆ.
        // Wcześniej było tylko obniżanie (if v.volume > target) i po wyciszeniu na 0%
        // głos już nigdy nie wracał. Ustawiamy min(target, savedVolume), żeby nigdy
        // nie przekroczyć pierwotnej głośności ustawionej przez użytkownika.
        if (savedVolume !== null) {
            v.volume = Math.min(target, savedVolume);
        } else if (v.volume > target) {
            v.volume = target;
        }
    }
    function restoreVolume() {
        var v = getVideo();
        if (v && savedVolume !== null) { v.volume = savedVolume; savedVolume = null; }
    }
    function pauseSpeech() {
        try { chrome.runtime.sendMessage({ action: 'TTS_PAUSE' }); } catch (e) {}
    }
    function stopSpeech() {
        try { chrome.runtime.sendMessage({ action: 'TTS_CLEAR_BUFFER' }); } catch (e) {}
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
        // Mocne wulgaryzmy — wycinane; pusta linia nie jest czytana
        cleaned = cleaned.replace(LIVEDUB_PROFANITY_RE, ' ').replace(/\s{2,}/g, ' ').trim();
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

    // Mocne wulgaryzmy PL+EN (rdzenie łapią odmiany) — wycinane z mowy lektora.
    var LIVEDUB_PROFANITY_RE = /(\b\p{L}*(?:kurw|chuj|huj|jeb|pizd|pierdol|pierdal|cipk|cip[aeęyiu]|dziwk|szmat|g[óo]wn|fuck|motherfuck|cunt|cocksuck|wank|whore|slut|pussy|shit)[^\s]*)/giu;

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
    function collectIT(root, results) {
        if (!root || !root.querySelectorAll) return results;
        try {
            var nodes = root.querySelectorAll(IT_GROUP);
            for (var i = 0; i < nodes.length; i++) {
                var node = nodes[i];
                if (!isVisibleElement(node)) continue;
                if (isControl(node)) continue;
                if (isOriginNode(node)) continue; // oryginał (EN) — nigdy nie czytamy
                if (node.querySelector && node.querySelector(IT_GROUP)) continue; // tylko liście
                var text = cleanTranslationJunk((node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim());
                if (text.length >= 2 && !isSystemPrompt(text)) {
                    if (looksEnglish(text)) continue; // oryginał EN (IT) — nigdy nie czytamy
                    results.push(text);
                }
            }
        } catch (e) {}
        var all = [];
        try { all = root.querySelectorAll('*'); } catch (e) { all = []; }
        for (var k = 0; k < all.length; k++) {
            try { if (all[k].shadowRoot) collectIT(all[k].shadowRoot, results); } catch (e) {}
        }
        return results;
    }

    // Zbieranie napisów WŁASNYCH playera (native) — z pomijaniem duplikatów względem IT.
    function collectNative(root, results, itTexts) {
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
                    var text = cleanTranslationJunk((node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim());
                    if (text.length < 2 || isSystemPrompt(text)) continue;
                    var dup = false;
                    for (var d = 0; d < itTexts.length; d++) {
                        if (isSimilar(itTexts[d], text)) { dup = true; break; }
                    }
                    if (dup) continue;
                    results.push(text);
                }
            }
        } catch (e) {}
        var all = [];
        try { all = root.querySelectorAll('*'); } catch (e) { all = []; }
        for (var k = 0; k < all.length; k++) {
            try { if (all[k].shadowRoot) collectNative(all[k].shadowRoot, results, itTexts); } catch (e) {}
        }
        return results;
    }

    // Bieżący napis — zależnie od serwisu i opcji źródła.
    // - iQIYI: WYŁĄCZNIE Immersive Translate (PL) — bez fallbacku do wbudowanych
    //   (wbudowane to oryginał EN/CN; fallback czytał angielskie zdania).
    // - Prime Video: wg ustawienia primeSubtitleSource ('both' domyślnie = IT + wbudowane).
    function getCurrentCaption() {
        var itTexts = collectIT(document, []);
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
        }, FRAME_SETTLE_MS + Math.max(0, getOff()));
    }

    function scanCaptions() {
        if (!enabled) return;
        if (document.visibilityState !== 'visible') return;
        var text = getCurrentCaption();
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
        try {
            observer.observe(document.body || document.documentElement, {
                childList: true,
                subtree: true,
                characterData: true
            });
        } catch (e) {}
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

    function isUserBlocked(text) {
        if (!userBlockedPhrases.length) return false;
        var norm = normalizeForCheck(text).toLowerCase();
        for (var i = 0; i < userBlockedPhrases.length; i++) {
            if (norm.indexOf(userBlockedPhrases[i]) !== -1) return true;
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
            if (panelBox) panelBox.style.display = panelVisible ? 'flex' : 'none';
            if (panelPill) panelPill.style.display = panelVisible ? 'none' : 'flex';
        } catch (e) {}
    }

    function setPanelVisible(vis) {
        panelVisible = vis;
        try { chrome.storage.local.set({ 'panelVisible': vis }); } catch (e) {}
        applyPanelVisibility();
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
        panelPill.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147483647;display:none;align-items:center;gap:5px;background:rgba(18,18,22,0.94);color:#eee;border:1px solid rgba(255,255,255,0.25);border-radius:999px;padding:4px 10px;font:10px system-ui,sans-serif;cursor:pointer;';
        panelPill.addEventListener('click', function () { setPanelVisible(true); });
        root.appendChild(panelPill);
        renderBlockedChips();
        applyPanelVisibility();
    }

    // --- Telemetria dla popupu: wypowiedziane wyrazy (napisy na żywo, brak „do przodu") ---
    setInterval(function () {
        try {
            chrome.runtime.sendMessage({
                action: 'REC_TELEMETRY',
                platform: 'dom',
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
    function fileApply(f) {
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
            restoreVolume();
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
            if (!v || v.paused) return;
            var nowMs = v.currentTime * 1000;
            var off = getOff();
            var preBudget = 4; // max nowe syntezy na tick — bez burstów
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
                    if (isBlockedPhrase(sub.text)) continue; // blokujemy "Only the translation ,,"
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
        chrome.storage.local.get(['fileSubs', 'lookaheadMin', 'subtitleOffsetMs'], function (r) {
            var m = Number(r && r.lookaheadMin);
            if (!isNaN(m) && r.lookaheadMin !== undefined) fileLookahead = m > 0 ? m * 60000 : 0;
            if (typeof (r && r.subtitleOffsetMs) === 'number') storageOffsetMs = r.subtitleOffsetMs;
            fileApply(r && r.fileSubs);
        });
        chrome.storage.onChanged.addListener(function (ch, area) {
            if (area !== 'local') return;
            if (ch.fileSubs !== undefined) fileApply(ch.fileSubs.newValue);
            if (ch.subtitleOffsetMs !== undefined) storageOffsetMs = Number(ch.subtitleOffsetMs.newValue) || 0;
            if (ch.lookaheadMin !== undefined) {
                var m2 = Number(ch.lookaheadMin.newValue);
                if (!isNaN(m2)) fileLookahead = m2 > 0 ? m2 * 60000 : 0;
            }
        });
    } catch (e) {}

    // ===== Start =====
    createPanel();
    loadSettings();
    initObserver();
    pollTimer = setInterval(scanCaptions, POLL_MS);
    if (bc && tabFocused) bc.postMessage({ cmd: 'active' });
})();