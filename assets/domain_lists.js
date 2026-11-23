// domain_lists.js — [FIX 2026-11-02] WSPÓLNE listy domen lektora (biała / czarna) i przełącznik „📋 Tylko domeny z listy”.
// Jeden kod dla: skryptów stron (options_hooks.js → __LivedubOpts.asleep()), tła (Łowca, przycisk CC, jednorazowe
// wypełnienie białej listy), popupu (stan karty, „➕ Dodaj tę stronę”) i strony ustawień („📥 Wpisz domeny lektora”).
// Zasady:
//  • jedna domena na linię (można też po przecinku / spacji); pasuje też do subdomen (youtube.com → m.youtube.com);
//    adres strony, port, „www.” i „*.” są obcinane; linie z # lub // (i dopiski po „ #”) to komentarze;
//  • liczy się strona z paska adresu: odtwarzacz w ramce z innej domeny (np. player.vimeo.com na cda.pl) działa razem
//    ze stroną; czarna lista obejmuje też domenę samej ramki i zawsze wygrywa z białą;
//  • przełącznik domainListsOn (domyślnie WŁ.): wyłączony = listy nie działają, lektor wszędzie, gdzie się uruchomi;
//    pusta biała lista = to samo (zostaje tylko czarna).
// Bez zależności — działa w świecie izolowanym strony, w service workerze (import) i na stronach rozszerzenia.
(function (G) {
    'use strict';
    if (G.__LektorDomains) return;

    // Serwisy z lektorem wbudowanym w rozszerzenie (manifest.json → content_scripts). HBO Max: cenzor dźwięku + Łowca.
    var BUILTIN = ['youtube.com', 'netflix.com', 'primevideo.com', 'amazon.com', 'iq.com', 'iqiyi.com', 'dailymotion.com',
        'dai.ly', 'rumble.com', 'viki.com', 'wetv.vip', 'bilibili.com', 'bilibili.tv', 'hbomax.com', 'max.com'];
    // Klucze storage, z których zbieramy domeny lektora (collect) — plus same listy.
    var SOURCE_KEYS = ['domainWhitelist', 'domainBlacklist', 'lowcaSites', 'customSources', 'fileSubs', 'fileSubsMem',
        'ocrToolRegions', 'popupLayout'];
    var LIST_KEYS = ['domainListsOn', 'domainWhitelist', 'domainBlacklist'];

    // Wpis z listy (domena, adres, *.domena, domena:port) → sama domena małymi literami, bez www; '' gdy to nie domena.
    function norm(d) {
        d = String(d || '').trim().toLowerCase();
        if (!d) return '';
        d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^[^@/]*@/, '').replace(/^\*\./, '')
            .replace(/[/?#].*$/, '').replace(/:\d*$/, '').replace(/\.+$/, '').replace(/^www\./, '');
        if (d && !/^[a-z0-9.-]+$/.test(d)) {   // polskie litery itp. → zapis IDN (xn--…), taki jak w location.hostname
            try { d = new URL('http://' + d).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
        }
        return /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/.test(d) ? d : '';
    }
    // Tekst listy → tablica domen (bez powtórzeń i komentarzy).
    function parse(text) {
        var out = [];
        String(text || '').split(/\r?\n/).forEach(function (line) {
            line.replace(/(^|\s)(#|\/\/).*$/, '').split(/[\s,;]+/).forEach(function (tok) {
                var d = norm(tok);
                if (d && out.indexOf(d) === -1) out.push(d);
            });
        });
        return out;
    }
    // Adres → domena bez www ('' dla stron innych niż http / https).
    function hostOf(url) {
        try {
            var u = new URL(String(url || ''));
            return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '').toLowerCase() : '';
        } catch (e) { return ''; }
    }
    // Czy domena h jest na liście (sama albo jako subdomena wpisu).
    function matches(h, list) {
        h = String(h || '').toLowerCase().replace(/^www\./, '');
        if (!h || !list) return false;
        for (var i = 0; i < list.length; i++) {
            var d = list[i];
            if (h === d || h.slice(-(d.length + 1)) === '.' + d) return true;
        }
        return false;
    }
    // Stan lektora na stronie. top = domena z paska adresu, frame = domena ramki, o = ustawienia (domainListsOn,
    // domainWhitelist, domainBlacklist). why: 'off' (przełącznik wył.), 'black' (czarna lista), 'empty' (biała pusta),
    // 'white' (na białej liście), 'notwhite' (spoza białej listy — lektor śpi).
    function state(top, frame, o) {
        o = o || {};
        if (o.domainListsOn === false) return { asleep: false, why: 'off' };
        var bl = parse(o.domainBlacklist);
        if (matches(top, bl) || matches(frame, bl)) return { asleep: true, why: 'black' };
        var wl = parse(o.domainWhitelist);
        if (!wl.length) return { asleep: false, why: 'empty' };
        if (matches(top || frame, wl)) return { asleep: false, why: 'white' };
        return { asleep: true, why: 'notwhite' };
    }
    // Domeny → wzorce dla chrome.scripting.registerContentScripts (domena i jej subdomeny, każdy port).
    function patterns(list) {
        var out = [];
        (list || []).forEach(function (d) {
            if (!d || !/^[a-z0-9_.-]+$/.test(d)) return;
            out.push('*://' + d + '/*');
            if (!/^\d+(\.\d+){3}$/.test(d)) out.push('*://*.' + d + '/*');
        });
        return out;
    }

    // Wszystkie domeny, na których lektor działa albo był używany — grupy z opisem (do wpisania na białą listę).
    // all = wpisy z chrome.storage.local (SOURCE_KEYS). Domen z czarnej listy nie proponujemy.
    function collect(all) {
        all = all || {};
        var seen = {}, groups = [], bl = parse(all.domainBlacklist);
        function obj(x) { return x && typeof x === 'object' ? x : {}; }
        function group(title, list) {
            var g = [];
            (list || []).forEach(function (x) {
                var d = norm(x);
                if (!d || seen[d] || matches(d, bl)) return;
                seen[d] = 1;
                g.push(d);
            });
            if (g.length) groups.push({ title: title, domains: g });
        }
        group('Serwisy z wbudowanym lektorem', BUILTIN);
        var ls = obj(all.lowcaSites), lw = [];
        Object.keys(ls).forEach(function (h) { lw.push(h); (Array.isArray(ls[h] && ls[h].frames) ? ls[h].frames : []).forEach(function (f) { lw.push(f); }); });
        group('Łowca napisów — zapamiętane strony i ich odtwarzacze', lw);
        var cs = obj(all.customSources);
        group('Kreator napisów', Object.keys(cs).filter(function (h) { return Array.isArray(cs[h]) && cs[h].length; }));
        var files = [], mem = obj(all.fileSubsMem);
        if (all.fileSubs && all.fileSubs.page) files.push(hostOf(all.fileSubs.page));
        Object.keys(mem).forEach(function (k) { files.push(hostOf((mem[k] && mem[k].page) || k)); });
        group('Napisy z pliku i z baz napisów', files);
        group('OCR — zapamiętana ramka napisów', Object.keys(obj(all.ocrToolRegions)));
        var sites = obj(obj(all.popupLayout).sites), ps = [];
        Object.keys(sites).forEach(function (id) { ps = ps.concat(parse(sites[id])); });
        group('Strony z ustawień układu popupu', ps);
        // subdomena objęta inną domeną z listy (ebd.cda.pl przy cda.pl) jest zbędna — wpis domeny działa na subdomeny
        var every = Object.keys(seen);
        return groups.map(function (g) {
            return { title: g.title, domains: g.domains.filter(function (d) {
                return !every.some(function (e) { return e !== d && d.slice(-(e.length + 1)) === '.' + e; });
            }) };
        }).filter(function (g) { return g.domains.length; });
    }
    // Dopisuje do tekstu białej listy brakujące domeny lektora (pod nagłówkami grup). Niczego nie usuwa.
    // Zwraca { text, added: [domeny] }.
    function fill(text, all) {
        text = String(text || '');
        var have = parse(text), added = [], lines = [];
        collect(all).forEach(function (g) {
            var miss = g.domains.filter(function (d) { return !matches(d, have) && added.indexOf(d) === -1; });
            if (!miss.length) return;
            lines.push('# ' + g.title);
            miss.forEach(function (d) { lines.push(d); added.push(d); });
        });
        if (!added.length) return { text: text, added: added };
        var head = have.length ? '' : '# Lektor działa tylko na tych domenach (i ich subdomenach). Dopisuj następne — jedna domena na linię.\n';
        var before = text.trim() ? text.replace(/\s+$/, '') + '\n\n' : '';
        return { text: before + head + lines.join('\n') + '\n', added: added };
    }
    // Dopisuje jedną domenę na koniec listy. null = nie trzeba (już jest) albo to nie domena.
    function addHost(text, host) {
        var d = norm(host);
        text = String(text || '');
        if (!d || matches(d, parse(text))) return null;
        return (text.trim() ? text.replace(/\s+$/, '') + '\n' : '') + d + '\n';
    }

    G.__LektorDomains = {
        BUILTIN: BUILTIN, SOURCE_KEYS: SOURCE_KEYS, LIST_KEYS: LIST_KEYS,
        norm: norm, parse: parse, hostOf: hostOf, matches: matches, state: state, patterns: patterns,
        collect: collect, fill: fill, addHost: addHost
    };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window));
