// [AGENT-EXP] 2026-10-26: 🧩 moduły popupu — wspólny spis modułów i zakładek (popup + Ustawienia).
// Układ leży w chrome.storage.local.popupLayout (eksport/import ustawień zabiera go sam) i w lustrze
// localStorage (ta sama strona rozszerzenia) — popup układa karty od razu, zanim storage odpowie.
// Nowy moduł w popupie = karta z data-mod="<id>" + wpis w MODULES (bez wpisu karta zostaje tam, gdzie jest w HTML).
(function () {
    'use strict';
    if (self.MLLayout) return;

    var KEY = 'popupLayout';
    var MIRROR = 'mlPopupLayout';

    var TABS = [
        { id: 'lektor', name: 'Lektor' },
        { id: 'napisy', name: 'Napisy' },
        { id: 'glosy', name: 'Głosy' },
        { id: 'narzedzia', name: 'Narzędzia' },
        { id: 'moje', name: '★ Moje' }   // pusta na start — własna zakładka użytkownika (pusta = schowana)
    ];

    // kolejność = domyślny układ; noFold = karta bez nagłówka do zwijania
    // [FIX 2026-11-16] domyślny układ = jak na zrzucie z Ustawień („Przywróć domyślny układ”):
    // Lektor 8, Napisy 7 (cenzura na górze), Głosy 2, Narzędzia 7 (bufor, domeny, test, pasek tutaj), ★ Moje pusta.
    var MODULES = [
        { id: 'status', tab: 'lektor', name: 'Status (lektor i cenzor)', noFold: true },
        { id: 'lektor', tab: 'lektor', name: 'Lektor — włącz / wyłącz', noFold: true },
        { id: 'silnik', tab: 'lektor', name: '🗣 Silnik mowy' },
        { id: 'predkosc', tab: 'lektor', name: 'Prędkość lektora' },
        { id: 'ducking', tab: 'lektor', name: 'Ducking (wyciszanie filmu)' },
        { id: 'glosnosc', tab: 'lektor', name: 'Głośność lektora' },
        { id: 'cenzorCzasy', tab: 'lektor', name: '⏱ Czasy ciszy cenzora' },
        { id: 'zapas', tab: 'lektor', name: 'Nagrywanie / zapas do przodu' },
        { id: 'cenzura', tab: 'napisy', name: '🤬 Cenzura przekleństw' },
        { id: 'kreator', tab: 'napisy', name: '🧪 Kreator napisów — wskaż na ekranie' },
        { id: 'plik', tab: 'napisy', name: 'Napisy z pliku' },
        { id: 'bazy', tab: 'napisy', name: '🌐 Szukaj w bazach napisów' },
        { id: 'przesuniecie', tab: 'napisy', name: 'Przesunięcie napisów (lektor + cenzor)' },
        { id: 'calenapisy', tab: 'napisy', name: 'Całe napisy — na żądanie' },
        { id: 'wlasnyglos', tab: 'glosy', name: 'Własny głos (Sherpa/Piper z plików)' },
        { id: 'jezyki', tab: 'glosy', name: '🌐 Języki świata — pobieranie głosów' },
        { id: 'glosnapisy', tab: 'narzedzia', name: '🎙 Głos i napisy' },
        { id: 'lowca', tab: 'narzedzia', name: '🔍 Łowca napisów' },
        { id: 'ait', tab: 'narzedzia', name: '🤖 AI Subtitle Translator' },
        { id: 'bufor', tab: 'narzedzia', name: '💾 Buforowanie' },
        { id: 'domeny', tab: 'narzedzia', name: '📋 Tylko domeny z listy' },
        { id: 'test', tab: 'narzedzia', name: 'Test lektora' },
        { id: 'pasek', tab: 'narzedzia', name: '📊 Pasek lektora' }
    ];
    // vis: zawsze | only = tylko na podanych stronach | except = poza nimi | never = ukryty
    var VIS = ['always', 'only', 'except', 'never'];

    var modById = {};
    MODULES.forEach(function (m) { modById[m.id] = m; });
    var tabIds = TABS.map(function (t) { return t.id; });

    function own(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }

    // dowolne dane (stary zapis, import, ręczna edycja) → poprawny układ; nowe moduły wchodzą na swoje domyślne miejsce
    function normalize(raw) {
        raw = raw && typeof raw === 'object' ? raw : {};
        var out = { v: 1, tabs: {}, vis: {}, sites: {}, fold: {}, start: 'last' };
        var seen = {};
        tabIds.forEach(function (t) {
            out.tabs[t] = [];
            var list = raw.tabs && Array.isArray(raw.tabs[t]) ? raw.tabs[t] : [];
            list.forEach(function (id) {
                if (own(modById, id) && !seen[id]) { seen[id] = 1; out.tabs[t].push(id); }
            });
        });
        MODULES.forEach(function (m, i) {
            if (seen[m.id]) return;
            seen[m.id] = 1;
            var list = out.tabs[m.tab];
            // za poprzednikiem z domyślnej kolejności, jeśli stoi w tej samej zakładce
            var at = 0;
            for (var j = i - 1; j >= 0; j--) {
                var p = list.indexOf(MODULES[j].id);
                if (p >= 0) { at = p + 1; break; }
            }
            list.splice(at, 0, m.id);
        });
        MODULES.forEach(function (m) {
            var v = raw.vis && raw.vis[m.id];
            if (VIS.indexOf(v) > 0) out.vis[m.id] = v;
            var s = raw.sites && raw.sites[m.id];
            if (typeof s === 'string' && s.trim()) out.sites[m.id] = s.trim().slice(0, 500);
            if (raw.fold && raw.fold[m.id] === true && !m.noFold) out.fold[m.id] = true;
        });
        if (raw.start === 'last' || tabIds.indexOf(raw.start) >= 0) out.start = raw.start;
        return out;
    }
    // [FIX 2026-11-16] karty domyślnie zwinięte (układ z Ustawień). Rozwinięte zostają: Status, Lektor,
    // ⏱ Czasy ciszy cenzora, 🤬 Cenzura, Łowca napisów, AI Subtitle Translator, Buforowanie, Tylko domeny.
    var DEFAULT_FOLD = ['silnik', 'predkosc', 'ducking', 'glosnosc', 'zapas', 'kreator', 'plik', 'bazy',
        'przesuniecie', 'calenapisy', 'wlasnyglos', 'jezyki', 'glosnapisy', 'test', 'pasek'];

    function defaults() {
        var out = normalize(null);
        DEFAULT_FOLD.forEach(function (id) {
            if (own(modById, id) && !modById[id].noFold) out.fold[id] = true;
        });
        return out;
    }

    function tabOf(layout, id) {
        for (var i = 0; i < tabIds.length; i++) if (layout.tabs[tabIds[i]].indexOf(id) >= 0) return tabIds[i];
        return '';
    }
    // przenieś moduł: do zakładki tab, przed modułem beforeId (brak = na koniec)
    function move(layout, id, tab, beforeId) {
        if (!own(modById, id) || tabIds.indexOf(tab) < 0 || id === beforeId) return layout;
        tabIds.forEach(function (t) {
            var k = layout.tabs[t].indexOf(id);
            if (k >= 0) layout.tabs[t].splice(k, 1);
        });
        var list = layout.tabs[tab];
        var at = beforeId ? list.indexOf(beforeId) : -1;
        if (at < 0) list.push(id); else list.splice(at, 0, id);
        return layout;
    }
    // o jedno miejsce w górę / w dół w swojej zakładce
    function shift(layout, id, dir) {
        var list = layout.tabs[tabOf(layout, id)];
        if (!list) return layout;
        var i = list.indexOf(id), j = i + (dir < 0 ? -1 : 1);
        if (i < 0 || j < 0 || j >= list.length) return layout;
        list[i] = list[j]; list[j] = id;
        return layout;
    }

    function domains(text) {
        return String(text || '').toLowerCase().split(/[\s,;]+/).map(function (d) {
            return d.replace(/^[a-z]+:\/\//, '').replace(/^\*\./, '').replace(/^www\./, '').replace(/[/:].*$/, '');
        }).filter(Boolean);
    }
    function hostMatches(text, host) {
        host = String(host || '').toLowerCase().replace(/^www\./, '');
        if (!host) return false;
        return domains(text).some(function (d) { return host === d || host.slice(-(d.length + 1)) === '.' + d; });
    }
    // czy moduł ma być widoczny przy tej karcie przeglądarki (host = '' gdy to nie strona www)
    function visibleOn(layout, id, host) {
        var v = layout.vis[id] || 'always';
        if (v === 'never') return false;
        if (v === 'only') return hostMatches(layout.sites[id], host);
        if (v === 'except') return !hostMatches(layout.sites[id], host);
        return true;
    }

    function readMirror() {
        try { var s = localStorage.getItem(MIRROR); return s ? normalize(JSON.parse(s)) : null; } catch (e) { return null; }
    }
    function writeMirror(layout) {
        try { localStorage.setItem(MIRROR, JSON.stringify(layout)); } catch (e) { /* ignore */ }
    }
    function load(cb) {
        try {
            chrome.storage.local.get(KEY, function (r) {
                void chrome.runtime.lastError;
                // [FIX 2026-11-16] brak zapisanego układu = domyślny (z domyślnie zwiniętymi kartami)
                var l = (r && r[KEY]) ? normalize(r[KEY]) : defaults();
                writeMirror(l);
                cb(l);
            });
        } catch (e) { cb(readMirror() || defaults()); }
    }
    function save(layout, cb) {
        var l = normalize(layout);
        writeMirror(l);
        try { chrome.storage.local.set({ [KEY]: l }, function () { void chrome.runtime.lastError; if (cb) cb(l); }); }
        catch (e) { if (cb) cb(l); }
        return l;
    }
    function same(a, b) { return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b)); }

    self.MLLayout = {
        KEY: KEY, TABS: TABS, MODULES: MODULES, VIS: VIS, mod: function (id) { return modById[id] || null; },
        normalize: normalize, defaults: defaults, tabOf: tabOf, move: move, shift: shift,
        hostMatches: hostMatches, visibleOn: visibleOn,
        readMirror: readMirror, writeMirror: writeMirror, load: load, save: save, same: same
    };
})();
