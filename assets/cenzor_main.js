// cenzor_main.js — [AGENT-EXP] 2026-10-19: 🤐 Cenzor przekleństw (świat MAIN, document_start).
// Port „Netflix Cenzor 4.5.2” / „YouTube Cenzor 1.1.0” (userscript). Wycisza ORYGINALNY dźwięk filmu
// (video.muted) — lektor ścisza film przez video.volume, więc oba mechanizmy się nie gryzą, a głos
// lektora (osobne audio) gra dalej.
// Dwa tryby, osobne opcje w Ustawieniach (src/options/options.js, sekcja „🤐 Cenzor przekleństw”):
//  1) cenzorOn — Z POBRANYCH NAPISÓW (YouTube): łapie odpowiedzi /api/timedtext (te, które pobiera
//     odtwarzacz i yt_subs_bridge.js lektora — ten plik jest w manifeście PRZED nim, więc jego
//     origFetch to nasz fetch), a gdy nic nie przyszło — sam każe odtwarzaczowi załadować ścieżkę
//     (ta sama metoda co getRaw w yt_subs_bridge.js). Wszystkie słowa są znane z góry, więc cisza
//     wchodzi PRZED słowem — także wtedy, gdy lektor nic nie mówi.
//  2) cenzorLive — NA BIEŻĄCO, bez pobierania: czyta napisy widoczne na ekranie (YouTube, Netflix,
//     Prime, selektory z Kreatora napisów, ścieżki <track> odtwarzacza HTML5) i szacuje modelem
//     segmentowym, kiedy padnie słowo. [AGENT-EXP] 2026-10-20: osobno czyta też polskie tłumaczenie
//     Immersive Translate (TR_SELECTORS). Działa na wszystkich stronach lektora. Przy włączonym 1)
//     jest zapasem: [AGENT-EXP] 2026-11-14 czyta też PO KOŃCU pobranego pliku (hybryda) i w Shadow DOM.
// [AGENT-EXP] 2026-10-25: 1) działa też na HBO Max — całe napisy z manifestu (sekcja 1c: DASH/HLS/plik/ścieżka odtwarzacza).
// Zawsze wycisza TYLKO samo słowo (nie całą kwestię). Nie słucha dźwięku — wyłącznie tekst napisów.
// Działa niezależnie od tego, czy lektor jest włączony (własne skrypty, własne opcje).
// Ustawienia przychodzą z cenzor_bridge.js (świat ISOLATED, chrome.storage) przez postMessage.
// Diagnostyka w konsoli: lektorCenzor.status()
(function () {
    'use strict';
    if (window.__lektorCenzor) return;
    window.__lektorCenzor = true;

    var TAG = '__lektorCenzor';
    var IS_YT = /(^|\.)youtube(-nocookie)?\.com$/.test(location.hostname);
    function isAmazonVideoLocation(hostname, pathname) {
        return /(^|\.)amazon\.com$/i.test(String(hostname || ''))
            && /^(?:\/gp)?\/video(?:\/|$)/i.test(String(pathname || ''));
    }
    function isPrimeVideoLocation(hostname, pathname) {
        return /(^|\.)primevideo\.com$/i.test(String(hostname || ''))
            || isAmazonVideoLocation(hostname, pathname);
    }
    var IS_AMAZON_VIDEO = isAmazonVideoLocation(location.hostname, location.pathname);
    var IS_PV = isPrimeVideoLocation(location.hostname, location.pathname);
    // [AGENT-EXP] 2026-11-14: Facebook — tylko cenzor (bez potoku napisów). Strona ogromna, więc czytamy
    // napisy wyłącznie z obszaru filmu, żeby tekst postów/UI nie wyciszał dźwięku.
    var IS_FB = /(^|\.)facebook\.com$/i.test(location.hostname);
    // [AGENT-EXP] 2026-11-06: serwisy z lektorem wbudowanym — mają własne pełne napisy, więc cenzor nie wysyła im
    // dodatkowo tego, co znajdzie w ścieżce odtwarzacza (nie przykrywamy lepszego źródła).
    var IS_LEKTOR_SITE = /(^|\.)(primevideo\.com|iq\.com|iqiyi\.com|dailymotion\.com|dai\.ly|rumble\.com|viki\.com|wetv\.vip|bilibili\.com|bilibili\.tv)$/.test(location.hostname) || IS_AMAZON_VIDEO;

    /* ---------------- ustawienia ---------------- */

    // [FIX 2026-11-02] JEDEN cenzor: własna lista (DEFAULT_WORDS, „kurw*” itd.) usunięta — słowa rozpoznaje wspólny silnik
    // assets/censor.js (ten sam, który wycina przekleństwa z mowy lektora; wczytany w świecie MAIN przed tym plikiem):
    // wbudowane listy wielu języków + rdzenie + własne słowa użytkownika (censorCustomWords, „-słowo” = wyjątek).

    var opt = {
        cenzorOn: true,     // [FIX] włączone domyślnie — wyciszanie dźwięku filmu z pobranych napisów
        cenzorLive: true,   // [FIX] włączone domyślnie — wyciszanie z napisów na bieżąco z ekranu
        cenzorPriority: 'file',   // [FIX 2026-11-16] kto ma pierwszeństwo: 'file' (pobrane napisy) | 'hybrid' (plik + live 30 s przed końcem) | 'live' (ekran)
        cenzorBufferMs: 400,   // [FIX 2026-11-21] 400/200 zamiast 500/100 — test na czasach słów: mniej przecieków przy tej samej długości ciszy
        cenzorHoldMs: 200,
        cenzorLenMode: 'normal',
        cenzorTextRate: 0.6,   // [FIX 2026-11-16] tempo tekstu domyślnie 0,6× (jak w starym cenzorze); działa, gdy cenzorTextAuto wył.
        cenzorTextAuto: false, // [FIX 2026-11-16] domyślnie WYŁ. — cisza liczona z suwaka tempa, nie z prędkości filmu
        cenzorTimingMode: 'legacy',
        cenzorPrerollMs: 120,
        cenzorPostrollMs: 140,
        cenzorAsrTag: true,
        subOffsetMs: 0,       // [FIX 2026-11-21] przesunięcie napisów (subtitleOffsetMs — wspólne z lektorem; + = później)
        cenzorPreview: false, // [FIX 2026-11-21] podgląd napisów z pliku na ekranie
        cenzorTailFix: true,  // [FIX 2026-11-21] „napis wisi dłużej niż mowa” — cisza obejmuje oba położenia słowa
        words: '',            // [FIX 2026-11-02] wspólne własne słowa cenzora (censorCustomWords)
        censorEnabled: true,  // [AGENT-EXP] 2026-11-17: cenzura mowy lektora (checkbox w popupie) — decyduje też o kreskach w napisach
        censorMode: 'remove', // [AGENT-EXP] 2026-11-17: 'remove' | 'beep' | 'replace' | 'dashes' (dashes = ---------- w napisach na ekranie)
        cenzorNfPl: true,      // Netflix: zawsze cały polski plik napisów
        cenzorYtPl: true,      // YouTube: zawsze polskie napisy (ręczne → auto → tłumaczenie YouTube)
        selectors: []          // Kreator napisów dla tej strony (z cenzor_bridge.js)
    };
    opt.subSource = 'both';   // [AGENT-EXP] 2026-11-14: źródło napisów: 'both' (plik + ekran) | 'immersive' | 'native'
    // [AGENT-EXP] 2026-11-17: tryb „Kreski (----------)”. W napisach rysowanych przez odtwarzacz podmieniamy samo słowo
    // na kreski, a ORYGINAŁ chowamy w tym atrybucie — cenzor dźwięku (i lektor) czytają z niego, więc cisza w filmie
    // działa dalej, mimo że na ekranie widać „----------”. Atrybut nic nie zmienia w wyglądzie.
    var MASK_ATTR = 'data-lkc-raw';
    // [AGENT-EXP] 2026-11-17: węzeł tekstowy → jego treść przed kreskami. Dzięki temu cenzor czyta ORYGINAŁ nawet gdy
    // odtwarzacz dopisuje kolejne słowa do tego samego węzła (napisy automatyczne), a atrybut na elemencie zostaje
    // dla skryptów w świecie ISOLATED (lektor: dom_content / content.js / youtube_content / LOWCA).
    var maskOrig = new WeakMap();

    function num(v, min, max, def) { var n = Number(v); return isFinite(n) ? Math.min(max, Math.max(min, n)) : def; }

    function applyOpts(o) {
        if (!o || typeof o !== 'object') return;
        var wasOn = opt.cenzorOn || opt.cenzorLive;
        var wasMask = maskOn();   // [AGENT-EXP] 2026-11-17: kreski w napisach na ekranie
        // [AGENT-EXP] 2026-11-16: brak wpisu w pamięci = zostaje wartość domyślna (WŁ.), a nie „wyłącz”.
        // Mostek (cenzor_bridge.js) dosyła komplet, ale częściowe „opts” nie może już zgasić cenzora.
        opt.cenzorOn = o.cenzorOn === undefined ? opt.cenzorOn : !!o.cenzorOn;
        opt.cenzorLive = o.cenzorLive === undefined ? opt.cenzorLive : !!o.cenzorLive;
        opt.cenzorPriority = (o.cenzorPriority === 'live' || o.cenzorPriority === 'hybrid') ? o.cenzorPriority : 'file';   // [FIX 2026-11-16] priorytet źródeł
        opt.cenzorBufferMs = num(o.cenzorBufferMs, 0, 3000, 400);
        opt.cenzorHoldMs = num(o.cenzorHoldMs, 0, 2000, 200);
        opt.cenzorLenMode = ['off', 'normal', 'strong'].indexOf(o.cenzorLenMode) >= 0 ? o.cenzorLenMode : 'normal';
        opt.cenzorTextRate = num(o.cenzorTextRate, 0.25, 2.5, 0.6);   // [FIX 2026-11-16] brak zapisu = 0,6×
        opt.cenzorTextAuto = o.cenzorTextAuto === true;                // [FIX 2026-11-16] brak zapisu = auto WYŁ.
        // [FIX 2026-11-21] trzy tryby: 'legacy' (proporcje + pauzy z interpunkcji), 'pmtpos' (model PMT tylko wyznacza
        // MIEJSCE słowa, okno ciszy z suwaków jak w legacy), 'pmt' (okna liczy w całości model — diagnostyka).
        opt.cenzorTimingMode = (o.cenzorTimingMode === 'pmt' || o.cenzorTimingMode === 'model') ? 'pmt'
            : (o.cenzorTimingMode === 'pmtpos' ? 'pmtpos' : 'legacy');
        opt.cenzorPrerollMs = num(o.cenzorPrerollMs, 0, 750, 120);
        opt.cenzorPostrollMs = num(o.cenzorPostrollMs, 0, 750, 140);
        // [FIX 2026-11-14] usunięte z Ustawień — cenzor ZAWSZE traktuje „[ __ ]” (auto-napisy YouTube) jak przekleństwo.
        // Napisy z pliku mają prawdziwe słowa, więc tam działa zwykła lista — nic tego nie wyłącza.
        opt.cenzorAsrTag = true;
        opt.subOffsetMs = num(o.subtitleOffsetMs, -30000, 30000, 0);   // [FIX 2026-11-21] działa też przy wyłączonym lektorze
        opt.cenzorTailFix = o.cenzorTailFix !== false;
        opt.cenzorPreview = o.cenzorPreview === true;   // [FIX 2026-11-21] podgląd napisów z przesunięciem
        opt.words = typeof o.censorCustomWords === 'string' ? o.censorCustomWords : '';   // [FIX 2026-11-02] jedna lista słów
        opt.censorEnabled = o.censorEnabled === undefined ? opt.censorEnabled : !!o.censorEnabled;   // [AGENT-EXP] 2026-11-17
        opt.censorMode = ['remove', 'beep', 'replace', 'dashes'].indexOf(o.censorMode) >= 0 ? o.censorMode : opt.censorMode;   // [AGENT-EXP] 2026-11-17
        // [FIX 2026-11-14] usunięte z Ustawień — ZAWSZE polskie napisy: Netflix (cały plik) i YouTube
        // (ręczne → auto → ścieżka przetłumaczona). Stare zapisy w chrome.storage nie mają już znaczenia.
        opt.cenzorNfPl = true;
        opt.cenzorYtPl = true;
        opt.selectors = Array.isArray(o.selectors) ? o.selectors.filter(function (s) { return typeof s === 'string' && s.trim(); }) : [];
        opt.subSource = (o.subSource === 'immersive' || o.subSource === 'native') ? o.subSource : 'both';   // [AGENT-EXP] 2026-11-14
        buildRegex();
        windows = []; plannedFor = -1;
        liveWins = []; liveSeen = new Set(); lastSubs = { nat: '', tr: '' }; natChangedAt = -1;   // [AGENT-EXP] 2026-10-20
        if (cueMode) planFromCues();
        if (wasOn && !(opt.cenzorOn || opt.cenzorLive)) applyMute(false);
        // [AGENT-EXP] 2026-11-17: tryb cenzury zmieniony w popupie — kreski w napisach idą za nim (zdejmij / załóż od razu)
        if (wasMask && !maskOn()) unmaskAll();
        else if (!wasMask && maskOn()) maskSoon(true);
    }

    window.addEventListener('message', function (ev) {
        if (ev.source !== window || ev.origin !== location.origin) return;
        var d = ev.data;
        if (d && d[TAG] === 'opts') applyOpts(d.opts);
    });

    /* ---------------- 1) napisy z sieci (YouTube /api/timedtext) ---------------- */

    var cuesByVid = new Map();
    var ytLang = new Map();     // YouTube: język napisów, z których wyciszamy (vid -> 'pl', 'en'…)
    function isPl(l) { return /^pl/i.test(String(l || '')); }
    var cues = [];
    var cueMode = false;
    var lastTrackInfo = '';

    function isTimedtextUrl(u) { return typeof u === 'string' && u.indexOf('/api/timedtext') >= 0; }
    function paramOf(u, name) { try { return new URL(u, location.href).searchParams.get(name) || ''; } catch (e) { return ''; } }

    function decodeEntities(s) {
        return String(s)
            .replace(/&#(\d+);/g, function (m, n) { return String.fromCodePoint(+n); })
            .replace(/&#x([0-9a-f]+);/gi, function (m, n) { return String.fromCodePoint(parseInt(n, 16)); })
            .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&');
    }

    // Skleja kawałki w linię i pamięta, gdzie zaczyna się każdy kawałek (auto-napisy: czas słowa).
    function joinPieces(pieces) {
        var text = '', segs = [];
        pieces.forEach(function (p) {
            var r = String(p.text || '').replace(/\s+/g, ' ');
            if (!r.trim()) { if (text && text.slice(-1) !== ' ') text += ' '; return; }
            if ((!text || text.slice(-1) === ' ') && r.charAt(0) === ' ') r = r.replace(/^ +/, '');
            var lead = r.length - r.replace(/^ +/, '').length;
            segs.push({ off: text.length + lead, t: p.t });
            text += r;
        });
        return { text: text.replace(/ +$/, ''), segs: segs };
    }

    function parseJson3(obj) {
        var out = [];
        ((obj && obj.events) || []).forEach(function (ev) {
            if (!ev || !ev.segs || typeof ev.tStartMs !== 'number') return;
            var t0 = ev.tStartMs / 1000;
            var dur = (typeof ev.dDurationMs === 'number' ? ev.dDurationMs : 2000) / 1000;
            var j = joinPieces(ev.segs.map(function (s) {
                return { text: (s && s.utf8) || '', t: t0 + ((s && typeof s.tOffsetMs === 'number') ? s.tOffsetMs / 1000 : 0) };
            }));
            if (!j.text) return;
            var wordLevel = j.segs.length > 1 && j.segs.some(function (s) { return s.t !== t0; });
            out.push({ start: t0, end: t0 + Math.max(0.1, dur), text: j.text, segs: wordLevel ? j.segs : null, rawSegs: j.segs });
        });
        return wordLevelFile(out);
    }

    // [AGENT-EXP] 2026-10-20: gdy plik ma czasy słów (auto-napisy), linia z JEDNYM słowem też je ma — słowo zaczyna
    // się na początku linii. Wcześniej taka linia szła modelem proporcji, a auto-napisy trzymają linię długo
    // (np. „kurwa” wisi 3 s) → cisza na całe 3 s zamiast na samo słowo.
    function wordLevelFile(out) {
        var any = out.some(function (c) { return c.segs; });
        out.forEach(function (c) {
            if (any && !c.segs && c.rawSegs && c.rawSegs.length) c.segs = c.rawSegs;
            delete c.rawSegs;
        });
        return out;
    }

    // XML bez DOMParser (YouTube wymusza Trusted Types).
    function parseXml(xml) {
        var out = [], m;
        var stripTags = function (s) { return decodeEntities(s.replace(/<[^>]*>/g, '')); };
        var attr = function (a, n) { var r = a.match(new RegExp('\\b' + n + '="([^"]*)"')); return r ? r[1] : null; };
        var reP = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
        while ((m = reP.exec(xml))) {
            var t = +attr(m[1], 't'), d = +attr(m[1], 'd');
            if (!isFinite(t)) continue;
            var t0 = t / 1000, pieces = [], s;
            var reS = /<s\b([^>]*)>([\s\S]*?)<\/s>/g;
            while ((s = reS.exec(m[2]))) {
                var off = +attr(s[1], 't');
                pieces.push({ text: stripTags(s[2]), t: t0 + (isFinite(off) ? off / 1000 : 0) });
            }
            if (!pieces.length) pieces.push({ text: stripTags(m[2]), t: t0 });
            var j = joinPieces(pieces);
            if (!j.text) continue;
            var wl = j.segs.length > 1 && j.segs.some(function (x) { return x.t !== t0; });
            out.push({ start: t0, end: t0 + Math.max(0.1, (isFinite(d) ? d : 2000) / 1000), text: j.text, segs: wl ? j.segs : null, rawSegs: j.segs });
        }
        if (out.length) return wordLevelFile(out);   // [AGENT-EXP] 2026-10-20
        var reT = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
        while ((m = reT.exec(xml))) {
            var st = +attr(m[1], 'start'), du = +attr(m[1], 'dur');
            if (!isFinite(st)) continue;
            var tx = stripTags(decodeEntities(m[2])).replace(/\s+/g, ' ').trim();
            if (tx) out.push({ start: st, end: st + Math.max(0.1, isFinite(du) ? du : 2), text: tx, segs: null });
        }
        return out;
    }

    function parseVtt(txt) {
        var out = [];
        var tm = function (s) {
            var p = s.trim().split(':').map(Number);
            if (p.some(function (x) { return !isFinite(x); })) return NaN;
            return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
        };
        txt.replace(/\r/g, '').split(/\n\n+/).forEach(function (b) {
            var lines = b.split('\n');
            var i = lines.findIndex(function (l) { return l.indexOf('-->') >= 0; });
            if (i < 0) return;
            var parts = lines[i].split('-->');
            var st = tm(parts[0]), en = tm(parts[1].trim().split(/\s+/)[0]);
            if (!isFinite(st) || !isFinite(en)) return;
            var tx = decodeEntities(lines.slice(i + 1).join(' ').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
            if (tx) out.push({ start: st, end: Math.max(en, st + 0.1), text: tx, segs: null });
        });
        return out;
    }

    function parseTimedtext(body) {
        if (body && typeof body === 'object') return parseJson3(body);
        var s = String(body || '').trim();
        if (!s) return [];
        if (s.charAt(0) === '{') { try { return parseJson3(JSON.parse(s)); } catch (e) { return []; } }
        if (s.charAt(0) === '<') return parseXml(s);
        if (s.indexOf('-->') >= 0) return parseVtt(s);
        return [];
    }

    function onTimedtext(url, body) {
        var list;
        try { list = parseTimedtext(body); } catch (e) { list = []; }
        if (!list.length) return;
        list.sort(function (a, b) { return a.start - b.start; });
        var vid = paramOf(url, 'v') || currentVid() || '?';
        var tl = paramOf(url, 'tlang'), lang = String(tl || paramOf(url, 'lang')).toLowerCase();
        // Druga ścieżka tego samego filmu (inny język) ZASTĘPUJE poprzednią — dwa sklejone języki
        // dawałyby fałszywe okna ciszy. [AGENT-EXP] 2026-10-19: przy cenzorYtPl polskie napisy wygrywają
        // (gdy już są, inny język ich nie nadpisze, np. po przywróceniu angielskich CC użytkownika).
        // Bez tej opcji — jak dawniej: auto-tłumaczenie YouTube (tlang) nie nadpisuje oryginału.
        if (opt.cenzorYtPl) { if (isPl(ytLang.get(vid)) && !isPl(lang)) return; }
        else if (tl && cuesByVid.has(vid)) return;
        cuesByVid.delete(vid);
        cuesByVid.set(vid, list);
        ytLang.set(vid, lang);
        while (cuesByVid.size > 20) { var old = cuesByVid.keys().next().value; cuesByVid.delete(old); ytLang.delete(old); }
        lastTrackInfo = (lang || '?') + (tl ? ' (tłumaczenie YouTube)' : paramOf(url, 'kind') === 'asr' ? ' (auto)' : '')
            + ', ' + list.length + ' kwestii' + (list.some(function (c) { return c.segs; }) ? ', czasy słów' : '');
        if (vid === currentVid()) useCuesFor(vid);
    }

    // [AGENT-EXP] 2026-10-25: napisy LEKTORA z dowolnego źródła (dom_content.js: plik z dysku, bazy napisów, Łowca,
    // ⬇ Pobierz całe napisy, auto_subs) — „są napisy z czasami, to cenzor działa”. Używane, gdy strona nie dała
    // własnego pliku (YouTube / Netflix / HBO Max mają pierwszeństwo). Każda kwestia w obu wersjach: przetłumaczona
    // (to czyta lektor) i oryginał, jeśli jest — przekleństwo w którejkolwiek wycisza.
    var extCues = null;   // { vid, list, info, at }
    function onExtCues(d) {
        var list = [];
        (Array.isArray(d.cues) ? d.cues : []).forEach(function (c) {
            if (!c) return;
            var st = +c.startMs / 1000, en = +c.endMs / 1000;
            if (!isFinite(st) || !(en > st)) return;
            var seen = {};
            [c.text, c.orig].forEach(function (t) {
                t = String(t || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
                if (!t || seen[t]) return;
                seen[t] = 1;
                list.push({ start: st, end: Math.max(en, st + 0.1), text: t, segs: null });
            });
        });
        list.sort(function (a, b) { return a.start - b.start; });
        var vid = currentVid();
        extCues = list.length ? { vid: vid, list: list, info: 'napisy lektora (' + String(d.key || 'plik') + '), ' + list.length + ' kwestii', at: Date.now(), ep: String(d.ep || '') } : null;
        if (vid === curVid || curVid === null) useCuesFor(vid);
    }
    window.addEventListener('message', function (ev) {
        if (ev.source !== window || ev.origin !== location.origin) return;
        if (ev.data && ev.data[TAG] === 'cues') { try { onExtCues(ev.data); } catch (e) {} }
    });

    // [AGENT-EXP] 2026-11-14: rozpiętość czasu, jaką lista pokrywa (pierwsza kwestia → koniec ostatniej).
    function spanOf(list) {
        if (!list || !list.length) return 0;
        var a = Infinity, b = 0;
        for (var i = 0; i < list.length; i++) {
            if (list[i].start < a) a = list[i].start;
            if (list[i].end > b) b = list[i].end;
        }
        return b > a ? b - a : 0;
    }
    // Czy `a` pokrywa film LEPIEJ niż `b`: najpierw rozpiętość czasu (5% tolerancji), przy remisie liczba kwestii.
    // [AGENT-EXP] 2026-11-14: SAMEJ liczby kwestii nie wystarczy — gęsty kawałek z bufora (środek filmu) ma ich
    // więcej niż rzadszy plik CAŁEGO filmu, więc wcześniej wygrywał i cenzor zaczynał dopiero w środku
    // („HBO ściąga środek zamiast początek”).
    function betterThanCues(a, b) {
        if (!a || !a.length) return false;
        if (!b || !b.length) return true;
        var sa = spanOf(a), sb = spanOf(b);
        if (sa > sb * 1.05) return true;
        if (sb > sa * 1.05) return false;
        return a.length > b.length;
    }

    // [AGENT-EXP] 2026-11-17: ostatnio odrzucony plik lektora (inny odcinek) — log tylko raz na odcinek
    var lastEpReject = '';

    function useCuesFor(vid) {
        var own = cuesByVid.get(vid) || [];
        // [AGENT-EXP] 2026-11-06: wygrywa lista, która pokrywa więcej filmu — kawałki ze ścieżki odtwarzacza
        // (bufor) nie mogą przykryć całego pliku z manifestu ani napisów pobranych „na żądanie”.
        var ext = null;
        if (extCues) {
            // [AGENT-EXP] 2026-11-17: napisy lektora niosą numer odcinka (`ep`). Po autoplay Netflixa partie nowego
            // odcinka potrafią dotrzeć ze starym adresem — takie kwestie NIE mogą ciąć nowego odcinka
            // (wcześniej cenzor wyciszał w miejscach, gdzie nikt nie mówi).
            var epOk = !extCues.ep || extCues.ep === (location.pathname || '');
            if (extCues.vid === vid && epOk) ext = extCues.list;
            else if (!epOk && lastEpReject !== extCues.ep) {
                lastEpReject = extCues.ep;
                try { console.log('[Lektor Cenzor] odrzucam plik lektora z innego odcinka (' + extCues.ep + ' ≠ ' + location.pathname + ')'); } catch (e) {}
            }
        }
        cues = (ext && betterThanCues(ext, own)) ? ext : own;
        if (cues === ext) lastTrackInfo = extCues.info;
        cueMode = cues.length > 0;
        windows = []; plannedFor = -1;
        if (cueMode) planFromCues();
    }

    var origFetch = window.fetch;
    if (IS_YT) {
        try {
            window.fetch = function (input) {
                var p = origFetch.apply(this, arguments);
                try {
                    var url = (input && typeof input === 'object' && 'url' in input) ? input.url : String(input);
                    if (isTimedtextUrl(url)) {
                        p.then(function (res) {
                            try { res.clone().text().then(function (t) { onTimedtext(url, t); }).catch(function () {}); } catch (e) {}
                        }).catch(function () {});
                    }
                } catch (e) {}
                return p;
            };
        } catch (e) {}
        try {
            var XP = XMLHttpRequest.prototype, oOpen = XP.open, oSend = XP.send;
            XP.open = function (m, url) { try { this.__czUrl = String(url); } catch (e) {} return oOpen.apply(this, arguments); };
            XP.send = function () {
                try {
                    if (isTimedtextUrl(this.__czUrl)) {
                        var x = this;
                        x.addEventListener('load', function () {
                            try {
                                var rt = x.responseType, body;
                                if (!rt || rt === 'text') body = x.responseText;
                                else if (rt === 'json') body = x.response;
                                else if (rt === 'arraybuffer') body = new TextDecoder().decode(x.response);
                                else return;
                                onTimedtext(x.responseURL || x.__czUrl, body);
                            } catch (e) {}
                        });
                    }
                } catch (e) {}
                return oSend.apply(this, arguments);
            };
        } catch (e) {}
    }

    /* ---------------- 1b) NETFLIX: całe napisy z góry ---------------- */
    // [AGENT-EXP] 2026-10-19: Netflix ładuje napisy wybranej ścieżki PARTIAMI. Pełny plik każdej ścieżki jest
    // w manifeście filmu (timedtexttracks → ttDownloadables) — tak jak robią programy do pobierania napisów:
    //  - JSON.stringify: do zapytania o manifest dopisujemy formaty pełnych plików (WebVTT, DFXP)
    //    i showAllSubtitles (wszystkie języki mają wtedy adresy),
    //  - JSON.parse: z odpowiedzi bierzemy listę ścieżek (movieId = id odcinka z /watch/<id>),
    //  - opcja cenzorNfPl: od razu ściągamy CAŁY polski plik (nie trzeba go wybierać w odtwarzaczu).
    // Drugie źródło: napisy wybrane w odtwarzaczu (inject.js lektora → LIVEDUB_SUBTITLE_DATA, partiami).
    // [AGENT-EXP] 2026-10-19: cenzor NIE słucha dźwięku — pracuje wyłącznie na tekście napisów. Gdy cały polski
    // plik jest pobrany, tylko on się liczy (wystarcza); napisy z odtwarzacza są zapasem, gdy pliku brak.
    var IS_NF = /(^|\.)netflix\.com$/.test(location.hostname);
    var NF_PROFILES = ['webvtt-lssdh-ios8', 'dfxp-ls-sdh'];
    var NF_FORMATS = NF_PROFILES.concat(['imsc1.1']);   // imsc1.1 = TTML, Netflix daje go domyślnie
    var nfTracks = new Map();   // movieId -> timedtexttracks
    var nfStore = new Map();    // movieId -> { file: cues|null, fileLang, sel: { klucz: cues } }
    var nfFetched = new Set();  // movieId|język — już ściągnięte (albo w trakcie)

    function nfEntry(vid) {
        var e = nfStore.get(vid);
        if (!e) { e = { file: null, fileLang: '', sel: Object.create(null), sent: 0 }; nfStore.set(vid, e); }
        while (nfStore.size > 20) nfStore.delete(nfStore.keys().next().value);
        return e;
    }


    function nfRebuild(vid) {
        var e = nfStore.get(vid);
        if (!e) return;
        var all = [];
        // [AGENT-EXP] 2026-10-19: cały polski plik WYSTARCZA — napisy z odtwarzacza tylko, gdy go brak.
        if (e.file) e.file.forEach(function (c) { all.push(c); });
        else for (var k in e.sel) e.sel[k].forEach(function (c) { all.push(c); });
        all.sort(function (a, b) { return a.start - b.start; });
        cuesByVid.set(vid, all);
        lastTrackInfo = (e.file ? 'cały plik ' + (e.fileLang || '?') + ' (' + e.file.length + ')' : 'bez pełnego pliku')
            + ', z odtwarzacza: ' + Object.keys(e.sel).length;
        if (vid === currentVid()) useCuesFor(vid);
    }

    // TTML/DFXP Netflixa: <p begin="123t" end="456t">…<br/>…</p>, ttp:tickRate; też zapis zegarowy.
    function parseTtml(xml) {
        var out = [], m;
        var tr = xml.match(/tickRate="(\d+)"/);
        var tick = tr ? +tr[1] : 10000000;
        var tm = function (s) {
            if (!s) return NaN;
            var t = s.match(/^(\d+)t$/);
            if (t) return +t[1] / tick;
            var c = s.match(/^(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)$/);
            if (c) return (+(c[1] || 0)) * 3600 + (+c[2]) * 60 + parseFloat(c[3].replace(',', '.'));
            var sec = s.match(/^([\d.]+)s$/);
            return sec ? +sec[1] : NaN;
        };
        var attr = function (a, n) { var r = a.match(new RegExp('\\b' + n + '="([^"]*)"')); return r ? r[1] : null; };
        var reP = /<(?:[a-z]+:)?p\b([^>]*)>([\s\S]*?)<\/(?:[a-z]+:)?p>/gi;   // [AGENT-EXP] 2026-11-06: też <tt:p> (prefiksy TTML)
        while ((m = reP.exec(xml))) {
            var st = tm(attr(m[1], 'begin')), en = tm(attr(m[1], 'end'));
            if (!isFinite(en) && isFinite(st)) en = st + (tm(attr(m[1], 'dur')) || 2);
            if (!isFinite(st)) continue;
            var tx = decodeEntities(m[2].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
            if (!tx) continue;
            var last = out[out.length - 1];   // dwie linie jednej kwestii jako dwa <p> — sklejamy
            if (last && Math.abs(last.start - st) < 0.1 && Math.abs(last.end - en) < 0.1) last.text += ' ' + tx;
            else out.push({ start: st, end: Math.max(en, st + 0.1), text: tx, segs: null });
        }
        return out;
    }

    function nfTrackUrl(t) {
        var dl = t && t.ttDownloadables;
        if (!dl) return '';
        for (var i = 0; i < NF_FORMATS.length; i++) {
            var d = dl[NF_FORMATS[i]];
            if (!d) continue;
            if (Array.isArray(d.urls) && d.urls[0] && d.urls[0].url) return d.urls[0].url;
            if (d.downloadUrls) { for (var k in d.downloadUrls) if (d.downloadUrls[k]) return d.downloadUrls[k]; }
        }
        return '';
    }

    function nfLang(t) { return String((t && (t.language || t.bcp47)) || '').toLowerCase().split('-')[0]; }

    function nfPickTrack(tracks, lang) {
        var ok = tracks.filter(function (t) { return t && !t.isNoneTrack && !t.isForcedNarrative && nfLang(t) === lang && nfTrackUrl(t); });
        return ok.filter(function (t) { return t.trackType === 'PRIMARY' || t.rawTrackType === 'subtitles'; })[0] || ok[0] || null;
    }

    async function nfFetchFile(vid, lang) {
        var key = vid + '|' + lang;
        if (nfFetched.has(key)) return;
        var track = nfPickTrack(nfTracks.get(vid) || [], lang);
        if (!track) return;
        nfFetched.add(key);
        try {
            var resp = await origFetch.call(window, nfTrackUrl(track));
            if (!resp.ok) { nfDiag('polski plik ' + vid + ': HTTP ' + resp.status); nfFailLater(key); return; }
            var txt = await resp.text();
            var s = String(txt || '').trim();
            var list = s.indexOf('WEBVTT') === 0 ? parseVtt(s) : parseTtml(s);
            if (!list.length) { nfDiag('polski plik ' + vid + ': pusty / nieczytelny'); nfFailLater(key); return; }
            nfDiag('polski plik ' + vid + ': ' + list.length + ' kwestii');
            var e = nfEntry(vid);
            e.file = list; e.fileLang = lang; e.sent = 0;
            nfRebuild(vid);
            nfSendToLektor(vid);
        } catch (err) { nfDiag('polski plik ' + vid + ': błąd ' + (err && err.message || err)); nfFailLater(key); }
    }
    // [FIX 2026-11-21] ponowna próba nie częściej niż co 15 s (wcześniej co ~1 s w nieskończoność)
    function nfFailLater(key) { setTimeout(function () { nfFetched.delete(key); }, 15000); }
    // [FIX 2026-11-21] dziennik Netflixa — konsola „[Lektor Cenzor] Netflix: …” i lektorCenzor.status().nfLog
    var nfLog = [];
    function nfDiag(msg) {
        nfLog.push(new Date().toTimeString().slice(0, 8) + ' ' + msg);
        if (nfLog.length > 30) nfLog.shift();
        try { console.log('[Lektor Cenzor] Netflix: ' + msg); } catch (e) {}
    }

    // [AGENT-EXP] 2026-10-19: cały polski plik idzie też do LEKTORA — tym samym komunikatem co napisy z inject.js
    // (content.js-BgeP3Ise.js: LIVEDUB_SUBTITLE_DATA, osobne źródło 'cenzor-pl'; lektor woli polskie źródło).
    // Lektor ma wtedy komplet od pierwszej minuty, nawet gdy w odtwarzaczu nie wybrano napisów. Wysyłamy
    // po pobraniu i jeszcze 2× przy kolejnych partiach z odtwarzacza (gdyby lektor wtedy jeszcze nie słuchał).
    var NF_LEKTOR_KEY = 'cenzor-pl';
    function nfSendToLektor(vid) {
        var e = nfStore.get(vid);
        if (!e || !e.file || e.sent >= 3 || vid !== currentVid()) return;
        e.sent++;
        try {
            window.postMessage({
                type: 'LIVEDUB_SUBTITLE_DATA',
                source: { key: NF_LEKTOR_KEY, url: 'cenzor:pl:' + vid },
                subtitles: e.file.map(function (c, i) {
                    var st = Math.round(c.start * 1000);
                    return { id: NF_LEKTOR_KEY + '_' + st + '_' + i, text: c.text, lines: [c.text], startMs: st, endMs: Math.round(c.end * 1000) };
                })
            }, location.origin);
        } catch (err) {}
    }

    // [AGENT-EXP] 2026-11-17] Ostatnia deska ratunku dla Netflixa: odtwarzacz sam pobiera plik napisów (TTML/DFXP/VTT),
    // więc gdy cenzor nie ma kwestii dla BIEŻĄCEGO odcinka (nowy odcinek, partie sprzed zmiany adresu), bierzemy
    // najświeższy taki adres z `performance` i pobieramy go jeszcze raz — własnym parserem. Tylko gdy `own` = 0.
    var nfResTried = new Set(), nfResAt = 0;
    function nfResFetch(vid, url) {
        try {
            origFetch.call(window, url).then(function (r) { return r.text(); }).then(function (txt) {
                var s = String(txt || '').trim();
                if (!s) return;
                var list = s.indexOf('WEBVTT') === 0 ? parseVtt(s)
                    : (/<(?:\w+:)?tt[\s>]/i.test(s.slice(0, 4000)) ? parseTtml(s) : []);
                if (!list.length) return;
                if (currentVid() !== vid) return;                 // film zmienił się w trakcie pobierania
                var e = nfEntry(vid);
                if (e.file && e.file.length >= list.length) return;
                e.file = list; e.fileLang = ''; e.sent = 0;
                nfRebuild(vid);
            }).catch(function () {});
        } catch (e) {}
    }
    function nfScanResources(vid) {
        if (!IS_NF || !vid) return;
        if (Date.now() - nfResAt < 4000) return;
        nfResAt = Date.now();
        var ents = [];
        try { ents = performance.getEntriesByType('resource') || []; } catch (e) { return; }
        var now = (function () { try { return performance.now(); } catch (e) { return Date.now(); } })();
        for (var i = ents.length - 1, n = 0; i >= 0 && n < 80; i--, n++) {
            var en = ents[i], u = String((en && en.name) || '');
            if (!/\.(ttml|dfxp|vtt|srt)(\?|$)/i.test(u)) continue;
            if (nfResTried.has(vid + '|' + u)) continue;
            // świeże pobranie (3 min) — stare pliki to poprzednie odcinki
            if (typeof en.startTime === 'number' && now - en.startTime > 180000) continue;
            nfResTried.add(vid + '|' + u);
            nfResFetch(vid, u);
            return;   // jedna próba na raz
        }
    }

    // [FIX 2026-11-21] Autoplay / druga część filmu: odtwarzacz pobiera napisy NASTĘPNEJ części, zanim zmieni adres,
    // więc partie z inject.js wpadały do worka POPRZEDNIEGO filmu, a nowy zostawał pusty (tryb live do F5).
    // Pamiętamy każde źródło osobno (klucz pliku z inject.js) z czasem pierwszego pojawienia się. Gdy nowy film
    // nie ma żadnych kwestii, przejmujemy źródła, które pojawiły się najwcześniej 10 min przed zmianą adresu —
    // ale nie te, których treść jest w kwestiach poprzedniego filmu z INNEGO źródła (to byłby stary odcinek).
    var nfSrcAll = new Map();   // klucz źródła -> { first, vid, cues }
    function nfTextSet(list, out) { for (var i = 0; i < list.length; i++) out.add(list[i].text); return out; }
    function nfLooksForeign(vid, k, list) {
        var other = new Set();
        nfStore.forEach(function (e, v) {
            if (v === vid) return;
            if (e.file) nfTextSet(e.file, other);
            for (var kk in e.sel) if (kk !== k) nfTextSet(e.sel[kk], other);
        });
        if (!other.size) return false;
        var n = 0, hit = 0, step = Math.max(1, Math.floor(list.length / 40));
        for (var i = 0; i < list.length; i += step) { n++; if (other.has(list[i].text)) hit++; }
        return n > 0 && hit / n >= 0.5;
    }
    function nfAdoptEarly(vid) {
        var e = nfEntry(vid), took = 0;
        nfSrcAll.forEach(function (src, k) {
            if (src.vid === vid || e.sel[k]) return;
            if (src.first < vidSince - 600000) return;          // za stare — to napisy poprzedniego filmu
            if (src.cues.length < 5 || nfLooksForeign(vid, k, src.cues)) return;
            e.sel[k] = src.cues.slice();
            took++;
        });
        if (took) { nfDiag('film ' + vid + ': przejmuję ' + took + ' źródło(a) napisów pobrane tuż przed zmianą adresu'); nfRebuild(vid); }
    }

    function nfMaybeFetch() {
        if (!IS_NF || !opt.cenzorOn || opt.cenzorNfPl === false || !curVid) return;
        if (nfTracks.has(curVid)) nfFetchFile(curVid, 'pl');
        if (!(cuesByVid.get(curVid) || []).length) nfAdoptEarly(curVid);    // [FIX 2026-11-21]
        if (!(cuesByVid.get(curVid) || []).length) nfScanResources(curVid);   // [AGENT-EXP] 2026-11-17
    }

    if (IS_NF) {
        try {
            var oParse = JSON.parse, oStringify = JSON.stringify;
            JSON.stringify = function (value) {
                try {
                    var prm = value && value.params;
                    if (prm && Array.isArray(prm.profiles) && opt.cenzorOn && opt.cenzorNfPl !== false) {
                        NF_PROFILES.forEach(function (p) { if (prm.profiles.indexOf(p) < 0) prm.profiles.push(p); });
                        prm.showAllSubtitles = true;
                    }
                } catch (e) {}
                return oStringify.apply(this, arguments);
            };
            JSON.parse = function () {
                var r = oParse.apply(this, arguments);
                try {
                    // [FIX 2026-11-21] wynik bywa też tablicą (kilka manifestów naraz — np. następny odcinek z wyprzedzeniem)
                    var found = 0;
                    (function scan(o, depth) {
                        if (!o || typeof o !== 'object' || depth > 3 || found > 10) return;
                        if (Array.isArray(o.timedtexttracks) && o.movieId) {
                            found++;
                            var vid = String(o.movieId);
                            nfTracks.set(vid, o.timedtexttracks);
                            while (nfTracks.size > 20) nfTracks.delete(nfTracks.keys().next().value);
                            var hasPl = !!nfPickTrack(o.timedtexttracks, 'pl');
                            nfDiag('manifest ' + vid + ': ' + o.timedtexttracks.length + ' ścieżek, polski plik: ' + (hasPl ? 'jest' : 'BRAK adresu') + (vid === curVid ? '' : ' (teraz gra ' + curVid + ')'));
                            return;
                        }
                        if (Array.isArray(o)) { for (var i = 0; i < o.length && i < 20; i++) scan(o[i], depth + 1); return; }
                        if (o.result) scan(o.result, depth + 1);
                        if (o.results) scan(o.results, depth + 1);
                    })(r, 0);
                    if (found) setTimeout(nfMaybeFetch, 0);
                } catch (e) {}
                return r;
            };
        } catch (e) {}

        // Napisy z odtwarzacza (wybrana ścieżka) — z inject.js lektora, partiami.
        window.addEventListener('message', function (ev) {
            if (ev.source !== window || !ev.data || ev.data.type !== 'LIVEDUB_SUBTITLE_DATA') return;
            var vid = currentVid();
            if (!vid) return;
            var src = ev.data.source || {};
            var k = String(src.key || src.url || 'src');
            if (k === NF_LEKTOR_KEY) return;   // nasz własny komunikat dla lektora
            var e = nfEntry(vid);
            var have = e.sel[k] || [], ids = new Set(have.map(function (c) { return c.id; }));
            (ev.data.subtitles || []).forEach(function (s) {
                if (!s || ids.has(String(s.id))) return;
                var tx = String(s.text || '').replace(/\s+/g, ' ').trim();
                if (!tx || !(s.endMs > s.startMs)) return;
                have.push({ id: String(s.id), start: s.startMs / 1000, end: s.endMs / 1000, text: tx, segs: null });
            });
            e.sel[k] = have;
            var sa = nfSrcAll.get(k);   // [FIX 2026-11-21] pamięć źródła niezależna od adresu (patrz nfAdoptEarly)
            if (!sa) { sa = { first: Date.now(), vid: vid, cues: [] }; nfSrcAll.set(k, sa); while (nfSrcAll.size > 40) nfSrcAll.delete(nfSrcAll.keys().next().value); }
            sa.cues = have;
            nfRebuild(vid);
            nfSendToLektor(vid);
        });
    }

    /* ---------------- 1c) HBO MAX: cały plik napisów z góry (DASH / HLS / plik / <track>) ---------------- */
    // [AGENT-EXP] 2026-11-06: tak jak w Netflixie i na YouTube — cenzor sam ściąga CAŁY plik napisów filmu
    // (CC w odtwarzaczu nie trzeba włączać), więc wie z góry, które słowa padną i kiedy; cisza wchodzi PRZED słowem.
    // Kolejność źródeł:
    //  1) manifest DASH (.mpd) albo HLS (.m3u8) z fetch/XHR odtwarzacza — rozpoznawany po TREŚCI („<MPD”, „#EXTM3U”),
    //     nie po adresie (HBO potrafi podać manifest bez .mpd w adresie),
    //  2) manifest z performance.getEntriesByType('resource') — gdy pobrał go worker albo zanim podmieniliśmy fetch,
    //  3) pojedynczy plik .vtt/.ttml/.srt (odtwarzacz z <track src>),
    //  4) ścieżki tekstowe odtwarzacza (video.textTracks — cues są już w pamięci przeglądarki).
    // W manifeście: SegmentTemplate (SegmentTimeline albo duration), SegmentList, SegmentBase/BaseURL,
    // BaseURL na każdym poziomie (MPD → Period → AdaptationSet → Representation), wiele <Period>.
    // Napisy: WebVTT (także z X-TIMESTAMP-MAP), TTML/DFXP (także z prefiksami tt:/ttp:), SRT.
    // Wybór ścieżki: pl/subtitle → pl/caption → pl/inna → en/subtitle → en/caption → en/inna → pierwsza nie-forced.
    // Diagnostyka: konsola („[Lektor Cenzor] HBO: …”) i lektorCenzor.status().hbo
    var IS_HBO = /(^|\.)(hbomax|max)\.com$/.test(location.hostname);
    var hboSeen = new Set();       // adresy manifestów już pobrane (albo w trakcie)
    var hboManifests = [];         // { url, kind } — co odtwarzacz podał (diagnostyka)
    var hboBest = 0;               // najdłuższa przyjęta lista kwestii
    var hboFromManifest = 0;       // > 0 = pełny plik z manifestu przyjęty (koniec szukania)
    var hboLog = [];
    var hboAttempts = 0, hboLastScan = 0, hboLastTry = 0;
    var hboPending = [];           // adresy manifestów z tła — pobieramy, gdy w ramce jest już film
    var hboProcessed = new Set();  // manifesty już przetworzone (odtwarzacz potrafi pobrać ten sam kilka razy)
    var hboParts = [];             // kawałki .vtt/.ttml, które odtwarzacz sam pobrał (zapas, gdy manifest nie da się odczytać)
    var hboMpd = null;             // { url, text } — ostatni manifest (zgodność ze statusem)

    function hboNote(msg) {
        var line = String(msg);
        hboLog.push(line);
        if (hboLog.length > 30) hboLog.shift();
        try { console.log('[Lektor Cenzor] HBO: ' + line); } catch (e) {}
    }
    function hboIsManifestUrl(u) { return /\.(mpd|m3u8)(?=$|[?#])/i.test(String(u || '')); }
    function hboIsSubFile(u) { return /\.(vtt|ttml|dfxp|srt|xml)(?=$|[?#])/i.test(String(u || '')); }

    // 01:02:03.500 / 02:03.500 / 3.5 → sekundy
    function hboClock(s) {
        var t = String(s || '').trim().replace(',', '.');
        if (!t) return NaN;
        var p = t.split(':').map(Number);
        if (p.some(function (x) { return !isFinite(x); })) return NaN;
        return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : (p.length === 2 ? p[0] * 60 + p[1] : p[0]);
    }
    function hboSec(s) {   // PT1H2M3.5S (ISO 8601 z manifestu)
        var m = String(s || '').match(/^P(?:(\d+)D)?T?(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?$/);
        if (!m) return 0;
        return (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+(m[3] || 0)) * 60 + (+(m[4] || 0));
    }
    function hboAttr(a, n) { var r = String(a || '').match(new RegExp('\\b' + n + '="([^"]*)"')); return r ? decodeEntities(r[1]) : null; }
    function hboAbs(u, base) { try { return new URL(u, base).toString(); } catch (e) { return ''; } }
    function hboInner(tagBlock) { var s = String(tagBlock || ''), i = s.indexOf('>'); return i < 0 ? '' : s.slice(i + 1); }
    // <BaseURL> danego zakresu (przed jego dziećmi) — tak jak dziedziczy DASH.
    function hboOwnBase(inner, base) {
        var s = String(inner || '');
        var i = s.search(/<(?:Period|AdaptationSet|Representation|SegmentTemplate|SegmentList|SegmentBase|Role|ContentComponent|AudioChannelConfiguration)\b/);
        var head = i < 0 ? s : s.slice(0, i);
        var m = head.match(/<BaseURL[^>]*>([\s\S]*?)<\/BaseURL>/i);
        var u = m ? String(m[1]).trim() : '';
        return u ? (hboAbs(decodeEntities(u), base) || base) : base;
    }
    // $Number$ / $Time$ / $RepresentationID$ / $Bandwidth$ (też z zerami wiodącymi: $Number%05d$)
    function hboFill(media, repAttrs, num, time) {
        var m = String(media || '');
        m = m.replace(/\$RepresentationID\$/g, hboAttr(repAttrs, 'id') || '').replace(/\$Bandwidth\$/g, hboAttr(repAttrs, 'bandwidth') || '');
        m = m.replace(/\$(Number|Time)(?:%0(\d+)d)?\$/g, function (all, what, w) {
            var v = String(what === 'Time' ? time : num);
            while (w && v.length < +w) v = '0' + v;
            return v;
        });
        return m;
    }
    // 0 = to nie napisy, 1 = napisy tekstowe (VTT/TTML), 2 = napisy w MP4 (stpp/wvtt — nieobsługiwane)
    function hboTextKind(probe) {
        var p = String(probe || '');
        if (/codecs="[^"]*(?:stpp|wvtt|tx3g)[^"]*"/i.test(p)) return 2;
        if (/mimeType="application\/(?:mp4|webm)[^"]*"/i.test(p)) return 0;
        if (/contentType="text"/i.test(p)) return 1;
        if (/mimeType="(?:text\/|application\/(?:ttml|dfxp))/i.test(p)) return 1;
        return 0;
    }

    // Ścieżki tekstowe manifestu DASH: [{ lang, role, segs: [{ url, shift }], mp4 }]
    function hboMpdTracks(xml, mpdUrl) {
        var out = [], s = String(xml || '');
        var base0 = hboOwnBase(s, mpdUrl);
        var periods = [], m, reP = /<Period\b([^>]*)>([\s\S]*?)<\/Period>/g;
        while ((m = reP.exec(s))) periods.push({ head: m[1], body: m[2] });
        if (!periods.length) periods.push({ head: '', body: s });
        // [AGENT-EXP] 2026-11-14: długość Periodu bywa TYLKO na <MPD mediaPresentationDuration> (typowe VOD HBO).
        // Wcześniej pDur=0 → cnt=1 → pobierany był JEDEN kawałek napisów i koniec („pobiera część, potem nic”).
        var mpdDur = hboSec(hboAttr((s.match(/<MPD\b([^>]*)>/) || [])[1] || '', 'mediaPresentationDuration'));
        var pStarts = [], acc = 0;
        periods.forEach(function (p) {
            var st = hboAttr(p.head, 'start'), en = hboAttr(p.head, 'end');
            var start = st != null ? hboSec(st) : acc;
            pStarts.push(start);
            var d = hboSec(hboAttr(p.head, 'duration'));
            acc = en != null ? hboSec(en) : start + (d || 0);
        });
        periods.forEach(function (p, pi) {
            var pStart = pStarts[pi];
            var pEndAttr = hboAttr(p.head, 'end');
            var pDurAttr = hboSec(hboAttr(p.head, 'duration'));
            var pEnd = pEndAttr != null ? hboSec(pEndAttr)
                : (pDurAttr > 0 ? pStart + pDurAttr
                : (pi + 1 < periods.length ? pStarts[pi + 1] : (mpdDur > pStart ? mpdDur : 0)));
            var pDur = pEnd > pStart ? pEnd - pStart : 0;
            var pBase = hboOwnBase(p.body, base0);
            var reAS = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/g, a;
            while ((a = reAS.exec(p.body))) {
                var asHead = a[1], asBody = a[2], asBase = hboOwnBase(asBody, pBase);
                var reR = /<Representation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Representation>)/g, r, reps = [];
                while ((r = reR.exec(asBody))) reps.push({ head: r[1], body: r[2] || '' });
                if (!reps.length) reps.push({ head: '', body: '' });
                reps.forEach(function (rep) {
                    var kind = hboTextKind(asHead + ' ' + rep.head + ' ' + rep.body.slice(0, 400) + ' ' + asBody.slice(0, 400));
                    if (!kind) return;
                    var lang = String(hboAttr(rep.head, 'lang') || hboAttr(asHead, 'lang') || '').toLowerCase();
                    var roleM = rep.body.match(/<Role\b[^>]*value="([^"]*)"/) || asBody.match(/<Role\b[^>]*value="([^"]*)"/);
                    var role = String(roleM ? roleM[1] : 'subtitle').toLowerCase();
                    if (role.indexOf('forced') >= 0) return;         // forced = tylko obce wtrącenia, nie cały film
                    if (kind === 2) { out.push({ lang: lang, role: role, segs: [], mp4: true }); return; }
                    var segs = hboRepSegs(rep, asBody, asBase, pStart, pDur);
                    if (segs.length) out.push({ lang: lang, role: role, segs: segs, mp4: false });
                });
            }
        });
        return out;
    }

    // Kawałki jednej ścieżki: SegmentTemplate / SegmentList / SegmentBase+BaseURL.
    // shift = czas w filmie − czas w pliku (zasada DASH: start <Period> − presentationTimeOffset).
    function hboRepSegs(rep, asBody, asBase, pStart, pDur) {
        var attrs = rep.head || '', body = rep.body || '', segs = [];
        var repBase = body ? hboOwnBase(body, asBase) : asBase;
        // SegmentTemplate jako element z <SegmentTimeline> albo pusty znacznik z atrybutami
        var box = body.match(/<SegmentTemplate\b([^>]*)>([\s\S]*?)<\/SegmentTemplate>/) || asBody.match(/<SegmentTemplate\b([^>]*)>([\s\S]*?)<\/SegmentTemplate>/);
        var tpl = box ? box[1] : (body.match(/<SegmentTemplate\b([^>]*?)\/?>/) || asBody.match(/<SegmentTemplate\b([^>]*?)\/?>/) || [])[1];
        var tlBody = box ? box[2] : '';
        if (tpl != null) {
            var media = hboAttr(tpl, 'media') || '';
            var startNum = +(hboAttr(tpl, 'startNumber') || 1);
            var ts = +(hboAttr(tpl, 'timescale') || 1) || 1;
            var pto = (+(hboAttr(tpl, 'presentationTimeOffset') || 0)) / ts;
            var S = (tlBody || asBody).match(/<S\b[^>]*>/g);
            if (S) {
                var t = 0, num = startNum;
                S.forEach(function (e) {
                    var a = e.slice(2), st = hboAttr(a, 't'), d = +(hboAttr(a, 'd') || 0), r = +(hboAttr(a, 'r') || 0);
                    if (st != null) t = +st;
                    for (var k = 0; k <= Math.max(0, r) && segs.length < 2000; k++) {
                        segs.push({ url: hboAbs(decodeEntities(hboFill(media, attrs, num++, t)), repBase), shift: pStart - pto });
                        t += d;
                    }
                });
            } else if (media) {
                var dur = (+(hboAttr(tpl, 'duration') || 0)) / ts;
                var cnt = dur > 0 && pDur > 0 ? Math.ceil(pDur / dur) : 1;
                // [AGENT-EXP] 2026-11-14: endNumber z manifestu jest pewniejszy niż wyliczenie z długości Periodu.
                var endNum = +(hboAttr(tpl, 'endNumber') || 0);
                if (endNum >= startNum) cnt = endNum - startNum + 1;
                for (var i = 0; i < Math.min(cnt, 2000); i++) {
                    segs.push({ url: hboAbs(decodeEntities(hboFill(media, attrs, startNum + i, Math.round(i * dur * ts))), repBase), shift: pStart - pto });
                }
            }
        }
        if (!segs.length) {
            var list = body.match(/<SegmentList\b([^>]*)>([\s\S]*?)<\/SegmentList>/) || asBody.match(/<SegmentList\b([^>]*)>([\s\S]*?)<\/SegmentList>/);
            if (list) {
                var tsL = +(hboAttr(list[1], 'timescale') || 1) || 1;
                var ptoL = (+(hboAttr(list[1], 'presentationTimeOffset') || 0)) / tsL;
                var reU = /<SegmentURL\b([^>]*?)\/?>/g, u;
                while ((u = reU.exec(list[2])) && segs.length < 2000) {
                    var mu = hboAttr(u[1], 'media') || '';
                    if (mu) segs.push({ url: hboAbs(decodeEntities(mu), repBase), shift: pStart - ptoL });
                }
            }
        }
        if (!segs.length) {   // cały plik jednym adresem (SegmentBase / BaseURL)
            var own = body.match(/<BaseURL[^>]*>([\s\S]*?)<\/BaseURL>/i);
            if (own) segs.push({ url: hboAbs(decodeEntities(String(own[1]).trim()), asBase), shift: pStart });
            else if (/<BaseURL/i.test(asBody)) segs.push({ url: asBase, shift: pStart });
        }
        return segs.filter(function (x) { return !!x.url; });
    }

    function hboRank(t) {   // 0 = najlepsza ścieżka (polskie napisy), im wyżej, tym gorsza
        var l = String((t && t.lang) || '').split('-')[0];
        var base = l === 'pl' ? 0 : (l === 'en' ? 20 : (l ? 40 : 50));
        var r = String((t && t.role) || '');
        var rr = r === 'subtitle' ? 0 : r === 'caption' ? 2 : r === 'sdh' ? 3 : 4;
        return base + rr;
    }
    function hboOrder(tracks) {   // polskie przed angielskimi, subtitle przed caption
        return (tracks || []).slice().sort(function (a, b) { return hboRank(a) - hboRank(b); });
    }
    function hboPickTrack(tracks) { return hboOrder(tracks)[0] || null; }   // zgodność (testy)

    // Sklejanie kwestii: [{ cues, shift }] albo stare [{ cues, pStart, pto }].
    function hboMerge(parts) {
        var all = [], seen = new Set();
        (parts || []).forEach(function (pt) {
            if (!pt || !pt.cues || !pt.cues.length) return;
            var shift = (pt.shift != null) ? pt.shift : ((+pt.pStart || 0) - (+pt.pto || 0));
            pt.cues.forEach(function (c) {
                var st = c.start + shift, k = Math.round(st * 10) + '|' + c.text;
                if (seen.has(k)) return;
                seen.add(k);
                all.push({ start: st, end: Math.max(c.end + shift, st + 0.1), text: c.text, segs: null });
            });
        });
        return all.sort(function (a, b) { return a.start - b.start; });
    }

    // Jeden kawałek napisów → { cues, map } (map = przesunięcie z X-TIMESTAMP-MAP, 0 gdy brak).
    function hboVtt(txt) {
        var map = 0, s = String(txt || ''), m = s.match(/X-TIMESTAMP-MAP[^\r\n]*/i);
        if (m) {
            var lc = /LOCAL:([\d:.]+)/i.exec(m[0]), ts = /MPEGTS:(\d+)/i.exec(m[0]);
            if (ts) map = (+ts[1]) / 90000 - (lc ? (hboClock(lc[1]) || 0) : 0);
        }
        return { cues: parseVtt(s), map: map };
    }
    function hboParseSeg(txt) {
        var s = String(txt || '').replace(/^\uFEFF/, '');
        if (!s.trim()) return null;
        if (/^WEBVTT/.test(s.trim()) || s.indexOf('-->') >= 0) return hboVtt(s);
        if (/<(?:[a-z]+:)?tt\b/i.test(s) || /<(?:[a-z]+:)?p\b/i.test(s)) return { cues: parseTtml(s), map: 0 };
        return null;
    }

    async function hboGet(url) {
        try { var r = await origFetch.call(window, url, { credentials: 'include' }); return await r.text(); } catch (e) { return ''; }
    }

    // Pobiera wszystkie kawałki jednej ścieżki (4 równolegle) i skleja w cały plik.
    async function hboFetchList(segs, useMap) {
        var parts = new Array(segs.length), next = 0, bad = 0, empty = 0;
        async function worker() {
            while (next < segs.length) {
                var i = next++;
                try {
                    var got = hboParseSeg(await hboGet(segs[i].url));
                    if (!got || !got.cues.length) { empty++; continue; }
                    var off = (useMap && got.map) ? got.map : (+segs[i].shift || 0);
                    parts[i] = got.cues.map(function (c) {
                        return { start: c.start + off, end: Math.max(c.end + off, c.start + off + 0.1), text: c.text, segs: null };
                    });
                } catch (e) { bad++; }
            }
        }
        await Promise.all([worker(), worker(), worker(), worker()]);
        var all = [], seen = new Set();
        parts.forEach(function (list) {
            (list || []).forEach(function (c) {
                var k = Math.round(c.start * 10) + '|' + c.text;
                if (seen.has(k)) return;
                seen.add(k);
                all.push(c);
            });
        });
        all.sort(function (a, b) { return a.start - b.start; });
        if (bad || empty) hboNote('kawałki: ' + segs.length + ', puste: ' + empty + ', błędy: ' + bad);
        return all;
    }

    // HLS: osobne ścieżki napisów z playlisty głównej + playlisty z kawałkami .vtt
    function hboHlsSubs(text) {
        var out = [];
        String(text || '').replace(/\r/g, '').split('\n').forEach(function (l) {
            if (l.indexOf('#EXT-X-MEDIA:') !== 0) return;
            var a = l.slice('#EXT-X-MEDIA:'.length);
            if (!/TYPE=SUBTITLES/i.test(a)) return;
            var uri = hboAttr(a, 'URI');
            if (!uri) return;
            out.push({ lang: String(hboAttr(a, 'LANGUAGE') || '').toLowerCase(), name: hboAttr(a, 'NAME') || '', uri: uri });
        });
        return out;
    }
    function hboHlsSegs(text, base) {   // playlisty z kawałkami: #EXTINF + adres
        var segs = [], dur = 0, t = 0, lines = String(text || '').replace(/\r/g, '').split('\n');
        for (var i = 0; i < lines.length && segs.length < 2000; i++) {
            var l = lines[i].trim();
            if (!l) continue;
            if (l.indexOf('#EXTINF:') === 0) { dur = parseFloat(l.slice(8)) || 0; continue; }
            if (l.charAt(0) === '#') continue;
            segs.push({ url: hboAbs(l, base), shift: t });   // brak mapy: czas z długości kawałków
            t += dur; dur = 0;
        }
        return segs;
    }

    // Zwraca true, gdy lista została przyjęta (potrzebne, by `hboFromManifest` nie blokował szukania po odrzuceniu).
    function hboAccept(list, lang, role, segCount, source) {
        if (!list || list.length < 5) return false;
        var frag = (source === 'kawałki odtwarzacza' || source === 'ścieżka odtwarzacza');
        var vid = currentVid();
        var have = cuesByVid.get(vid) || [];
        // [AGENT-EXP] 2026-11-14: o „całym pliku” decyduje POKRYCIE CZASU, nie liczba kwestii (patrz betterThanCues).
        // Wcześniej gęsty kawałek środka filmu (500 kwestii z 20 min) blokował rzadszy plik całości (400 kwestii
        // z 60 min) → cenzor milczał na początku i włączał się dopiero w środku.
        if (have.length && !betterThanCues(list, have)) {
            hboNote((lang || '?') + ': ' + list.length + ' kwestii nie pokrywa więcej niż to, co już mam ('
                + have.length + ') — zostawiam');
            return false;
        }
        cuesByVid.delete(vid);
        cuesByVid.set(vid, list);
        while (cuesByVid.size > 20) cuesByVid.delete(cuesByVid.keys().next().value);
        hboBest = list.length;
        lastTrackInfo = 'HBO Max: ' + source + ' — cały plik ' + (lang || '?')
            + (role && role !== 'subtitle' ? ' (' + role + ')' : '') + ', ' + list.length + ' kwestii'
            + (segCount ? ' z ' + segCount + ' części' : '');
        hboNote((lang || '?') + (role ? '/' + role : '') + ': ' + list.length + ' kwestii' + (segCount ? ' z ' + segCount + ' części' : '') + ' (' + source + ')'
            + (frag ? '' : ', pokrycie ' + fmtSec(list[0].start) + '–' + fmtSec(list[list.length - 1].end)));
        useCuesFor(vid);
        hboSendToLektor(list, lang, vid);
        return true;
    }
    function fmtSec(t) {
        var s = Math.max(0, Math.round(+t || 0));
        return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
    }

    async function hboProcess(url, text) {
        var s = String(text || ''), key = String(url || '');
        if (hboFromManifest || hboProcessed.has(key)) return;
        var kind = /^\s*#EXTM3U/.test(s) ? 'hls' : (s.indexOf('<MPD') >= 0 ? 'mpd' : '');
        if (!kind) return;
        hboProcessed.add(key);
        if (kind === 'mpd') hboMpd = { url: String(url || location.href), text: s };
        hboManifests.push({ url: String(url || ''), kind: kind });
        if (hboManifests.length > 8) hboManifests.shift();
        hboNote('manifest ' + kind + ': ' + String(url || '').split('?')[0]);
        if (kind === 'mpd') {
            var tracks = hboOrder(hboMpdTracks(s, url));
            if (!tracks.length) { hboNote('brak ścieżek napisów w manifeście'); return; }
            hboNote('ścieżki: ' + tracks.map(function (t) { return (t.lang || '?') + '/' + t.role + (t.mp4 ? '(mp4)' : '·' + t.segs.length); }).join(', '));
            for (var i = 0; i < tracks.length && !hboFromManifest; i++) {
                var tr = tracks[i];
                if (tr.mp4) { hboNote('napisy ' + (tr.lang || '?') + ' są w MP4 (stpp) — pomijam'); continue; }
                var list = await hboFetchList(tr.segs, false);
                if (list.length >= 5) {
                    // [AGENT-EXP] 2026-11-14: dopiero PRZYJĘTY plik kończy szukanie (wcześniej odrzucony też blokował)
                    if (hboAccept(list, tr.lang, tr.role, tr.segs.length, 'DASH')) hboFromManifest = list.length;
                } else hboNote('ścieżka ' + (tr.lang || '?') + '/' + tr.role + ': 0 kwestii');
            }
            return;
        }
        var subs = hboHlsSubs(s);
        if (!subs.length) { hboNote('HLS: brak osobnej ścieżki napisów'); return; }
        subs = subs.map(function (x) { return { lang: x.lang, role: 'subtitle', uri: x.uri }; });
        subs.sort(function (a, b) { return hboRank(a) - hboRank(b); });
        for (var k = 0; k < subs.length && !hboFromManifest; k++) {
            var mediaUrl = hboAbs(subs[k].uri, url);
            var mtxt = await hboGet(mediaUrl);
            if (mtxt.indexOf('#EXTM3U') < 0) continue;
            var segs = hboHlsSegs(mtxt, mediaUrl);
            if (!segs.length) continue;
            var l2 = await hboFetchList(segs, true);
            if (l2.length >= 5 && hboAccept(l2, subs[k].lang, 'subtitle', segs.length, 'HLS')) { hboFromManifest = l2.length; return; }
        }
    }

    function hboOnManifest(url, text) {
        if (!IS_HBO) return;
        hboProcess(url, text).catch(function (e) { hboNote('błąd: ' + ((e && e.message) || e)); });
    }

    // Jedna odpowiedź sieci: manifest / cały plik napisów / kawałek (zapas: składamy z kawałków odtwarzacza).
    function hboOnResponse(url, text) {
        if (!IS_HBO || !text) return;
        var s = String(text);
        if (s.indexOf('<MPD') >= 0 || /^\s*#EXTM3U/.test(s)) { hboOnManifest(url, s); return; }
        if (hboFromManifest || !hboIsSubFile(url)) return;
        var got = hboParseSeg(s);
        if (!got || got.cues.length < 5) return;
        var span = got.cues[got.cues.length - 1].end - got.cues[0].start;
        if (span >= 120) {   // cały plik jednym adresem
            hboAccept(hboMerge([{ cues: got.cues, shift: got.map || 0 }]), '', 'subtitle', 0, 'plik');
            return;
        }
        // [AGENT-EXP] 2026-11-06: kawałek napisów pobrany przez odtwarzacz — składamy z takich kawałków cały film
        // (działa też wtedy, gdy manifestu nie da się odczytać; wymaga włączonych napisów w odtwarzaczu).
        var u = String(url || '');
        if (hboParts.some(function (p) { return p.url === u; })) return;
        hboParts.push({ url: u, cues: got.cues, map: got.map || 0 });
        if (hboParts.length > 400) hboParts.shift();
        var all = [];
        hboParts.forEach(function (p) { p.cues.forEach(function (c) { all.push(c); }); });
        if (all.length < 5) return;
        hboAccept(hboMerge(hboParts.map(function (p) { return { cues: p.cues, shift: p.map }; })), '', 'subtitle', hboParts.length, 'kawałki odtwarzacza');
    }

    // [AGENT-EXP] 2026-10-25: całe napisy HBO idą też do LEKTORA (cenzor_bridge.js → LOWCA_AUTO_CUES z full: true).
    // Łowca łapie tylko części, które odtwarzacz już pobrał (bufor ~15 min), i potem lektor stał. Pełny plik ma
    // pierwszeństwo przed kawałkami Łowcy; polskie napisy lektor czyta bez tłumaczenia, inne tłumaczy od razu w całości.
    // Wysyłamy 4× (od razu, po 5 s, 20 s i 60 s) — lektor mógł jeszcze nie słuchać; powtórka bez zmian nic nie robi.
    // [AGENT-EXP] 2026-11-06: etykieta idzie do paska lektora („czytam z: HBO Max — cały plik”).
    function hboSendToLektor(list, lang, vid, label, kind) {
        var payload = {
            __lektorCenzor: kind || 'hboFull', lang: lang || '', label: label || 'HBO Max — cały plik',
            cues: list.map(function (c) { return [Math.round(c.start * 1000), Math.round(c.end * 1000), c.text]; })
        };
        try { console.log('[Lektor Cenzor] cały plik do lektora — ' + list.length + ' kwestii [' + (lang || '?') + '] ' + (label || '')); } catch (e) {}
        [0, 5000, 20000, 60000].forEach(function (ms) {
            setTimeout(function () {
                if (vid !== currentVid()) return;
                try { window.postMessage(payload, location.origin); } catch (e) {}
            }, ms);
        });
    }

    // Ścieżki <track> odtwarzacza: cues są już w pamięci przeglądarki (ostatnia deska ratunku).
    function hboFromTextTracks() {
        var v = mainVideo();
        if (!v || !v.textTracks) return;
        var tt = v.textTracks, best = [];
        for (var i = 0; i < tt.length; i++) {
            var tr = tt[i];
            if (!tr || tr.mode === 'disabled' || !tr.cues || !tr.cues.length) continue;
            // [AGENT-EXP] 2026-11-14: odrzucamy tylko ścieżkę, która nie pokrywa więcej filmu (sama liczba kwestii
            // myliła: kawałek środka bywa gęstszy niż cały plik)
            if (hboBest && tr.cues.length <= hboBest
                && (tr.cues[tr.cues.length - 1].endTime - tr.cues[0].startTime) <= spanOf(cuesByVid.get(currentVid()) || []) * 0.95) continue;
            var one = [];
            for (var k = 0; k < tr.cues.length; k++) {
                var c = tr.cues[k], tx = String(c.text || '').replace(/\s+/g, ' ').trim();
                if (!tx || !(c.endTime > c.startTime)) continue;
                one.push({ start: c.startTime, end: c.endTime, text: tx, segs: null });
            }
            if (one.length > best.length) best = one;
        }
        if (best.length >= 5) hboAccept(best, '', 'subtitle', 0, 'ścieżka odtwarzacza');
    }

    // Manifest pobrany przez workera / zanim podmieniliśmy fetch: bierzemy adres z performance i pobieramy sami.
    function hboScanPerf() {
        if (hboFromManifest) return;
        var es = [];
        try { es = performance.getEntriesByType('resource') || []; } catch (e) { return; }
        for (var i = 0; i < es.length && hboAttempts < 15; i++) {
            var u = String(es[i] && es[i].name || '');
            if (!u || hboSeen.has(u) || !hboIsManifestUrl(u)) continue;
            hboSeen.add(u); hboAttempts++;
            (function (addr) {
                hboGet(addr).then(function (t) {
                    if (t && (t.indexOf('<MPD') >= 0 || /^\s*#EXTM3U/.test(t))) hboOnManifest(addr, t);
                }).catch(function () {});
            })(u);
        }
    }

    function hboMaybeFetch() {
        if (!IS_HBO || hboFromManifest) return;
        if (!mainVideo()) return;   // [AGENT-EXP] 2026-11-06: napisy pobiera tylko ramka z filmem (nie każda ramka strony)
        var now = Date.now();
        if (now - hboLastScan < 1000) return;
        hboLastScan = now;
        if (hboPending.length) {
            var pending = hboPending.slice(0, 4);
            hboPending = hboPending.slice(4);
            pending.forEach(function (u) {
                hboGet(u).then(function (t) { if (t) hboOnResponse(u, t); }).catch(function () {});
            });
        }
        hboFromTextTracks();
        if (hboFromManifest || now - hboLastTry < 3000 || hboAttempts >= 15) return;
        hboLastTry = now;
        hboScanPerf();
    }

    // Zgodność: stara nazwa (manifest MPD z sieci)
    function hboOnMpd(url, text) { hboOnManifest(url, text); }

    // Nowy film/odcinek (zmiana adresu) — trzeba znowu szukać napisów. Adresy manifestów zostają,
    // żeby nie pobierać drugi raz tego samego.
    function hboReset() {
        hboBest = 0; hboFromManifest = 0; hboManifests = []; hboAttempts = 0; hboLastScan = 0; hboLastTry = 0; hboPending = []; hboParts = [];
    }

    if (IS_HBO) {
        // [AGENT-EXP] 2026-11-06: adres manifestu od tła (webRequest) — dotyczy też fetchtów z workera odtwarzacza
        window.addEventListener('message', function (ev) {
            if (ev.source !== window || ev.origin !== location.origin) return;
            var d = ev.data;
            if (!d || d.__lektorCenzor !== 'hboUrl' || !d.url) return;
            var u = String(d.url);
            if (hboSeen.has(u)) return;
            hboSeen.add(u);
            hboPending.push(u);   // pobierzemy, gdy ramka będzie miała film (hboMaybeFetch)
        });
        try {
            window.fetch = function (input) {
                var p = origFetch.apply(this, arguments);
                try {
                    var url = (input && typeof input === 'object' && 'url' in input) ? input.url : String(input);
                    p.then(function (res) {
                        try {
                            if (hboFromManifest) return;   // mamy już cały plik — nie kopiujemy odpowiedzi
                            var ct = String((res.headers && res.headers.get && res.headers.get('content-type')) || '').toLowerCase();
                            // [AGENT-EXP] 2026-11-06: manifest po samym typie odpowiedzi (HBO nie zawsze ma .mpd w adresie)
                            if (hboIsManifestUrl(url) || hboIsSubFile(url) || /dash\+xml|mpegurl|vnd\.apple/.test(ct)) {
                                res.clone().text().then(function (t) { hboOnResponse(res.url || url, t); }).catch(function () {});
                            }
                        } catch (e) {}
                    }).catch(function () {});
                } catch (e) {}
                return p;
            };
        } catch (e) {}
        try {
            var HXP = XMLHttpRequest.prototype, hOpen = HXP.open, hSend = HXP.send;
            HXP.open = function (m, url) { try { this.__czUrl = String(url); } catch (e) {} return hOpen.apply(this, arguments); };
            HXP.send = function () {
                try {
                    if (hboIsManifestUrl(this.__czUrl) || hboIsSubFile(this.__czUrl)) {
                        var x = this;
                        x.addEventListener('load', function () {
                            try {
                                if (hboFromManifest) return;   // mamy już cały plik
                                var rt = x.responseType, body;
                                var ct = '';
                                try { ct = String(x.getResponseHeader('content-type') || '').toLowerCase(); } catch (e) {}
                                if (/dash\+xml|mpegurl|vnd\.apple/.test(ct) && (!rt || rt === 'text')) { hboOnResponse(x.responseURL || x.__czUrl, x.responseText); return; }
                                if (!rt || rt === 'text') body = x.responseText;
                                else if (rt === 'arraybuffer') body = new TextDecoder().decode(x.response);
                                else if (rt === 'document' && x.response) body = new XMLSerializer().serializeToString(x.response);
                                else return;
                                hboOnResponse(x.responseURL || x.__czUrl, body);
                            } catch (e) {}
                        });
                    }
                } catch (e) {}
                return hSend.apply(this, arguments);
            };
        } catch (e) {}
    }

    // Samodzielne pobranie (metoda z yt_subs_bridge.js → getRaw), gdy ani odtwarzacz, ani lektor
    // nie pobrały napisów. Czekamy dłużej niż w userscripcie, żeby nie przełączać ścieżki
    // równocześnie z lektorem.
    var autoTried = new Set(), autoBusy = false, vidSince = 0;
    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

    function playerResponse() {
        try {
            var p = document.getElementById('movie_player');
            return (p && p.getPlayerResponse && p.getPlayerResponse()) || window.ytInitialPlayerResponse || null;
        } catch (e) { return null; }
    }

    // [AGENT-EXP] 2026-10-19: przy cenzorYtPl — polskie ręczne → polskie auto → ścieżka filmu przetłumaczona
    // przez YouTube na polski (tlang=pl, jak „Automatyczne tłumaczenie” w odtwarzaczu). Zwraca { track, tlang }.
    function pickTrackPl(tracks, audioLang) {
        var pl = tracks.filter(function (t) { return isPl(t.languageCode); });
        var man = pl.filter(function (t) { return t.kind !== 'asr'; })[0];
        if (man || pl[0]) return { track: man || pl[0], tlang: '' };
        var base = pickTrack(tracks, audioLang);
        if (!base) return null;
        return { track: base, tlang: base.isTranslatable === false ? '' : 'pl' };
    }

    function pickTrack(tracks, audioLang) {
        var lang = String(audioLang || '').toLowerCase().split('-')[0];
        var is = function (t, l) { return String(t.languageCode || '').toLowerCase().split('-')[0] === l; };
        var langs = [lang, 'pl', 'en'].filter(Boolean);
        for (var i = 0; i < langs.length; i++) {
            var l = langs[i], hit = tracks.filter(function (t) { return is(t, l); });
            var man = hit.filter(function (t) { return t.kind !== 'asr'; })[0];
            if (man || hit[0]) return man || hit[0];
        }
        return tracks.filter(function (t) { return t.kind !== 'asr'; })[0] || tracks[0] || null;
    }

    async function autoLoad(vid) {
        autoTried.add(vid); autoBusy = true;
        try {
            var pr = playerResponse();
            if (!pr || !pr.videoDetails || pr.videoDetails.videoId !== vid) { autoTried.delete(vid); return; }
            var r = pr.captions && pr.captions.playerCaptionsTracklistRenderer;
            var tracks = (r && r.captionTracks) || [];
            if (!tracks.length) return;
            var mf = pr.microformat && pr.microformat.playerMicroformatRenderer;
            var aLang = (mf && mf.defaultAudioLanguage) || pr.videoDetails.defaultAudioLanguage;
            var sel = opt.cenzorYtPl ? pickTrackPl(tracks, aLang) : { track: pickTrack(tracks, aLang), tlang: '' };
            var track = sel && sel.track;
            if (!track) return;
            // przy cenzorYtPl czekamy na POLSKIE napisy (te z odtwarzacza w innym języku się nie liczą)
            var wantPl = opt.cenzorYtPl && (sel.tlang === 'pl' || isPl(track.languageCode));
            var got = wantPl ? function () { return isPl(ytLang.get(vid)); } : function () { return cuesByVid.has(vid); };
            try {
                var u = new URL(track.baseUrl, location.origin);
                u.searchParams.set('fmt', 'json3');
                if (sel.tlang) u.searchParams.set('tlang', sel.tlang);
                var t = await (await origFetch.call(window, u.toString(), { credentials: 'include' })).text();
                if (t && t.trim()) onTimedtext(u.toString(), t);
            } catch (e) {}
            if (got()) return;
            var player = document.getElementById('movie_player');
            if (!player || typeof player.setOption !== 'function') return;
            var prev = null;
            try { prev = player.getOption && player.getOption('captions', 'track'); } catch (e) {}
            try {
                if (player.loadModule) player.loadModule('captions');
                await sleep(300);
                var list = (player.getOption && player.getOption('captions', 'tracklist')) || [];
                var target = list.filter(function (x) { return x.languageCode === track.languageCode && (x.kind || '') === (track.kind || ''); })[0]
                    || { languageCode: track.languageCode };
                if (sel.tlang) target = Object.assign({}, target, { translationLanguage: { languageCode: sel.tlang, languageName: 'Polski' } });
                player.setOption('captions', 'track', target);
            } catch (e) {}
            for (var i = 0; i < 30 && !got(); i++) await sleep(200);
            try {
                if (prev && prev.languageCode) player.setOption('captions', 'track', prev);
                else if (player.unloadModule) player.unloadModule('captions');
            } catch (e) {}
        } finally { autoBusy = false; }
    }

    // [FIX] Prime Video: pobieranie całych napisów (cenzorOn) — skanuje kontener .atvwebplayersdk-captions-text
    // i inne selektory napisów PV, dodaje je do cuesByVid tak jak onTimedtext robi to dla YouTube.
    function pvMaybeFetch() {
        if (!IS_PV || !opt.cenzorOn || autoBusy || !curVid) return;
        if (cueMode || cuesByVid.has(curVid)) return;
        if (autoTried.has(curVid)) return;
        autoTried.add(curVid); autoBusy = true;
        setTimeout(function () { autoBusy = false; }, 800);
        var v = mainVideo();
        if (!v) return;
        var t = v.currentTime;
        var parts = readSels(['.atvwebplayersdk-captions-text', '.avp-captions', '.prime-captions'], null);
        var flat = flatOf(parts);
        if (flat && flat.trim()) {
            var list = [];
            list.push({ text: flat, start: t, end: t + 3 });
            cuesByVid.set(curVid, list);
            useCuesFor(curVid);
        }
    }

    function maybeAutoLoad() {
        if (!opt.cenzorOn || autoBusy || !curVid || isShorts() || isAd()) return;
        if (cueMode && (!opt.cenzorYtPl || isPl(ytLang.get(curVid)))) return;   // napisy już są (przy cenzorYtPl: polskie)
        if (IS_YT) {
            if (autoTried.has(curVid) || Date.now() - vidSince < 4000) return;
            autoLoad(curVid).catch(function () { autoBusy = false; });
        } else if (IS_PV) {
            pvMaybeFetch();
        }
    }

    /* ---------------- lista słów ---------------- */

    var DIGRAPH_RE = /dzi(?=[aąeęioóuy])|dż|dź|dz|sz|cz|rz|ch/g;
    var VOWEL_RE = /[aąeęioóuy]/;
    var PUNCT_RE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
    var ASR_TAG_RE = /\[\s*_{2,}\s*\]/g;
    // [FIX 2026-11-02] rozpoznawanie słów = wspólny silnik cenzora (assets/censor.js → window.__lektorCensor)
    var wordRegex = null;      // tu: „silnik ustawiony dla bieżących własnych słów” (nazwa zostaje dla zgodności)
    var wordsApplied = null;
    function engine() { return window.__lektorCensor || null; }
    function buildRegex() {
        var e = engine();
        if (!e) { wordRegex = null; return; }
        if (wordsApplied !== opt.words) { e.applySettings({ censorCustomWords: opt.words }); wordsApplied = opt.words; }
        wordRegex = true;
    }

    // [FIX 2026-11-21] Frazy z listy („po chuja”, „w chuj”, „fuck you”, „son of a bitch”) wyciszały też słowa
    // neutralne („po”, „you”, „son of a”). Do ciszy w filmie zawężamy frazę do słów, które same są przekleństwem
    // (ten sam silnik, bez drugiej listy). Gdy żadne słowo osobno nie pasuje — zostaje cała fraza.
    function narrowPhrase(m) {
        if (!/\s/.test(m.word)) return [m];
        var e = engine(), out = [], re = /\S+/g, t;
        if (!e || !e.findMatches) return [m];
        while ((t = re.exec(m.word))) {
            e.findMatches(t[0]).forEach(function (s) {
                out.push({ word: s.word, index: m.index + t.index + s.index });
            });
        }
        return out.length ? out : [m];
    }

    function findMatches(flat) {
        var out = [], m, e = engine();
        if (e && e.findMatches) {
            if (!wordRegex || wordsApplied !== opt.words) buildRegex();
            e.findMatches(flat).forEach(function (x) { narrowPhrase(x).forEach(function (y) { out.push(y); }); });
        }
        if (opt.cenzorAsrTag) {
            ASR_TAG_RE.lastIndex = 0;
            while ((m = ASR_TAG_RE.exec(flat))) out.push({ word: m[0], index: m.index });
        }
        return out.sort(function (a, b) { return a.index - b.index; });
    }

    /* ---------------- model czasu słowa (z Netflix Cenzor 4.5.2) ---------------- */

    function estimateWeight(w) {
        if (!w) return 0.4;
        var c = w.replace(DIGRAPH_RE, '#'), weight = 0;
        for (var i = 0; i < c.length; i++) {
            var ch = c[i], prev = c[i - 1] || '', next = c[i + 1] || '';
            if (ch === '#') weight += 0.8;
            else if (ch === 'i' && VOWEL_RE.test(next)) weight += (prev && !VOWEL_RE.test(prev)) ? 0 : 0.8;
            else if (VOWEL_RE.test(ch)) weight += 1.4;
            else weight += 0.8;
        }
        return Math.max(weight, 1.0);
    }
    function cleanW(w) { return String(w).toLowerCase().replace(PUNCT_RE, ''); }
    // [FIX 2026-11-21] waga pauzy po słowie (te same jednostki co estimateWeight; „kurwa” ≈ 5,2)
    function punctPauseWeight(w) {
        var m = String(w).match(/([,;:.!?…]+)["'»)\]]*$/);
        if (!m) return 0;
        var r = m[1];
        // [FIX 2026-11-21] wagi dobrane na 12,5 tys. słów z czasami (audiobook 1,5×): kropka 6 zamiast 8.
        // Krótkich słów („i”, „w”, „z”) celowo NIE skracamy: test pokazał, że niższa waga pogarsza celowanie.
        if (/…|\.{2,}/.test(r)) return 6;
        if (/[.!?]/.test(r)) return 6;
        return 4.5;   // , ; :
    }

    function calculateWordTimings(text, startTime, endTime) {
        text = String(text || '').trim();
        if (!text || !(endTime > startTime)) return [];
        // [FIX 2026-11-21] Pauzy z interpunkcji (z modelu PMT, model.json: przecinek ok. +190 ms, kropka/?/! ok. +330 ms
        // przy słowie ok. 200 ms) dostają własną wagę PO słowie, a tokeny bez liter (myślnik dialogowy „-”) nie zabierają
        // czasu. Wcześniej cały czas kwestii szedł proporcjonalnie na litery, więc słowa z drugiej połowy dłuższej
        // kwestii wypadały nawet 0,4 s za późno. Liczba tokenów zostaje ta sama (wordSpan liczy po spacjach).
        var words = text.split(/\s+/).map(function (w) {
            var core = cleanW(w);
            if (!/[\p{L}\p{N}]/u.test(w)) return { word: w, weight: 0, pause: 0 };
            return { word: w, weight: estimateWeight(core), pause: punctPauseWeight(w) };
        });
        var last = words.length - 1;
        while (last >= 0 && !words[last].weight) last--;
        // pauza po OSTATNIM słowie też się liczy (jak w modelu): napis zwykle wisi chwilę po końcu mowy,
        // więc ten „ogon” ściąga wcześniejsze słowa bliżej początku; ostatnie słowo i tak kończy się z kwestią.
        var total = words.reduce(function (s, w) { return s + w.weight + w.pause; }, 0);
        if (!(total > 0)) total = 1;
        var dur = endTime - startTime, acc = 0;
        var out = words.map(function (it) {
            var st = startTime + (acc / total) * dur;
            acc += it.weight;
            var en = startTime + (acc / total) * dur;
            acc += it.pause;
            return { word: it.word, start: st, end: en };
        });
        if (last >= 0) out[last].end = endTime;
        return out;
    }

    // Zakres słów [first, last] obejmujący trafienie (wg podziału po spacjach).
    function wordSpan(text, match) {
        var toks = String(text).trim().split(/\s+/), pos = 0, first = -1, last = -1;
        var mEnd = match.index + Math.max(1, match.word.length) - 1;
        var t = String(text);
        for (var i = 0; i < toks.length; i++) {
            while (pos < t.length && /\s/.test(t[pos])) pos++;
            var s = pos, e = s + toks[i].length;
            if (first < 0 && match.index < e) first = i;
            if (first >= 0 && s <= mEnd) last = i;
            if (s > mEnd) break;
            pos = e;
        }
        return { first: first, last: last };
    }

    // [FIX 2026-11-21] Sąsiednie słowa: krótki bleed tylko wewnątrz realnej luki,
    // żeby cisza nie zaczynała się ani nie kończyła nagle na początku/koncu fonemu.
    // 60 ms jest limitem, a połowa luki zapobiega przejściu okna na sąsiednie słowo.
    function neighborBleed(from, to, prevEnd, nextStart) {
        var startBleed = 0, endBleed = 0;
        if (Number.isFinite(prevEnd)) {
            var gapBefore = Math.max(0, from - prevEnd);
            startBleed = Math.min(0.06, gapBefore * 0.5);
        }
        if (Number.isFinite(nextStart)) {
            var gapAfter = Math.max(0, nextStart - to);
            endBleed = Math.min(0.06, gapAfter * 0.5);
        }
        return {
            from: Math.max(0, from - startBleed),
            to: Math.max(from, to + endBleed)
        };
    }

    var LEN_FACTOR = { off: 0, normal: 1, strong: 2 };
    function extraHold(word) {
        var f = LEN_FACTOR[opt.cenzorLenMode];
        var letters = String(word).replace(/[^\p{L}\p{N}]/gu, '').length;
        return f ? Math.max(0, (letters - 4) * 90 * f) : 0;
    }
    function asrWordDuration(word) { return Math.max(0.35, estimateWeight(cleanW(word)) * 0.09); }

    // [FIX 2026-11-21] „NAPIS WISI DŁUŻEJ NIŻ MOWA”. W filmach napis zostaje często 0,5–1,5 s po końcu mowy, a legacy
    // rozkłada słowa na CAŁĄ kwestię → przekleństwo wypada za późno (symulacja na 12,5 tys. słów z czasami:
    // przeciek 9,6% → 43,7%). Gdy kwestia jest wyraźnie za długa na swój tekst, liczymy też drugie położenie:
    // słowa od początku kwestii w normalnym tempie mowy, a cisza obejmuje OBA (przeciek 43,7% → 18,7%;
    // bez ogona 9,6% → 8,7%). Tempo bierzemy z wczytanego pliku: P20 „sekund na jednostkę tekstu” to kwestie
    // prawie bez ogona; z danych: tempo mowy = P20 × 1,11, próg „za długa” = P20 × 1,30.
    var TAIL_P20_DEF = 0.0636;   // s materiału (1,0×) na jednostkę wagi — P20 z danych (audiobook)
    var tailP20 = TAIL_P20_DEF, tailCalibN = 0;
    function cueUnits(text) {   // te same wagi co calculateWordTimings (słowa + pauzy z interpunkcji)
        var u = 0;
        String(text || '').trim().split(/\s+/).forEach(function (w) {
            if (!/[\p{L}\p{N}]/u.test(w)) return;
            u += estimateWeight(cleanW(w)) + punctPauseWeight(w);
        });
        return u;
    }
    function calibrateTail() {
        var r = [];
        cues.forEach(function (c) {
            if (c.segs && c.segs.length) return;
            var t = String(c.text || '');
            if (t.split(/\s+/).length < 3) return;
            var u = cueUnits(t), d = c.end - c.start;
            if (u > 0 && d > 0) r.push(d / u);
        });
        tailCalibN = r.length;
        if (r.length < 30) { tailP20 = TAIL_P20_DEF; return; }
        r.sort(function (a, b) { return a - b; });
        // Górny limit 0,066 (ok. +4% ponad dane): gdy WSZYSTKIE kwestie mają ogon, P20 też go ma i bez limitu
        // dostrajanie „uczyło się” zbyt wolnej mowy (test: przeciek 39% przy 0,080 → 23% przy 0,066).
        tailP20 = Math.min(0.066, Math.max(0.050, r[Math.floor(r.length * 0.2)]));
    }
    // Drugie położenie słowa (od początku kwestii, normalne tempo) — albo null, gdy kwestia nie jest „za długa”.
    function tailAltTimes(cue, sp) {
        if (!opt.cenzorTailFix) return null;
        var u = cueUnits(cue.text), d = cue.end - cue.start;
        if (!(u > 0) || d <= u * tailP20 * 1.30) return null;
        var tm2 = calculateWordTimings(cue.text, cue.start, cue.start + u * tailP20 * 1.11);
        if (!tm2.length || !tm2[sp.first] || !tm2[sp.last]) return null;
        return { from: tm2[sp.first].start, to: Math.max(tm2[sp.last].end, tm2[sp.first].start + 0.15) };
    }

    // [FIX 2026-11-21] Tempo, na którym trenowano model PMT (model.json: meta.speed / timeline.rate = 1,5×).
    // Czasy z pobranego pliku są czasami FILMU, więc model zawsze dostaje SWOJE tempo i oś pliku — nie
    // video.playbackRate. Wcześniej przy 1,0× skala modelu wybijała w limit 1,35 i okno przesuwało się o ~0,4 s.
    function pmtRate(pmt) {
        var r = pmt && pmt.MODEL && pmt.MODEL.timeline && Number(pmt.MODEL.timeline.rate);
        return r > 0 ? r : 1.5;
    }
    // Tokeny kwestii z pozycją znaków, odfiltrowane tak samo jak w PMT (stripPunctuation) → indeks = indeks w layout.
    function pmtTokens(pmt, text) {
        var toks = [], re = /\S+/g, m;
        while ((m = re.exec(text))) if (pmt.stripPunctuation(m[0])) toks.push({ text: m[0], s: m.index, e: m.index + m[0].length });
        return toks;
    }
    var pmtLayoutCache = new WeakMap();   // kwestia → { text, toks, layout } (układ nie zależy od suwaków)
    function pmtLayoutOf(pmt, cue) {
        var text = String(cue.text || ''), hit = pmtLayoutCache.get(cue);
        if (hit && hit.text === text && hit.s === cue.start && hit.e === cue.end) return hit;
        var toks = pmtTokens(pmt, text), layout = [];
        if (toks.length) {
            layout = pmt.computeCueMuteWindows(toks.map(function (t) { return { text: t.text, isProfanity: false }; }),
                cue.start * 1000, cue.end * 1000, { rate: pmtRate(pmt), axis: 'file_1.0x' }).layout || [];
        }
        hit = { text: text, s: cue.start, e: cue.end, toks: toks, layout: layout };
        pmtLayoutCache.set(cue, hit);
        return hit;
    }
    // Model PMT jako model POŁOŻENIA słowa: zwraca from/to (sekundy filmu) jak wordTimesInCue; okno ciszy
    // (Wstecz/Przód, Długość słowa) buduje dalej planFromCues() — PMT nie zastępuje głównego mechanizmu.
    function pmtWordTimes(cue, match) {
        var pmt = window.PMT_MUTE_TIMER;
        if (!pmt || !pmt.computeCueMuteWindows || !pmt.stripPunctuation) return null;
        var lay = pmtLayoutOf(pmt, cue), toks = lay.toks, L = lay.layout;
        if (!toks.length || L.length !== toks.length) return null;
        var mEnd = match.index + Math.max(1, String(match.word || '').length), first = -1, last = -1;
        for (var i = 0; i < toks.length; i++) if (toks[i].s < mEnd && toks[i].e > match.index) { if (first < 0) first = i; last = i; }
        if (first < 0) return null;
        var mr = pmtRate(pmt);
        var at = function (ms) { return cue.start + ms * mr / 1000; };
        var from = at(L[first].startRealMs), to = Math.max(at(L[last].endRealMs), from + 0.15);
        return neighborBleed(from, to, first > 0 ? at(L[first - 1].endRealMs) : NaN,
            last + 1 < L.length ? at(L[last + 1].startRealMs) : NaN);
    }

    function wordTimesInCue(cue, match) {
        var text = cue.text || '';
        var mEnd = match.index + Math.max(1, match.word.length) - 1;
        if (cue.segs && cue.segs.length) {   // auto-napisy: prawdziwe czasy słów
            var sg = cue.segs, i = 0;
            while (i + 1 < sg.length && sg[i + 1].off <= match.index) i++;
            var j = i;
            while (j + 1 < sg.length && sg[j + 1].off <= mEnd) j++;
            var from = sg[i].t;
            var to = j + 1 < sg.length ? sg[j + 1].t : Math.min(cue.end, sg[j].t + asrWordDuration(text.slice(sg[j].off)));
            var prevEnd = i > 0
                ? sg[i - 1].t + asrWordDuration(text.slice(sg[i - 1].off, sg[i].off))
                : NaN;
            var nextStart = j + 1 < sg.length ? sg[j + 1].t : NaN;
            var bleed = neighborBleed(from, Math.max(to, from + 0.15), prevEnd, nextStart);
            return bleed;
        }
        if (opt.cenzorTimingMode === 'pmtpos') {   // [FIX 2026-11-21] model PMT wyznacza miejsce słowa
            var pw = null;
            try { pw = pmtWordTimes(cue, match); } catch (e) { pw = null; }
            if (pw) return pw;   // brak PMT / wyjątek → zwykłe legacy niżej
        }
        var tm = calculateWordTimings(text, cue.start, cue.start + Math.max(0.1, cue.end - cue.start));
        var sp = wordSpan(text, match);
        if (!tm.length || sp.first < 0 || sp.last < 0) return null;
        var prevEnd = sp.first > 0 ? tm[sp.first - 1].end : NaN;
        var nextStart = sp.last + 1 < tm.length ? tm[sp.last + 1].start : NaN;
        var bleed = neighborBleed(tm[sp.first].start, Math.max(tm[sp.last].end, tm[sp.first].start + 0.15), prevEnd, nextStart);
        var alt = tailAltTimes(cue, sp);   // [FIX 2026-11-21] napis za długi na tekst → cisza obejmuje oba położenia
        if (alt) bleed = { from: Math.min(bleed.from, alt.from), to: Math.max(bleed.to, alt.to) };
        return bleed;
    }

    /* ---------------- planowanie okien ciszy ---------------- */

    var windows = [], plannedFor = -1;
    var covStart = 0, covEnd = 0;      // [AGENT-EXP] 2026-11-14: pokrycie filmu przez pobrane napisy (dokąd cisza „z góry”)
    var LIVE_WARMUP_SEC = 30;   // [FIX 2026-11-16] rozbieg live przed końcem pliku — tylko w trybie „hybrid” (opcja cenzorPriority)

    // ms czasu rzeczywistego → sekundy materiału (przy 1.5× okno w materiale musi być 1.5× dłuższe).
    // [AGENT-EXP] 2026-10-20: trzeci suwak z „Netflix Cenzor 4.6” — TEMPO TEKSTU. Auto = tempo filmu (jak dotąd);
    // ręcznie = suwak 0,25–2,5, niezależny od tempa filmu (mniej = krótsze okna ciszy, więcej = dłuższe).
    function textRate() {
        if (opt.cenzorTextAuto) return speedOf();
        var n = Number(opt.cenzorTextRate);
        return (!isFinite(n) || n <= 0) ? 1 : Math.min(2.5, Math.max(0.25, n));
    }
    function realMsToMaterial(ms) { return Math.max(0, ms) / 1000 * textRate(); }

    function pmtWordsInCue(cue) {
        var text = String(cue.text || '');
        var matches = findMatches(text);
        var words = [], pos = 0;
        text.split(/\s+/).forEach(function (raw) {
            if (!raw) return;
            var start = text.indexOf(raw, pos);
            var end = start + raw.length;
            if (start < 0) return;
            pos = end;
            var prof = matches.some(function (m) {
                var mEnd = m.index + Math.max(1, String(m.word || '').length);
                return m.index < end && mEnd > start;
            });
            words.push({ text: raw, isProfanity: prof });
        });
        return words;
    }

    // [FIX 2026-11-21] Okna ciszy krótsze niż ta przerwa sklejamy w jedno: inaczej między bliskimi przekleństwami
    // („kurwa mać, chuj”) przebijała sylaba (PMT ma do tego merge_gap_ms = 120 ms).
    var MERGE_GAP_SEC = 0.15;
    // Wstecz/Przód w ms materiału filmu. Mostek ustawia cenzorPrerollMs = Wstecz i cenzorPostrollMs = Przód,
    // więc liczy się suwak; większa z wartości zostaje tylko dla zgodności ze starymi zapisami/testami.
    // (Stara wersja: „buffer + preroll, gdy preroll > buffer, inaczej sam preroll” — była nieciągła.)
    function prerollSec() { return Math.max(opt.cenzorBufferMs, opt.cenzorPrerollMs || 0) / 1000; }
    function postrollSec() { return Math.max(opt.cenzorHoldMs, opt.cenzorPostrollMs || 0) / 1000; }

    function planFromCues() {
        if (!wordRegex) buildRegex();
        var out = [], pre = prerollSec(), post = postrollSec();
        var off = opt.subOffsetMs / 1000;   // [FIX 2026-11-21] przesunięcie napisów — to samo co u lektora (+ = później)
        calibrateTail();
        covStart = Infinity; covEnd = 0;
        cues.forEach(function (c) {
            if (c.start < covStart) covStart = c.start;
            if (c.end > covEnd) covEnd = c.end;
            var pmt = window.PMT_MUTE_TIMER;
            // [FIX 2026-11-21] tryb 'pmt': okna w całości z modelu. Prawdziwe czasy słów (segs, auto-napisy YouTube)
            // zawsze wygrywają z modelem, więc wtedy idziemy ścieżką słów niżej.
            if (opt.cenzorTimingMode === 'pmt' && !(c.segs && c.segs.length) && pmt && pmt.computeCueMuteWindows) {
                try {
                    var mr = pmtRate(pmt);
                    var result = pmt.computeCueMuteWindows(pmtWordsInCue(c), c.start * 1000, c.end * 1000, {
                        rate: mr,                    // tempo MODELU (czasy pliku = czasy filmu), nie video.playbackRate
                        axis: 'file_1.0x',           // pobrany plik ma jedną oś — bez zgadywania per kwestia
                        preroll_ms: pre * 1000 / mr, // model mnoży przez mr → wychodzi tyle samo ms co w legacy
                        postroll_ms: post * 1000 / mr,
                        // [FIX 2026-11-21] bez przycinania początku do „ciszy przed słowem + 60 ms”: nowy model wlicza
                        // pauzy do słowa, więc ta cisza wychodziła ~28 ms i początek przekleństwa przeciekał.
                        neighbor_aware: false
                    });
                    (result.windows || []).forEach(function (w) {
                        out.push({ start: Math.max(0, w.startMs / 1000), end: w.endMs / 1000 });
                    });
                    return;
                } catch (e) {
                    console.warn('[Lektor Cenzor] PMT: awaryjny powrót do starego planowania:', e);
                }
            }
            findMatches(c.text).forEach(function (m) {
                // [AGENT-EXP] 2026-10-19: zawsze TYLKO samo słowo (tryb „cała kwestia” usunięty na życzenie).
                var extra = realMsToMaterial(extraHold(m.word));
                var wt = wordTimesInCue(c, m);
                if (!wt) {   // awaryjnie: proporcja pozycji w tekście
                    var dur = Math.max(0.2, c.end - c.start), total = c.text.length || 1;
                    var f = c.start + (m.index / total) * dur;
                    wt = { from: f, to: f + Math.max(0.15, (m.word.length / total) * dur) };
                }
                out.push({ start: Math.max(0, wt.from - pre), end: wt.to + extra + post });
            });
        });
        if (off) out.forEach(function (w) { w.start = Math.max(0, w.start + off); w.end = Math.max(0, w.end + off); });
        out.sort(function (a, b) { return a.start - b.start; });
        windows = [];
        out.forEach(function (w) {
            var last = windows[windows.length - 1];
            if (last && w.start - last.end <= MERGE_GAP_SEC) last.end = Math.max(last.end, w.end);
            else windows.push(w);
        });
        plannedFor = cues.length;
        if (!isFinite(covStart)) covStart = 0;
        else if (off) { covStart = Math.max(0, covStart + off); covEnd = Math.max(0, covEnd + off); }
    }

    /* ---------------- 2) LIVE: napisy z ekranu ---------------- */

    var LIVE_SELECTORS = [
        '.ytp-caption-segment',
        '.player-timedtext-text-container',
        '.atvwebplayersdk-captions-text',        // Prime Video (Amazon Web Video Player SDK)
        '.dmp_SubtitleText', '.vjs-text-track-display', '.jw-text-track-cue', '.shaka-text-container',
        '[data-testid="cueBoxRowTextCue"]',      // [AGENT-EXP] 2026-10-25: HBO Max (każda linia napisu osobno)
        '.avp-captions', '.prime-captions',      // Prime Video (alternatywne selektory napisów)
        '.webvtt-cue', '.tt-cue',                // ogólne ścieżki tekstowe HTML5 (track)
        // [AGENT-EXP] 2026-11-15: własne odtwarzacze (nie z listy) — łapiemy po nazwie klasy/id.
        // Tanie w zapytaniu, a fałszywy alarm jest niemożliwy: tekst i tak musi trafić w listę słów.
        '[class*="subtitle" i]', '[class*="caption" i]', '[class*="cue" i]', '[class*="napis" i]',
        '[id*="subtitle" i]', '[id*="caption" i]', '[id*="cue" i]', '[id*="napis" i]',
        '[role="region"][aria-label*="caption"]', '[role="region"][aria-label*="subtitle"]'  // napisy ARIA
    ];
    // [AGENT-EXP] 2026-10-20: polskie tłumaczenie Immersive Translate (to samo co czyta lektor — dom_content.js,
    // youtube_content.js). Czytane OSOBNO od napisów strony: wcześniej brana była tylko pierwsza znaleziona grupa
    // (np. angielskie napisy Netflixa), więc polskiego przekleństwa z Immersive cenzor nie widział.
    var TR_SELECTORS = [
        '.imt-captions-text', '.imt-cue', '.immersive-translate-subtitle',
        '[data-immersive-translate-translation-element="target"]',
        '.immersive-translate-target-inner', '.immersive-translate-target-translation',
        '#immersive-translate-caption-window'   // [AGENT-EXP] 2026-11-14: okno napisów IT (na końcu — może mieć też oryginał)
    ];

    /* ---------------- 1c) napisy NA EKRANIE: kreski zamiast przekleństw ---------------- */
    // [AGENT-EXP] 2026-11-17: tryb „Kreski (----------)”. Napisy rysuje odtwarzacz, więc podmieniamy tekst w DOM —
    // tylko w elementach napisów leżących na filmie (generyczne selektory „subtitle” i tłumaczenia IT sięgają też
    // treści strony, a tam nic nie ruszamy). Oryginał trzyma pamięć podmienionych węzłów (maskOrig) + atrybut
    // MASK_ATTR na elemencie, więc cenzor dźwięku dalej widzi przekleństwo (domText czyta oryginał) i wycisza film.
    var MASK_TR = ['.imt-captions-text', '.imt-cue', '.immersive-translate-subtitle', '#immersive-translate-caption-window'];
    var maskTicks = 0, maskTimer = 0, maskLastAt = 0, maskObs = null, maskObserved = null;

    function maskOn() { return !!(opt.censorEnabled && opt.censorMode === 'dashes'); }

    function maskStr(s) {
        var e = engine();
        if (!e || !e.maskText) return s;
        try { return e.maskText(s); } catch (err) { return s; }
    }

    // Widoczny tekst elementu (z <br> jako spacją) — bez zaglądania do MASK_ATTR.
    function visibleText(el) {
        var out = '';
        for (var n = el.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 3) out += n.nodeValue;
            else if (n.nodeType === 1) out += String(n.nodeName).toUpperCase() === 'BR' ? ' ' : visibleText(n);
        }
        return out;
    }
    function textNodesIn(el, out) {
        for (var n = el.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 3) out.push(n);
            else if (n.nodeType === 1 && String(n.nodeName).toUpperCase() !== 'BR') textNodesIn(n, out);
        }
        return out;
    }

    function maskEl(el) {
        var raw = rawNodesText(el);
        if (!raw || raw.length > 600) return;             // 600 znaków to nie linia napisów (zabezpieczenie)
        var masked = maskStr(raw);
        if (masked === raw) {                             // brak przekleństw — zdejmij ślad, jeśli został
            if (el.getAttribute(MASK_ATTR) != null) { try { el.removeAttribute(MASK_ATTR); } catch (e) {} }
            return;
        }
        if (visibleText(el) !== masked) {
            var changed = false, nodes = textNodesIn(el, []);
            for (var i = 0; i < nodes.length; i++) {       // najpierw węzły tekstowe — zachowuje span-y odtwarzacza
                var v = nodes[i].nodeValue, m = maskStr(v);
                if (m !== v) { maskOrig.set(nodes[i], v); nodes[i].nodeValue = m; changed = true; }
            }
            if (!changed) {                                 // słowo rozbite na kilka węzłów (np. Netflix) — składamy linię
                try { el.textContent = masked; } catch (e) { return; }
            }
        }
        el.setAttribute(MASK_ATTR, raw);
    }

    function maskObserve(el) {
        var p = el && el.parentElement;
        if (!p) return;
        if (!maskObserved) maskObserved = new WeakSet();
        if (maskObserved.has(p)) return;
        maskObserved.add(p);
        try {
            if (!maskObs) {
                maskObs = new MutationObserver(function (muts) {
                    if (!maskOn()) return;
                    // [AGENT-EXP] 2026-11-17: reagujemy na SAM element, który się zmienił — pełny skan selektorów przy
                    // każdym słowie napisów YouTube zjadałby procesor.
                    for (var i = 0; i < muts.length; i++) {
                        var m = muts[i];
                        if (m.type === 'childList') {
                            for (var k = 0; k < m.addedNodes.length && k < 8; k++) {
                                var a = m.addedNodes[k];
                                // tylko liście (linia/słówko napisu) — kontenery i tak obejmuje skan co 600 ms,
                                // a chodzenie po całym poddrzewie nowej ramki UI tylko paliłoby procesor
                                if (!a || a.nodeType !== 1 || a.childElementCount || !a.getAttribute) continue;
                                try { maskEl(a); } catch (e) {}
                            }
                        } else {
                            var t = m.target;
                            var el2 = t && t.nodeType === 1 ? t : (t && t.parentElement);
                            if (el2 && el2.getAttribute) { try { maskEl(el2); } catch (e) {} }
                        }
                    }
                });
            }
            maskObs.observe(p, { childList: true, characterData: true, subtree: true });
        } catch (e) {}
    }

    // Nowa kwestia = nowy tekst w tym samym elemencie. Observer daje reakcję natychmiast, a skan co 200 ms × 3
    // (czyli ok. 600 ms) to tylko siatka bezpieczeństwa — gdy odtwarzacz wstawi napis poza obserwowanym rodzicem.
    function maskSoon(force) {
        if (!maskOn() || maskTimer) return;
        var wait = force ? 0 : Math.max(0, 100 - (Date.now() - maskLastAt));
        maskTimer = setTimeout(function () { maskTimer = 0; try { maskScreen(); } catch (e) {} }, wait);
    }

    function depthOf(el) {
        var d = 0, p = el;
        while (p && d < 60) { p = p.parentElement; d++; }
        return d;
    }

    function maskScreen() {
        if (!maskOn()) return;
        maskLastAt = Date.now();
        var v = mainVideo();
        if (!v) return;
        var vr = null;
        try { vr = v.getBoundingClientRect(); } catch (e) {}
        if (!vr || !(vr.width > 80 && vr.height > 40)) return;
        var sels = LIVE_SELECTORS.concat(MASK_TR, opt.selectors || []);
        var list = [], seen = new Set();
        // [AGENT-EXP] 2026-11-17: napisy IT na iQ/Prime potrafią być w Shadow DOM (jak w cenzorze live) —
        // szukamy też w otwartych shadow rootach, ale tylko gdy są ślady Immersive Translate.
        var roots = [document].concat(itShadowRoots());
        for (var ri = 0; ri < roots.length; ri++) {
            var root = roots[ri];
            if (!root || !root.querySelectorAll) continue;
            for (var i = 0; i < sels.length; i++) {
                var nodes;
                try { nodes = root.querySelectorAll(sels[i]); } catch (e) { continue; }
                for (var k = 0; k < nodes.length; k++) {
                    var el = nodes[k];
                    if (seen.has(el)) continue;
                    seen.add(el);
                    if (el.closest && el.closest('[data-lektor-ui], [data-lowca-ui]')) continue;   // własny interfejs rozszerzenia
                    var r = null;
                    try { r = el.getBoundingClientRect(); } catch (e) {}
                    if (!r || !(r.width > 0 && r.height > 0)) continue;
                    // tylko napisy przy filmie — inaczej „subtitle”/IT łapałyby też tekst artykułu pod odtwarzaczem
                    if (!(r.bottom > vr.top - 120 && r.top < vr.bottom + 120 && r.right > vr.left - 40 && r.left < vr.right + 40)) continue;
                    list.push(el);
                }
            }
        }
        // [AGENT-EXP] 2026-11-17: najpierw NAJGŁĘBSZE elementy napisów. Gdy kontener („caption window”) jest też
        // w selektorach, podmiana od niego składałaby całą linię w jedno i chowała oryginał w złym miejscu.
        list.sort(function (a, b) { return depthOf(b) - depthOf(a); });
        for (var j = 0; j < list.length; j++) {
            maskObserve(list[j]);
            maskEl(list[j]);
        }
    }

    // Tryb wyłączony / zmieniony — zdejmij kreski z tego, co właśnie widać, i przestań obserwować.
    function unmaskAll() {
        try { if (maskObs) maskObs.disconnect(); } catch (e) {}
        maskObs = null; maskObserved = null;
        if (maskTimer) { clearTimeout(maskTimer); maskTimer = 0; }
        var nodes;
        try { nodes = document.querySelectorAll('[' + MASK_ATTR + ']'); } catch (e) { return; }
        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i], raw = el.getAttribute(MASK_ATTR);
            try { el.removeAttribute(MASK_ATTR); } catch (e) {}
            var tns = textNodesIn(el, []);               // przywróć oryginały węzłom, które podmieniliśmy
            for (var k = 0; k < tns.length; k++) {
                if (maskOrig.has(tns[k])) { try { tns[k].nodeValue = maskOrig.get(tns[k]); } catch (e) {} maskOrig.delete(tns[k]); }
            }
            // linia złożona z wielu span-ów (fallback) nie ma już starych węzłów — bierzemy oryginał z atrybutu
            if (raw != null && visibleText(el) === maskStr(raw) && visibleText(el) !== raw) {
                try { el.textContent = raw; } catch (e) {}
            }
        }
    }

    var SEC_PER_WEIGHT = 0.075;   // ok. 13 głosek/s — tempo mowy do szacowania, kiedy padnie słowo
    var TR_ANCHOR_SEC = 2.5;      // tłumaczenie przychodzi z opóźnieniem — liczymy od zmiany napisu strony
    var lastSubs = { nat: '', tr: '' }, natChangedAt = -1, liveWins = [], liveSeen = new Set();

    // vr — prostokąt filmu: tłumaczenie bierzemy tylko z obszaru filmu (Immersive tłumaczy też resztę strony).
    // [AGENT-EXP] 2026-10-20: tekst elementu z <br> jako spacją — textContent sklejał linie napisów („możesz”+„wypierdalać”
    // → „możeszwypierdalać”), więc słowa z listy nie były rozpoznawane. innerText odpada: jest pusty, gdy napisy są schowane.
    function domText(node) {
        var raw = rawNodesText(node);
        // [AGENT-EXP] 2026-11-17: napis z kreskami (tryb „dashes”) trzyma oryginał w MASK_ATTR — cenzor musi widzieć
        // prawdziwe słowo, inaczej po podmianie tekstu przestałby planować ciszę w dźwięku filmu. Atrybut bierzemy tylko
        // wtedy, gdy z węzłów wychodzi dokładnie wersja z kreskami (np. po złożeniu linii z wielu span-ów).
        if (node && node.nodeType === 1 && node.getAttribute) {
            var maskedRaw = node.getAttribute(MASK_ATTR);
            if (maskedRaw != null && raw === maskStr(maskedRaw)) return maskedRaw;
        }
        return raw;
    }
    // To samo bez zaglądania w atrybut: oryginał z pamięci podmienionych węzłów tekstowych.
    function rawNodesText(el) {
        var out = '';
        for (var n = el.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 3) out += maskOrig.has(n) ? maskOrig.get(n) : n.nodeValue;
            else if (n.nodeType === 1) out += String(n.nodeName).toUpperCase() === 'BR' ? ' ' : rawNodesText(n);
        }
        return out;
    }
    function readSelsIn(root, sel, vr, parts) {
        var nodes;
        try { nodes = root.querySelectorAll(sel); } catch (e) { return; }
        for (var k = 0; k < nodes.length; k++) {
            var tx = domText(nodes[k]).replace(/\s+/g, ' ');   // [AGENT-EXP] 2026-10-20: było textContent
            if (!tx.trim()) continue;
            var r = nodes[k].getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) continue;
            if (vr && !(r.right > vr.left && r.left < vr.right && r.bottom > vr.top - 40 && r.top < vr.bottom + 40)) continue;
            parts.push(tx);
        }
    }
    function readSels(sels, vr, roots) {
        var parts = [];
        for (var i = 0; i < sels.length; i++) {
            readSelsIn(document, sels[i], vr, parts);
            for (var j = 0; roots && !parts.length && j < roots.length; j++) readSelsIn(roots[j], sels[i], vr, parts);
            if (parts.length) break;
        }
        return parts;
    }

    // [AGENT-EXP] 2026-11-14: Immersive Translate potrafi rysować napisy w Shadow DOM (tak jak na iQ/Prime) —
    // wtedy document.querySelectorAll nic nie widzi i cenzor milczał. Zbieramy otwarte shadow rooty, z pamięcią 5 s
    // (skan całej strony tylko wtedy, gdy w zwykłym DOM nie ma tłumaczenia).
    var itRoots = [], itRootsAt = 0;
    function itShadowRoots() {
        var now = Date.now();
        if (now - itRootsAt < 5000) return itRoots;
        itRootsAt = now;
        // bez śladów Immersive Translate nie ma czego szukać w shadow rootach (oszczędza skan na FB i zwykłych stronach)
        try {
            if (!document.querySelector('[class*="immersive-translate"], [id*="immersive-translate"], [class*="imt-"]')) { itRoots = []; return itRoots; }
        } catch (e) {}
        var out = [], n = 0;
        (function walk(root, depth) {
            if (depth > 3 || out.length >= 40) return;
            var all;
            try { all = root.querySelectorAll('*'); } catch (e) { return; }
            for (var i = 0; i < all.length; i++) {
                if (++n > 4000 || out.length >= 40) return;
                var sr = null;
                try { sr = all[i].shadowRoot; } catch (e) {}
                if (sr) { out.push(sr); walk(sr, depth + 1); }
            }
        })(document, 0);
        itRoots = out;
        return out;
    }
    function flatOf(parts) { return parts.join(' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }

    function liveSources() {
        var v = mainVideo(), vr = null;
        try { vr = v && v.getBoundingClientRect(); } catch (e) {}
        // [AGENT-EXP] 2026-11-14: ustawienie źródła („Tylko Immersive Translate” / „Tylko wbudowane”) działa też w cenzorze:
        // w trybie IT nie czytamy wbudowanych napisów strony i odwrotnie.
        // [AGENT-EXP] 2026-11-15: cenzor nie patrzy już na opt.subSource — czyta oba źródła naraz (dwa w jednym)
        // [AGENT-EXP] 2026-11-14: na Facebooku filtr prostokąta filmu obowiązuje też napisy strony — inaczej
        // „subtitle”/„caption” z postów i UI mogłoby wyciszać losowe słowa. Serwisy filmowe bez zmian.
        // [AGENT-EXP] 2026-11-15: czytamy ZAWSZE napisy z ekranu — „Tylko Immersive Translate” nie może już
        // zablokować live (wcześniej parts było puste, gdy nie było tłumacza IT, więc checkbox live nic nie robił).
        var parts = readSels(LIVE_SELECTORS.concat(opt.selectors), IS_FB ? vr : null);
        if (!parts.length) {   // odtwarzacz HTML5 z ścieżką <track> (też ukrytą)
            try {
                var tt = v && v.textTracks;
                for (var n = 0; tt && n < tt.length; n++) {
                    if (tt[n].mode === 'disabled' || !tt[n].activeCues) continue;
                    for (var c = 0; c < tt[n].activeCues.length; c++) parts.push(tt[n].activeCues[c].text || '');
                    if (parts.length) break;
                }
            } catch (e) {}
        }
        var tr = [];
        if (vr && vr.width > 0 && vr.height > 0) {   // [AGENT-EXP] 2026-11-15: Immersive Translate czytany ZAWSZE, też razem z napisami wbudowanymi
            tr = readSels(TR_SELECTORS, vr);
            if (!tr.length) tr = readSels(TR_SELECTORS, vr, itShadowRoots());   // [AGENT-EXP] 2026-11-14: IT w Shadow DOM
        }
        return { nat: flatOf(parts), tr: flatOf(tr) };
    }

    function checkLive(t) {
        var src = liveSources();
        if (src.nat && src.nat !== lastSubs.nat) natChangedAt = t;
        // tłumaczenie: słowo liczone od chwili, gdy zmienił się napis strony (jeśli niedawno) — okno, które już
        // minęło, zaczyna się OD RAZU (start nie wcześniej niż teraz).
        var trAnchor = (natChangedAt >= 0 && t - natChangedAt >= 0 && t - natChangedAt < TR_ANCHOR_SEC) ? natChangedAt : t;
        checkLiveSrc('nat', src.nat, t, t);
        checkLiveSrc('tr', src.tr, trAnchor, t);
    }

    // [FIX 2026-11-21] LIVE nie zna końca kwestii, więc proporcje nie działają — liczymy czas bezwzględnie.
    // Z modelem PMT: suma czasów słów i pauz przed przekleństwem (z interpunkcją: „Nie wiem, ___” = ok. 0,7 s,
    // stała SEC_PER_WEIGHT dawała 0,39 s → okno kończyło się przed końcem słowa). Bez PMT — stary szacunek.
    // Wynik w sekundach filmu (model liczy ms przy swoim tempie 1,5×, więc × pmtRate / 1000).
    function liveSpeech(beforeText, wordTok, lineText) {
        var pmt = window.PMT_MUTE_TIMER, b = String(beforeText || '').trim();
        if (pmt && pmt.extractFeatures && pmt.estimateWordMs) {
            try {
                var mr = pmtRate(pmt), total = Math.max(1, String(lineText || '').trim().split(/\s+/).length);
                var toks = b ? b.split(/\s+/) : [], ms = 0, idx = 0;
                toks.forEach(function (x) {
                    var f = pmt.extractFeatures(x, idx, total, false);
                    if (!f) return;
                    idx++;
                    ms += pmt.estimateWordMs(f) + (pmt.estimateGapMs ? pmt.estimateGapMs(f) : 0);
                });
                var fw = pmt.extractFeatures(wordTok, idx, total, true);
                var wms = fw ? pmt.estimateWordMs(fw) : 200;
                return { before: ms * mr / 1000, word: Math.max(0.25, wms * mr / 1000) };
            } catch (e) {}
        }
        var w = b ? b.split(/\s+/).reduce(function (s, x) { return s + estimateWeight(cleanW(x)); }, 0) : 0;
        return { before: w * SEC_PER_WEIGHT, word: Math.max(0.25, estimateWeight(cleanW(wordTok)) * SEC_PER_WEIGHT) };
    }

    function checkLiveSrc(key, flat, anchor, t) {
        if (flat === lastSubs[key]) return;
        var prev = lastSubs[key];
        lastSubs[key] = flat;
        var matches = flat ? findMatches(flat) : [];
        // Tylko samo słowo: napis zwykle wchodzi razem z początkiem kwestii, więc słowo pada
        // po tylu sekundach, ile zajmuje wypowiedzenie tekstu przed nim. Auto-napisy dopisują
        // słowa na końcu linii — wtedy liczymy tylko od nowej części.
        var base = (prev && flat.indexOf(prev) === 0) ? prev.length : 0;
        if (base) anchor = t;
        var keep = new Set();
        matches.forEach(function (m) {
            var sig = key + '|' + m.word.toLowerCase() + '|' + flat.slice(Math.max(0, m.index - 12), m.index).toLowerCase();
            keep.add(sig);
            if (liveSeen.has(sig)) return;
            liveSeen.add(sig);
            var before = m.index >= base ? flat.slice(base, m.index) : '';
            var est = liveSpeech(before, flat.slice(m.index, m.index + m.word.length + 3).split(/\s+/)[0] || m.word, flat.slice(base));
            var from = anchor + est.before + opt.subOffsetMs / 1000;   // [FIX 2026-11-21] przesunięcie napisów także w live
            var to = from + est.word;
            var preroll = prerollSec();
            var postroll = postrollSec();
            var end = to + realMsToMaterial(extraHold(m.word)) + postroll;
            liveWins.push({
                start: Math.max(t, from - preroll),
                end: Math.max(end, t + 0.45)   // spóźnione tłumaczenie: i tak krótkie cięcie od razu
            });
        });
        liveSeen.forEach(function (s) { if (s.indexOf(key + '|') === 0 && !keep.has(s)) liveSeen.delete(s); });
    }

    /* ---------------- wyciszanie i pętla ---------------- */

    function isShorts() { return IS_YT && location.pathname.indexOf('/shorts/') === 0; }
    function playerEl() {
        if (!IS_YT) return null;
        return isShorts() ? (document.getElementById('shorts-player') || document.getElementById('movie_player'))
            : document.getElementById('movie_player');
    }
    function vidFromUrl() {
        var m = location.pathname.match(/^\/(?:shorts|embed|live|watch\/)\/?([\w-]{6,})/);
        if (m) return m[1];
        try { return new URLSearchParams(location.search).get('v') || location.pathname; } catch (e) { return location.pathname; }
    }
    function currentVid() {
        if (IS_YT && !isShorts()) {
            try {
                var pl = playerEl(), d = pl && pl.getVideoData ? pl.getVideoData() : null;
                if (d && d.video_id) return d.video_id;
            } catch (e) {}
        }
        return vidFromUrl();
    }
    function mainVideo() {
        var pl = playerEl(), v = pl && pl.querySelector('video');
        if (v) return v;
        var all = document.querySelectorAll('video'), best = null, bestA = 0;
        // [AGENT-EXP] 2026-11-14: Facebook — w feedzie jest wiele <video>; bierzemy ten, który GRA i jest na ekranie,
        // inaczej `video.muted` trafiał w film poza widokiem (a napisy czytaliśmy z innego prostokąta).
        if (IS_FB) {
            var fv = null, fs = -1;
            for (var k = 0; k < all.length; k++) {
                var r = all[k].getBoundingClientRect();
                if (!(r.width > 120 && r.height > 60)) continue;
                var on = r.bottom > 0 && r.top < (window.innerHeight || 800);
                var sc = (all[k].paused ? 0 : 2) + (on ? 2 : 0) + Math.min(1, (r.width * r.height) / 1e6);
                if (sc > fs) { fs = sc; fv = all[k]; }
            }
            if (fv) return fv;
        }
        for (var i = 0; i < all.length; i++) {
            var a = (all[i].videoWidth || 0) * (all[i].videoHeight || 0);
            if (a > bestA) { bestA = a; best = all[i]; }
        }
        return best;
    }
    function isAd() {
        var pl = playerEl();
        return !!(pl && (pl.classList.contains('ad-showing') || pl.classList.contains('ad-interrupting')));
    }
    function speedOf() {
        var v = mainVideo(), r = v ? Number(v.playbackRate) : NaN;
        return (!isFinite(r) || r <= 0) ? 1 : Math.min(4, Math.max(0.25, r));
    }

    var mutedEl = null, mutedWas = false, muting = false;
    function applyMute(want) {
        if (want) {
            var v = mainVideo();
            if (!v) return;
            if (mutedEl && mutedEl !== v) { mutedEl.muted = mutedWas; mutedEl = null; }
            if (!mutedEl) { mutedEl = v; mutedWas = v.muted; }
            if (!v.muted) v.muted = true;
        } else if (mutedEl) {
            if (mutedEl.muted !== mutedWas) mutedEl.muted = mutedWas;
            mutedEl = null;
        }
        muting = !!want;
    }

    // [AGENT-EXP] 2026-11-06: ścieżki tekstowe odtwarzacza na KAŻDEJ stronie — gdy odtwarzacz ma całe napisy
    // w video.textTracks, cenzor bierze je bez pobierania (to samo, co „całe napisy na żądanie”, tylko automatycznie).
    var tracksTicks = 0;
    function cuesFromTracks() {
        if (IS_YT || IS_NF || IS_HBO) return;   // te serwisy mają własne, pełne źródła napisów
        var v = mainVideo();
        if (!v || !v.textTracks || !v.textTracks.length) return;
        var best = [], lang = '', have = cuesByVid.get(currentVid()) || [];
        for (var i = 0; i < v.textTracks.length; i++) {
            var tr = v.textTracks[i];
            if (!tr || tr.mode === 'disabled' || !tr.cues || !tr.cues.length) continue;
            if (tr.cues.length <= have.length) continue;   // nie dłuższa niż to, co już mamy
            var one = [];
            for (var k = 0; k < tr.cues.length; k++) {
                var c = tr.cues[k], tx = String(c.text || '').replace(/\s+/g, ' ').trim();
                if (!tx || !(c.endTime > c.startTime)) continue;
                one.push({ start: c.startTime, end: c.endTime, text: tx, segs: null });
            }
            if (one.length > best.length) { best = one; lang = String(tr.language || ''); }
        }
        if (best.length < 5) return;
        var vid = currentVid();
        if (have.length >= best.length) return;
        cuesByVid.set(vid, best);
        while (cuesByVid.size > 20) cuesByVid.delete(cuesByVid.keys().next().value);
        lastTrackInfo = 'ścieżka odtwarzacza ' + (lang || '?') + ', ' + best.length + ' kwestii';
        if (vid === curVid) useCuesFor(vid);
        // [AGENT-EXP] 2026-11-06: całe napisy ze ścieżki odtwarzacza → też LEKTOR (cenzor_bridge → LOWCA_AUTO_CUES,
        // które zapamiętuje stronę — następny film na tej stronie ruszy sam, bez klikania).
        // Tylko gdy lista wygląda na CAŁY film — kawałek z bufora nie może przykryć pełnych napisów.
        var sd = Number(v.duration) || 0, span = best[best.length - 1].end - best[0].start;
        var looksFull = sd > 0 ? span > sd * 0.4 : best.length >= 200;
        if (looksFull && !IS_LEKTOR_SITE) hboSendToLektor(best, lang, vid, 'całe napisy (odtwarzacz)', 'extFull');
    }

    var curVid = null, lastT = null, lastRate = null;
    var AUDIO_LEAD_MS = 30;   // [FIX 2026-11-21] opóźnienie wyjścia audio — słuchawki/głośniki na kablu

    function tick() {
        if (!opt.cenzorOn && !opt.cenzorLive) { if (muting) applyMute(false); return; }
        var vid = currentVid();
        if (vid !== curVid) {
            curVid = vid; vidSince = Date.now();
            if (IS_HBO) hboReset();   // [AGENT-EXP] 2026-11-06: nowy film/odcinek — szukamy napisów od nowa
            applyMute(false);
            lastT = null; lastRate = null; lastSubs = { nat: '', tr: '' }; natChangedAt = -1; liveWins = []; liveSeen = new Set();
            useCuesFor(vid);
            // [AGENT-EXP] 2026-11-17: diagnostyka zmiany odcinka (Netflix autoplay) — od razu widać, czy nowy film ma plik
            try {
                console.log('[Lektor Cenzor] nowy film ' + (IS_NF ? 'Netflix' : '') + ' (' + vid + '): '
                    + (cueMode ? ('plik, ' + cues.length + ' kwestii — ' + lastTrackInfo) : 'brak pliku, ciszę planuje live'));
            } catch (e) {}
        }
        var v = mainVideo();
        if (!v) return;
        var t = v.currentTime, rate = speedOf();
        var jumped = lastT !== null && Math.abs(t - lastT) > 1.5;
        if ((lastRate !== null && rate !== lastRate) || jumped) {
            windows = []; plannedFor = -1;
            if (cueMode) planFromCues();
            if (jumped) liveWins = [];
        }
        lastT = t; lastRate = rate;

        var useCues = opt.cenzorOn && cueMode;   // [AGENT-EXP] 2026-11-15: wczytany plik ZAWSZE ma pierwszeństwo (wybór źródła napisów już tego nie wyłącza)
        if (useCues && plannedFor !== cues.length) planFromCues();
        // [AGENT-EXP] 2026-11-14: HYBRYDA — plik rządzi tam, gdzie sięga (cisza PRZED słowem), a po jego końcu
        // (albo przed pierwszym napisem) cenzor czyta napisy z ekranu: native HBO + polskie Immersive Translate.
        var priorityLive = opt.cenzorPriority === 'live';   // [FIX 2026-11-16] ekran pierwszy także w pokryciu pliku
        var inCoverage = useCues && t >= covStart - 2 && t < covEnd;
        var want = false;
        // [FIX 2026-11-21] dźwięk już wysłany do karty audio gra mimo video.muted — przy słuchawkach na kablu
        // ok. 20–40 ms. Sprawdzamy więc chwilę „za AUDIO_LEAD_MS”: całe okno (start i koniec) przesuwa się o tyle wcześniej.
        var tq = t + AUDIO_LEAD_MS / 1000 * rate;
        if (!isAd()) {
            if (inCoverage) want = windows.some(function (w) { return tq >= w.start && tq < w.end; });
            if (!want && opt.cenzorLive && (priorityLive || !useCues || !inCoverage)) {
                want = liveWins.some(function (w) { return tq >= w.start && tq < w.end; });
            }
            if (liveWins.length) liveWins = liveWins.filter(function (w) { return w.end > t - 1; });
        }
        applyMute(!!want);
        while (windows.length && windows[0].end + 5 < t) windows.shift();
    }

    // [AGENT-EXP] 2026-11-14: czy w tym miejscu filmu warto czytać napisy z ekranu (zapas po końcu pobranego pliku).
    function liveReadingAllowed(t) {
        if (!opt.cenzorLive) return false;
        // [AGENT-EXP] 2026-11-15: wybór źródła napisów (Immersive / wbudowane) nie wyłącza już pierwszeństwa pliku
        if (!cueMode) return true;                          // brak pliku — jak dotąd, cały czas z ekranu
        if (t < covStart - 5) return true;                  // napisy zaczynają się później niż film
        if (opt.cenzorPriority === 'live') return true;                              // [FIX 2026-11-16] ekran ma pierwszeństwo także w pokryciu pliku
        return t >= covEnd - (opt.cenzorPriority === 'hybrid' ? LIVE_WARMUP_SEC : 0);  // 'file': dopiero po końcu pliku; 'hybrid': rozbieg 30 s jak wcześniej
    }

    /* ---------------- podgląd napisów (sprawdzanie przesunięcia) ---------------- */
    // [FIX 2026-11-21] Pole „Podgląd napisów na ekranie” pod suwakiem przesunięcia: na filmie pokazujemy kwestie z POBRANEGO
    // pliku dokładnie tak, jak liczy je cenzor (z przesunięciem), przekleństwa na czerwono, 🔇 gdy film jest wyciszony.
    // Gdy tekst pojawia się razem z głosem — przesunięcie jest dobre. Działa też przy wyłączonym lektorze.
    // Uwaga: nazwy bez „cue/caption/subtitle/napis” — inaczej live cenzora czytałby własny podgląd jako napisy.
    // Elementy budowane przez DOM (bez innerHTML) — YouTube wymaga Trusted Types.
    var pvEl = null, pvKey = '', pvPosAt = 0;
    function pvActive(t) {
        var off = opt.subOffsetMs / 1000, out = [], lo = 0, hi = cues.length;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (cues[mid].start + off <= t) lo = mid + 1; else hi = mid; }
        for (var i = lo - 1; i >= 0 && i >= lo - 8; i--) {
            var c = cues[i];
            if (t >= c.start + off && t < c.end + off) out.unshift(c);
        }
        return out;
    }
    function pvHost() { return document.fullscreenElement || document.webkitFullscreenElement || document.documentElement; }
    function pvRemove() { if (pvEl) { try { pvEl.remove(); } catch (e) {} pvEl = null; pvKey = ''; } }
    function pvLine(box, text) {
        var line = document.createElement('div'), ms = findMatches(text), pos = 0;
        ms.forEach(function (m) {
            if (m.index < pos) return;
            if (m.index > pos) line.appendChild(document.createTextNode(text.slice(pos, m.index)));
            var b = document.createElement('span');
            b.textContent = text.substr(m.index, m.word.length);
            b.style.cssText = 'color:#ff5a5a;font-weight:700;text-decoration:underline;';
            line.appendChild(b);
            pos = m.index + m.word.length;
        });
        if (pos < text.length) line.appendChild(document.createTextNode(text.slice(pos)));
        box.appendChild(line);
    }
    function previewTick() {
        if (!opt.cenzorPreview) { pvRemove(); return; }
        var v = mainVideo();
        if (!v) { pvRemove(); return; }
        var t = v.currentTime, list = (cueMode && cues.length) ? pvActive(t) : null;
        var offTxt = (opt.subOffsetMs >= 0 ? '+' : '−') + (Math.abs(opt.subOffsetMs) / 1000).toFixed(1).replace('.', ',') + ' s';
        var key = (list ? list.map(function (c) { return c.start + '|' + c.text; }).join('#') : 'brak') + '|' + muting + '|' + offTxt;
        var host = pvHost();
        if (!pvEl || pvEl.parentNode !== host) {
            pvRemove();
            pvEl = document.createElement('div');
            pvEl.id = 'lkc-podglad';
            pvEl.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;text-align:center;font:600 22px/1.35 system-ui,sans-serif;'
                + 'color:#fff;text-shadow:0 0 4px #000,0 0 2px #000;background:rgba(0,0,0,.55);border:2px dashed #ffd400;border-radius:8px;padding:6px 14px;max-width:80vw;';
            host.appendChild(pvEl);
            pvKey = '';
        }
        var now = Date.now();
        if (now - pvPosAt > 400) {   // położenie: nad dolną częścią filmu (nie zasłania napisów odtwarzacza)
            pvPosAt = now;
            var r = v.getBoundingClientRect();
            pvEl.style.left = Math.round(r.left + r.width / 2) + 'px';
            pvEl.style.transform = 'translateX(-50%)';
            pvEl.style.top = Math.round(r.top + r.height * 0.62) + 'px';
        }
        if (key === pvKey) return;
        pvKey = key;
        while (pvEl.firstChild) pvEl.removeChild(pvEl.firstChild);
        var head = document.createElement('div');
        head.textContent = '👁 Podgląd cenzora · przesunięcie ' + offTxt + (muting ? '  🔇' : '');
        head.style.cssText = 'font-size:13px;font-weight:500;color:#ffd400;';
        pvEl.appendChild(head);
        if (!list) {
            var n = document.createElement('div');
            n.textContent = 'Brak pobranego pliku napisów — podgląd pokazuje tylko napisy z pliku.';
            n.style.fontSize = '15px';
            pvEl.appendChild(n);
        } else if (!list.length) {
            var e = document.createElement('div');
            e.textContent = '…';
            e.style.opacity = '.5';
            pvEl.appendChild(e);
        } else list.forEach(function (c) { pvLine(pvEl, String(c.text || '')); });
    }

    // rAF staje w karcie w tle, a YouTube często gra w tle — wtedy setTimeout.
    function loop() {
        try { tick(); } catch (e) {}
        try { previewTick(); } catch (e) {}   // [FIX 2026-11-21] podgląd działa też przy wyłączonym cenzorze
        if (document.hidden) setTimeout(loop, 40);
        else requestAnimationFrame(loop);
    }

    function ready(fn) {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
        else fn();
    }

    var nfTicks = 0;
    buildRegex();
    window.lektorCenzor = {
        status: function () {
            return { on: opt.cenzorOn, live: opt.cenzorLive, priority: opt.cenzorPriority, vid: curVid, cueMode: cueMode, cues: cues.length,
                timingModelLoaded: !!(window.PMT_MUTE_TIMER && window.PMT_MUTE_TIMER.computeCueMuteWindows),
                timingModelSource: (window.PMT_MUTE_TIMER && window.PMT_MUTE_TIMER.MODEL && window.PMT_MUTE_TIMER.MODEL.meta && window.PMT_MUTE_TIMER.MODEL.meta.source) || 'wbudowany (bez meta)',
                audioLeadMs: AUDIO_LEAD_MS,
                subOffsetMs: opt.subOffsetMs,   // [FIX 2026-11-21] przesunięcie napisów (wspólne z lektorem)
                tailFix: opt.cenzorTailFix, tailTempo: Math.round(tailP20 * 1.11 * 10000) / 10000, tailCalibCues: tailCalibN,
                timingMode: opt.cenzorTimingMode,
                prerollMs: opt.cenzorPrerollMs,
                postrollMs: opt.cenzorPostrollMs,
                bufferMs: opt.cenzorBufferMs,
                holdMs: opt.cenzorHoldMs,
                windowRanges: windows.slice(0, 12).map(function (w) {
                    return { start: Math.round(w.start * 100) / 100,
                        end: Math.round(w.end * 100) / 100,
                        durationMs: Math.round((w.end - w.start) * 1000) };
                }),
                mask: maskOn(),   // [AGENT-EXP] 2026-11-17: kreski w napisach na ekranie (tryb „dashes”)
                windows: windows.length, track: lastTrackInfo, muting: muting,
                coveredFrom: Math.round(covStart * 10) / 10,   // [AGENT-EXP] 2026-11-14: od kiedy plik pokrywa film (0 = od początku)
                coveredUntil: Math.round(covEnd * 10) / 10,
                // [FIX 2026-11-21] liveFrom wg priorytetu (jak liveReadingAllowed): live = od 0, hybrid = 30 s przed końcem pliku, file = po końcu
                liveFrom: opt.cenzorPriority === 'live' ? 0 : Math.round(Math.max(0, covEnd - (opt.cenzorPriority === 'hybrid' ? LIVE_WARMUP_SEC : 0)) * 10) / 10,
                nfTracks: IS_NF ? (nfTracks.get(curVid) || []).length : undefined,
                nfLog: IS_NF ? nfLog.slice() : undefined,   // [FIX 2026-11-21]
                own: (cuesByVid.get(curVid) || []).length,   // [AGENT-EXP] 2026-11-17: ile kwestii ma cenzor dla TEGO filmu
                fileFrom: lastTrackInfo,   // [AGENT-EXP] 2026-11-17: skąd cenzor ma plik (diagnostyka Netflixa)
                ext: extCues ? { vid: extCues.vid, ep: extCues.ep, cues: extCues.list.length } : null,
                hboMpd: IS_HBO ? !!hboMpd : undefined,   // [AGENT-EXP] 2026-10-25
                hbo: IS_HBO ? { cues: hboBest, full: !!hboFromManifest, manifests: hboManifests.slice(-4), log: hboLog.slice(-8) } : undefined };   // [AGENT-EXP] 2026-11-06
        },
        // [AGENT-EXP] 2026-11-15: diagnostyka pojedynczego słowa — czy jest w liście, czy jest w wczytanym pliku
        // napisów i czy w jego okolicy powstało okno ciszy. Użycie w konsoli: lektorCenzor.checkWord('chujowa')
        // [AGENT-EXP] 2026-11-15: co live NAPRAWDĘ widzi na ekranie — do diagnozy braku cięć.
        // Konsola: lektorCenzor.liveText()
        liveText: function () {
            var s = liveSources();
            var v = mainVideo();
            var t = v ? v.currentTime : 0;
            return { nat: s.nat, tr: s.tr, matches: findMatches((s.nat || '') + ' ' + (s.tr || '')).map(function (m) { return m.word; }), custom: (opt.selectors || []).length,
                cueMode: cueMode, liveAllowed: liveReadingAllowed(t), liveOn: !!opt.cenzorLive, at: Math.round(t * 10) / 10 };
        },
        checkWord: function (w) {
            buildRegex();
            var q = String(w || '').toLowerCase();
            var inList = findMatches(q).length > 0;
            var hits = [];
            cues.forEach(function (c) {
                if (c.text && c.text.toLowerCase().indexOf(q) >= 0) {
                    hits.push({ start: Math.round(c.start * 10) / 10, end: Math.round(c.end * 10) / 10, text: c.text.slice(0, 90) });
                }
            });
            var near = windows.filter(function (x) {
                return hits.some(function (h) { return x.start <= h.end && x.end >= h.start; });
            });
            return { word: q, inList: inList, cueMode: cueMode, cues: cues.length, coverUntil: Math.round(covEnd * 10) / 10,
                cueHits: hits.slice(0, 8), windowsNearHits: near.slice(0, 8) };
        },
        __test: { parseTimedtext: parseTimedtext, parseTtml: parseTtml, nfPickTrack: nfPickTrack, nfTrackUrl: nfTrackUrl,
            nfMerge: function (vid, file, sel) { var e = nfEntry(vid); e.file = file; e.sel = Object.create(null); if (sel) e.sel.x = sel; nfRebuild(vid); return (cuesByVid.get(vid) || []).length; },
            pickTrackPl: pickTrackPl, onTimedtext: onTimedtext, ytLang: function (v) { return ytLang.get(v); },
            nfStoreGet: function (v) { return nfStore.get(String(v)); }, nfSendToLektor: nfSendToLektor,
            nfTrackCount: function (v) { return (nfTracks.get(String(v)) || []).length; }, applyOpts: applyOpts, wordTimesInCue: wordTimesInCue,
            plan: function (list) { cues = list; cueMode = true; planFromCues(); return windows.slice(); },
            previewTick: function () { previewTick(); },   // [FIX 2026-11-21] test podglądu
            live: function (text, t, tr) { if (!liveReadingAllowed(t)) return { liveWins: [], skipped: 'plik ma priorytet' }; liveSources = function () { return { nat: text, tr: tr || '' }; }; checkLive(t); return { liveWins: liveWins.slice() }; },
            liveAllowed: function (t) { return liveReadingAllowed(t); },   // [AGENT-EXP] 2026-11-14: hybryda — od kiedy czytamy ekran
            findMatches: function (s) { return findMatches(s); },
            domText: domText, maskOn: maskOn, maskScreen: maskScreen, maskEl: maskEl, visibleText: visibleText,   // [AGENT-EXP] 2026-11-17: kreski w napisach — diagnostyka
            nfScanResources: nfScanResources,   // [AGENT-EXP] 2026-11-17: Netflix — plik z performance
            hboParseMpd: hboMpdTracks, hboPickTrack: hboPickTrack, hboMerge: hboMerge, hboOnMpd: hboOnMpd,   // [AGENT-EXP] 2026-10-25
            hboMpdTracks: hboMpdTracks, hboRepSegs: hboRepSegs, hboParseSeg: hboParseSeg, hboVtt: hboVtt,   // [AGENT-EXP] 2026-11-06
            hboHlsSubs: hboHlsSubs, hboHlsSegs: hboHlsSegs, hboFromTextTracks: hboFromTextTracks,
            hboAccept: hboAccept, hboOnResponse: hboOnResponse, hboProcess: hboProcess, hboReset: hboReset, onExtCues: onExtCues, tick: tick,
            cuesFromTracks: cuesFromTracks, hboSendToLektor: hboSendToLektor,
            isPrimeVideoLocation: isPrimeVideoLocation,
            cuesOf: function (v) { return cuesByVid.get(String(v)) || []; },
            // [AGENT-EXP] 2026-11-14: czyszczenie stanu napisów między scenariuszami testu (nowy film bez przeładowania karty)
            resetCues: function () { cuesByVid.clear(); extCues = null; cues = []; cueMode = false; windows = []; plannedFor = -1; covStart = 0; covEnd = 0; },
            status: function () { return window.lektorCenzor.status(); } }
    };

    // [AGENT-EXP] 2026-11-14: mostek pyta o stan (karta „Status” w popupie, pigułka na pasku) —
    // odpowiadamy tym samym obiektem co lektorCenzor.status() (świat strony → postMessage).
    window.addEventListener('message', function (ev) {
        if (ev.source !== window || ev.origin !== location.origin) return;
        if (!ev.data || ev.data[TAG] !== 'status' || ev.data.status) return;
        try { window.postMessage({ __lektorCenzor: 'status', status: window.lektorCenzor.status() }, location.origin); } catch (e) {}
    });
    ready(function () {
        setInterval(function () {
            if (IS_HBO) hboMaybeFetch();   // [AGENT-EXP] 2026-11-06: także bez cenzora — cały plik napisów jest potrzebny lektorowi
            if (maskOn() && ++maskTicks % 3 === 0) maskSoon(true);   // [AGENT-EXP] 2026-11-17: kreski w napisach na ekranie (siatka bezpieczeństwa)
            if (!opt.cenzorOn && !opt.cenzorLive) return;
            var v = mainVideo();
            if (v && !isAd() && liveReadingAllowed(v.currentTime)) checkLive(v.currentTime);
            if (++tracksTicks % 10 === 0) cuesFromTracks();   // [AGENT-EXP] 2026-11-06: całe napisy ze ścieżki odtwarzacza
            maybeAutoLoad();
            if (IS_NF && ++nfTicks % 5 === 0) nfMaybeFetch();
        }, 200);
        try { window.postMessage({ __lektorCenzor: 'hello' }, location.origin); } catch (e) {}
        // [FIX 2026-11-21] LIVE: nowa linia napisu wykrywana od razu (MutationObserver), a nie do 200 ms później
        // w setInterval — przy przekleństwie na początku linii ten czas był słyszalny. Najwyżej jedno sprawdzenie
        // na klatkę; interwał wyżej zostaje jako zapas (Shadow DOM Immersive Translate, <track>).
        try {
            var liveQueued = false;
            var liveKick = function () {
                liveQueued = false;
                if (!opt.cenzorLive) return;
                var v = mainVideo();
                if (v && !v.paused && !isAd() && liveReadingAllowed(v.currentTime)) checkLive(v.currentTime);
            };
            var liveSelCache = '', liveSelKey = null;
            var liveSel = function () {   // selektory napisów (+ Kreator napisów) jako jeden ciąg do closest()
                var k = (opt.selectors || []).join('\n');
                if (k !== liveSelKey) { liveSelKey = k; liveSelCache = LIVE_SELECTORS.concat(TR_SELECTORS, opt.selectors || []).join(','); }
                return liveSelCache;
            };
            new MutationObserver(function (recs) {
                if (liveQueued || !opt.cenzorLive) return;
                var v = mainVideo();
                if (!v || v.paused || !liveReadingAllowed(v.currentTime)) return;   // plik pokrywa film → live i tak nie czyta
                var sel = liveSel(), hit = false;
                for (var i = 0; i < recs.length && i < 40 && !hit; i++) {
                    var n = recs[i].target;
                    var el = n && (n.nodeType === 1 ? n : n.parentElement);
                    try {
                        hit = !!(el && el.closest && el.closest(sel));
                        // nowa linia wstawiona do zwykłego kontenera: sprawdź też dodany węzeł
                        var a = !hit && recs[i].addedNodes && recs[i].addedNodes[0];
                        if (a && a.nodeType === 1) hit = a.matches(sel) || !!a.querySelector(sel);
                    } catch (e) { hit = true; }   // zły selektor użytkownika → po prostu sprawdź
                }
                if (!hit) return;
                liveQueued = true;
                if (document.hidden) setTimeout(liveKick, 0); else requestAnimationFrame(liveKick);
            }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
        } catch (e) {}
        loop();
    });
})();
