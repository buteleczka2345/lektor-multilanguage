// options_hooks.js — OPTIONS-PAGE: wspólne ustawienia ze strony opcji dla skryptów treści.
// Wstrzykiwany jako pierwszy w grupie (ten sam izolowany świat → window.__LivedubOpts widzą
// youtube_content.js, dom_content.js, content.js, sub_panel.js).
// Zawiera: opcje (chrome.storage.local), listy domen (białą/czarną — kod w domain_lists.js), selektory Kreatora napisów
// oraz obsługę poleceń z strony opcji (test selektora, szukanie tekstu, wskazanie myszką).
(function () {
    'use strict';
    if (window.__LivedubOpts) return;

    var DEF = {
        singleTabMode: true,          // tylko jedna karta naraz (audio focus)
        autoMuteHidden: true,         // wyciszaj kartę w tle
        pauseVideoWithLektor: false,  // pauzuj film razem z lektorem
        readToEnd: false,             // [AGENT-EXP] 2026-10-22: lektor czyta zawsze do końca (bez pomijania, pauza dokańcza zdanie)
        detectYTPolish: true,         // wyłącz przy polskim dubbingu
        detectYTPolishChannel: true,  // wyłącz na polskich kanałach/filmach
        soundCuesFilter: true,        // pomijaj (wiatr), [muzyka], ♪
        extTrOn: false,             // EXT-TRANSLATE: eksperymentalne tłumaczenie sieciowe (domyślnie WYŁ.)
        extTrEngine: 'rotacja',     // 'rotacja' | 'google' | 'gtab' | 'bing' | 'deepl'
        autoSubsOn: true,           // [FIX 2026-11-16] auto-pobieranie całych napisów (iQIYI, WeTV, Viki, Bilibili) — domyślnie WŁ.
        extTrChunk: 'mieszane',     // '100' | '300' | '400' | 'mieszane'
        extTrInterval: '30s',       // '20s' | '30s' | '1min' | '2min' | '3min' | '4min' | '5min'   [AGENT-EXP] 2026-10-17
        // [AGENT-EXP] nowe opcje eksperymentalne (domyślnie WYŁ. = zachowanie jak przed zmianą)
        extTrStopWithLektor: false, // zatrzymaj tłumaczenie sieciowe razem z wyłączeniem lektora
        extTrMicrosoftBatch: false, // Microsoft/Bing: czysta tablica + limit 7 żąd./1250 ms (styl Immersive)
        extTrContext: true,         // [AGENT-EXP] 2026-10-17: tłumacz dostaje kwestie blokami do pauzy w mowie (kontekst)
        extTrJoinSentences: true,   // [AGENT-EXP] 2026-10-15: całe zdania do tłumacza (skrypty czytają też chrome.storage same)
        extTrNonEnCloud: true,      // [AGENT-EXP] 2026-10-15: „lokalny” — angielski Translatorem Chrome, inne języki Bingiem
        ytTlangPl: true,            // [AGENT-EXP] 2026-10-21: YouTube — najpierw polska wersja od YouTube (tlang=pl, jak Live Dubbing)
        // [AGENT-EXP] silnik AI (OpenAI-compatible) — CometAPI domyślnie, z.ai przez zmianę URL
        aiOn: false,
        aiApiUrl: 'https://api.cometapi.com/v1/chat/completions',
        aiApiKey: '',
        aiModel: 'gpt-oss-20b-free',
        uiScale: 100,                 // skala panelu w %
        captionOverlay: false,        // nakładka z czytanym tekstem
        domainListsOn: true,          // [FIX 2026-11-02] 📋 lektor tylko na domenach z białej listy (domyślnie WŁ.)
        domainWhitelist: '',
        domainBlacklist: '',
        customSources: {},            // { host: [selektory] }
        customSourcesOn: {}           // { host: true|false }
    };
    var KEYS = Object.keys(DEF);
    var o = {};
    KEYS.forEach(function (k) { o[k] = DEF[k]; });
    var listeners = [];
    var sleepCbs = [], lastAsleep = false;   // [FIX 2026-11-02] onSleep — patrz checkSleep()

    function fire() { listeners.forEach(function (f) { try { f(o); } catch (e) {} }); checkSleep(); }

    try {
        chrome.storage.local.get(KEYS, function (r) {
            r = r || {};
            KEYS.forEach(function (k) { if (r[k] !== undefined) o[k] = r[k]; });
            fire();
        });
        chrome.storage.onChanged.addListener(function (ch, area) {
            if (area !== 'local') return;
            var any = false;
            KEYS.forEach(function (k) { if (ch[k] !== undefined) { o[k] = ch[k].newValue === undefined ? DEF[k] : ch[k].newValue; any = true; } });
            if (any) fire();
        });
    } catch (e) {}

    function host() {
        try { return location.hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; }
    }
    // [FIX 2026-11-02] Listy domen: wspólny kod w assets/domain_lists.js (wczytywany tuż przed tym plikiem).
    // Liczy się strona z paska adresu — odtwarzacz w ramce z innej domeny działa razem ze stroną (dawniej ramka
    // player.vimeo.com na cda.pl z białej listy spała), czarna lista obejmuje też domenę ramki; port i adres są obcinane.
    function domains() { return window.__LektorDomains || null; }
    function topHost() {
        try { if (window === window.top) return host(); } catch (e) {}
        try {
            var ao = location.ancestorOrigins;
            if (ao && ao.length) return new URL(ao[ao.length - 1]).hostname.replace(/^www\./, '').toLowerCase();
        } catch (e) {}
        try { return window.top.location.hostname.replace(/^www\./, '').toLowerCase(); } catch (e) {}
        return '';
    }
    function domainState() {
        var D = domains();
        return D ? D.state(topHost(), host(), o) : { asleep: false, why: '' };
    }
    function asleep() { return domainState().asleep; }
    // Zmiana stanu (lista / przełącznik zmienione na otwartej karcie) → skrypty lektora usypiają się albo wracają
    // do stanu z popupu. Start: zakładamy „nie śpi” — powiadomienie przychodzi tylko przy zmianie.
    function checkSleep() {
        var a = asleep();
        if (a === lastAsleep) return;
        lastAsleep = a;
        sleepCbs.forEach(function (f) { try { f(a); } catch (e) {} });
    }
    // [FIX 2026-11-02] błędny selektor odrzucamy tutaj — w dom_content.js selektory idą jedną listą (a, b, c),
    // więc jeden zły wpis wyłączał czytanie WSZYSTKICH napisów Immersive Translate na tej domenie
    function validSelector(sel) {
        try { document.createDocumentFragment().querySelector(sel); return true; } catch (e) { return false; }
    }
    function customSelectors() {
        var h = host();
        if (o.customSourcesOn && o.customSourcesOn[h] === false) return [];
        var l = o.customSources && o.customSources[h];
        return Array.isArray(l) ? l.filter(function (s) { return typeof s === 'string' && s.trim() && validSelector(s); }) : [];
    }

    window.__LivedubOpts = {
        get: function (k) { return o[k]; },
        all: function () { return o; },
        host: host,
        topHost: topHost,
        asleep: asleep,
        domainState: domainState,
        onSleep: function (f) { sleepCbs.push(f); },   // f(true) = uśpij lektora, f(false) = obudź (stan z popupu)
        customSelectors: customSelectors,
        onChange: function (f) { listeners.push(f); try { f(o); } catch (e) {} }
    };

    // ---------------- Kreator napisów: polecenia ze strony opcji ----------------
    // [FIX 2026-11-02] 🎯 „Wskaż myszką” od nowa. Dawniej klik brał element pod kursorem: gdy warstwa napisów nie
    // przyjmuje kliknięć (pointer-events: none — tak ma większość odtwarzaczy), łapał się sam film (#v) i lektor nic nie
    // czytał; gdy przyjmuje — łapała się JEDNA linia (span.linia), a selektor pasował też do tekstów obok napisów.
    // Teraz: niebieska RAMKA pokazuje pod kursorem, co lektor złapie (z podglądem tekstu) — napis szukany jest po
    // położeniu tekstu na ekranie, więc działa też przez warstwy bez kliknięć i w ramkach odtwarzaczy (wskazywanie
    // rusza we wszystkich ramkach karty). Domyślnie ramka obejmuje cały napis (wszystkie linie). Kółko myszy albo ↑ ↓
    // — szerzej / węziej, klik albo Enter — wybierz, Esc — anuluj. Selektor jest zawężany przodkami, aż przestanie
    // pasować do tekstów poza napisem; jeśli dalej pasuje gdzie indziej, te miejsca mają pomarańczowe ramki.
    // Na czas wskazywania film w tej ramce stoi (pauza), żeby napis nie znikał; potem gra dalej.
    function txt(el) { return String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim(); }
    function stableId(id) { return !!id && id.length <= 40 && !/\d{3,}/.test(id); }
    function stableClasses(el) {
        var cls = typeof el.className === 'string' ? el.className : ((el.getAttribute && el.getAttribute('class')) || '');
        return cls.split(/\s+/).filter(function (c) {
            return c && c.length <= 40 && !/\d{3,}/.test(c) && !/^(css|sc|jsx|svelte|emotion)-/i.test(c)
                && !/^(is-|has-)?(active|hover|focus|focused|visible|hidden|show|shown|open|selected|playing|paused)$/i.test(c);
        });
    }
    function cssPath(el) {   // jeden poziom: #id albo znacznik.klasa.klasa
        if (!el || el.nodeType !== 1) return '';
        if (stableId(el.id)) return '#' + CSS.escape(el.id);
        return el.tagName.toLowerCase() + stableClasses(el).slice(0, 2).map(function (c) { return '.' + CSS.escape(c); }).join('');
    }
    function rootOf(el) { var r = el.getRootNode ? el.getRootNode() : document; return r && r.querySelectorAll ? r : document; }
    function lca(a, b) {
        var up = [];
        for (var x = a; x; x = x.parentElement) up.push(x);
        for (var y = b; y; y = y.parentElement) if (up.indexOf(y) !== -1) return y;
        return null;
    }
    function depthTo(el, anc) { var d = 0; for (var x = el; x && x !== anc; x = x.parentElement) d++; return d; }
    // linie jednego napisu: wspólny przodek najwyżej 2 poziomy wyżej
    function sameBlock(a, b) { var c = lca(a, b); return !!c && depthTo(a, c) <= 2 && depthTo(b, c) <= 2; }
    function partOfPick(m, el) { return m === el || el.contains(m) || m.contains(el) || sameBlock(m, el); }
    function matchesOf(sel, el) { try { return Array.prototype.slice.call(rootOf(el).querySelectorAll(sel)); } catch (e) { return []; } }
    // Selektor wskazanego miejsca: od samego elementu w górę (przodkowie z klasą / id), aż pasuje tylko do napisu.
    function buildSelector(el) {
        var parts = [], cur = el, best = '';
        for (var depth = 0; cur && cur.nodeType === 1 && depth < 7; depth++) {
            var p = cssPath(cur);
            if (depth === 0 || p.indexOf('.') !== -1 || p.charAt(0) === '#') {   // goły znacznik przodka (div) nic nie zawęża
                parts.unshift(p);
                best = parts.join(' ');
                var m = matchesOf(best, el);
                if (m.length && m.every(function (x) { return partOfPick(x, el); })) return best;
                if (p.charAt(0) === '#') break;
            }
            cur = cur.parentElement;
            if (!cur || cur === document.body || cur === document.documentElement) break;
        }
        return best;
    }
    function visibleRect(el) {
        if (!el || el.nodeType !== 1) return null;
        var cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return null;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? r : null;
    }
    // Tekst pod punktem — po położeniu (Range), nie po kliknięciu: działa też przez pointer-events: none.
    var pickRange = null;
    function textAt(root, x, y, budget) {
        var best = null, bestArea = Infinity, seen = 0;
        function walk(r) {
            var w;
            try { w = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT); } catch (e) { return; }
            var n;
            while ((n = w.nextNode()) && seen < budget) {
                if (n.nodeType === 1) { if (n.shadowRoot) walk(n.shadowRoot); continue; }
                seen++;
                if (!n.nodeValue || !n.nodeValue.trim() || !n.parentElement) continue;
                pickRange = pickRange || document.createRange();
                pickRange.selectNodeContents(n);
                var rs = pickRange.getClientRects();
                for (var i = 0; i < rs.length; i++) {
                    var q = rs[i];
                    if (x < q.left - 2 || x > q.right + 2 || y < q.top - 2 || y > q.bottom + 2) continue;
                    var a = q.width * q.height, pe = n.parentElement;
                    if (a < bestArea && !(pe.closest && pe.closest('[data-lektor-pick]')) && visibleRect(pe)) { best = pe; bestArea = a; }
                }
            }
        }
        walk(root);
        return best;
    }
    function hitAt(x, y) {
        var stack = [];
        try { stack = document.elementsFromPoint(x, y) || []; } catch (e) {}
        for (var i = 0, tried = 0; i < stack.length && tried < 6; i++) {
            var el = stack[i];
            if (el === document.documentElement || el === document.body) break;
            if (el.closest && el.closest('[data-lektor-pick]')) continue;
            tried++;
            var t = textAt(el, x, y, 3000);
            if (t) return t;
        }
        return textAt(document.body || document.documentElement, x, y, 8000);
    }
    function chainFor(el) {
        var chain = [], cur = el;
        while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement && chain.length < 12) {
            chain.push(cur);
            cur = cur.parentElement;
        }
        return chain;
    }
    // Domyślna ramka: najniższy przodek z CAŁYM napisem (wszystkie linie) — bez odtwarzacza, przycisków i dużych bloków.
    function autoLevel(chain) {
        var vh = window.innerHeight || 800, best = 0, bestLen = txt(chain[0]).length;
        for (var i = 1; i < chain.length; i++) {
            var p = chain[i];
            if (p.querySelector('video, canvas, iframe, button, input, select, textarea')) break;
            var r = p.getBoundingClientRect();
            if (r.height > vh * 0.4) break;
            var len = txt(p).length;
            if (len > 400) break;
            if (len > bestLen) { best = i; bestLen = len; }
        }
        return best;
    }
    function flash(el) {
        try {
            var old = el.style.outline;
            el.style.outline = '3px solid #4da3ff';
            setTimeout(function () { el.style.outline = old; }, 3000);
        } catch (e) {}
    }
    // [FIX 2026-11-10] 🎯 wskazanie napisów z POPUPU: popup zamyka się przy kliknięciu w stronę, więc zapis robi tło
    // (background.js: kreatorSavePick). Tu tylko potwierdzenie na ekranie — inaczej użytkownik nie widzi, że zapisano.
    // [FIX 2026-11-22] err = wybór NIE zapisany (np. po czasie) — czerwony toast zamiast milczenia
    function kreatorToast(sel, h, err) {
        var old = document.getElementById('lektor-kreator-toast');
        if (old) { try { old.remove(); } catch (e) {} }
        var t = document.createElement('div');
        t.id = 'lektor-kreator-toast';
        t.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483647;max-width:92vw;'
            + 'background:#0b1726;color:#e8f1ff;font:13px/1.35 system-ui,sans-serif;padding:8px 14px;border-radius:9px;'
            + 'border:2px solid ' + (err ? '#f87171' : '#34d399') + ';box-shadow:0 6px 22px rgba(0,0,0,.5);white-space:normal;box-sizing:border-box;';
        var head = document.createElement('b');
        head.textContent = err ? ('⚠ Nie zapisano — ' + err) : '💾 Zapisano — lektor czyta z tego miejsca';
        t.appendChild(head);
        var code = document.createElement('span');
        code.setAttribute('data-noi18n', '1');
        code.style.cssText = 'display:block;margin-top:3px;color:#9fe8c9;font:12px/1.3 ui-monospace,Consolas,monospace;word-break:break-all;';
        code.textContent = sel + (h ? '  (' + h + ')' : '');
        t.appendChild(code);
        (document.body || document.documentElement).appendChild(t);
        try { if (self.MLi18n && self.MLi18n.watch) self.MLi18n.watch(t); } catch (e) {}
        setTimeout(function () { try { t.remove(); } catch (e) {} }, 6000);
    }

    var pick = null;
    function pickBox(color, solid) {
        var b = document.createElement('div');
        b.setAttribute('data-lektor-pick', '1');
        b.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;box-sizing:border-box;border-radius:4px;display:none;'
            + 'border:' + (solid ? '3px solid ' : '2px dashed ') + color + ';background:' + (solid ? 'rgba(77,163,255,.14)' : 'transparent') + ';';
        (document.body || document.documentElement).appendChild(b);
        return b;
    }
    function placeBox(b, r) {
        if (!r) { b.style.display = 'none'; return; }
        b.style.display = 'block';
        b.style.left = (r.left - 3) + 'px'; b.style.top = (r.top - 3) + 'px';
        b.style.width = (r.width + 6) + 'px'; b.style.height = (r.height + 6) + 'px';
    }
    function pickRender() {
        if (!pick) return;
        var el = pick.chain[pick.level];
        var r = el && el.isConnected ? el.getBoundingClientRect() : null;
        placeBox(pick.box, r);
        if (!r) {
            pick.others.forEach(function (b) { placeBox(b, null); });
            pick.label.style.display = 'none';
            return;
        }
        if (pick.selFor !== el) {
            pick.selFor = el;
            pick.sel = buildSelector(el);
            pick.matches = matchesOf(pick.sel, el);
        }
        var inside = 0, outside = [];
        pick.matches.forEach(function (m) { if (partOfPick(m, el)) inside++; else outside.push(m); });
        pick.others.forEach(function (b, i) {
            var m = outside[i];
            b.style.borderColor = '#ff9f43';
            placeBox(b, m ? m.getBoundingClientRect() : null);
        });
        var t = txt(el);
        pick.lText.textContent = t ? '„' + (t.length > 140 ? t.slice(0, 140) + '…' : t) + '”' : '—';
        pick.lHead.textContent = t ? '✅ Lektor złapie:' : '⚠ Tu nie ma tekstu napisów';
        pick.lSel.textContent = '🎯 ' + pick.sel + '  ·  poziom ' + (pick.level + 1) + ' / ' + pick.chain.length
            + (outside.length ? '  ·  ⚠ pasuje też poza napisem: ' + outside.length + ' (pomarańczowe ramki) — zawęź albo poszerz' : '');
        var L = pick.label;
        L.style.display = 'block';
        var lh = L.offsetHeight || 70, top = r.top - lh - 10;
        if (top < 4) top = Math.min(r.bottom + 10, (window.innerHeight || 800) - lh - 4);
        L.style.top = Math.max(4, top) + 'px';
        L.style.left = Math.max(4, Math.min(r.left, (window.innerWidth || 1000) - L.offsetWidth - 4)) + 'px';
    }
    function pickUpdate() {
        if (!pick) return;
        pick.raf = 0;
        var el = hitAt(pick.x, pick.y);
        if (el !== pick.hit) {
            pick.hit = el;
            pick.chain = el ? chainFor(el) : [];
            pick.level = el ? autoLevel(pick.chain) : 0;
            pick.selFor = null;
        }
        pickRender();
    }
    function pickFinish(chosen) {
        if (!pick) return;
        var el = chosen ? pick.chain[pick.level] : null;
        if (el) {
            var sel = pick.selFor === el ? pick.sel : buildSelector(el);
            var count = matchesOf(sel, el).length;
            flash(el);
            try { chrome.runtime.sendMessage({ action: 'KREATOR_PICKED', host: host(), top: topHost(), selector: sel, text: txt(el).slice(0, 160), count: count }); } catch (e) {}
        } else if (!chosen) {
            try { chrome.runtime.sendMessage({ action: 'KREATOR_PICK_CANCEL' }); } catch (e) {}
        }
        stopPick();
    }
    function stopPick() {
        if (!pick) return;
        var p = pick;
        pick = null;
        p.off.forEach(function (f) { f(); });
        [p.box, p.label, p.bar].concat(p.others).forEach(function (n) { try { if (n) n.remove(); } catch (e) {} });
        clearTimeout(p.timer);
        if (p.raf) cancelAnimationFrame(p.raf);
        p.paused.forEach(function (v) { try { var pr = v.play(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) {} });
    }
    function startPick(isTop) {
        stopPick();
        var p = { x: -1, y: -1, hit: null, chain: [], level: 0, sel: '', selFor: null, matches: [], raf: 0, off: [], paused: [], others: [] };
        p.box = pickBox('#4da3ff', true);
        for (var i = 0; i < 6; i++) p.others.push(pickBox('#ff9f43', false));
        var L = document.createElement('div');
        L.setAttribute('data-lektor-pick', '1');
        L.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;display:none;max-width:min(560px,92vw);background:#0b1726;color:#e8f1ff;'
            + 'font:13px/1.35 system-ui,sans-serif;padding:7px 10px;border-radius:8px;border:2px solid #4da3ff;box-shadow:0 4px 18px rgba(0,0,0,.5);white-space:normal;';
        p.lHead = document.createElement('b'); L.appendChild(p.lHead);
        L.appendChild(document.createTextNode(' '));
        p.lText = document.createElement('span'); p.lText.setAttribute('data-noi18n', '1'); L.appendChild(p.lText);
        p.lSel = document.createElement('div'); p.lSel.style.cssText = 'margin-top:4px;color:#9fc3ff;font-size:12px;word-break:break-all;'; L.appendChild(p.lSel);
        var keys = document.createElement('div');
        keys.style.cssText = 'margin-top:3px;color:#c9d6e8;font-size:12px;';
        keys.textContent = '🖱 Kółko myszy albo ↑ ↓ — szerzej / węziej · Klik albo Enter — wybierz · Esc — anuluj';
        L.appendChild(keys);
        (document.body || document.documentElement).appendChild(L);
        p.label = L;
        if (isTop) {
            var bar = document.createElement('div');
            bar.setAttribute('data-lektor-pick', '1');
            bar.textContent = '🎯 Najedź myszką na napisy — niebieska ramka pokazuje, co lektor złapie. Kółko myszy / ↑ ↓: szerzej / węziej · klik: wybierz · Esc: anuluj';
            bar.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;background:#4da3ff;color:#08131f;font:bold 13px system-ui,sans-serif;padding:6px 14px;border-radius:6px;max-width:94vw;text-align:center;';
            (document.body || document.documentElement).appendChild(bar);
            p.bar = bar;
        }
        try { if (self.MLi18n && self.MLi18n.watch) { self.MLi18n.watch(L); if (p.bar) self.MLi18n.watch(p.bar); } } catch (e) {}
        // film stoi na czas wskazywania (napis nie znika)
        try { Array.prototype.forEach.call(document.querySelectorAll('video'), function (v) { if (!v.paused) { v.pause(); p.paused.push(v); } }); } catch (e) {}
        function on(type, f, opts) { window.addEventListener(type, f, opts); p.off.push(function () { window.removeEventListener(type, f, opts); }); }
        var CAP = { capture: true, passive: false };
        function block(ev) { ev.preventDefault(); ev.stopPropagation(); if (ev.stopImmediatePropagation) ev.stopImmediatePropagation(); }
        function move(ev) {
            if (!pick) return;
            if (Math.abs(ev.clientX - pick.x) < 3 && Math.abs(ev.clientY - pick.y) < 3) return;
            pick.x = ev.clientX; pick.y = ev.clientY;
            if (!pick.raf) pick.raf = requestAnimationFrame(pickUpdate);
        }
        function step(d) {
            if (!pick || !pick.chain.length) return;
            pick.level = Math.max(0, Math.min(pick.chain.length - 1, pick.level + d));
            pickRender();
        }
        on('mousemove', move, CAP);
        on('pointermove', move, CAP);
        on('wheel', function (ev) { if (!pick || !pick.chain.length) return; block(ev); step(ev.deltaY < 0 ? 1 : -1); }, CAP);
        ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'touchstart'].forEach(function (t) { on(t, block, CAP); });
        on('click', function (ev) {
            block(ev);
            if (!pick) return;
            pick.x = ev.clientX; pick.y = ev.clientY;
            if (!pick.chain.length) pickUpdate();
            if (pick.chain.length) pickFinish(true);
        }, CAP);
        on('keydown', function (ev) {
            if (!pick) return;
            if (ev.key === 'Escape') { block(ev); pickFinish(false); }
            else if (ev.key === 'ArrowUp' || ev.key === '+') { block(ev); step(1); }
            else if (ev.key === 'ArrowDown' || ev.key === '-') { block(ev); step(-1); }
            else if (ev.key === 'Enter') { block(ev); if (pick.chain.length) pickFinish(true); }
        }, CAP);
        on('scroll', function () { if (pick) pickRender(); }, { capture: true, passive: true });
        on('resize', function () { if (pick) pickRender(); }, { passive: true });
        p.timer = setTimeout(stopPick, 180000);   // bezpiecznik: 3 min bez wyboru — koniec wskazywania
        pick = p;
    }

    try {
        chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
            if (!msg || typeof msg.action !== 'string' || msg.action.indexOf('KREATOR_') !== 0) return;
            var isTop = (window === window.top);
            // wskazywanie rusza we WSZYSTKICH ramkach (napisy bywają w ramce odtwarzacza); odpowiada główna ramka
            if (msg.action === 'KREATOR_PICK') { startPick(isTop); if (isTop) sendResponse({ ok: true, host: host() }); return; }
            if (msg.action === 'KREATOR_STOP') { stopPick(); return; }   // wybrano / anulowano w innej ramce (tło rozsyła)
            if (msg.action === 'KREATOR_SAVED') {   // [FIX 2026-11-10] zapis z 🎯 w popupie (robi go tło) — potwierdzenie
                if (isTop) kreatorToast(String(msg.selector || ''), String(msg.host || ''), msg.ok === false ? String(msg.error || 'błąd zapisu') : '');
                return;
            }
            if (msg.action === 'KREATOR_TEST') {
                var nodes = [];
                try { nodes = Array.prototype.slice.call(document.querySelectorAll(msg.selector)); } catch (e) { if (isTop) sendResponse({ ok: false, error: 'Błędny selektor', host: host() }); return; }
                var samples = nodes.slice(0, 3).map(function (n) { return String(n.innerText || n.textContent || '').trim().slice(0, 100); });
                nodes.slice(0, 10).forEach(flash);   // [FIX 2026-11-02] podświetl wszystkie trafienia, nie tylko pierwsze
                if (nodes.length || isTop) {
                    var reply = function () { sendResponse({ ok: true, count: nodes.length, samples: samples, host: host() }); };
                    if (nodes.length) reply(); else setTimeout(reply, 400);
                    return true;
                }
                return;
            }
            if (msg.action === 'KREATOR_FIND') {
                var needle = String(msg.text || '').toLowerCase();
                if (!needle) { if (isTop) sendResponse({ ok: true, results: [], host: host() }); return; }
                var found = [];
                var all = document.querySelectorAll('body *');
                for (var i = 0; i < all.length && found.length < 6; i++) {
                    var n = all[i];
                    var own = Array.prototype.filter.call(n.childNodes, function (c) { return c.nodeType === 3; }).map(function (c) { return c.nodeValue; }).join(' ').toLowerCase();
                    if (own.indexOf(needle) !== -1) found.push({ selector: buildSelector(n), tag: n.tagName.toLowerCase(), id: n.id || '', cls: typeof n.className === 'string' ? n.className : '', text: own.trim().slice(0, 80) });   // [FIX 2026-11-02] selektor zawężony jak przy wskazywaniu
                    if (found.length === 1 && own.indexOf(needle) !== -1) flash(n);
                }
                if (found.length || isTop) {
                    var rep = function () { sendResponse({ ok: true, results: found, host: host() }); };
                    if (found.length) rep(); else setTimeout(rep, 400);
                    return true;
                }
            }
        });
    } catch (e) {}

    // dla testów (tests/kreator_pick.cjs): te same funkcje, których używa wskazywanie
    window.__LivedubOpts.kreator = { buildSelector: buildSelector, hitAt: hitAt, chainFor: chainFor, autoLevel: autoLevel };
})();
