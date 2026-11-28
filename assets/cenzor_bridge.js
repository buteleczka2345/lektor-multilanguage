// cenzor_bridge.js — [AGENT-EXP] 2026-10-19: most ustawień 🤐 Cenzora (świat ISOLATED, document_start).
// cenzor_main.js działa w świecie MAIN (musi podmienić fetch/XHR strony), więc nie widzi chrome.storage.
// Ten plik czyta opcje cenzor* (+ selektory Kreatora napisów dla tej domeny) i wysyła je przez
// postMessage: od razu, po „hello” z cenzor_main.js i po każdej zmianie w Ustawieniach.
(function () {
    'use strict';
    if (window.__lektorCenzorBridge) return;
    window.__lektorCenzorBridge = true;

    var KEYS = ['cenzorOn', 'cenzorLive', 'cenzorPriority', 'cenzorBufferMs', 'cenzorHoldMs', 'cenzorLenMode', 'cenzorTextRate', 'cenzorTextAuto',   // [AGENT-EXP] 2026-10-20: tempo tekstu
        'cenzorTimingMode', 'cenzorPrerollMs', 'cenzorPostrollMs',
        'cenzorAsrTag', 'censorCustomWords', 'cenzorNfPl', 'cenzorYtPl', 'customSources', 'customSourcesOn', 'primeSubtitleSource',   // [FIX 2026-11-02] jedna lista słów (wspólna z lektorem)   // [AGENT-EXP] 2026-11-14: źródło napisów (Immersive / wbudowane)
        'censorEnabled', 'censorMode',
        'subtitleOffsetMs', 'cenzorTailFix', 'cenzorPreview', 'cenzorSentence'];   // [AGENT-EXP] 2026-11-28: cisza na całe zdanie   // [FIX 2026-11-21] wspólne przesunięcie napisów (lektor + cenzor) i „napis wisi dłużej niż mowa”   // [AGENT-EXP] 2026-11-17: tryb cenzury (m.in. „kreski ----------” widoczne w napisach na ekranie)
    var last = {};

    // [AGENT-EXP] 2026-11-16: DOMYŚLNE ustawienia cenzora = stan z popupu (wszystko WŁ., tryb „usuń słowo”,
    // pierwszeństwo pobranych napisów). Wcześniej BRAK wpisu w chrome.storage znaczył „wyłącz” — applyOpts
    // dostawał undefined → false, więc cenzor dźwięku filmu był domyślnie WYŁĄCZONY, mimo że w „opt”
    // w cenzor_main.js stały wartości true.
    var DEF = {
        cenzorOn: true,
        cenzorLive: true,
        cenzorPriority: 'file',
        cenzorBufferMs: 400,   // [FIX 2026-11-21] było 500/100
        cenzorHoldMs: 200,
        cenzorLenMode: 'normal',
        cenzorTextRate: 0.6,
        cenzorTextAuto: false,
        cenzorTimingMode: 'legacy',
        cenzorPrerollMs: 120,
        cenzorPostrollMs: 140,
        cenzorAsrTag: true,
        censorCustomWords: '',
        cenzorNfPl: true,
        cenzorYtPl: true,
        primeSubtitleSource: 'both',
        censorEnabled: true,   // [AGENT-EXP] 2026-11-17: cenzura mowy lektora — steruje też kreskami w napisach na ekranie
        censorMode: 'remove',
        subtitleOffsetMs: 0,   // [FIX 2026-11-21] ten sam suwak co „Przesunięcie napisów” lektora (popup i panel ⚙)
        cenzorPreview: false,  // [FIX 2026-11-21] podgląd napisów z pliku na ekranie (sprawdzanie przesunięcia)
        cenzorSentence: false, // [AGENT-EXP] 2026-11-28: cisza na całe zdanie z przekleństwem
        cenzorTailFix: true    // [FIX 2026-11-21] cisza obejmuje oba możliwe położenia słowa, gdy kwestia jest za długa na tekst
    };
    // Brak wpisu → wartość domyślna (customSources/customSourcesOn zostają undefined = brak własnych selektorów).
    function fillDefaults(src) {
        var o = {};
        KEYS.forEach(function (k) { o[k] = (src && src[k] !== undefined) ? src[k] : DEF[k]; });
        if (src && src.cenzorPrerollMs === undefined && src.cenzorBufferMs !== undefined) o.cenzorPrerollMs = src.cenzorBufferMs;
        if (src && src.cenzorPostrollMs === undefined && src.cenzorHoldMs !== undefined) o.cenzorPostrollMs = src.cenzorHoldMs;
        return o;
    }

    function validSelector(sel) {
        if (typeof sel !== 'string' || !sel.trim()) return false;
        try { document.createDocumentFragment().querySelector(sel); return true; } catch (e) { return false; }
    }
    function host() { try { return location.hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } }

    function send() {
        var o = {};
        KEYS.forEach(function (k) { if (k.indexOf('custom') !== 0) o[k] = last[k]; });
        // UI "Wstecz / Przód" zapisuje stare klucze cenzorBufferMs/cenzorHoldMs.
        // PMT i plan live musza otrzymac te same wartosci natychmiast, bez restartu.
        if (last.cenzorBufferMs !== undefined) o.cenzorPrerollMs = last.cenzorBufferMs;
        if (last.cenzorHoldMs !== undefined) o.cenzorPostrollMs = last.cenzorHoldMs;
        var h = host(), on = last.customSourcesOn || {}, src = last.customSources || {};
        // [FIX 2026-11-22] błędne selektory odrzucamy (jak options_hooks.validSelector): cenzor łączy je przecinkami
        // w JEDEN selektor, więc jeden zły wpis (np. z Łowcy) wyłączał cały tryb LIVE na tej domenie
        o.selectors = (on[h] !== false && Array.isArray(src[h])) ? src[h].filter(validSelector) : [];
        o.subSource = last.primeSubtitleSource || 'both';   // [AGENT-EXP] 2026-11-14: 'both' | 'immersive' | 'native'
        try { window.postMessage({ __lektorCenzor: 'opts', opts: o }, location.origin); } catch (e) {}
    }

    function load() {
        try { chrome.storage.local.get(KEYS, function (r) { last = fillDefaults(r); send(); }); } catch (e) {}
    }

    window.addEventListener('message', function (ev) {
        if (ev.source !== window || ev.origin !== location.origin) return;
        if (ev.data && ev.data.__lektorCenzor === 'hello') send();
        // [AGENT-EXP] 2026-11-26: podgląd cenzora zsynchronizował przesunięcie (klik w przekleństwo / klawisz S)
        // → zapis wspólnego suwaka; popup, panel ⚙ i lektor dostaną zmianę przez storage.onChanged.
        if (ev.data && ev.data.__lektorCenzor === 'setOffset') {
            var ms = Number(ev.data.ms);
            if (isFinite(ms)) { try { chrome.storage.local.set({ subtitleOffsetMs: Math.max(-10000, Math.min(10000, Math.round(ms))) }); } catch (e) {} }
        }
        // [DIAG 2026-11-26] dziennik wyciszeń → popup (🤬 Cenzor → Diagnostyka). Ostatnie 50 wpisów.
        if (ev.data && ev.data.__lektorCenzor === 'diag' && ev.data.entry) {
            var en = ev.data.entry; en.ts = Date.now();
            try {
                chrome.storage.local.get('cenzorDiagLog', function (r) {
                    var log = Array.isArray(r && r.cenzorDiagLog) ? r.cenzorDiagLog : [];
                    log.push(en);
                    chrome.storage.local.set({ cenzorDiagLog: log.slice(-50) });
                });
            } catch (e) {}
        }
        // [AGENT-EXP] 2026-10-25: cały plik napisów (HBO z manifestu, inne strony ze ścieżki odtwarzacza) → lektor
        // (jak Łowca, ale full: pierwszeństwo; przy okazji zapamiętuje stronę — następny film rusza sam).
        var k = ev.data && ev.data.__lektorCenzor;
        if ((k === 'hboFull' || k === 'extFull') && Array.isArray(ev.data.cues) && ev.data.cues.length >= 5) {
            try {
                chrome.runtime.sendMessage({ action: 'LOWCA_AUTO_CUES', full: true, lang: ev.data.lang || '', label: ev.data.label || '',
                    url: '', page: location.href, cues: ev.data.cues }, function (r) {
                    void chrome.runtime.lastError;
                    // [AGENT-EXP] 2026-11-06: powiedz w konsoli, gdy lektor jednak nie dostał pliku (np. uśpiona domena)
                    if (!r || !r.ok) { try { console.warn('[Lektor Cenzor] HBO: lektor nie dostał napisów', r || '(brak odpowiedzi)'); } catch (e) {} }
                });
            } catch (e) {}
        }
    });
    // [AGENT-EXP] 2026-11-06: HBO Max — adres manifestu napisów znaleziony w tle (webRequest; także worker odtwarzacza)
    // → cenzor_main.js (świat MAIN), który pobierze go sam i wyciągnie cały plik napisów.
    try {
        chrome.runtime.onMessage.addListener(function (m) {
            if (!m || m.action !== 'HBO_MANIFEST_URL' || !m.url) return;
            try { window.postMessage({ __lektorCenzor: 'hboUrl', url: String(m.url) }, location.origin); } catch (e) {}
        });
    } catch (e) {}
    try {
        chrome.storage.onChanged.addListener(function (ch, area) {
            if (area !== 'local') return;
            var any = false;
            KEYS.forEach(function (k) { if (ch[k]) { last[k] = ch[k].newValue; any = true; } });
            if (any) send();
        });
    } catch (e) {}
    // [AGENT-EXP] 2026-11-14: stan ramki dla karty „Status” (popup) i kropki na ikonie.
    var lastCensor = null, lastPushSig = '', lastPushAt = 0;
    function askStatus() { try { window.postMessage({ __lektorCenzor: 'status' }, location.origin); } catch (e) {} }
    function lektorNow() {
        try { var S = window.__LektorSched, g = S && S.getSource(); return g ? { source: g.name, cues: g.cues, at: g.at } : null; } catch (e) { return null; }
    }
    function frameStatus() { return { ok: true, lektor: lektorNow(), cenzor: lastCensor, href: location.href, top: window.top === window }; }
    window.addEventListener('message', function (ev) {
        if (ev.source !== window || ev.origin !== location.origin) return;
        var d = ev.data;
        if (!d || d.__lektorCenzor !== 'status' || !d.status) return;
        lastCensor = d.status;
        window.__LEKTOR_CENSOR__ = d.status;   // pigułka na pasku lektora
        // [AGENT-EXP] 2026-11-14: do tła tylko gdy stan się zmienił albo co 5 s (nie budzimy service workera co 1,5 s)
        var st = frameStatus(), sig = (st.lektor ? st.lektor.source + '|' + st.lektor.cues : '-') + '|' + d.status.cueMode + '|' + d.status.cues + '|' + d.status.muting + '|' + d.status.coveredFrom + '|' + d.status.coveredUntil;
        if (sig === lastPushSig && Date.now() - lastPushAt < 5000) return;
        lastPushSig = sig; lastPushAt = Date.now();
        try { chrome.runtime.sendMessage({ action: 'LEKTOR_STATUS_PUSH', status: st }, function () { void chrome.runtime.lastError; }); } catch (e) {}
    });
    try {
        chrome.runtime.onMessage.addListener(function (m, _s, sendResponse) {
            if (!m || m.action !== 'LEKTOR_STATUS') return;
            sendResponse(frameStatus());
        });
    } catch (e) {}
    askStatus();
    setInterval(askStatus, 1500);
    load();
})();
