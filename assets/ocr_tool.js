// ocr_tool.js — OCR napisów wtopionych w obraz, NIEZALEŻNY od Łowcy (świat izolowany, wstrzykiwany na żądanie).
// Sterowanie: menu przycisku CC (assets/lowca_cc_stub.js) → background OCR_TOOL_CMD → {action:'OCR_TOOL', cmd}.
// Tu: zrzut ramki filmu (co 0,5 s, tylko gdy obraz napisu się zmienił) → background → silnik w dokumencie
// lektora (src/offscreen/ocr_engine.js) → tekst → małe okienko z napisem + lektor (obcy tekst tłumaczony na polski).
// Ustawienia: język (ocrToolLang, wspólny) i ramka (ocrToolRegions[host]) w chrome.storage.local.
(function () {
    'use strict';
    if (window.__LEKTOR_OCR_TOOL__) return;
    window.__LEKTOR_OCR_TOOL__ = true;

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


    const HOST = location.hostname || '';
    const DEF_REGION = [0, 0.62, 1, 0.38];
    const OCR_LANGS = { pl: 'pol', en: 'eng', de: 'deu', fr: 'fra', es: 'spa', it: 'ita', ru: 'rus', uk: 'ukr', ja: 'jpn', ko: 'kor', zh: 'chi_sim' };
    const st = { on: false, busy: false, timer: 0, sig: null, last: '', lang: '', region: DEF_REGION.slice(), fails: 0, cv: null, cv2: null, cv3: null, status: '', engine: 'tesseract',
        tr: 'skrypt', esig: null, askAt: 0, asked: 0, skipped: 0, nextCap: 0,
        auto: false, afScreen: false, finding: false, autoAt: 0, quiet: 0, quietAt: 0, afNote: '', cvA: null,
        big: true, bigSize: 'l', bigLinger: 2500 };   // [AGENT-EXP] 2026-10-19: 🔠 duże napisy na filmie (ocrToolBigSubs / ocrToolBigSize)   // [AGENT-EXP] 🎯 auto-ramka   // [AGENT-EXP] tr = kto tłumaczy; esig/askAt/asked/skipped = krawędzie liter (PP-OCR)
    // [AGENT-EXP] kto tłumaczy (menu CC → „Kto tłumaczy”, storage ocrToolTr):
    //   skrypt = silnik z ustawień rozszerzenia (przy „lokalnym” — Bing), google / bing = ten silnik,
    //   strona = Immersive Translate / TWP przez element-most (brak odpowiedzi w 2,5 s → silnik rozszerzenia)
    function trKey(v) { return v === 'google' || v === 'bing' || v === 'deepl' || v === 'strona' || v === 'lokalny' ? v : 'skrypt'; }   // [AGENT-EXP] lokalny = tylko Translator Chrome, bez sieci
    // [AGENT-EXP] (cz. 4) wykrywanie zmiany napisu dla PP-OCR (storage ocrToolDetect): 'jasnosc' = jak przed zmianami
    // (domyślnie — łapie każdy napis), 'krawedzie' = krawędzie liter (mniej zapytań, ale tylko jasne białe/żółte napisy;
    // szare / kolorowe uchodziły za „brak liter” i część kwestii przepadała).
    function detKey(v) { return v === 'krawedzie' ? 'krawedzie' : 'jasnosc'; }
    function bigSizeKey(v) { return v === 'm' || v === 'xl' ? v : 'l'; }   // [AGENT-EXP] 2026-10-19 🔠 m / l / xl
    // [AGENT-EXP] 2026-10-19: ile ms napis zostaje na ekranie PO zniknięciu oryginału (cisza) — domyślnie 2,5 s
    function bigLingerMs(v) { const n = Number(v); return [0, 1000, 2500, 4000, 6000].indexOf(n) >= 0 ? n : 2500; }
    let lektorOn = true, duckLevel = 20;

    try {
        chrome.storage.local.get(['ocrToolLang', 'ocrToolRegions', 'enabled', 'duckLevel', 'ocrToolEngine', 'ocrToolTr', 'ocrToolDetect', 'ocrToolBoxPos', 'ocrToolAutoFrame', 'ocrToolBigSubs', 'ocrToolBigSize', 'ocrToolBigLinger'], (r) => {
            r = r || {};
            st.engine = engineKey(r.ocrToolEngine);
            st.tr = trKey(r.ocrToolTr); if (boxTr) boxTr.value = st.tr;   // [AGENT-EXP]
            st.detect = detKey(r.ocrToolDetect);   // [AGENT-EXP]
            st.auto = r.ocrToolAutoFrame === true;   // [AGENT-EXP] 🎯 auto-ramka
            st.big = r.ocrToolBigSubs !== false; st.bigSize = bigSizeKey(r.ocrToolBigSize); st.bigLinger = bigLingerMs(r.ocrToolBigLinger);   // [AGENT-EXP] 2026-10-19 🔠
            const bp = r.ocrToolBoxPos && r.ocrToolBoxPos[HOST];   // [AGENT-EXP] (cz. 5) zapamiętane miejsce okienka OCR
            if (bp && Number.isFinite(bp.x) && Number.isFinite(bp.y)) { boxPos = bp; placeBox(); }
            if (typeof r.ocrToolLang === 'string') st.lang = r.ocrToolLang;
            const reg = r.ocrToolRegions && r.ocrToolRegions[HOST];
            if (Array.isArray(reg) && reg.length === 4 && reg.every((x) => Number.isFinite(x) && Math.abs(x) < 10) && reg[2] > 0 && reg[3] > 0) st.region = reg;
            if (r.enabled === false) lektorOn = false;
            if (r.duckLevel !== undefined) duckLevel = Number(r.duckLevel) || 0;
        });
        chrome.storage.onChanged.addListener((ch, area) => {
            if (area !== 'local') return;
            if (ch.ocrToolLang) { st.lang = ch.ocrToolLang.newValue || ''; st.sig = null; st.last = ''; ui(); }
            if (ch.ocrToolEngine) { st.engine = engineKey(ch.ocrToolEngine.newValue); st.sig = null; st.last = ''; if (st.on) setStatus('silnik: ' + engineLabel()); }
            if (ch.ocrToolAutoFrame) { st.auto = ch.ocrToolAutoFrame.newValue === true; st.quiet = 0; st.quietAt = 0; st.afNote = ''; if (st.auto && st.on) { const v = bigVideo(); if (v) autoFind(v); } }   // [AGENT-EXP] 🎯
            if (ch.ocrToolDetect) { st.detect = detKey(ch.ocrToolDetect.newValue); st.sig = null; st.esig = null; }   // [AGENT-EXP]
            if (ch.ocrToolTr) { st.tr = trKey(ch.ocrToolTr.newValue); if (boxTr) boxTr.value = st.tr; br.misses = 0; br.offUntil = 0; if (st.tr !== 'strona') bridgeHide(); showEng(''); }   // [AGENT-EXP]
            if (ch.enabled) lektorOn = ch.enabled.newValue !== false;
            if (ch.ocrToolBigSubs) { st.big = ch.ocrToolBigSubs.newValue !== false; if (!st.big) bigHide(true); }   // [AGENT-EXP] 2026-10-19 🔠
            if (ch.ocrToolBigSize) { st.bigSize = bigSizeKey(ch.ocrToolBigSize.newValue); bigPlace(); }
            if (ch.ocrToolBigLinger) st.bigLinger = bigLingerMs(ch.ocrToolBigLinger.newValue);
            if (ch.duckLevel) duckLevel = Number(ch.duckLevel.newValue) || 0;
        });
    } catch (e) { /* kontekst rozszerzenia unieważniony */ }

    function langs() {
        if (st.lang) return st.lang;
        const l = [];
        (navigator.languages || [navigator.language || 'en']).forEach((x) => { const c = OCR_LANGS[String(x).slice(0, 2).toLowerCase()]; if (c && l.indexOf(c) === -1) l.push(c); });
        if (l.indexOf('eng') === -1) l.push('eng');
        return l.slice(0, 3).join('+');
    }
    // [PP-OCR] Silnik do wyboru (menu CC): Tesseract (czarno-biały zrzut, wiele języków) albo PP-OCR (kolorowy zrzut,
    // lepszy na kolorowym/ruchliwym tle i dla chińskiego). PP-OCR ma modele: łaciński (pl/en/de/fr/es/it…) i chiński
    // (też japoński/angielski). Dla innych pism (cyrylica, koreański) automatycznie Tesseract.
    // [PP-OCRv6] ocrToolEngine: 'tesseract' | 'ppocr6t' (v6 tiny) | 'ppocr6s' (v6 small); stare 'ppocr' (usunięty v5) → small.
    // v6 to jeden wielojęzyczny model (łacińskie + chiński); japońskiego tiny nie zna → wtedy small.
    function engineKey(v) { return v === 'ppocr6t' ? 'ppocr6t' : (v === 'ppocr6s' || v === 'ppocr') ? 'ppocr6s' : 'tesseract'; }
    function ppModel() {
        const l = langs();
        if (/rus|ukr|kor/.test(l)) return '';
        return st.engine === 'ppocr6t' && !/jpn/.test(l) ? 'v6tiny' : 'v6small';
    }
    function isPp() { return st.engine !== 'tesseract'; }
    function useEngine() { return isPp() && ppModel() ? 'ppocr' : 'tesseract'; }
    function engineLabel() {
        if (isPp() && !ppModel()) return 'Tesseract (PP-OCR nie ma tego języka)';
        const m = ppModel();
        return useEngine() === 'ppocr' ? (m === 'v6tiny' ? 'PP-OCRv6 tiny' : 'PP-OCRv6 small') : 'Tesseract ' + langs();
    }
    // ---------- [EKRAN] źródło zrzutu ----------
    // Ramka w obrazie filmu → piksele prosto z <video> (szybko). Ramka wychodzi poza obraz (czarny pasek pod filmem,
    // napisy rysowane przez stronę) → zrzut widocznej części karty (chrome.tabs.captureVisibleTab, tylko główna ramka;
    // Chrome pozwala na ~2 zrzuty/s). Na czas zrzutu chowamy własne okienko OCR i przycisk CC, jeśli są w ramce.
    const IS_TOP = window.top === window;
    let lastScreenAt = 0;
    function inPicture(r) { return r[0] >= -0.002 && r[1] >= -0.002 && r[0] + r[2] <= 1.002 && r[1] + r[3] <= 1.002; }
    function screenMode() { return IS_TOP && (st.afScreen || !inPicture(st.region)); }   // [AGENT-EXP] afScreen = 🎯 napis rysuje strona (nie ma go w pikselach filmu)
    function clamp01(r) { const x = Math.min(Math.max(0, r[0]), 0.96), y = Math.min(Math.max(0, r[1]), 0.96); return [x, y, Math.min(r[2], 1 - x), Math.min(r[3], 1 - y)]; }
    const nextFrame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    function loadImg(url) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('screen:obraz')); i.src = url; }); }
    // [AGENT-EXP] okienka lektora chowane na czas zrzutu ekranu — inaczej OCR czytał własne teksty lektora
    // (panel z przeczytanymi kwestiami, nakładka z czytanym tekstem, ustawienia, Łowca), które leżą w ramce.
    const OWN_UI = '[data-lektor-ocr],[data-lektor-cc],[data-lektor-ui],[data-ush-host],#lektor-controls-bar,#lektor-settings-sheet,#lektor-settings-gear,[id^="livedub-"]';
    // [AGENT-EXP] zrzut widocznej części karty; na ten czas chowamy okienka lektora nachodzące na prostokąt x0..x1, y0..y1
    async function screenShot(x0, y0, x1, y1) {
        const hidden = [];
        document.querySelectorAll(OWN_UI).forEach((el) => {   // [AGENT-EXP] wszystkie okienka lektora, nie tylko OCR i CC
            if (el.style.visibility === 'hidden') return;
            const b = el.getBoundingClientRect();
            // chowamy tylko to, co nachodzi na ramkę (bez migania reszty ekranu)
            const hit = !b.width || (b.left < x1 && b.right > x0 && b.top < y1 && b.bottom > y0);
            if (hit) { el.style.visibility = 'hidden'; hidden.push(el); }
        });
        if (hidden.length) await nextFrame();
        lastScreenAt = Date.now();
        const res = await send({ action: 'OCR_TOOL_SCREEN' });
        hidden.forEach((el) => { el.style.visibility = ''; });
        return res;
    }
    async function grab(v) {
        const reg = st.region;
        if (!screenMode()) {
            const r = clamp01(reg);
            return { src: v, sx: v.videoWidth * r[0], sy: v.videoHeight * r[1], sw: Math.max(16, v.videoWidth * r[2]), sh: Math.max(16, v.videoHeight * r[3]) };
        }
        if (Date.now() - lastScreenAt < 600) return null;          // limit Chrome: najwyżej ~2 zrzuty na sekundę
        const pb = videoBox(v);
        const x0 = Math.max(0, pb.left + reg[0] * pb.width), y0 = Math.max(0, pb.top + reg[1] * pb.height);
        const x1 = Math.min(innerWidth, pb.left + (reg[0] + reg[2]) * pb.width), y1 = Math.min(innerHeight, pb.top + (reg[1] + reg[3]) * pb.height);
        if (x1 - x0 < 8 || y1 - y0 < 8) return null;
        const res = await screenShot(x0, y0, x1, y1);   // [AGENT-EXP] wspólne z 🎯 auto-ramką
        if (!res || !res.ok) throw new Error('screen:' + ((res && res.error) || 'brak odpowiedzi'));
        const img = await loadImg(res.image);
        const sc = img.naturalWidth / innerWidth;
        return { src: img, sx: x0 * sc, sy: y0 * sc, sw: (x1 - x0) * sc, sh: (y1 - y0) * sc, screen: true };
    }

    // Kolorowy wycinek ramki dla PP-OCR (szer. ≤ 960 px) + „odcisk” jasności do wykrywania zmian napisu
    function captureColor(g) {
        const sx = Math.round(g.sx), sy = Math.round(g.sy), sw = Math.round(g.sw), sh = Math.round(g.sh);
        const k = Math.min(1, 960 / sw), dw = Math.max(32, Math.round(sw * k)), dh = Math.max(16, Math.round(sh * k));
        if (!st.cv3) st.cv3 = document.createElement('canvas');
        const c = st.cv3; c.width = dw; c.height = dh;
        const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(g.src, sx, sy, sw, sh, 0, 0, dw, dh);
        const d = x.getImageData(0, 0, dw, dh).data, gw = 48, gh = 12, n = gw * gh;
        // [AGENT-EXP] obok średniej jasności w każdym polu siatki liczymy GĘSTOŚĆ KRAWĘDZI LITER — tylko skoki,
        // przy których jedna strona jest jasna jak napis (biały/żółty), a różnica duża. Brzeg obwódka↔tło się nie
        // liczy, więc zmiana tła (cięcie sceny, wybuch, światło) nie budzi OCR; zmiana napisu — tak.
        const grid = new Float32Array(n), cnt = new Float32Array(n), edge = new Float32Array(n);
        const sw2 = Math.ceil(dw / 2), sh2 = Math.ceil(dh / 2), L = new Uint8Array(sw2 * sh2);
        for (let y = 0, j = 0; y < dh; y += 2) for (let xx = 0; xx < dw; xx += 2, j++) {
            const p = (y * dw + xx) * 4; L[j] = (d[p] * 77 + d[p + 1] * 151 + d[p + 2] * 28) >> 8;
        }
        for (let ry = 0; ry < sh2; ry++) for (let rx = 0; rx < sw2; rx++) {
            const j = ry * sw2 + rx, l = L[j], gi = ((ry * 2 * gh / dh) | 0) * gw + ((rx * 2 * gw / dw) | 0);
            grid[gi] += l; cnt[gi]++;
            const nr = rx + 1 < sw2 ? L[j + 1] : l, nd = ry + 1 < sh2 ? L[j + sw2] : l;
            if ((Math.max(l, nr) >= OCR_LETTER_L && Math.abs(l - nr) >= OCR_EDGE_T)
                || (Math.max(l, nd) >= OCR_LETTER_L && Math.abs(l - nd) >= OCR_EDGE_T)) edge[gi]++;
        }
        let textCells = 0;
        for (let i = 0; i < n; i++) {
            if (cnt[i]) { grid[i] /= cnt[i]; edge[i] = edge[i] * 255 / cnt[i]; }
            if (edge[i] >= OCR_TEXT_CELL) textCells++;
        }
        return { canvas: c, grid, edge, text: textCells >= 2 };
    }
    const OCR_LETTER_L = 190;    // [AGENT-EXP] jasność „litery” (biały ≈ 255, żółty ≈ 227, jasnoszary ≈ 200)
    const OCR_EDGE_T = 80;       // [AGENT-EXP] skok jasności sąsiednich próbek = brzeg litery
    const OCR_TEXT_CELL = 38;    // [AGENT-EXP] pole „z literami” = ≥15% próbek to krawędzie (skala 0–255)
    const OCR_EDGE_DIFF = 20;    // [AGENT-EXP] zmiana gęstości krawędzi w polu (≈8%) = „inny napis”
    // zmiana napisu przy kolorowym zrzucie: kilka komórek wyraźnie się zmieniło (t: próg, domyślnie jasność 18)
    function changedColor(a, b, t) { if (!a) return true; t = t || 18; let n = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > t) n++; return n >= 3; }
    function bigVideo() {
        const vs = document.querySelectorAll('video'); let best = null, ba = 0;
        for (const v of vs) { const r = v.getBoundingClientRect(), a = r.width * r.height; if (a > ba && v.videoWidth) { ba = a; best = v; } }
        return best;
    }
    function send(msg) {
        return new Promise((res) => { try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r || null); }); } catch (e) { res(null); } });
    }

    // ---------- zrzut ramki: jasny tekst → czarny na białym + „odcisk” do wykrywania zmian ----------
    function otsu(hist, total) {
        let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
        let wB = 0, sB = 0, best = 0, thr = 128;
        for (let i = 0; i < 256; i++) { wB += hist[i]; if (!wB) continue; const wF = total - wB; if (!wF) break; sB += i * hist[i]; const mB = sB / wB, mF = (sum - sB) / wF; const v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; thr = i; } }
        return thr;
    }
    function capture(g) {
        const sx = Math.round(g.sx), sy = Math.round(g.sy), sw = Math.round(g.sw), sh = Math.round(g.sh);
        const k = Math.min(2, 1100 / sw), dw = Math.max(32, Math.round(sw * k)), dh = Math.max(16, Math.round(sh * k));
        if (!st.cv) { st.cv = document.createElement('canvas'); st.cv2 = document.createElement('canvas'); }
        const cv = st.cv, c2 = st.cv2; cv.width = c2.width = dw; cv.height = c2.height = dh;
        const x = cv.getContext('2d', { willReadFrequently: true }); x.drawImage(g.src, sx, sy, sw, sh, 0, 0, dw, dh);
        const d = x.getImageData(0, 0, dw, dh).data, n = dw * dh, lum = new Uint8Array(n), hist = new Uint32Array(256);
        for (let i = 0, p = 0; i < n; i++, p += 4) { const l = (d[p] * 77 + d[p + 1] * 151 + d[p + 2] * 28) >> 8; lum[i] = l; hist[l]++; }
        const thr = Math.max(150, Math.min(235, otsu(hist, n)));
        const out = x.createImageData(dw, dh), o = out.data; let on = 0; const gw = 48, gh = 12, grid = new Float32Array(gw * gh);
        for (let y = 0; y < dh; y++) for (let xx = 0; xx < dw; xx++) {
            const i = y * dw + xx, t = lum[i] >= thr, q = i * 4, val = t ? 0 : 255; o[q] = o[q + 1] = o[q + 2] = val; o[q + 3] = 255;
            if (t) { on++; grid[((y * gh / dh) | 0) * gw + ((xx * gw / dw) | 0)] += 1; }
        }
        c2.getContext('2d').putImageData(out, 0, 0);
        return { canvas: c2, ratio: on / n, grid };
    }
    function changed(a, b) { if (!a) return true; let s = 0, m = 0; for (let i = 0; i < a.length; i++) { s += Math.abs(a[i] - b[i]); m += Math.max(a[i], b[i]); } return m > 0 && s / m > 0.12; }
    const CJK = /[぀-ヿ㐀-鿿가-힯豈-﫿]/g;
    function clean(lines) {
        const keep = [];
        for (const l of lines || []) {
            let t = String(l.text || '').replace(/[|\\{}~_`^<>]+/g, ' ').replace(/\s+/g, ' ').trim();
            t = t.replace(/([぀-ヿ㐀-鿿가-힯豈-﫿])\s+(?=[぀-ヿ㐀-鿿가-힯豈-﫿])/g, '$1');
            const nLat = t.replace(/[^A-Za-zÀ-žЀ-ӿ]/g, '').length, nCjk = (t.match(CJK) || []).length;
            if ((l.conf || 0) < 55 || nLat + 2 * nCjk < 3) continue;
            keep.push(t);
        }
        return keep.join(' ');
    }
    function similar(a, b) {
        if (!a || !b) return false;
        a = a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); b = b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
        if (a === b) return true;
        const n = Math.max(a.length, b.length); if (n < 4 || Math.abs(a.length - b.length) > n * 0.3) return false;
        let same = 0; const m = Math.min(a.length, b.length); for (let i = 0; i < m; i++) if (a[i] === b[i]) same++;
        return same / n > 0.82;
    }

    // ---------- lektor: polski od razu, obcy przez tłumacza (EXT_TR_LIVE), kolejność zachowana ----------
    let chain = Promise.resolve(), lastSaid = '', seq = 0, duckVid = null, duckSaved = null, duckTimer = 0;
    // [AGENT-EXP] czy tekst jest już po polsku (jak userscript 4.2.14+). Wcześniej samo „to” / „co” w angielskim
    // zdaniu („I want to go home”) = „polskie” → kwestia szła do lektora PO ANGIELSKU, bez tłumaczenia.
    // „mocne” = tylko polskie słowa; „słabe” = krótkie, które zdarzają się też w innych językach.
    const PL_STRONG = /(?<!\p{L})(nie|się|że|jest|jak|ale|już|tak|czy|dla|być|był|była|było|są|przez|tylko|bardzo|mnie|może|tego|jestem|jesteś|wszystko|dobrze|proszę|dziękuję|chcę|wiem|jeszcze|teraz|gdzie|kiedy|dlaczego|tutaj|sobie|mój|moja|twój|twoja|ty|co)(?!\p{L})/giu;
    const PL_WEAK = /(?<!\p{L})(tam|na|za|od|ze|lub|to|w|z|i)(?!\p{L})/giu;
    function looksPolish(s) {
        s = String(s || '');
        const words = (s.match(/\p{L}+/gu) || []).length;
        if (!words) return false;
        const dia = (s.match(/[ąćęłńśźżĄĆĘŁŃŚŹŻ]/g) || []).length;
        const strong = (s.match(PL_STRONG) || []).length, weak = (s.match(PL_WEAK) || []).length;
        if (words <= 4) return dia >= 1 || strong >= 1;
        return dia / words >= 0.06 || (strong >= 2 && (strong + weak) / words >= 0.15);
    }
    function duck(len) {
        const v = bigVideo(); if (!v || v.paused) return;
        try {
            if (duckVid !== v) { duckVid = v; duckSaved = null; }
            if (duckSaved === null) duckSaved = v.volume;
            v.volume = Math.min(duckSaved, duckLevel / 100);
            clearTimeout(duckTimer);
            duckTimer = setTimeout(() => { try { if (duckVid && duckSaved !== null) duckVid.volume = duckSaved; } catch (e) {} duckSaved = null; }, Math.min(6000, Math.max(1500, len * 65) + 400));
        } catch (e) {}
    }
    function say(text) {
        // [AGENT-EXP] 2026-10-19: 🔠 duże napisy — tłumaczenie idzie na ekran OD RAZU, gdy tylko przyjdzie (bez
        // czekania na lektora), także przy WYŁĄCZONYM lektorze. Lektor (gdy włączony) czyta po swojemu, później.
        const speak = lektorOn, wantBig = st.big;
        if (!speak && !wantBig) return;
        const my = ++seq, lg = langs();
        // [AGENT-EXP] tłumacz wg „Kto tłumaczy” + w okienku: kto przetłumaczył i ile to trwało (albo dlaczego nie)
        let ready;
        if (lg !== 'pol' && !looksPolish(text)) {
            const t0 = Date.now();
            showEng('🌐 tłumaczę (' + trLabel() + ')…');
            ready = trOne(text).then((r) => {
                if (my === seq) showEng(r && r.text ? '🌐 ' + r.by + ' · ' + (Date.now() - t0) + ' ms' : '⚠️ ' + ((r && r.error) || 'brak tłumaczenia') + ' — kwestia pominięta');
                return r && r.text ? String(r.text).trim() : '';
            });
        } else { ready = Promise.resolve(text); if (lg !== 'pol') showEng('🇵🇱 po polsku — bez tłumaczenia'); }
        if (wantBig) {
            ready.then((pl) => {
                if (!pl || !st.on || !st.big || my < bigSeq) return;   // starsze tłumaczenie nie zasłoni nowszego
                bigSeq = my; bigShow(pl);
                if (!speak) showText(st.last, pl);
            }).catch(() => {});
        }
        if (!speak) return;
        chain = chain.then(() => ready).then((pl) => {
            if (!pl || !lektorOn || !st.on) return;
            if (seq - my > 2) return;            // OCR już dalej — stary napis pomijamy
            if (pl === lastSaid) return;
            lastSaid = pl; duck(pl.length); showText(st.last, pl);
            try { var LS = window.__LektorSched; if (LS) LS.setSource('OCR: napisy z obrazu', 0); } catch (e) {}   // [FIX 2026-11-02] „czytam z: …”
            send({ action: 'TTS_PLAY', id: 'ocrt_' + Date.now() + '_' + my, text: pl.slice(0, 600), durationMs: 0 })
                .then((r) => { if (r && r.status === 'blocked' && my === seq) showEng('🚫 kwestia pominięta — pasuje do listy Blokad'); });   // [AGENT-EXP]
        }).catch(() => {});
    }

    // [AGENT-EXP] całe zdania: obcy napis z OCR czeka na dalszy ciąg zdania (zdLiveFeed), polski idzie od razu
    function sayZd(txt) {
        if (!zdOn || langs() === 'pol' || looksPolish(txt)) { zdRelease(); say(txt); return; }
        zdLiveFeed(txt, say, 150);
    }

    // ---------- [AGENT-EXP] 🎯 auto-ramka: sama znajduje napisy (storage ocrToolAutoFrame) ----------
    // Kilka klatek (co ~1 s, najwyżej AF_SAMPLES) całego obrazu filmu → PP-OCR tiny, TYLKO wykrywanie tekstu
    // (offscreen OCR_TOOL_FIND). Z prostokątów wybieramy pas napisów (pickBand) i ustawiamy ramkę. Potem zwykła
    // pętla — szukanie wraca dopiero po AF_QUIET_MS odtwarzania bez przeczytanego tekstu (najwyżej co AF_GAP_MS).
    const AF_SAMPLES = 6, AF_EVERY = 1000, AF_QUIET_MS = 20000, AF_GAP_MS = 30000, AF_W = 640;
    // samples: [[{x,y,w,h} w ułamkach obrazu 0..1], …] (jedna tablica na klatkę) → [x,y,w,h] ramki albo null
    function pickBand(samples, maxY) {   // [AGENT-EXP] maxY: dół zrzutu (1 = dół filmu, 1.25 = z pasem pod filmem)
        const cl = [];
        samples.forEach((boxes, si) => boxes.forEach((b) => {
            const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
            if (cx < 0.15 || cx > 0.85 || b.h < 0.02 || b.h > 0.14 || b.w < 0.03) return;   // logo w rogu, duże plansze
            let c = cl.find((k) => Math.abs(k.cy - cy) < 0.045);
            if (!c) { c = { cy, items: [] }; cl.push(c); }
            c.items.push({ si, b });
            c.cy = c.items.reduce((s, it) => s + it.b.y + it.b.h / 2, 0) / c.items.length;
        }));
        let best = null, bestScore = 0;
        for (const c of cl) {
            const hits = new Set(c.items.map((it) => it.si)).size;
            const shapes = new Set(c.items.map((it) => Math.round(it.b.x * 50) + ':' + Math.round(it.b.w * 50))).size;
            if (hits >= 3 && shapes < 2) continue;                       // stały znak wodny / pasek kanału — zawsze ten sam
            const score = hits + (shapes >= 2 ? 1 : 0) + (c.cy > 0.5 ? 0.5 : 0);
            if (score > bestScore) { bestScore = score; best = c; }
        }
        if (!best) return null;
        const bs = best.items.map((it) => it.b);
        const y0 = Math.min(...bs.map((b) => b.y)), y1 = Math.max(...bs.map((b) => b.y + b.h));
        const hs = bs.map((b) => b.h).sort((a, b) => a - b), lh = hs[hs.length >> 1];
        let top = y0 - 0.6 * lh, bot = y1 + 0.6 * lh;
        if (y1 - y0 < 1.6 * lh) { if (best.cy > 0.5) top -= 1.1 * lh; else bot += 1.1 * lh; }   // miejsce na drugą linijkę
        top = Math.max(0, top); bot = Math.min(maxY || 1, bot);
        return [0.08, +top.toFixed(4), 0.84, +(bot - top).toFixed(4)];
    }
    // pickBand-end
    // [AGENT-EXP] jedna klatka do szukania. Główna ramka: ZRZUT EKRANU prostokąta filmu + AF_BELOW pod nim — widać
    // wszystko: napisy wtopione w obraz, napisy rysowane przez stronę (HTML, Łowca), czarny pas pod filmem.
    // Iframe (bez zrzutu ekranu): piksele filmu. Wynik: obrazek + mapa (ox, oy, kx, ky) z pikseli obrazka
    // na ułamki obrazu filmu: x = ox + px / szer * kx (y > 1 = pod filmem).
    const AF_BELOW = 0.25;
    function afCanvas(w, h) {
        const k = Math.min(1, AF_W / w), dw = Math.max(32, Math.round(w * k)), dh = Math.max(32, Math.round(h * k));
        if (!st.cvA) st.cvA = document.createElement('canvas');
        const c = st.cvA; c.width = dw; c.height = dh;
        return c;
    }
    function afVideo(v) {   // piksele filmu (rzuca, gdy obraz chroniony / z innej domeny)
        const c = afCanvas(v.videoWidth, v.videoHeight);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        return { image: c.toDataURL('image/jpeg', 0.85), ox: 0, oy: 0, kx: 1, ky: 1, screen: false };
    }
    async function afFrame(v) {
        const pb = videoBox(v);
        const x0 = Math.max(0, pb.left), y0 = Math.max(0, pb.top);
        const x1 = Math.min(innerWidth, pb.left + pb.width), y1 = Math.min(innerHeight, pb.top + pb.height * (1 + AF_BELOW));
        if (!IS_TOP || x1 - x0 < 32 || y1 - y0 < 32) return afVideo(v);
        const wait = 600 - (Date.now() - lastScreenAt);
        if (wait > 0) await sleep(wait);                            // limit Chrome: ~2 zrzuty na sekundę
        const res = await screenShot(x0, y0, x1, y1);
        if (!res || !res.ok) throw new Error((res && res.error) || 'zrzut ekranu nieudany');
        const img = await loadImg(res.image), sc = img.naturalWidth / innerWidth;
        const c = afCanvas((x1 - x0) * sc, (y1 - y0) * sc);
        c.getContext('2d').drawImage(img, x0 * sc, y0 * sc, (x1 - x0) * sc, (y1 - y0) * sc, 0, 0, c.width, c.height);
        return { image: c.toDataURL('image/jpeg', 0.85), ox: (x0 - pb.left) / pb.width, oy: (y0 - pb.top) / pb.height,
            kx: (x1 - x0) / pb.width, ky: (y1 - y0) / pb.height, screen: true };
    }
    // [AGENT-EXP] czy napis w pasie reg jest w PIKSELACH filmu? (jedna klatka) — nie → rysuje go strona, czytamy ze zrzutu ekranu
    async function afInVideo(v, reg) {
        let f;
        try { f = afVideo(v); } catch (e) { return false; }
        const r = await send({ action: 'OCR_TOOL_FIND', image: f.image });
        if (!r || !r.ok) return true;                               // nie wiadomo — zostajemy przy szybkich pikselach
        return (r.boxes || []).some((b) => { const cy = (b.y + b.h / 2) / r.h; return cy >= reg[1] && cy <= reg[1] + reg[3]; });
    }
    async function autoFind(v) {
        if (st.finding) return;
        st.finding = true; st.busy = true; st.autoAt = Date.now();
        const old = st.status;
        try {
            setStatus('🎯 szukam napisów na filmie…');
            const samples = [];
            let maxY = 1, shot = false;   // [AGENT-EXP] maxY > 1 = zrzut sięga pod film; shot = szukano na zrzucie ekranu
            for (let i = 0; i < AF_SAMPLES && st.on; i++) {
                if (i) await sleep(AF_EVERY);
                if (!st.on || v.paused || v.ended || document.visibilityState !== 'visible') { i--; if (!st.on) break; await sleep(500); continue; }
                let r;
                let f;
                try { f = await afFrame(v); r = await send({ action: 'OCR_TOOL_FIND', image: f.image }); }
                catch (e) { setStatus('🎯 nie mogę zrobić zrzutu: ' + String(e.message || e)); return; }
                if (!r || !r.ok) { setStatus('🎯 błąd wykrywania: ' + ((r && r.error) || 'brak odpowiedzi')); return; }
                samples.push((r.boxes || []).map((b) => ({ x: f.ox + b.x / r.w * f.kx, y: f.oy + b.y / r.h * f.ky, w: b.w / r.w * f.kx, h: b.h / r.h * f.ky })));   // [AGENT-EXP] ułamki obrazu filmu
                maxY = Math.max(maxY, f.oy + f.ky); shot = shot || f.screen;
                const quick = samples.length >= 3 && pickBand(samples, maxY);
                if (quick && samples.filter((s) => s.length).length >= 3) break;   // wyraźnie widać — nie trzeba dalej
            }
            if (!st.on) return;
            const reg = pickBand(samples, maxY);
            if (!reg) { st.afNote = ' · 🎯 nie znalazłem napisów (stara ramka)'; setStatus('🎯 nie znalazłem napisów — zostaje dotychczasowa ramka'); return; }
            // [AGENT-EXP] pas w obrazie filmu, ale znaleziony na zrzucie ekranu → czy to piksele filmu, czy napis strony?
            const scr = shot && inPicture(reg) && !(await afInVideo(v, reg));
            if (!st.on) return;
            st.region = reg; st.afScreen = scr; st.sig = null; st.esig = null; st.last = '';
            try { chrome.storage.local.get('ocrToolRegions', (r) => { const m = (r && r.ocrToolRegions) || {}; m[HOST] = reg; chrome.storage.local.set({ ocrToolRegions: m }); }); } catch (e) {}
            st.afNote = ' · 🎯 ramka ' + Math.round(reg[1] * 100) + '–' + Math.round((reg[1] + reg[3]) * 100) + '%' + (scr ? ' (napisy strony)' : '');
            setStatus('🎯 znalazłem napisy — ramka ustawiona (' + Math.round(reg[1] * 100) + '–' + Math.round((reg[1] + reg[3]) * 100) + '% wysokości)');
        } finally {
            st.finding = false; st.busy = false; st.quiet = 0; st.quietAt = 0;
            if (st.on && /^🎯 szukam/.test(st.status)) setStatus(old || 'działa');
        }
    }

    // ---------- pętla ----------
    async function tick() {
        if (!st.on || st.busy || st.finding || document.visibilityState !== 'visible') return;   // [AGENT-EXP] st.finding = 🎯 szuka napisów
        const v = bigVideo(); if (!v || v.readyState < 2 || v.paused || v.ended) return;
        if (st.auto) {   // [AGENT-EXP] 🎯 auto-ramka: długo (czas odtwarzania) nic nie przeczytane → szukaj napisów jeszcze raz
            const now = Date.now();
            if (st.quietAt) st.quiet += Math.min(1000, now - st.quietAt);
            st.quietAt = now;
            if (st.quiet > AF_QUIET_MS && now - st.autoAt > AF_GAP_MS) { autoFind(v); return; }
        }
        // [AGENT-EXP] zegar co 250 ms; Tesseract (cięższy zrzut) nadal najwyżej co ~0,5 s
        if (useEngine() !== 'ppocr' || st.detect !== 'krawedzie') { if (Date.now() < st.nextCap) return; st.nextCap = Date.now() + 450; }   // jak dawniej: najwyżej co ~0,5 s
        st.busy = true;
        try {
            const eng = useEngine();
            let g;
            try { g = await grab(v); }
            catch (e) { st.fails++; setStatus('zrzut ekranu nieudany: ' + String(e.message || e).replace(/^screen:/, '')); if (st.fails > 8) stop('OCR zatrzymany — zrzut ekranu nie działa.'); return; }
            if (!g || !st.on) return;
            let cap;
            try { cap = eng === 'ppocr' ? captureColor(g) : capture(g); } catch (e) { stop('Film chroniony przed odczytem obrazu (DRM) — przesuń ramkę poza obraz filmu (zrzut ekranu) albo OCR tu nie zadziała.'); return; }
            if (eng === 'ppocr' && st.detect !== 'krawedzie') {
                if (!changedColor(st.sig, cap.grid)) return;   // [AGENT-EXP] domyślnie dokładnie jak przed zmianami
            } else if (eng === 'ppocr') {
                // [AGENT-EXP] silnik pytamy, gdy zmieniły się KRAWĘDZIE liter. Sama zmiana jasności (tło) budzi OCR
                // najwyżej co 1,5 s (litery w ramce) albo co 3 s (bez liter — kontrola, żeby nie zgubić bladych napisów).
                const now = Date.now(), lumCh = changedColor(st.sig, cap.grid);
                let ask;
                if (!cap.text) { if (st.last) { st.last = ''; showText('', ''); zdLiveGone(); bigHide(); } ask = lumCh && now - st.askAt > 3000; }
                else ask = changedColor(st.esig, cap.edge, OCR_EDGE_DIFF) || (lumCh && now - st.askAt > 1500);
                if (!ask) { st.skipped++; return; }
                st.esig = cap.edge; st.askAt = now; st.asked++;
            } else {
                if (cap.ratio < 0.0015 || cap.ratio > 0.35) { if (st.last) { st.last = ''; showText('', ''); zdLiveGone(); bigHide(); } st.sig = null; return; }
                if (!changed(st.sig, cap.grid)) return;
            }
            st.sig = cap.grid;
            const r = await send(eng === 'ppocr'
                ? { action: 'OCR_TOOL_RECOGNIZE', engine: 'ppocr', model: ppModel(), image: cap.canvas.toDataURL('image/jpeg', 0.92), langs: langs() }
                : { action: 'OCR_TOOL_RECOGNIZE', image: cap.canvas.toDataURL('image/png'), langs: langs() });
            if (!st.on) return;
            if (!r || !r.ok) { st.fails++; setStatus('błąd silnika: ' + ((r && (r.error || r.status)) || 'brak odpowiedzi')); if (st.fails > 8) stop('OCR zatrzymany po błędach.'); return; }
            st.fails = 0; setStatus('działa — ' + engineLabel() + (g.screen ? ' · zrzut ekranu' : '') + (eng === 'ppocr' && st.detect === 'krawedzie' ? ' · zapytań ' + st.asked + ', pominiętych klatek ' + st.skipped : '') + (st.auto ? st.afNote || '' : ''));   // [AGENT-EXP] licznik; 🎯 wynik auto-ramki
            const txt = clean(r.lines);
            if (!txt) { if (eng === 'ppocr' && st.last) { st.last = ''; showText('', ''); zdLiveGone(); bigHide(); } return; }
            st.quiet = 0;   // [AGENT-EXP] 🎯 jest tekst w ramce
            if (similar(txt, st.last)) return;
            st.last = txt; showText(txt, '');
            sayZd(txt);   // [AGENT-EXP] całe zdania
        } finally { st.busy = false; }
    }
    function start() {
        if (st.on) return;
        if (!bigVideo()) { setStatus('Nie widzę filmu — włącz odtwarzanie.'); return; }
        st.on = true; st.fails = 0; st.sig = null; st.last = ''; lastSaid = '';
        st.esig = null; st.askAt = 0; st.asked = 0; st.skipped = 0; st.nextCap = 0;   // [AGENT-EXP]
        setStatus('uruchamiam silnik — ' + engineLabel() + '…'); ui();
        clearInterval(st.timer); st.timer = setInterval(tick, 250);   // [AGENT-EXP] było 500 ms
        st.quiet = 0; st.quietAt = 0; st.autoAt = 0; st.afNote = '';   // [AGENT-EXP] 🎯
        if (st.auto) autoFind(bigVideo()); else tick();   // [AGENT-EXP] 🎯 auto-ramka: najpierw znajdź napisy
        send({ action: 'OCR_TOOL_STATE', on: true, status: st.status });
    }
    // [AGENT-EXP] ocr: true w EXT_TR_LIVE = przepustka trybu „tylko OCR”. Strona zamykana / przeładowana
    // z włączonym OCR → tło kończy ten tryb dla tej karty.
    window.addEventListener('pagehide', () => { if (st.on) send({ action: 'OCR_TOOL_STATE', on: false, status: 'strona zamknięta' }); });
    function stop(why) {
        st.on = false; clearInterval(st.timer); st.timer = 0; st.last = '';
        bridgeHide(); showEng('');   // [AGENT-EXP]
        bigHide(true);   // [AGENT-EXP] 2026-10-19 🔠
        setStatus(why || 'wyłączony'); ui();
        if (why) { showBox(true); setTimeout(() => { if (!st.on) showBox(false); }, 5000); }
        send({ action: 'OCR_TOOL_STOP' });
        send({ action: 'OCR_TOOL_STATE', on: false, status: st.status }); // checkbox „OCR” przy CC się odznacza
    }

    // ---------- okienko z napisem (nad filmem, w tej ramce) ----------
    let box = null, boxText = null, boxPl = null, boxStatus = null, boxEng = null, boxTr = null;   // [AGENT-EXP] boxTr = wybór tłumacza   // [AGENT-EXP] boxEng
    function buildBox() {
        const host = document.createElement('div');
        host.setAttribute('data-lektor-ocr', '');
        host.style.cssText = 'all:initial;position:fixed;left:12px;bottom:12px;z-index:2147483646;';
        const root = host.attachShadow({ mode: 'closed' });
        root.innerHTML = '<style>.b{font:13px system-ui,sans-serif;color:#fff;background:rgba(20,10,28,.86);border:1px solid #a21caf;border-radius:8px;padding:6px 44px 6px 9px;max-width:46vw;box-shadow:0 2px 10px rgba(0,0,0,.4)}' +
            '.s{font-size:10px;color:#e9b5f5;margin-bottom:2px}.t{white-space:pre-wrap}.p{color:#ffee58;white-space:pre-wrap}.e{font-size:10px;color:#7dd3fc;white-space:pre-wrap}' +
            '.x,.r{position:absolute;top:4px;cursor:pointer;color:#e9b5f5;font:bold 13px sans-serif;border:0;background:none}.x{right:6px}.r{right:24px;font-size:12px}' +
            '.w{display:block;margin:2px 0 3px;font:11px system-ui,sans-serif;color:#fff;background:#2a1436;border:1px solid #a21caf;border-radius:4px;padding:1px 3px;cursor:pointer;max-width:100%}</style>' +
            '<div class="b"><button class="x" title="Wyłącz OCR">✕</button><div class="s"></div><select class="w" title="Kto tłumaczy obcy tekst z OCR — zmiana działa od razu"></select><div class="t" data-noi18n></div><div class="p" data-noi18n></div><div class="e"></div></div>';
        try { if (self.MLi18n) MLi18n.watch(root); } catch (e) {}   // [AGENT-EXP] 2026-10-21: okienko OCR PL / EN (.t / .p = napis — bez tłumaczenia)
        boxStatus = root.querySelector('.s'); boxText = root.querySelector('.t'); boxPl = root.querySelector('.p'); boxEng = root.querySelector('.e');
        root.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); stop(); });
        // [AGENT-EXP] 2026-10-17: wybór tłumacza w samym okienku OCR (ten sam ocrToolTr co w menu CC)
        boxTr = root.querySelector('.w');
        TR_CHOICES.forEach((p) => { const o = document.createElement('option'); o.value = p[0]; o.textContent = p[1]; boxTr.appendChild(o); });
        boxTr.value = st.tr;
        boxTr.addEventListener('change', (e) => { e.stopPropagation(); st.tr = trKey(boxTr.value); showEng('🌐 tłumacz: ' + trLabel()); try { chrome.storage.local.set({ ocrToolTr: st.tr }); } catch (e2) {} });
        // [AGENT-EXP] 2026-10-17: przycisk 🏁 usunięty z okienka (odpalał się przypadkiem przy przeciąganiu / ✕) — wyścig tylko z menu CC
        ['mousedown', 'pointerdown', 'dblclick', 'click'].forEach((n) => host.addEventListener(n, (e) => e.stopPropagation()));
        box = host;
        // [AGENT-EXP] (cz. 5) okienko da się przesunąć: chwyć za pasek stanu; dwuklik = domyślne miejsce (lewy dolny róg)
        const bar = root.querySelector('.s');
        bar.style.cursor = 'move';
        bar.title = 'Przeciągnij, żeby przesunąć okienko OCR · dwuklik = domyślne miejsce';
        bar.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const r = host.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
            const move = (ev) => { boxPos = clampBox(ev.clientX - dx, ev.clientY - dy); placeBox(); };
            const up = () => { window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); saveBoxPos(); };
            window.addEventListener('pointermove', move, true);
            window.addEventListener('pointerup', up, true);
        });
        bar.addEventListener('dblclick', () => { boxPos = null; saveBoxPos(); placeBox(); });
        placeBox();
    }
    let boxPos = null;   // [AGENT-EXP] { x, y } albo null = domyślnie
    function clampBox(x, y) {
        const w = (box && box.offsetWidth) || 220, h = (box && box.offsetHeight) || 40;
        return { x: Math.round(Math.max(0, Math.min(innerWidth - w, x))), y: Math.round(Math.max(0, Math.min(innerHeight - h, y))) };
    }
    function placeBox() {
        if (!box) return;
        if (boxPos) { const q = clampBox(boxPos.x, boxPos.y); box.style.left = q.x + 'px'; box.style.top = q.y + 'px'; box.style.bottom = 'auto'; }
        else { box.style.left = '12px'; box.style.top = 'auto'; box.style.bottom = '12px'; }
    }
    function saveBoxPos() {
        try {
            chrome.storage.local.get('ocrToolBoxPos', (r) => {
                const m = (r && r.ocrToolBoxPos) || {};
                if (boxPos) m[HOST] = boxPos; else delete m[HOST];
                chrome.storage.local.set({ ocrToolBoxPos: m });
            });
        } catch (e) {}
    }
    function mountTarget() {
        try { const fs = document.fullscreenElement; if (fs && fs.tagName !== 'VIDEO' && fs.tagName !== 'IFRAME') return fs; } catch (e) {}
        return document.documentElement;
    }
    function showBox(show) {
        if (show) { if (!box) buildBox(); const t = mountTarget(); if (box.parentNode !== t) t.appendChild(box); }
        else if (box && box.parentNode) box.parentNode.removeChild(box);
    }
    function setStatus(s) { st.status = s; if (boxStatus) boxStatus.textContent = 'OCR: ' + s; }
    function showText(t, pl) { if (boxText) boxText.textContent = t || ''; if (boxPl && pl !== undefined) boxPl.textContent = pl || ''; }
    function showEng(s) { if (boxEng) boxEng.textContent = s || ''; }   // [AGENT-EXP] kto przetłumaczył / ile ms / błąd

    // ---------- [AGENT-EXP] 2026-10-19: 🔠 duże napisy (tłumaczenie) na obrazie filmu ----------
    // Na dole filmu, wyśrodkowane, czcionka liczona od wysokości filmu (m / l / xl = 5,5 / 7 / 9 %). Element ma
    // data-lektor-ocr: zrzut ekranu OCR go chowa (OWN_UI), a skanery napisów lektora go pomijają — OCR nie czyta
    // własnego tłumaczenia. Gdy napis zniknie z ramki (cisza), tłumaczenie WISI jeszcze st.bigLinger ms (menu CC
    // „Napis zostaje po ciszy”, domyślnie 2,5 s) i nigdy krócej niż czas na przeczytanie (BIG_MIN_MS albo ~60 ms
    // na znak). Nowy napis od razu zastępuje stary. Bez nowego napisu znika najpóźniej po BIG_MAX_MS.
    const BIG_FONT = { m: 0.055, l: 0.07, xl: 0.09 }, BIG_MIN_MS = 3000, BIG_MS_PER_CHAR = 60, BIG_MAX_MS = 20000;
    let big = null, bigTxt = null, bigSeq = 0, bigAt = 0, bigHideT = 0, bigReadUntil = 0;
    function buildBig() {
        const host = document.createElement('div');
        host.setAttribute('data-lektor-ocr', '');
        host.style.cssText = 'all:initial;position:fixed;z-index:2147483645;pointer-events:none;display:none;text-align:center;';
        const root = host.attachShadow({ mode: 'closed' });
        root.innerHTML = '<style>.t{display:inline-block;max-width:100%;box-sizing:border-box;padding:.12em .45em;border-radius:.25em;'
            + 'background:rgba(0,0,0,.55);color:#fff;font-family:system-ui,"Segoe UI",Arial,sans-serif;font-weight:700;line-height:1.22;'
            + 'white-space:pre-wrap;overflow-wrap:break-word;text-shadow:0 0 3px #000,0 0 3px #000,2px 2px 2px #000}</style><div class="t"></div>';
        bigTxt = root.querySelector('.t');
        big = host;
    }
    function bigPlace() {
        if (!big || big.style.display === 'none') return;
        const v = bigVideo(); if (!v) return;
        const r = v.getBoundingClientRect();
        const fs = Math.round(Math.max(20, Math.min(96, r.height * (BIG_FONT[st.bigSize] || BIG_FONT.l))));
        big.style.left = Math.round(r.left + r.width * 0.04) + 'px';
        big.style.width = Math.round(r.width * 0.92) + 'px';
        big.style.bottom = Math.round(Math.max(0, innerHeight - r.bottom) + r.height * 0.07) + 'px';
        if (bigTxt) bigTxt.style.fontSize = fs + 'px';
        const t = mountTarget(); if (big.parentNode !== t) t.appendChild(big);
    }
    function bigShow(text) {
        if (!big) buildBig();
        clearTimeout(bigHideT);
        bigTxt.textContent = text;
        big.style.display = 'block';
        bigAt = Date.now();
        bigReadUntil = bigAt + Math.max(BIG_MIN_MS, String(text).length * BIG_MS_PER_CHAR);
        bigPlace();
        bigHideT = setTimeout(() => bigHide(true), BIG_MAX_MS);
    }
    function bigHide(now) {
        if (!big || big.style.display === 'none') return;
        clearTimeout(bigHideT);
        const left = now ? 0 : Math.max(st.bigLinger, bigReadUntil - Date.now());
        if (left > 0) { bigHideT = setTimeout(() => bigHide(true), left); return; }
        big.style.display = 'none';
    }
    ['resize', 'fullscreenchange', 'scroll'].forEach((n) => window.addEventListener(n, () => bigPlace(), true));

    // ---------- [AGENT-EXP] tłumaczenie kwestii wg „Kto tłumaczy” ----------
    const TR_CHOICES = [['lokalny', '💻 Lokalny (Translator Chrome, bez sieci)'], ['bing', '🌐 Bing'], ['google', '🌐 Google'], ['deepl', '🌐 DeepL'],
        ['skrypt', '⚙️ Silnik z ustawień (lokalny → Bing)'], ['strona', '📄 Tłumacz strony (Immersive / TWP)']];   // [AGENT-EXP] 2026-10-17
    function trLabel() { return st.tr === 'lokalny' ? 'tylko lokalny' : st.tr === 'deepl' ? 'DeepL' : st.tr === 'google' ? 'Google' : st.tr === 'bing' ? 'Bing' : st.tr === 'strona' ? 'tłumacz strony' : 'silnik z ustawień'; }
    function engName(e) { return ({ google: 'Google', bing: 'Bing', deepl: 'DeepL', ai: 'AI', gtab: 'Google (karta)', 'pamięć': 'pamięć tłumaczeń' })[e] || String(e || 'sieć'); }
    function trNet(text) {
        return send({ action: 'EXT_TR_LIVE', ocr: true, text, engine: (st.tr === 'google' || st.tr === 'bing' || st.tr === 'deepl') ? st.tr : undefined   /* [AGENT-EXP] + deepl */ })
            .then((r) => (r && r.ok && r.text ? { text: r.text, by: engName(r.engine) } : { error: (r && r.error) || 'brak odpowiedzi tłumacza' }));
    }
    // [AGENT-EXP] 2026-10-17: „Tłumaczy: tylko lokalny” — Translator Chrome w tej ramce (język z ustawienia OCR
    // albo z pisma), a gdy tu go nie ma — Translator Chrome w tle rozszerzenia (en→pl). NIGDY sieć.
    const OCR_TO_TR = { eng: 'en', deu: 'de', fra: 'fr', spa: 'es', ita: 'it', rus: 'ru', ukr: 'uk', jpn: 'ja', kor: 'ko', chi_sim: 'zh' };
    function locLang(text) {
        const t = String(text || '');
        if (/[぀-ヿ]/.test(t)) return 'ja';
        if (/[가-힯]/.test(t)) return 'ko';
        if (/[一-鿿]/.test(t)) return 'zh';
        if (/[Ѐ-ӿ]/.test(t)) return /[іїєґ]/i.test(t) ? 'uk' : 'ru';
        const lg = langs(), first = String(Array.isArray(lg) ? lg[0] : lg).split('+')[0];
        return OCR_TO_TR[first] || 'en';
    }
    const locTrs = {};
    async function trLocal(text) {
        const lang = locLang(text);
        if (typeof Translator !== 'undefined' && Translator.create) {
            try {
                if (!locTrs[lang]) {
                    const av = await tmo(Translator.availability({ sourceLanguage: lang, targetLanguage: 'pl' }), 5000, 'Translator Chrome');
                    if (av !== 'available') throw new Error(lang + '→pl: ' + (av === 'unavailable' ? 'nieobsługiwany' : 'pakiet niepobrany'));
                    locTrs[lang] = tmo(Translator.create({ sourceLanguage: lang, targetLanguage: 'pl' }), 20000, 'Translator Chrome');
                }
                const tr = await locTrs[lang];
                const out = String(await tmo(tr.translate(text), 10000, 'Translator Chrome') || '').trim();
                if (out) return { text: out, by: 'Translator Chrome (' + lang + ')' };
            } catch (e) {
                delete locTrs[lang];
                if (lang !== 'en') return { error: 'lokalny Translator: ' + String((e && e.message) || e).slice(0, 100) };
            }
        } else if (lang !== 'en') return { error: 'lokalny Translator niedostępny w tej ramce (umie tu tylko angielski)' };
        const r = await send({ action: 'EXT_TR_LIVE', ocr: true, text, engine: 'lokalny' });
        return r && r.ok && r.text ? { text: r.text, by: 'Translator Chrome (tło)' } : { error: 'lokalny Translator: ' + ((r && r.error) || 'brak odpowiedzi') };
    }
    async function trOne(text) {
        if (st.tr === 'lokalny') return trLocal(text);   // [AGENT-EXP]
        if (st.tr === 'strona' && Date.now() >= br.offUntil) {
            const r = await bridgeTranslate(text, BR_WAIT);
            if (r && r.text) { br.misses = 0; return { text: r.text, by: r.by }; }
            if (r && r.cancelled) return { error: 'OCR wyłączony' };
            if (++br.misses >= 3) br.offUntil = Date.now() + 60000;   // 3× cisza → minuta bez czekania
            const n = await trNet(text);
            if (n.text) n.by += Date.now() < br.offUntil ? ' (tłumacz strony milczy — włącz „Przetłumacz stronę”)' : ' (tłumacz strony nie zdążył)';
            return n;
        }
        return trNet(text);
    }

    // ---------- [AGENT-EXP] most: OCR → tłumacz strony (Immersive Translate / TWP) → lektor ----------
    // Okienko OCR jest w ZAMKNIĘTYM Shadow DOM — tłumacze strony go nie widzą. Most to zwykły, widoczny element
    // (tłumacze pomijają ukryte) nad okienkiem; data-lektor-ocr = chowany przy zrzucie ekranu i pomijany przez skanery
    // napisów lektora (dom_content / youtube_content / content), żeby tłumaczenie nie było czytane drugi raz.
    //  * Immersive Translate (dwujęzycznie) zostawia oryginał i DOKLEJA element „immersive-translate-target…”,
    //  * TWP / tłumacz Chrome podmieniają tekst w miejscu.
    // Każda kwestia ma swój numer — nowa przerywa czekanie na starą.
    // [AGENT-EXP] (2026-10-13, cz. 3) każda kwestia dostaje ŚWIEŻY element-linię w moście i czeka niezależnie.
    // Wcześniej wszystkie trafiały do jednego <span> (Immersive Translate oznacza przetłumaczone elementy i potrafi
    // pomijać zmiany w nich), a nowa kwestia przerywała czekanie na poprzednią — po 2–3 zdaniach most milkł.
    const BR_WAIT = 2500, BR_SETTLE = 300, BR_MAX = 3;
    const br = { el: null, misses: 0, offUntil: 0, stops: new Set() };
    function bridgeEl() {
        if (!br.el) {
            const el = document.createElement('div');
            el.setAttribute('data-lektor-ocr', 'most');
            el.setAttribute('translate', 'yes');
            el.style.cssText = 'all:initial;position:fixed;left:12px;bottom:70px;z-index:2147483645;max-width:46vw;font:13px system-ui,sans-serif;color:#e9d5ff;background:rgba(20,10,28,.86);border:1px dashed #a21caf;border-radius:8px;padding:4px 8px;white-space:pre-wrap;';
            br.el = el;
        }
        try {
            const b = box && box.isConnected && box.getBoundingClientRect();
            if (b && b.height) {
                br.el.style.left = Math.round(b.left) + 'px';   // [AGENT-EXP] (cz. 5) most idzie za przesuniętym okienkiem
                if (b.top > 90) { br.el.style.top = 'auto'; br.el.style.bottom = Math.round(innerHeight - b.top + 6) + 'px'; }
                else { br.el.style.bottom = 'auto'; br.el.style.top = Math.round(b.bottom + 6) + 'px'; }
            }
        } catch (e) {}
        const t = mountTarget(); if (br.el.parentNode !== t) t.appendChild(br.el);
        return br.el;
    }
    function bridgeHide() {
        br.stops.forEach((f) => f()); br.stops.clear();
        if (br.el) { br.el.textContent = ''; if (br.el.parentNode) br.el.parentNode.removeChild(br.el); }
    }
    function bridgeRead(root, raw) {
        const norm = (x) => String(x || '').replace(/\s+/g, ' ').trim();
        const src = norm(raw);
        const its = root.querySelectorAll('[class*="immersive-translate"]');
        if (its.length) {
            let best = '';
            its.forEach((el) => {
                const cls = el.getAttribute('class') || '';
                if (!/target/i.test(cls) || /loading|spinner|error/i.test(cls)) return;
                const t = norm(el.innerText || el.textContent);
                if (t.length > best.length) best = t;
            });
            return (best && best !== src) ? { text: best, by: 'Immersive Translate' } : null;
        }
        const all = norm(root.innerText || root.textContent);
        if (all && all !== src && !similar(all, src)) return { text: all, by: 'TWP / tłumacz strony' };
        return null;
    }
    // → { text, by, ms } | { cancelled: true } (OCR wyłączony) | null (brak tłumaczenia w czasie wait)
    function bridgeTranslate(raw, wait) {
        const el = bridgeEl(), t0 = Date.now();
        const line = document.createElement('div');   // świeży element na każdą kwestię
        line.textContent = raw;
        el.appendChild(line);
        while (el.children.length > BR_MAX) el.removeChild(el.firstChild);   // na ekranie najwyżej 3 ostatnie
        return new Promise((resolve) => {
            let res = null, firstAt = 0, settle = 0, hard = 0, done = false, obs = null;
            const fin = (v) => {
                if (done) return; done = true;
                if (obs) obs.disconnect(); clearTimeout(settle); clearTimeout(hard);
                br.stops.delete(stop);
                resolve(v);
            };
            const stop = () => fin({ cancelled: true });
            obs = new MutationObserver(() => {
                const r = bridgeRead(line, raw);
                if (!r) return;
                res = r; if (!firstAt) firstAt = Date.now();
                clearTimeout(settle);
                settle = setTimeout(() => fin({ text: res.text, by: res.by, ms: firstAt - t0 }), BR_SETTLE);   // tłumaczenie bywa wpisywane kawałkami
            });
            obs.observe(line, { childList: true, subtree: true, characterData: true });
            hard = setTimeout(() => fin(res ? { text: res.text, by: res.by, ms: firstAt - t0 } : null), wait || BR_WAIT);
            br.stops.add(stop);
        });
    }

    // ---------- [AGENT-EXP] 🏁 WYŚCIG TŁUMACZY — czas dostarczenia polskiego napisu ----------
    // Każdy tłumacz dostaje 8 NOWYCH linii (8 języków; liczby w zdaniach, żeby nic nie pochodziło z pamięci).
    // Czas = od wysłania linii do gotowego polskiego tekstu (z drogą okienko → tło rozszerzenia → sieć).
    const RACE_LINES = [
        'The train leaves at {n} past nine, so hurry up.',
        'She told me she saw {n} birds on the roof yesterday.',
        'Wir treffen uns um {n} Uhr vor dem alten Bahnhof.',
        'Necesito {n} minutos más para terminar este trabajo.',
        'Il y avait {n} personnes dans la salle hier soir.',
        '駅まで{n}分かかります。',
        'У нас осталось {n} патронов, не больше.',
        '我等了你{n}分钟。'
    ];
    let raceBusy = false;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    function raceLines(k) { const base = (Date.now() % 100000) + k * 100; return RACE_LINES.map((x, i) => x.replace('{n}', String(base + i))); }
    function raceStats(ms) { const a = ms.slice().sort((x, y) => x - y); return a.length ? { med: Math.round(a[(a.length - 1) >> 1]), max: Math.round(a[a.length - 1]) } : null; }
    async function raceNet(engine, lines, sink, upd) {
        for (const q of lines) {
            const t0 = performance.now();
            const r = await send({ action: 'EXT_TR_RACE_ONE', engine, text: q });
            sink.push(r && r.ok && r.text ? { ms: performance.now() - t0, text: r.text } : { err: (r && r.error) || 'brak odpowiedzi' });
            upd(); await sleep(300);
        }
    }
    // Model Chrome bywa niegotowy i wtedy availability()/create() potrafią nie odpowiedzieć NIGDY — każde
    // wywołanie ma limit czasu; po zawieszeniu ten wiersz kończy się błędem, a wyścig idzie dalej.
    function tmo(p, ms, what) {
        return new Promise((res, rej) => {
            const tm = setTimeout(() => rej(Object.assign(new Error(what + ' nie odpowiada (' + Math.round(ms / 1000) + ' s)'), { hang: true })), ms);
            Promise.resolve(p).then((v) => { clearTimeout(tm); res(v); }, (e) => { clearTimeout(tm); rej(e); });
        });
    }
    async function raceLocal(lines, sink, upd) {
        if (typeof Translator === 'undefined' || !Translator.create) { sink.push({ err: 'Translator Chrome niedostępny tutaj (Chrome 138+)' }); upd(); return; }
        let det = null;
        try { if (typeof LanguageDetector !== 'undefined' && LanguageDetector.create) det = await tmo(LanguageDetector.create(), 4000, 'Wykrywacz języka'); } catch (e) { det = null; }
        const trs = {};
        for (const q of lines) {
            const t0 = performance.now(); let made = 0;
            try {
                let lang = 'en';
                if (det) { const d = await tmo(det.detect(q), 3000, 'Wykrywacz języka'); if (d && d[0] && d[0].detectedLanguage && d[0].detectedLanguage !== 'und') lang = String(d[0].detectedLanguage).split('-')[0]; }
                if (!trs[lang]) {   // tworzenie tłumacza (raz na język) nie wlicza się do czasu kwestii
                    const tc = performance.now();
                    const av = await tmo(Translator.availability({ sourceLanguage: lang, targetLanguage: 'pl' }), 5000, 'Translator Chrome');
                    if (av !== 'available') throw new Error(lang + '→pl: ' + (av === 'unavailable' ? 'nieobsługiwany' : 'pakiet niepobrany'));
                    trs[lang] = await tmo(Translator.create({ sourceLanguage: lang, targetLanguage: 'pl' }), 20000, 'Translator Chrome');
                    made = performance.now() - tc;
                }
                const out = await tmo(trs[lang].translate(q), 10000, 'Translator Chrome');
                sink.push({ ms: performance.now() - t0 - made, text: String(out || '').trim() });
            } catch (e) {
                sink.push({ err: String((e && e.message) || e).slice(0, 120) });
                if (e && e.hang) { upd(); break; }   // zawieszony model — dalsze linie też by wisiały
            }
            upd(); await sleep(300);
        }
        Object.keys(trs).forEach((k) => { try { trs[k].destroy(); } catch (e) {} });
    }
    async function racePage(lines, sink, upd) {
        let misses = 0;
        try {
            for (const q of lines) {
                const r = await bridgeTranslate(q, 5000);
                if (r && r.text) { sink.push({ ms: r.ms, text: r.text + '  [' + r.by + ']' }); misses = 0; }
                else {
                    sink.push({ err: 'brak tłumaczenia w 5 s' });
                    if (++misses >= 2) { sink.push({ err: 'tłumacz strony nie odpowiada — włącz na tej stronie „Przetłumacz stronę” w Immersive Translate / TWP' }); upd(); break; }
                }
                upd(); await sleep(300);
            }
        } finally { if (!(st.on && st.tr === 'strona')) bridgeHide(); }
    }
    let raceHost = null, raceRoot = null;
    function raceShow(rows, done) {
        if (!raceHost) {
            raceHost = document.createElement('div');
            raceHost.setAttribute('data-lektor-ocr', 'wyscig');
            raceHost.style.cssText = 'all:initial;position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:2147483647;';
            raceRoot = raceHost.attachShadow({ mode: 'closed' });
            try { if (self.MLi18n) MLi18n.watch(raceRoot); } catch (e) {}   // [AGENT-EXP] 2026-10-21: język interfejsu (PL / EN)
            ['mousedown', 'pointerdown', 'click', 'dblclick'].forEach((n) => raceHost.addEventListener(n, (e) => e.stopPropagation()));
        }
        const t = mountTarget(); if (raceHost.parentNode !== t) t.appendChild(raceHost);
        const mk = (tag, css, txt) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (txt != null) e.textContent = txt; return e; };
        raceRoot.textContent = '';
        const box2 = raceRoot.appendChild(mk('div', 'width:min(760px,94vw);max-height:80vh;overflow:auto;background:rgba(17,17,17,.97);border:1px solid #a21caf;border-radius:8px;padding:10px 12px;font:12px system-ui,sans-serif;color:#fff;box-shadow:0 4px 18px rgba(0,0,0,.5);box-sizing:border-box;'));
        const head = box2.appendChild(mk('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;'));
        head.appendChild(mk('strong', 'color:#e9b5f5;font-size:13px;', done ? '🏁 Wyścig tłumaczy — wyniki' : '🏁 Wyścig tłumaczy — trwa…'));
        const x = head.appendChild(mk('button', 'background:#111;color:#f66;border:1px solid #f66;cursor:pointer;font:11px sans-serif;padding:1px 6px;border-radius:3px;', '✕'));
        x.addEventListener('click', () => { if (raceHost.parentNode) raceHost.parentNode.removeChild(raceHost); });
        const stats = rows.map((r) => raceStats(r.res.filter((v) => v.ms != null).map((v) => v.ms)));
        let best = -1;
        rows.forEach((r, i) => { const ok = r.res.filter((v) => v.ms != null).length; if (stats[i] && ok >= r.total / 2 && (best < 0 || stats[i].med < stats[best].med)) best = i; });
        const tb = box2.appendChild(mk('table', 'width:100%;border-collapse:collapse;'));
        const th = tb.appendChild(mk('tr'));
        ['Tłumacz', 'OK', 'Mediana', 'Najwolniej', 'Przykład / błąd'].forEach((s) => th.appendChild(mk('th', 'text-align:left;border-bottom:1px solid #555;padding:3px 6px;color:#aaa;font-weight:normal;', s)));
        rows.forEach((r, i) => {
            const ok = r.res.filter((v) => v.ms != null);
            const err = (r.res.filter((v) => v.err).pop() || {}).err || '';
            const tr = tb.appendChild(mk('tr', i === best && done ? 'background:rgba(34,197,94,.18);' : ''));
            const td = (s, css) => tr.appendChild(mk('td', 'padding:3px 6px;border-bottom:1px solid #333;vertical-align:top;' + (css || ''), s));
            td((i === best && done ? '🥇 ' : '') + r.name);
            td(r.state === 'czeka' ? '—' : ok.length + '/' + r.total + (r.state === 'trwa' ? ' …' : ''));
            td(stats[i] ? stats[i].med + ' ms' : '—', 'font-weight:bold;');
            td(stats[i] ? stats[i].max + ' ms' : '—');
            td(ok.length ? ok[ok.length - 1].text + (err ? '  ⚠️ ' + err : '') : (err || (r.state === 'trwa' ? '…' : '')), 'color:' + (ok.length ? '#ddd' : '#f99') + ';');
        });
        box2.appendChild(mk('div', 'margin-top:8px;color:#aaa;line-height:1.4;',
            'Czas = od wysłania linii do gotowego polskiego tekstu (mediana z 8 linii w 8 językach). Przy tłumaczu strony doliczyć +300 ms '
            + '(OCR czeka, aż skończy wpisywać). Tłumacz strony mierzy się tylko z włączonym „Przetłumacz stronę” w Immersive Translate / TWP.'));
        if (rows.hid) box2.appendChild(mk('div', 'margin-top:6px;color:#fca5a5;line-height:1.4;',
            '⚠️ Karta była w tle — Chrome spowalnia wtedy liczniki czasu i tłumacza strony, więc czasy są zawyżone. Uruchom wyścig przy widocznej karcie.'));
    }
    async function race() {
        if (raceBusy) return;
        raceBusy = true;
        const C = [
            ['Translator Chrome (lokalny)', (l, k, u) => raceLocal(l, k, u)],
            ['Google — bezpośrednio (gtx)', (l, k, u) => raceNet('google', l, k, u)],
            ['Bing (Microsoft)', (l, k, u) => raceNet('bing', l, k, u)],
            ['DeepL (bez klucza)', (l, k, u) => raceNet('deepl', l, k, u)],
            ['Tłumacz strony (Immersive / TWP)', (l, k, u) => racePage(l, k, u)]
        ];
        const rows = C.map((c) => ({ name: c[0], res: [], total: RACE_LINES.length, state: 'czeka' }));
        rows.hid = document.visibilityState !== 'visible';
        const onVis = () => { if (document.visibilityState !== 'visible') rows.hid = true; };
        document.addEventListener('visibilitychange', onVis);
        try {
            for (let i = 0; i < C.length; i++) {
                rows[i].state = 'trwa'; raceShow(rows, false);
                try { await C[i][1](raceLines(i + 1), rows[i].res, () => raceShow(rows, false)); }
                catch (e) { rows[i].res.push({ err: String((e && e.message) || e) }); }
                rows[i].state = 'koniec';
            }
            raceShow(rows, true);
        } finally { raceBusy = false; document.removeEventListener('visibilitychange', onVis); }
    }
    function ui() { showBox(st.on); setStatus(st.status); }
    document.addEventListener('fullscreenchange', () => { if (st.on) showBox(true); });

    // ---------- ramka zrzutu (przesuń / zmień rozmiar nad filmem) ----------
    function videoBox(v) {
        const r = v.getBoundingClientRect(), vw = v.videoWidth || r.width, vh = v.videoHeight || r.height;
        const s = Math.min(r.width / vw, r.height / vh), w = vw * s, h = vh * s;
        return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
    }
    function frameEdit() {
        const v = bigVideo();
        if (!v) { setStatus('Nie widzę filmu — włącz odtwarzanie.'); showBox(true); return; }
        const old = document.getElementById('lektor-ocr-frame'); if (old) old.remove();
        const vb = videoBox(v);
        let reg = st.region.slice();
        const css = (el, o) => Object.keys(o).forEach((k) => el.style.setProperty(k, o[k], 'important'));
        // [EKRAN] główna ramka: edytor na CAŁY ekran — ramkę można zsunąć na czarny pasek pod filmem itd.
        const area = IS_TOP ? { left: 0, top: 0, width: innerWidth, height: innerHeight } : vb;
        const lim = IS_TOP
            ? { x0: -vb.left / vb.width, x1: (innerWidth - vb.left) / vb.width, y0: -vb.top / vb.height, y1: (innerHeight - vb.top) / vb.height }
            : { x0: 0, x1: 1, y0: 0, y1: 1 };
        const ov = document.createElement('div'); ov.id = 'lektor-ocr-frame';
        try { if (self.MLi18n) MLi18n.watch(ov); } catch (e) {}   // [AGENT-EXP] 2026-10-21: język interfejsu (PL / EN)
        css(ov, { position: 'fixed', left: area.left + 'px', top: area.top + 'px', width: area.width + 'px', height: area.height + 'px', 'z-index': '2147483647', background: 'rgba(0,0,0,.35)', 'box-sizing': 'border-box' });
        const pic = document.createElement('div');   // obraz filmu (przerywana linia)
        css(pic, { position: 'absolute', left: (vb.left - area.left) + 'px', top: (vb.top - area.top) + 'px', width: vb.width + 'px', height: vb.height + 'px', outline: '1px dashed rgba(255,255,255,.6)', 'pointer-events': 'none' });
        ov.appendChild(pic);
        const hint = document.createElement('div');
        hint.textContent = IS_TOP ? 'Przerywana linia = obraz filmu. Ramka może wyjść poza obraz (np. czarny pasek z napisami) — wtedy OCR robi zrzut ekranu.' : 'Ramka w obrębie obrazu filmu.';
        css(hint, { position: 'absolute', left: '8px', bottom: '8px', font: '12px sans-serif', color: '#fff', background: 'rgba(0,0,0,.6)', padding: '3px 7px', 'border-radius': '4px', 'pointer-events': 'none', 'max-width': '60%' });
        ov.appendChild(hint);
        const fr = document.createElement('div');
        css(fr, { position: 'absolute', border: '2px solid #e879f9', background: 'rgba(232,121,249,.12)', cursor: 'move', 'box-sizing': 'border-box' });
        const lab = document.createElement('div'); lab.textContent = 'Ramka OCR — przeciągnij, rogi zmieniają rozmiar';
        css(lab, { position: 'absolute', left: '0', top: '-22px', font: '12px sans-serif', color: '#fff', background: '#a21caf', padding: '2px 6px', 'border-radius': '4px', 'white-space': 'nowrap', 'pointer-events': 'none' });
        fr.appendChild(lab);
        const place = () => {
            css(fr, { left: (vb.left - area.left + reg[0] * vb.width) + 'px', top: (vb.top - area.top + reg[1] * vb.height) + 'px', width: (reg[2] * vb.width) + 'px', height: (reg[3] * vb.height) + 'px' });
            lab.textContent = inPicture(reg) ? 'Ramka OCR — obraz filmu' : 'Ramka OCR — poza obrazem: zrzut ekranu';
        };
        const corners = { nw: [0, 0], ne: [1, 0], sw: [0, 1], se: [1, 1] };
        Object.keys(corners).forEach((k) => {
            const c = document.createElement('div'); c.dataset.corner = k;
            css(c, { position: 'absolute', width: '14px', height: '14px', background: '#e879f9', border: '2px solid #fff', 'border-radius': '50%', left: 'calc(' + (corners[k][0] * 100) + '% - 8px)', top: 'calc(' + (corners[k][1] * 100) + '% - 8px)', cursor: (k === 'nw' || k === 'se') ? 'nwse-resize' : 'nesw-resize' });
            fr.appendChild(c);
        });
        const bar = document.createElement('div'); css(bar, { position: 'absolute', right: '8px', top: '8px', display: 'flex', gap: '6px' });
        const mkb = (t, fn, bg) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = t; css(b, { font: 'bold 12px sans-serif', padding: '5px 10px', 'border-radius': '6px', border: '1px solid #fff', background: bg, color: '#fff', cursor: 'pointer' }); b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b; };
        const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
        const close = () => { ov.remove(); window.removeEventListener('keydown', onKey, true); };
        bar.appendChild(mkb('✓ Zapisz', () => {
            st.region = reg.map((x) => Math.round(x * 1000) / 1000); st.sig = null; st.afScreen = false;   // [AGENT-EXP] ręczna ramka
            try { chrome.storage.local.get('ocrToolRegions', (r) => { const m = (r && r.ocrToolRegions) || {}; m[HOST] = st.region; chrome.storage.local.set({ ocrToolRegions: m }); }); } catch (e) {}
            close();
        }, '#a21caf'));
        bar.appendChild(mkb('Domyślna', () => { reg = DEF_REGION.slice(); place(); }, '#444'));
        bar.appendChild(mkb('✕ Anuluj', close, '#444'));
        ov.appendChild(fr); ov.appendChild(bar); place();
        let drag = null;
        fr.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); drag = { corner: e.target.dataset && e.target.dataset.corner, x: e.clientX, y: e.clientY, r: reg.slice() }; try { fr.setPointerCapture(e.pointerId); } catch (e2) {} });
        fr.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const dx = (e.clientX - drag.x) / vb.width, dy = (e.clientY - drag.y) / vb.height, r = drag.r, MIN = 0.04;
            let x = r[0], y = r[1], w = r[2], h = r[3];
            if (!drag.corner) { x = Math.min(Math.max(lim.x0, r[0] + dx), lim.x1 - w); y = Math.min(Math.max(lim.y0, r[1] + dy), lim.y1 - h); }
            else {
                if (drag.corner.indexOf('w') !== -1) { x = Math.min(Math.max(lim.x0, r[0] + dx), r[0] + r[2] - MIN); w = r[0] + r[2] - x; }
                if (drag.corner.indexOf('e') !== -1) { w = Math.min(Math.max(MIN, r[2] + dx), lim.x1 - r[0]); }
                if (drag.corner.indexOf('n') !== -1) { y = Math.min(Math.max(lim.y0, r[1] + dy), r[1] + r[3] - MIN); h = r[1] + r[3] - y; }
                if (drag.corner.indexOf('s') !== -1) { h = Math.min(Math.max(MIN, r[3] + dy), lim.y1 - r[1]); }
            }
            reg = [x, y, w, h]; place();
        });
        const end = () => { drag = null; };
        fr.addEventListener('pointerup', end); fr.addEventListener('pointercancel', end);
        ['click', 'mousedown', 'dblclick'].forEach((t) => ov.addEventListener(t, (e) => e.stopPropagation()));
        window.addEventListener('keydown', onKey, true);
        mountTarget().appendChild(ov);
    }

    // ---------- komendy z menu przycisku CC (odpowiada tylko ramka, w której jest film) ----------
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || msg.action !== 'OCR_TOOL') return;
        if (!bigVideo() && !st.on) return; // ta ramka nie ma filmu — odpowie inna
        if (msg.cmd === 'toggle') { if (st.on) stop(); else start(); }
        else if (msg.cmd === 'start') start();
        else if (msg.cmd === 'stop') stop();
        else if (msg.cmd === 'frame') frameEdit();
        else if (msg.cmd === 'race') race();   // [AGENT-EXP] 🏁 z menu CC
        sendResponse({ ok: true, on: st.on, langs: langs(), status: st.status });
        return true;
    });
})();
