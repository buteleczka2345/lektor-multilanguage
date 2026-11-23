// [AGENT-EXP] 2026-10-26: 🧩 układ modułów w popupie. Karty z data-mod przestawiane wg chrome.storage.local.popupLayout
// (spis i zasady: layout_shared.js). Karty są tylko przenoszone w drzewie DOM — ich id i obsługa w popup.js bez zmian.
// ▾ w nagłówku karty zwija ją do tytułu; ✏️ w nagłówku popupu = tryb edycji: przeciąganie ⠿, ↑ ↓, zakładka, 👁.
// Strony, na których moduł się pokazuje, i zakładka na start — w Ustawieniach (sekcja „🧩 Układ popupu”).
(function () {
    'use strict';
    var L = self.MLLayout;
    if (!L) return;

    var tabBtns = {}, panes = {}, mods = {}, bars = {};
    document.querySelectorAll('.tabs .tab[data-tab]').forEach(function (b) { tabBtns[b.dataset.tab] = b; });
    document.querySelectorAll('.pane[data-pane]').forEach(function (p) { panes[p.dataset.pane] = p; });
    document.querySelectorAll('.card[data-mod]').forEach(function (c) { if (L.mod(c.dataset.mod)) mods[c.dataset.mod] = c; });

    var layout = L.readMirror() || L.defaults();
    var host = null;        // null = jeszcze nie wiadomo, jaka strona jest w karcie
    var editing = false;
    var prevVis = {};       // 👁: reguła sprzed schowania (wraca po ponownym kliknięciu)
    var editBtn = document.getElementById('layoutEditBtn');
    var editBar = document.getElementById('layoutEditBar');

    function visibleNow(id) {
        if (host === null && layout.vis[id] === 'only') return false;   // „tylko na…” — do sprawdzenia strony schowany
        return L.visibleOn(layout, id, host || '');
    }

    // ----- puste zakładki: napis w trybie edycji -----
    function emptyNote(pane) {
        var n = pane.querySelector(':scope > .mod-empty');
        if (!n) {
            n = document.createElement('div');
            n.className = 'mod-empty';
            n.textContent = 'Pusta zakładka — przeciągnij tu moduł albo wybierz ją z listy przy module.';
            pane.appendChild(n);
        }
        return n;
    }

    function apply() {
        L.TABS.forEach(function (t) {
            var pane = panes[t.id];
            if (!pane) return;
            var list = layout.tabs[t.id];
            list.forEach(function (id) { if (mods[id]) pane.appendChild(mods[id]); });
            var shown = list.filter(function (id) { return mods[id] && visibleNow(id); }).length;
            var note = emptyNote(pane);
            pane.appendChild(note);
            note.hidden = !editing || list.some(function (id) { return !!mods[id]; });
            if (tabBtns[t.id]) tabBtns[t.id].hidden = !editing && shown === 0;
        });
        Object.keys(mods).forEach(function (id) {
            var c = mods[id];
            c.classList.toggle('mod-off', !visibleNow(id));
            c.classList.toggle('mod-folded', !!layout.fold[id]);
            var fb = c.querySelector('.mod-fold');
            if (fb) fb.setAttribute('aria-expanded', layout.fold[id] ? 'false' : 'true');
            if (bars[id]) fillBar(id);
        });
        // otwarta zakładka zniknęła (pusta / wszystko schowane) → pierwsza widoczna
        var act = document.querySelector('.tabs .tab.active');
        if (act && act.hidden && typeof window.__mlTabShow === 'function') window.__mlTabShow(act.dataset.tab);
    }

    function commit() {
        layout = L.save(layout);
        apply();
    }

    // ----- ▾ zwijanie karty do tytułu (zapamiętane, animowane) -----
    // [AGENT-EXP] 2026-11-16: bez animacji treść znikała w jednej klatce (display:none), karty pod spodem skakały
    // w górę, a okno popupu zmieniało wysokość — wyglądało to jak odświeżenie. Teraz: karta animuje wysokość
    // do samego nagłówka, dopiero po animacji wchodzi .mod-folded; nagłówek zostaje tam, gdzie kliknięto.
    var FOLD_MS = 190;

    // wysokość karty w danym stanie — mierzone bez malowania (klasa wchodzi i schodzi w jednej klatce)
    function heightIn(c, folded) {
        var h0 = c.style.height, tr = c.style.transition;
        c.style.transition = 'none';
        c.style.height = '';                 // pomiar na naturalnej wysokości, nie na animowanej
        var was = c.classList.contains('mod-folded');
        c.classList.toggle('mod-folded', folded);
        var h = c.offsetHeight;
        c.classList.toggle('mod-folded', was);
        c.style.height = h0;
        c.style.transition = tr;
        return h;
    }

    function animateFold(id, toFold, done) {
        var c = mods[id];
        var head = c.querySelector(':scope > .card-head');
        // karta w schowanej zakładce / schowana (👁) / bez nagłówka — nie ma czego animować
        if (!head || !c.offsetHeight || c.classList.contains('mod-off')) { done(); return; }
        var from = c.offsetHeight;
        var to = heightIn(c, toFold);
        if (Math.abs(to - from) < 2) { done(); return; }
        var headTop = head.getBoundingClientRect().top;   // kotwica: nagłówek ma zostać w tym miejscu
        clearTimeout(c.__foldT);
        c.classList.add('mod-anim');
        c.classList.toggle('folding', !!toFold);
        c.classList.toggle('unfolding', !toFold);
        c.classList.remove('mod-folded');                 // treść widoczna przez całą animację (przy zwijaniu i tak jest przycinana)
        c.style.transition = 'none';
        c.style.height = from + 'px';
        void c.offsetHeight;                              // start od sztywnej wysokości (bez tego przejście by nie ruszyło)
        c.style.transition = 'height ' + FOLD_MS + 'ms cubic-bezier(.4, 0, .2, 1)';
        c.style.height = to + 'px';
        c.__foldT = setTimeout(function () {
            c.classList.remove('mod-anim', 'folding', 'unfolding');
            c.classList.toggle('mod-folded', !!toFold);
            c.style.transition = '';
            c.style.height = '';
            done();                                       // commit(): zapis + apply() ustawia .mod-folded i strzałkę
            var dy = head.getBoundingClientRect().top - headTop;
            if (Math.abs(dy) > 1) window.scrollBy(0, dy);  // gdy popup był przewinięty, nie trać miejsca z oczu
        }, FOLD_MS + 30);
    }

    function toggleFold(id) {
        var toFold = !layout.fold[id];
        var fb = mods[id].querySelector('.mod-fold');
        if (fb) fb.setAttribute('aria-expanded', toFold ? 'false' : 'true');
        animateFold(id, toFold, function () {
            if (toFold) layout.fold[id] = true; else delete layout.fold[id];
            commit();
        });
    }
    Object.keys(mods).forEach(function (id) {
        var m = L.mod(id), c = mods[id];
        var head = c.querySelector(':scope > .card-head');
        if (m.noFold || !head) return;
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'mod-fold';
        b.title = 'Zwiń / rozwiń';
        b.setAttribute('aria-label', 'Zwiń / rozwiń');
        b.textContent = '▾';
        head.appendChild(b);
        head.classList.add('mod-head');
        head.addEventListener('click', function (e) {
            if (editing) return;
            if (e.target.closest('button:not(.mod-fold), select, input, a, label')) return;
            toggleFold(id);
        });
    });

    // ----- tryb edycji: pasek na każdej karcie -----
    function tagSpan(cls, text, plain) {
        var s = document.createElement('span');
        s.className = 'mod-tag ' + cls;
        if (plain) s.setAttribute('data-noi18n', '');
        s.textContent = text;
        return s;
    }
    function fillBar(id) {
        var b = bars[id];
        var list = layout.tabs[L.tabOf(layout, id)] || [];
        var i = list.indexOf(id);
        b.up.disabled = i <= 0;
        b.down.disabled = i < 0 || i >= list.length - 1;
        b.tab.value = L.tabOf(layout, id);
        var v = layout.vis[id] || 'always';
        b.eye.textContent = v === 'never' ? '🚫' : '👁';
        b.eye.title = v === 'never' ? 'Schowany — kliknij, aby pokazać' : 'Widoczny — kliknij, aby schować';
        b.eye.classList.toggle('off', v === 'never');
        b.tags.textContent = '';
        if (v === 'never') b.tags.appendChild(tagSpan('off', 'schowany'));
        else if (v === 'only' || v === 'except') {
            b.tags.appendChild(tagSpan('site', v === 'only' ? '🌐 tylko na:' : '🌐 poza:'));
            b.tags.appendChild(tagSpan('site', ' ' + (layout.sites[id] || '—'), true));
            if (!visibleNow(id)) b.tags.appendChild(tagSpan('off', 'tu niewidoczny'));
        }
        if (layout.fold[id]) b.tags.appendChild(tagSpan('fold', 'zwinięty'));
    }
    function button(cls, text, title) {
        var e = document.createElement('button');
        e.type = 'button';
        e.className = cls;
        e.textContent = text;
        if (title) { e.title = title; e.setAttribute('aria-label', title); }
        return e;
    }
    function buildBar(id) {
        var c = mods[id];
        var bar = document.createElement('div');
        bar.className = 'mod-bar';
        var grip = document.createElement('span');
        grip.className = 'mod-grip';
        grip.title = 'Przeciągnij, aby przestawić';
        grip.textContent = '⠿';
        var title = document.createElement('span');
        title.className = 'mod-title';
        var name = document.createElement('span');
        name.className = 'mod-name';
        name.textContent = L.mod(id).name;
        var tags = document.createElement('span');
        tags.className = 'mod-tags';
        title.appendChild(name);
        title.appendChild(tags);
        var up = button('mod-ic', '↑', 'W górę');
        var down = button('mod-ic', '↓', 'W dół');
        var tab = document.createElement('select');
        tab.className = 'mod-tab';
        tab.title = 'Zakładka, w której stoi moduł';
        L.TABS.forEach(function (t) {
            var o = document.createElement('option');
            o.value = t.id;
            o.textContent = t.name;
            tab.appendChild(o);
        });
        var eye = button('mod-ic eye', '👁', '');
        bar.appendChild(grip); bar.appendChild(title); bar.appendChild(up); bar.appendChild(down); bar.appendChild(tab); bar.appendChild(eye);
        c.insertBefore(bar, c.firstChild);
        up.addEventListener('click', function () { L.shift(layout, id, -1); commit(); });
        down.addEventListener('click', function () { L.shift(layout, id, 1); commit(); });
        tab.addEventListener('change', function () { L.move(layout, id, tab.value); commit(); flashTab(tab.value); });
        eye.addEventListener('click', function () {
            var v = layout.vis[id] || 'always';
            if (v === 'never') {
                if (prevVis[id]) layout.vis[id] = prevVis[id]; else delete layout.vis[id];
            } else {
                if (v !== 'always') prevVis[id] = v;
                layout.vis[id] = 'never';
            }
            commit();
        });
        bars[id] = { bar: bar, up: up, down: down, tab: tab, eye: eye, tags: tags };
        fillBar(id);
    }
    function flashTab(tabId) {
        var b = tabBtns[tabId];
        if (!b) return;
        b.classList.remove('mod-flash');
        void b.offsetWidth;   // restart animacji
        b.classList.add('mod-flash');
    }

    function setEditing(on) {
        editing = !!on;
        document.body.classList.toggle('ml-edit', editing);
        if (editBar) editBar.hidden = !editing;
        if (editBtn) editBtn.setAttribute('aria-pressed', editing ? 'true' : 'false');
        Object.keys(mods).forEach(function (id) {
            if (editing && !bars[id]) buildBar(id);
            mods[id].draggable = editing;
        });
        apply();
        if (editing) window.scrollTo(0, 0);
    }
    if (editBtn) editBtn.addEventListener('click', function () { setEditing(!editing); });
    document.addEventListener('keydown', function (e) { if (editing && e.key === 'Escape') { e.preventDefault(); setEditing(false); } });

    var doneBtn = document.getElementById('layoutDoneBtn');
    if (doneBtn) doneBtn.addEventListener('click', function () { setEditing(false); });
    var moreBtn = document.getElementById('layoutMoreBtn');
    if (moreBtn) moreBtn.addEventListener('click', function () {
        var url = chrome.runtime.getURL('src/options/options.html#uklad');
        try { chrome.tabs.create({ url: url }); } catch (e) { window.open(url); }
    });
    var resetBtn = document.getElementById('layoutResetBtn');
    if (resetBtn) {
        var resetArmed = 0;
        resetBtn.addEventListener('click', function () {
            if (!resetArmed) {   // pierwszy klik pyta, drugi przywraca (bez okienka confirm w popupie)
                resetBtn.textContent = 'Na pewno? Kliknij jeszcze raz';
                resetBtn.classList.add('danger');
                resetArmed = setTimeout(function () { resetArmed = 0; resetBtn.textContent = '↺ Domyślny'; resetBtn.classList.remove('danger'); }, 3000);
                return;
            }
            clearTimeout(resetArmed);
            resetArmed = 0;
            resetBtn.textContent = '↺ Domyślny';
            resetBtn.classList.remove('danger');
            prevVis = {};
            layout = L.defaults();
            commit();
        });
    }

    // ----- przeciąganie: między kartami, na koniec zakładki, na przycisk zakładki -----
    var dragId = '', springTimer = 0;
    function clearMarks() {
        document.querySelectorAll('.drop-before, .drop-after, .drop-end, .drop-tab').forEach(function (e) {
            e.classList.remove('drop-before', 'drop-after', 'drop-end', 'drop-tab');
        });
    }
    function dropTarget(e, pane) {
        var card = e.target.closest && e.target.closest('.card[data-mod]');
        if (card && card.dataset.mod !== dragId && pane.contains(card)) {
            var r = card.getBoundingClientRect();
            return { card: card, after: e.clientY > r.top + r.height / 2 };
        }
        return { card: null, after: true };
    }
    Object.keys(mods).forEach(function (id) {
        var c = mods[id];
        c.addEventListener('dragstart', function (e) {
            if (!editing) { e.preventDefault(); return; }
            dragId = id;
            c.classList.add('mod-dragging');
            try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); } catch (x) { /* ignore */ }
        });
        c.addEventListener('dragend', function () {
            dragId = '';
            c.classList.remove('mod-dragging');
            clearTimeout(springTimer);
            clearMarks();
        });
    });
    Object.keys(panes).forEach(function (tabId) {
        var pane = panes[tabId];
        pane.addEventListener('dragover', function (e) {
            if (!editing || !dragId) return;
            e.preventDefault();
            clearMarks();
            var t = dropTarget(e, pane);
            if (t.card) t.card.classList.add(t.after ? 'drop-after' : 'drop-before');
            else pane.classList.add('drop-end');
        });
        pane.addEventListener('drop', function (e) {
            if (!editing || !dragId) return;
            e.preventDefault();
            var t = dropTarget(e, pane);
            var before = '';
            if (t.card) {
                var list = layout.tabs[tabId].filter(function (x) { return x !== dragId; });
                var k = list.indexOf(t.card.dataset.mod);
                before = t.after ? (list[k + 1] || '') : t.card.dataset.mod;
            }
            L.move(layout, dragId, tabId, before);
            clearMarks();
            commit();
        });
    });
    Object.keys(tabBtns).forEach(function (tabId) {
        var b = tabBtns[tabId];
        b.addEventListener('dragover', function (e) {
            if (!editing || !dragId) return;
            e.preventDefault();
            if (!b.classList.contains('drop-tab')) {
                clearMarks();
                b.classList.add('drop-tab');
                clearTimeout(springTimer);   // przytrzymanie nad zakładką = otwórz ją (upuścisz w wybranym miejscu)
                springTimer = setTimeout(function () { if (dragId && typeof window.__mlTabShow === 'function') window.__mlTabShow(tabId); }, 650);
            }
        });
        b.addEventListener('dragleave', function () { b.classList.remove('drop-tab'); clearTimeout(springTimer); });
        b.addEventListener('drop', function (e) {
            if (!editing || !dragId) return;
            e.preventDefault();
            clearTimeout(springTimer);
            L.move(layout, dragId, tabId);
            clearMarks();
            commit();
            flashTab(tabId);
        });
    });

    // ----- start: od razu z lustra, potem storage i strona w karcie -----
    if (layout.start !== 'last') { try { localStorage.setItem('lektorTab', layout.start); } catch (e) { /* ignore */ } }
    apply();
    L.load(function (l) {
        if (L.same(l, layout)) return;
        layout = l;
        apply();
    });
    try {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            void chrome.runtime.lastError;
            try {
                var u = new URL(tabs && tabs[0] && tabs[0].url || '');
                host = /^https?:$/.test(u.protocol) ? u.hostname : '';
            } catch (e) { host = ''; }
            apply();
        });
    } catch (e) { host = ''; apply(); }
    try {
        chrome.storage.onChanged.addListener(function (ch, area) {
            if (area !== 'local' || !ch[L.KEY]) return;
            var l = L.normalize(ch[L.KEY].newValue);
            if (L.same(l, layout)) return;
            layout = l;
            L.writeMirror(l);
            apply();
        });
    } catch (e) { /* ignore */ }
})();

// [AGENT-EXP] 2026-11-16: „🛠 Diagnostyka” i „⚙ Ustawienia i dziennik” (<details> w kartach) rozwijały się skokowo —
// natywne przełączenie pokazuje/ukrywa treść w jednej klatce, więc karty pod spodem przeskakują. Ten sam rachunek,
// co przy kartach: animujemy wysokość (treść przycinana overflow), a stan `open` ustawiamy DOPIERO po animacji.
(function () {
    'use strict';
    var MS = 190;
    var list = document.querySelectorAll('details');
    Array.prototype.forEach.call(list, function (d) {
        var s = d.querySelector(':scope > summary');
        if (!s) return;
        var timer = 0;
        function reset() {
            d.style.transition = '';
            d.style.height = '';
            d.style.overflow = '';
        }
        s.addEventListener('click', function (e) {
            e.preventDefault();                     // zamiast natychmiastowego przełączenia — animacja
            var wasOpen = d.open;
            if (timer) { clearTimeout(timer); timer = 0; reset(); }   // poprzednia animacja przerwana: kończymy ją w miejscu
            var from = d.offsetHeight;
            var to;
            d.style.transition = 'none';
            if (wasOpen) {                          // zwijanie: cel = sam nagłówek
                d.open = false;
                to = d.offsetHeight;
                d.open = true;
            } else {                                // rozwijanie: otwieramy, żeby zmierzyć pełną treść
                d.open = true;
                to = d.offsetHeight;
            }
            d.style.overflow = 'hidden';             // dopiero po pomiarze — overflow blokuje zapadanie marginesu nagłówka
            d.style.height = from + 'px';
            void d.offsetHeight;                    // start od wysokości wyjściowej
            d.style.transition = 'height ' + MS + 'ms cubic-bezier(.4, 0, .2, 1)';
            d.style.height = to + 'px';
            d.open = true;                          // przez czas animacji treść jest w układzie (przycięta overflow),
                                                    // właściwy stan (open/closed) wchodzi dopiero po animacji
            timer = setTimeout(function () {
                timer = 0;
                d.open = !wasOpen;                  // właściwy stan wchodzi na końcu — bez skoku wysokości
                reset();
            }, MS + 30);
        });
    });
})();
