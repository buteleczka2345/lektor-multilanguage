// i18n.js — Multilektor: język interfejsu (polski / angielski). [AGENT-EXP] 2026-10-21
// Teksty w kodzie zostają po polsku; słownik pl → en jest w assets/i18n_en.js (self.ML_I18N_EN, wczytany wcześniej).
// Wybór: chrome.storage.local.uiLang = 'auto' (język Chrome: polski → PL, każdy inny → EN) | 'pl' | 'en'.
// Strony rozszerzenia (popup, Ustawienia): MLi18n.page() tłumaczy cały dokument i pilnuje zmian (MutationObserver).
// Skrypty na stronach z filmem: MLi18n.watch(element) — TYLKO panele lektora, nigdy interfejs serwisu.
// Elementy z atrybutem data-noi18n (np. lista czytanych napisów) i pola tekstowe są pomijane.
// Tłumaczenie: najpierw cały tekst węzła, potem znane fragmenty (najdłuższe pierwsze) — dla tekstów sklejanych
// z liczbami („Pobrano 12 kwestii”). Fragment w cudzysłowie „…” (tytuł, napis z filmu) nie jest tłumaczony.
// Oryginał każdego węzła jest zapamiętany, więc powrót na polski działa od razu, bez przeładowania.
(function () {
    'use strict';
    if (self.MLi18n) return;

    var EN = self.ML_I18N_EN || {};
    var ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
    var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, PRE: 1, NOSCRIPT: 1 };
    var ATTR_ONLY = { TEXTAREA: 1, CODE: 1, PRE: 1 };   // treść bez zmian, ale title / placeholder tłumaczymy
    var norm = function (s) { return String(s).replace(/\s+/g, ' ').trim(); };

    var exact = new Map();
    Object.keys(EN).forEach(function (k) { exact.set(norm(k), EN[k]); });
    // fragmenty: bez cudzysłowu na brzegu (tekst w „…” jest wycinany przed podmianą), najdłuższe pierwsze
    var unq = function (s) { return String(s).replace(/^[\s”“"]+|[\s„“"]+$/g, ''); };
    var frags = Object.keys(EN).map(function (k) { return [unq(k), unq(EN[k])]; })
        .filter(function (p) { return p[0].length >= 2; })
        .sort(function (a, b) { return b[0].length - a[0].length; });

    var lang = 'pl';
    var origText = new WeakMap();   // węzeł tekstowy → oryginał (polski)
    var origAttr = new WeakMap();   // element → { atrybut: oryginał }
    var roots = [];                 // { el, obs }

    var LETTER = /[\p{L}\p{N}]/u;
    // podmień k → v tylko jako całe słowo/frazę: „polski” nie rusza „polskie”, „Głos” nie rusza „Głosy”
    function replaceWhole(s, k, v) {
        var out = '', from = 0, i;
        var needL = LETTER.test(k.charAt(0)), needR = LETTER.test(k.charAt(k.length - 1));
        while ((i = s.indexOf(k, from)) !== -1) {
            var okL = !needL || i === 0 || !LETTER.test(s.charAt(i - 1));
            var j = i + k.length;
            var okR = !needR || j >= s.length || !LETTER.test(s.charAt(j));
            if (okL && okR) { out += s.slice(from, i) + v; from = j; }
            else { out += s.slice(from, i + 1); from = i + 1; }
        }
        return out + s.slice(from);
    }
    // cytaty „…”, które są częścią tekstów interfejsu (np. „Test lektora”) — te wolno tłumaczyć razem ze zdaniem
    var uiQuotes = new Set();
    Object.keys(EN).forEach(function (k) { (k.match(/„[^”]*”/g) || []).forEach(function (q) { uiQuotes.add(q); }); });
    function fragReplace(s) {
        // inne cytaty „…” (tytuł filmu, zdanie z napisów, nazwa głosu) chowamy przed podmianą i wstawiamy z powrotem
        var kept = [];
        var masked = s.replace(/„[^”]*”/g, function (q) {
            if (uiQuotes.has(q)) return q;
            kept.push(q);
            return '\u0001' + (kept.length - 1) + '\u0002';
        });
        for (var i = 0; i < frags.length; i++) {
            var k = frags[i][0];
            if (masked.indexOf(k) !== -1) masked = replaceWhole(masked, k, frags[i][1]);
        }
        return masked.replace(/\u0001(\d+)\u0002/g, function (_, n) { return kept[+n]; });
    }

    function tr(s) {
        if (lang !== 'en' || !s || !/[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]/.test(s)) return s;
        var n = norm(s);
        if (exact.has(n)) {
            var lead = s.match(/^\s*/)[0], tail = s.match(/\s*$/)[0];
            return lead + exact.get(n) + tail;
        }
        // wszystko albo nic: zdanie przetłumaczone w połowie („Voice męski”) jest gorsze niż polskie
        var out = fragReplace(s);
        return hasPolish(out.replace(/„[^”]*”/g, '')) ? s : out;
    }
    // polski został? ogonki albo częste polskie słowa bez ogonków (nie mylą się z angielskimi: bez „do”, „to”, „no”)
    var PL_LEFT = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;
    var PL_WORDS = /(^|[^\p{L}])(na|tej|nie|jest|oraz|lub|albo|bez|dla|przy|czy|jak|tylko|gdy|kiedy|jeszcze|tego|tym|tych|ten|ta|tu|pliku|plik|napisy|napisu|filmu|film|stronie|strony|strona|karty|karta|kliknij|lokalne|lokalny|rozpoznawanie|najlepsze|pobierz|szukaj|zapisz|kopiuj|wczytaj|w|z|i)(?=$|[^\p{L}])/u;
    function hasPolish(s) { return PL_LEFT.test(s) || PL_WORDS.test(s); }

    function skipped(el) {
        for (var e = el; e && e.nodeType === 1; e = e.parentElement) {
            if (SKIP_TAGS[e.tagName] || e.hasAttribute('data-noi18n') || e.isContentEditable) return true;
        }
        return false;
    }

    function doText(node) {
        var cur = node.nodeValue;
        var known = origText.get(node);
        // tekst zmieniony przez kod lektora (po polsku) → nowy oryginał
        var orig = (known && (known.en === cur)) ? known.pl : cur;
        var out = lang === 'en' ? tr(orig) : orig;
        if (out !== cur) node.nodeValue = out;
        if (out !== orig) origText.set(node, { pl: orig, en: out }); else origText.delete(node);
    }

    function doAttrs(el) {
        var saved = origAttr.get(el) || {};
        var changed = false;
        ATTRS.forEach(function (a) {
            if (!el.hasAttribute(a)) return;
            var cur = el.getAttribute(a);
            var orig = (saved[a] && saved[a].en === cur) ? saved[a].pl : cur;
            var out = lang === 'en' ? tr(orig) : orig;
            if (out !== cur) el.setAttribute(a, out);
            if (out !== orig) { saved[a] = { pl: orig, en: out }; changed = true; } else delete saved[a];
        });
        if (changed) origAttr.set(el, saved); else origAttr.delete(el);
    }

    function apply(root) {
        if (!root) return;
        if (root.nodeType === 3) { if (!skipped(root.parentElement)) doText(root); return; }
        if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
        if (root.nodeType === 1) { if (skipped(root)) return; doAttrs(root); }
        var w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
            acceptNode: function (n) {
                if (n.nodeType === 1) {
                    if (n.hasAttribute('data-noi18n')) return NodeFilter.FILTER_REJECT;
                    if (SKIP_TAGS[n.tagName]) { if (ATTR_ONLY[n.tagName]) doAttrs(n); return NodeFilter.FILTER_REJECT; }   // pole / kod: tylko podpowiedź
                    return NodeFilter.FILTER_ACCEPT;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        for (var n = w.nextNode(); n; n = w.nextNode()) {
            if (n.nodeType === 3) doText(n); else doAttrs(n);
        }
    }

    var busy = false;
    function watch(el) {
        if (!el || roots.some(function (r) { return r.el === el; })) return;
        var obs = new MutationObserver(function (muts) {
            if (busy) return;
            busy = true;
            try {
                obs.disconnect();
                for (var i = 0; i < muts.length; i++) {
                    var m = muts[i];
                    if (m.type === 'childList') m.addedNodes.forEach(apply);
                    else if (m.type === 'characterData') { if (!skipped(m.target.parentElement)) doText(m.target); }
                    else if (m.type === 'attributes' && (!skipped(m.target) || (ATTR_ONLY[m.target.tagName] && !skipped(m.target.parentElement)))) doAttrs(m.target);
                }
            } finally {
                obs.observe(el, OBS_OPTS);
                busy = false;
            }
        });
        roots.push({ el: el, obs: obs });
        apply(el);
        obs.observe(el, OBS_OPTS);
    }
    var OBS_OPTS = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS };

    function chromeLang() {
        try { if (self.chrome && chrome.i18n && chrome.i18n.getUILanguage) return chrome.i18n.getUILanguage(); } catch (e) {}
        return (self.navigator && navigator.language) || 'pl';
    }
    function pick(pref) {
        if (pref === 'pl' || pref === 'en') return pref;
        return /^pl\b/i.test(chromeLang()) ? 'pl' : 'en';
    }
    var isPage = false;   // strona rozszerzenia (popup, Ustawienia, okienka „Głos”) — tylko wtedy ustawiamy <html lang>
    var hasStorage = false;
    try { hasStorage = !!(self.chrome && chrome.storage && chrome.storage.local); } catch (e) {}
    // Świat strony (Łowca, MAIN) nie ma chrome.storage — język czyta z atrybutu data-ml-lang na <html>,
    // który ustawia i18n.js w świecie izolowanym tej samej ramki.
    var DOM_ATTR = 'data-ml-lang';
    function markDom(l) {
        if (!hasStorage || isPage) return;
        try { document.documentElement.setAttribute(DOM_ATTR, l); } catch (e) {}
    }
    function setLang(l) {
        markDom(l);
        if (l === lang) return;
        lang = l;
        if (isPage) { try { document.documentElement.lang = l; } catch (e) {} }
        roots.forEach(function (r) { apply(r.el); });
    }

    var ready = new Promise(function (resolve) {
        var fired = false;
        var done = function (l) { if (fired) return; fired = true; lang = l; markDom(l); resolve(lang); };
        if (hasStorage) {
            try { chrome.storage.local.get('uiLang', function (r) { void chrome.runtime.lastError; done(pick(r && r.uiLang)); }); }
            catch (e) { done(pick('auto')); }
            setTimeout(function () { done(pick('auto')); }, 1500);   // gdyby storage milczało (tylko pierwszy wynik się liczy)
            return;
        }
        var fromDom = function () { var v = document.documentElement && document.documentElement.getAttribute(DOM_ATTR); return v === 'en' || v === 'pl' ? v : ''; };
        if (fromDom()) { done(fromDom()); }
        else setTimeout(function () { done(fromDom() || pick('auto')); }, 1500);
        try {
            new MutationObserver(function () { var v = fromDom(); if (!v) return; if (!fired) done(v); else setLang(v); })
                .observe(document.documentElement, { attributes: true, attributeFilter: [DOM_ATTR] });
        } catch (e) {}
    });
    if (hasStorage) {
        try {
            chrome.storage.onChanged.addListener(function (ch, area) {
                if (area === 'local' && ch.uiLang) setLang(pick(ch.uiLang.newValue));
            });
        } catch (e) {}
    }

    // Przełącznik <select data-ui-lang> (auto / pl / en) w popupie i Ustawieniach — zmiana działa od razu wszędzie
    function bindSelects() {
        var sels = document.querySelectorAll('select[data-ui-lang]');
        if (!sels.length) return;
        var show = function (v) { sels.forEach(function (s) { s.value = (v === 'pl' || v === 'en') ? v : 'auto'; }); };
        try { chrome.storage.local.get('uiLang', function (r) { void chrome.runtime.lastError; show(r && r.uiLang); }); } catch (e) {}
        try { chrome.storage.onChanged.addListener(function (ch, a) { if (a === 'local' && ch.uiLang) show(ch.uiLang.newValue); }); } catch (e) {}
        sels.forEach(function (s) {
            s.addEventListener('change', function () { try { chrome.storage.local.set({ uiLang: s.value }); } catch (e) {} });
        });
    }

    // Strona rozszerzenia: chowamy ją na moment (do odczytu ustawienia), żeby nie mignęła po polsku.
    function page() {
        isPage = true;
        var de = document.documentElement;
        try { de.removeAttribute(DOM_ATTR); } catch (e) {}
        de.style.visibility = 'hidden';
        var show = function () { de.style.visibility = ''; };
        var t = setTimeout(show, 1600);
        ready.then(function () {
            var go = function () {
                try { de.lang = lang; watch(document.body || de); bindSelects(); } finally { clearTimeout(t); show(); }
            };
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true }); else go();
        });
    }

    self.MLi18n = {
        ready: ready,
        lang: function () { return lang; },
        setLang: function (l) { setLang(l === 'en' ? 'en' : 'pl'); },   // na chwilę (bez zapisu); na stałe = storage uiLang
        t: tr,
        watch: function (el) { ready.then(function () { watch(el); }); },
        page: page
    };
    // <script src="…/i18n.js" data-page> w popupie / Ustawieniach = tłumacz cały dokument
    try { if (document.currentScript && document.currentScript.hasAttribute('data-page')) page(); } catch (e) {}
})();
