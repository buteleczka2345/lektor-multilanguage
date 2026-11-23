// sub_panel.js — wspólny panel podglądu lektora + filtrowanie fraz przez użytkownika.
// Wstrzykiwany przed youtube_content.js (ta sama izolowana strefa → window współdzielony).
// Blokady zapisuje w chrome.storage.local ('userBlockedPhrases') — ten sam klucz co
// dom_content.js (Prime/iQ), więc frazy zablokowane na YouTube działają też tam i odwrotnie.
(function () {
    'use strict';
    // Ramka Hover (/embed/): zero UI panelu — tylko TTS. Top rysuje panel jak dotad.
    try { if (/^\/embed\//.test(location.pathname)) return; } catch (e) {}
    if (window.__LivedubPanel) return; // anty-dubel (wiele ramek / ponowne wstrzyknięcie)

    var blocked = [];
    var visible = true;
    var panelOn = true; // [AGENT-EXP] opcja „lektorPanelOn” z Ustawień: wył. = panel i pigułka całkiem ukryte
    var box = null, list = null, input = null, blockedBox = null, pill = null;

    function normalize(text) {
        return String(text)
            .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, ' ')
            .replace(/[\s\u00A0]+/g, ' ')
            .trim();
    }

    chrome.storage.local.get(['userBlockedPhrases', 'panelVisible', 'lektorPanelOn'], function (res) {
        if (Array.isArray(res.userBlockedPhrases)) blocked = res.userBlockedPhrases;
        if (res.lektorPanelOn !== undefined) panelOn = res.lektorPanelOn !== false; // [AGENT-EXP]
        if (res.panelVisible !== undefined) visible = !!res.panelVisible;
        renderChips();
        applyVisibility();
    });
    chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        if (changes.userBlockedPhrases !== undefined) {
            blocked = Array.isArray(changes.userBlockedPhrases.newValue) ? changes.userBlockedPhrases.newValue : [];
            renderChips();
        }
        if (changes.panelVisible !== undefined) { visible = !!changes.panelVisible.newValue; applyVisibility(); }
        if (changes.lektorPanelOn !== undefined) { panelOn = changes.lektorPanelOn.newValue !== false; applyVisibility(); } // [AGENT-EXP]
    });

    function saveBlocked() {
        try { chrome.storage.local.set({ 'userBlockedPhrases': blocked.slice() }); } catch (e) {}
    }

    function addUserPhrase(phrase) {
        phrase = normalize(phrase).toLowerCase();
        if (!phrase || phrase.length < 2) return;
        if (blocked.indexOf(phrase) === -1) { blocked.push(phrase); saveBlocked(); }
        renderChips();
    }

    function removeUserPhrase(phrase) {
        var i = blocked.indexOf(phrase);
        if (i !== -1) { blocked.splice(i, 1); saveBlocked(); }
        renderChips();
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
        if (!blocked.length) return false;
        var norm = normalize(text).toLowerCase();
        for (var i = 0; i < blocked.length; i++) {
            if (phraseHit(norm, String(blocked[i] || '').toLowerCase())) return true;
        }
        return false;
    }

    function mkBtn(label, title, onClick) {
        var b = document.createElement('button');
        b.textContent = label;
        b.title = title;
        b.style.cssText = 'flex:0 0 auto;background:rgba(255,255,255,0.12);color:#eee;border:1px solid rgba(255,255,255,0.2);border-radius:5px;padding:1px 6px;font:10px system-ui,sans-serif;cursor:pointer;';
        b.addEventListener('click', onClick);
        return b;
    }

    function renderChips() {
        if (!blockedBox) return;
        try {
            blockedBox.textContent = '';
            for (var i = 0; i < blocked.length; i++) {
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
                    blockedBox.appendChild(chip);
                })(blocked[i]);
            }
        } catch (e) {}
    }

    function panelLog(text, status) {
        if (!list) return;
        try {
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:5px;align-items:flex-start;padding:2px 8px;border-bottom:1px solid rgba(255,255,255,0.06);';
            var icon = document.createElement('span');
            icon.textContent = status === 'spoken' ? '🔊' : '🚫';
            icon.title = status === 'spoken' ? 'Wypowiedziane' : 'Zablokowane przez filtr';
            icon.style.cssText = 'flex:0 0 auto;';
            var tx = document.createElement('span');
            tx.textContent = normalize(text);
            tx.style.cssText = 'flex:1;word-break:break-word;' + (status === 'spoken' ? '' : 'opacity:0.55;text-decoration:line-through;');
            var bx = mkBtn('🚫', 'Zablokuj tę frazę', function () { addUserPhrase(text); });
            row.appendChild(icon); row.appendChild(tx); row.appendChild(bx);
            list.insertBefore(row, list.firstChild);
            if (status === 'spoken') showCaption(text); // OPTIONS-PAGE
            while (list.childNodes.length > 30) list.removeChild(list.lastChild);
        } catch (e) {}
    }

    function applyVisibility() {
        try {
            if (box) box.style.display = panelOn && visible ? 'flex' : 'none';
            if (pill) pill.style.display = panelOn && !visible ? 'flex' : 'none'; // [AGENT-EXP] panelOn
        } catch (e) {}
    }

    function setPanelVisible(vis) {
        visible = vis;
        try { chrome.storage.local.set({ 'panelVisible': vis }); } catch (e) {}
        applyVisibility();
    }

    function createPanel() {
        if (box) return;
        var root = document.body || document.documentElement;
        if (!root) return;
        box = document.createElement('div');
        box.setAttribute('data-lektor-ui', ''); // [AGENT-EXP] chowany przy zrzucie ekranu dla OCR
        box.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147483647;width:272px;max-height:40vh;display:flex;flex-direction:column;background:rgba(18,18,22,0.94);color:#e8e8e8;font:11px/1.35 system-ui,sans-serif;border:1px solid rgba(255,255,255,0.15);border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,0.5);overflow:hidden;';
        var head = document.createElement('div');
        head.style.cssText = 'display:flex;align-items:center;gap:5px;padding:5px 8px;border-bottom:1px solid rgba(255,255,255,0.12);font-weight:600;';
        var title = document.createElement('span');
        title.textContent = '🎤 Lektor — co mówię';
        title.style.cssText = 'flex:1;';
        head.appendChild(title);
        head.appendChild(mkBtn('🗑', 'Wyczyść podgląd', function () { if (list) list.textContent = ''; }));
        head.appendChild(mkBtn('—', 'Minimalizuj panel', function () { setPanelVisible(false); }));
        box.appendChild(head);
        var filterRow = document.createElement('div');
        filterRow.style.cssText = 'display:flex;gap:5px;padding:5px 8px;border-bottom:1px solid rgba(255,255,255,0.12);';
        input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Fraza do zablokowania…';
        input.style.cssText = 'flex:1;min-width:0;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);border-radius:5px;color:#eee;padding:2px 6px;font:10px system-ui,sans-serif;outline:none;';
        input.addEventListener('keydown', function (ev) {
            ev.stopPropagation();
            if (ev.key === 'Enter') { addUserPhrase(input.value); input.value = ''; }
        });
        filterRow.appendChild(input);
        filterRow.appendChild(mkBtn('＋ Blokuj', 'Dodaj frazę do blokad', function () { addUserPhrase(input.value); input.value = ''; }));
        box.appendChild(filterRow);
        blockedBox = document.createElement('div');
        blockedBox.style.cssText = 'padding:3px 8px;border-bottom:1px solid rgba(255,255,255,0.12);max-height:54px;overflow-y:auto;';
        box.appendChild(blockedBox);
        blockedBox.setAttribute('data-noi18n', '');   // [AGENT-EXP] 2026-10-21: frazy użytkownika
        list = document.createElement('div');
        list.setAttribute('data-noi18n', '');   // [AGENT-EXP] 2026-10-21: czytane napisy — nigdy nie tłumaczymy
        list.style.cssText = 'overflow-y:auto;flex:1;min-height:0;';
        box.appendChild(list);
        root.appendChild(box);
        pill = document.createElement('button');
        pill.setAttribute('data-lektor-ui', ''); // [AGENT-EXP]
        pill.textContent = '🎤 Lektor';
        pill.title = 'Pokaż podgląd lektora';
        pill.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147483647;display:none;align-items:center;gap:5px;background:rgba(18,18,22,0.94);color:#eee;border:1px solid rgba(255,255,255,0.25);border-radius:999px;padding:4px 10px;font:10px system-ui,sans-serif;cursor:pointer;';
        pill.addEventListener('click', function () { setPanelVisible(true); });
        root.appendChild(pill);
        try { if (self.MLi18n) { MLi18n.watch(box); MLi18n.watch(pill); } } catch (e) {}   // [AGENT-EXP] 2026-10-21: język interfejsu (PL / EN)
        renderChips();
        applyVisibility();
        try { applyUiOptions(); } catch (e) {} // OPTIONS-PAGE
    }

    var statusLine = null;
    function panelStatus(text) {
        try {
            if (!box) return;
            if (!statusLine) {
                statusLine = document.createElement('div');
                statusLine.style.cssText = 'padding:3px 8px;border-bottom:1px solid rgba(255,255,255,0.12);font-size:10px;color:#9fd8ff;';
                box.insertBefore(statusLine, list);
            }
            statusLine.textContent = text || '';
            statusLine.style.display = text ? 'block' : 'none';
        } catch (e) {}
    }

    // OPTIONS-PAGE-BEGIN: skala panelu + nakładka z czytanym tekstem (opcje ze strony ustawień)
    var capEl = null;
    function applyUiOptions() {
        try {
            var o = window.__LivedubOpts; if (!o) return;
            var sc = Math.max(0.8, Math.min(2, (Number(o.get('uiScale')) || 100) / 100));
            [box, pill].forEach(function (el) { if (el) { el.style.transformOrigin = 'left bottom'; el.style.transform = 'scale(' + sc + ')'; } });
            if (!o.get('captionOverlay') && capEl) capEl.style.display = 'none';
        } catch (e) {}
    }
    function ensureCap() {
        if (capEl && document.body.contains(capEl)) return capEl;
        capEl = document.createElement('div');
        capEl.setAttribute('data-lektor-ui', ''); // [AGENT-EXP] nakładka z czytanym tekstem — OCR nie może jej czytać
        capEl.style.cssText = 'position:fixed;z-index:2147483646;left:50%;top:80px;transform:translateX(-50%);max-width:60vw;background:rgba(0,0,0,.72);color:#fff;font:bold 15px Arial,sans-serif;padding:6px 10px;border-radius:5px;text-align:center;cursor:move;display:none;white-space:pre-wrap;line-height:1.3;text-shadow:0 1px 2px #000;';
        var drag = null;
        capEl.addEventListener('mousedown', function (e) { var r = capEl.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }; capEl.style.transform = 'none'; e.preventDefault(); });
        window.addEventListener('mousemove', function (e) { if (drag) { capEl.style.left = (e.clientX - drag.dx) + 'px'; capEl.style.top = (e.clientY - drag.dy) + 'px'; } });
        window.addEventListener('mouseup', function () { drag = null; });
        (document.body || document.documentElement).appendChild(capEl);
        return capEl;
    }
    function showCaption(text) {
        try {
            var o = window.__LivedubOpts;
            if (!o || !o.get('captionOverlay')) return;
            var el = ensureCap();
            el.textContent = normalize(text);
            el.style.display = 'block';
        } catch (e) {}
    }
    try { if (window.__LivedubOpts) window.__LivedubOpts.onChange(applyUiOptions); } catch (e) {}
    // OPTIONS-PAGE-END

    window.__LivedubPanel = {
        status: panelStatus,
        log: panelLog,
        isBlocked: isUserBlocked,
        addPhrase: addUserPhrase
    };

    if (document.body) createPanel();
    else document.addEventListener('DOMContentLoaded', createPanel);
})();
