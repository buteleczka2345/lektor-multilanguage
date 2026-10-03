// lektor-settings.js — Przycisk „⚙️ Ustawienia” + arkusz ustawień NA STRONIE.


 
// Działa na WSZYSTKICH wspieranych platformach (Netflix, YouTube, Prime Video, iQ,
// iQIYI, Dailymotion, Rumble)— także na Androidzie (Kiwi Browser itp.), bo to zwykły
// element DOM strony, NIE popup rozszerzenia (który na Androidzie się nie otwiera).
//
// Wszystko schowane pod jednym przyciskiem ⚙️:
//   1. Przesunięcie napisów w lewo/w prawo: −1 s, −100 ms, +100 ms, +1 s (0 = reset..
//      Ujemna wartość = lektor mówi WCZEŚNIEJ (np. jak Netflix buforuje), dodatnia = później.

(function () {
    'use strict';
    if (window.__LEKTOR_SETTINGS_JS_RUNNING__) return;
    window.__LEKTOR_SETTINGS_JS_RUNNING__ = true;
    try { if (/^\/embed\//.test(location.pathname)) return; } catch (e) {} // ramka Hover: bez arkusza ustawień w podglądzie
 
    var offsetMs = 0;
    var blocked = [];
    var sheet = null, gear = null;
 
    // =====================================================================
    // Blokady zdań i wyrazów (substring — wpis całego zdania też blokuje całe zdanie)
    // =====================================================================
    function normalizeForCheck(t) {
        return String(t)
            .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, ' ')
            .replace(/[\s\u00A0]+/g, ' ')
            .trim().toLowerCase();
    }
    function isBlockedText(t) {
        if (!blocked.length) return false;
        var n = normalizeForCheck(t);
        if (!n) return false;
        for (var i = 0; i < blocked.length; i++) {
            if (n.indexOf(blocked[i]) !== -1) return true;
        }
        return false;
    }
    function saveBlocked() {
        try { chrome.storage.local.set({ userBlockedPhrases: blocked.slice() }); } catch (e) {}
    }
    function addBlocked(phrase) {
        var p = normalizeForCheck(phrase);
        if (!p || p.length < 2) return;
        if (blocked.indexOf(p) === -1) { blocked.push(p); saveBlocked(); }
    }
    function removeBlocked(phrase) {
        var i = blocked.indexOf(phrase);
        if (i !== -1) { blocked.splice(i, 1); saveBlocked(); }
    }

    // =====================================================================
    // Offset napisów (przesuwanie lektora względem wideo)
    // =====================================================================
    function notifyOffsetHooks(nv, ov) {
        try {
            var hs = window.__LIVEDUB_OFFSET_HOOKS__;
            if (Array.isArray(hs)) for (var i = 0; i < hs.length; i++) { try { hs[i](nv, ov); } catch (e) {} }
        } catch (e) {}
    }
    function saveOffset(v) {
        v = Math.round(Number(v) || 0);
        v = Math.max(-60000, Math.min(60000, v));
        var old = offsetMs;
        offsetMs = v;
        window.__LIVEDUB_OFFSET_MS__ = offsetMs;

        try { chrome.storage.local.set({ subtitleOffsetMs: offsetMs }); } catch (e) {}
        notifyOffsetHooks(offsetMs, old);
        renderOffset();
        updateGearBadge();
    }

    // Ustawienia UI: domyślnie włączone, ale można wyłączyć lekturę panelu przez storage.
    var uiEnabled = true;
    try {
        chrome.storage.local.get(['lektorSettingsUiEnabled'], function (r) {
            uiEnabled = !r || r.lektorSettingsUiEnabled !== false;
            if (!uiEnabled && sheet) sheet.style.display = 'none';
            if (!uiEnabled && gear && gear.isConnected) gear.style.display = 'none';
            if (!uiEnabled && hiddenPill && hiddenPill.isConnected) hiddenPill.style.display = 'flex';
        });
    } catch (e) {}

    // ... (reszta funkcji bez zmian, szczególnie:
    //      - window.__LIVEDUB_OFFSET_MS__, __LIVEDUB_OFFSET_HOOKS__,
    //        __LIVEDUB_GET_OFFSET__, __LIVEDUB_SET_OFFSET__, __LIVEDUB_IS_BLOCKED__
    //        pozostają aktywne niezależnie od UI)
    // UI — renderowanie
    // =====================================================================
    function fmtOffset() {
        if (offsetMs === 0) return '0,000 s (brak przesunięcia)';
        var s = Math.abs(offsetMs / 1000).toFixed(3).replace('.', ',');
        return (offsetMs < 0 ? '−' : '+') + s + ' s — lektor ' + (offsetMs < 0 ? 'WCZEŚNIEJ' : 'PÓŹNIEJ');
    }
    function mkBtn(label, title, onClick, extraStyle) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.title = title || '';
        b.style.cssText = 'min-height:42px;border-radius:10px;border:1px solid rgba(255,255,255,.22);'
            + 'background:rgba(255,255,255,.09);color:#fff;font:bold 14px system-ui,sans-serif;'
            + 'cursor:pointer;padding:8px 10px;touch-action:manipulation;' + (extraStyle || '');
        b.addEventListener('click', onClick);
        return b;
    }
    function sectionTitle(t) {
        var d = document.createElement('div');
        d.textContent = t;
        d.style.cssText = 'color:#9cf;font:bold 12px system-ui,sans-serif;border-bottom:1px solid rgba(255,255,255,.12);padding-bottom:4px;';
        return d;
    }
    function renderOffset() {
        var el = document.getElementById('lektor-settings-offset-val');
        if (el) el.textContent = fmtOffset();
        var sub = document.getElementById('lektor-settings-offset-sub');
        if (sub) sub.textContent = 'Ujemna wartość = lektor mówi wcześniej (np. gdy buforuje). Dodatnia = później.';
        renderMode();
    }
    // Wskaźnik trybu: cofanie (−) działa tylko tam, gdzie lektor zna przyszłe kwestie
    // (oś czasu / napisy z pliku). W trybie „na żywo" nie może — napis jeszcze nie istnieje.
    function renderMode() {
        var el = document.getElementById('lektor-settings-mode');
        if (!el) return;
        var m = null;
        try { if (window.__LIVEDUB_GET_MODE__) m = window.__LIVEDUB_GET_MODE__(); } catch (e) {}
        if (!m) { el.textContent = ''; return; }
        if (m.mode === 'timeline') {
            el.textContent = '🎬 Oś czasu napisów aktywna (' + m.cues + ' kwestii) — przesunięcie działa w OBIE strony, także w lewo (−).';
            el.style.color = '#7effa0';
        } else if (m.mode === 'file') {
            el.textContent = '📂 Napisy z pliku (' + m.cues + ' kwestii) — przesunięcie działa w OBIE strony.';
            el.style.color = '#7effa0';
        } else {
            el.textContent = '🔴 Czytanie NA ŻYWO — „+" (później) działa, „−" (wcześniej) NIE: lektor widzi napis dopiero, gdy się pojawia. Cofanie działa na Netflixie, z napisami z pliku i na YouTube, gdy oś czasu napisów jest aktywna.';
            el.style.color = '#ffb86b';
        }
    }
    function renderBlocked() {
        var box = document.getElementById('lektor-settings-block-list');
        if (!box) return;
        box.textContent = '';
        if (!blocked.length) {
            var none = document.createElement('div');
            none.textContent = 'Brak blokad.';
            none.style.cssText = 'color:#777;font:11px system-ui,sans-serif;';
            box.appendChild(none);
            return;
        }
        for (var i = 0; i < blocked.length; i++) {
            (function (ph) {
                var chip = document.createElement('span');
                chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:rgba(255,90,90,.18);'
                    + 'border:1px solid rgba(255,90,90,.4);border-radius:999px;padding:4px 8px;margin:2px 4px 2px 0;font-size:12px;';
                chip.textContent = ph;
                var x = document.createElement('span');
                x.textContent = '✕';
                x.title = 'Usuń z blokad';
                x.style.cssText = 'cursor:pointer;opacity:0.85;font-weight:bold;padding:0 2px;';
                x.addEventListener('click', function () { removeBlocked(ph); });
                chip.appendChild(x);
                box.appendChild(chip);
            })(blocked[i]);
        }
    }
    // --- Kopiowanie do schowka (clipboard API + fallback) ---
    function copyFallback(t) {
        try {
            var ta = document.createElement('textarea');
            ta.value = t;
            ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
            (document.body || document.documentElement).appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
        } catch (e) {}
    }
    function copyToClipboard(t) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(t).catch(function () { copyFallback(t); });
                return;
            }
        } catch (e) {}
        copyFallback(t);
    }

    // --- Sekcja „🗣️ Wypowiedziane”: lista tekstów wypowiedzianych przez lektora ---
    function renderSpoken() {
        var box = document.getElementById('lektor-settings-spoken-list');
        if (!box) return;
        box.textContent = '';
        var log = [];
        try { if (window.__LIVEDUB_GET_SPOKEN__) log = window.__LIVEDUB_GET_SPOKEN__() || []; } catch (e) {}
        if (!log.length) {
            var none = document.createElement('div');
            none.textContent = 'Lektor jeszcze nic nie powiedział na tej stronie.';
            none.style.cssText = 'color:#777;font:11px system-ui,sans-serif;';
            box.appendChild(none);
            return;
        }
        for (var i = log.length - 1; i >= 0; i--) {
            (function (txt) {
                var row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:flex-start;gap:6px;background:rgba(255,255,255,.05);'
                    + 'border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:5px 7px;';
                var span = document.createElement('span');
                span.textContent = txt;
                span.style.cssText = 'flex:1;font:12px system-ui,sans-serif;line-height:1.4;word-break:break-word;';
                row.appendChild(span);
                var bBlock = mkBtn('🚫', 'Zablokuj tę linię', function () { addBlocked(txt); renderSpoken(); }, 'min-height:30px;padding:2px 8px;');
                bBlock.style.background = 'rgba(255,90,90,.15)';
                row.appendChild(bBlock);
                var bCopy = mkBtn('📋', 'Kopiuj tekst (wklej fragment do blokad powyżej)', function () {
                    copyToClipboard(txt);
                    bCopy.textContent = '✓';
                    setTimeout(function () { bCopy.textContent = '📋'; }, 900);
                }, 'min-height:30px;padding:2px 8px;');
                row.appendChild(bCopy);
                box.appendChild(row);
            })(log[i]);
        }
    }
// =====================================================================
    // Arkusz ustawień (tworzony leniwie, przy pierwszym otwarciu)
    // =====================================================================
    function ensureSheet() {
        if (sheet) return sheet;
        sheet = document.createElement('div');
        sheet.id = 'lektor-settings-sheet';
        sheet.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:16px;'
            + 'width:min(94vw,430px);max-height:82vh;overflow-y:auto;z-index:2147483647;'
            + 'background:rgba(14,14,18,.98);border:1px solid rgba(255,255,255,.22);'
            + 'border-radius:14px;padding:14px;display:none;flex-direction:column;gap:12px;'
            + 'color:#eee;font:13px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.65);'
            + 'box-sizing:border-box;touch-action:manipulation;';
        (document.body || document.documentElement).appendChild(sheet);

        // Nagłówek
        var head = document.createElement('div');
        head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
        var title = document.createElement('strong');
        title.textContent = '⚙️ Ustawienia lektora';
        title.style.cssText = 'font-size:15px;';
        var closeBtn = mkBtn('✕', 'Zamknij ustawienia', function () { sheet.style.display = 'none'; }, 'min-height:36px;padding:4px 10px;');
        closeBtn.style.background = 'rgba(255,90,90,.2)';
        closeBtn.style.borderColor = 'rgba(255,90,90,.5)';
        head.appendChild(title);
        head.appendChild(closeBtn);
        sheet.appendChild(head);

        // --- 1. Przesunięcie napisów ---
        sheet.appendChild(sectionTitle('🕒 Przesunięcie napisów (lewo / prawo)'));
        var offVal = document.createElement('div');
        offVal.id = 'lektor-settings-offset-val';
        offVal.style.cssText = 'text-align:center;font:bold 17px system-ui,sans-serif;color:#7ee0ff;';
        sheet.appendChild(offVal);
        var offGrid = document.createElement('div');
        offGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;';
        [[-1000,"−1 s","1 sekunda wcześniej"],[-100,"−100 ms","100 milisekund wcześniej"],[100,"+100 ms","100 milisekund później"],[1000,"+1 s","1 sekunda później"]].forEach(function (c) {
            var b = mkBtn(c[1], c[2], function () { saveOffset(offsetMs + c[0]); });
            offGrid.appendChild(b);
        });
        sheet.appendChild(offGrid);
        var offReset = mkBtn('0 — wyzeruj przesunięcie', 'Przywróć 0 (brak przesunięcia)', function () { saveOffset(0); }, 'width:100%;');
        offReset.style.background = 'rgba(255,255,255,.05)';
        sheet.appendChild(offReset);
        var offSub = document.createElement('div');
        offSub.id = 'lektor-settings-offset-sub';
        offSub.style.cssText = 'color:#888;font:11px system-ui,sans-serif;line-height:1.4;';
        sheet.appendChild(offSub);
        var modeEl = document.createElement('div');
        modeEl.id = 'lektor-settings-mode';
        modeEl.style.cssText = 'font:11px system-ui,sans-serif;line-height:1.5;';
        sheet.appendChild(modeEl);

        // (Sekcja „Napisy z pliku” usunięta — napisy z pliku wczytuje się w popupie
        //  rozszerzenia „📂 Wczytaj plik” oraz w panelu po lewej stronie na dole.)

// --- 3. Blokada zdań i wyrazów ---
        sheet.appendChild(sectionTitle('🚫 Blokada zdań i wyrazów'));
        var blockRow = document.createElement('div');
        blockRow.style.cssText = 'display:flex;gap:6px;';
        var blockInput = document.createElement('input');
        blockInput.type = 'text';
        blockInput.id = 'lektor-settings-block-input';
        blockInput.placeholder = 'np. „ale ja” — wpisz całe zdanie albo wyraz';
        blockInput.style.cssText = 'flex:1;min-height:42px;background:rgba(255,255,255,.07);color:#fff;'
            + 'border:1px solid rgba(255,255,255,.25);border-radius:10px;padding:6px 10px;'
            + 'font:13px system-ui,sans-serif;box-sizing:border-box;';
        blockRow.appendChild(blockInput);
        var blockAdd = mkBtn('＋ Blokuj', 'Dodaj do blokady', function () {
            addBlocked(blockInput.value);
            blockInput.value = '';
        }, '');
        blockRow.appendChild(blockAdd);
        sheet.appendChild(blockRow);
        blockInput.addEventListener('keydown', function (ev) {
            ev.stopPropagation();
            if (ev.key === 'Enter') {
                addBlocked(blockInput.value);
                blockInput.value = '';
            }
        });

        var blockHint = document.createElement('div');
        blockHint.textContent = 'Całe zdanie zablokuje to zdanie, a pojedynczy wyraz — ten wyraz.';
        blockHint.style.cssText = 'color:#888;font:11px system-ui,sans-serif;';
        sheet.appendChild(blockHint);

        var blockList = document.createElement('div');
        blockList.id = 'lektor-settings-block-list';
        blockList.style.cssText = 'display:flex;flex-wrap:wrap;gap:2px;max-height:110px;overflow-y:auto;';
        sheet.appendChild(blockList);

        // --- 4. Wypowiedziane teksty (podgląd + szybkie blokowanie/kopiowanie) ---
        sheet.appendChild(sectionTitle('🗣️ Wypowiedziane teksty (ostatnie 100)'));
        var spokenTools = document.createElement('div');
        spokenTools.style.cssText = 'display:flex;gap:6px;';
        var spokenRefresh = mkBtn('⟳ Odśwież', 'Pokaż aktualną listę wypowiedzi lektora', function () { renderSpoken(); }, 'flex:1;');
        spokenTools.appendChild(spokenRefresh);
        var spokenClear = mkBtn('🗑 Wyczyść', 'Usuń zapis wypowiedzi', function () {
            try { if (window.__LIVEDUB_CLEAR_SPOKEN__) window.__LIVEDUB_CLEAR_SPOKEN__(); } catch (e) {}
            renderSpoken();
        }, '');
        spokenClear.style.background = 'rgba(255,90,90,.15)';
        spokenTools.appendChild(spokenClear);
        sheet.appendChild(spokenTools);
        var spokenList = document.createElement('div');
        spokenList.id = 'lektor-settings-spoken-list';
        spokenList.style.cssText = 'display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto;';
        sheet.appendChild(spokenList);
        var spokenHint = document.createElement('div');
        spokenHint.textContent = '🚫 = zablokuj całą linię. 📋 = skopiuj tekst — możesz wtedy wkleić do blokad powyżej tylko wybrany wyraz (np. „porozmawiajmy”).';
        spokenHint.style.cssText = 'color:#888;font:11px system-ui,sans-serif;line-height:1.4;';
        sheet.appendChild(spokenHint);

        // Stopka
        var foot = document.createElement('div');
        foot.textContent = 'Zmiany działają od razu i są wspólne z popupem oraz ze wszystkimi platformami.';
        foot.style.cssText = 'color:#666;font:10px system-ui,sans-serif;border-top:1px solid rgba(255,255,255,.1);padding-top:6px;';
        sheet.appendChild(foot);

        renderOffset(); renderBlocked(); renderSpoken();
        return sheet;
    }
// =====================================================================
    // Pływające kółko zębate „⚙️” (otwiera ustawienia na każdej platformie)
    // =====================================================================
    function toggleSheet() {
        var s = ensureSheet();
        var willShow = s.style.display !== 'flex';
        s.style.display = willShow ? 'flex' : 'none';
        if (willShow) { renderOffset(); renderBlocked(); renderSpoken(); }
    }
    function ensureGear() {
        if (gear && gear.isConnected) return;
        gear = document.createElement('button');
        gear.id = 'lektor-settings-gear';
        gear.type = 'button';
        gear.textContent = '⚙️';
        gear.title = 'Ustawienia lektora: przesunięcie napisów, plik, blokady';
        gear.style.cssText = 'position:fixed;right:14px;bottom:64px;z-index:2147483646;'
            + 'width:46px;height:46px;border-radius:50%;background:rgba(18,18,22,.94);'
            + 'color:#fff;border:1px solid rgba(255,255,255,.3);font:bold 22px system-ui,sans-serif;'
            + 'cursor:pointer;display:flex;align-items:center;justify-content:center;'
            + 'box-shadow:0 2px 10px rgba(0,0,0,.5);touch-action:manipulation;';
        gear.addEventListener('click', function (ev) {
            ev.preventDefault(); ev.stopPropagation();
            // Przycisk ⚙️ wyłączony — stał się duży panel z prawej strony.
            // Zamiast niego służy lektor-controls.js (pasek po lewej).
            // Jeżeli chcesz z powrotem otworzyć arkusz ustawień, wpisz w storage
            // klucz 'lektorSettingsUiEnabled' na true i przeładuj rozszerzenie.
        });
        gear.addEventListener('keydown', function (ev) { ev.stopPropagation(); });
        var badge = document.createElement('span');
        badge.id = 'lektor-gear-badge';
        badge.style.cssText = 'position:absolute;top:-5px;right:-5px;background:#e50914;color:#fff;'
            + 'font:bold 10px system-ui,sans-serif;padding:1px 5px;border-radius:9px;display:none;white-space:nowrap;';
        gear.appendChild(badge);
        (document.body || document.documentElement).appendChild(gear);
        updateGearBadge();
    }

    // Znacznik na przycisku ⚙️: pokazuje aktywne przesunięcie (np. „−1,5 s”),
    // żeby od razu było widać na nowym odcinku, że offset nadal działa.
    function updateGearBadge() {
        try {
            if (!gear || !gear.isConnected) return;
            var b = document.getElementById('lektor-gear-badge');
            if (!b) return;
            if (offsetMs !== 0) {
                var sv = Math.abs(offsetMs) >= 1000
                    ? (Math.abs(offsetMs) / 1000).toFixed(1).replace('.', ',').replace(',0', '') + ' s'
                    : Math.abs(offsetMs) + ' ms';
                b.textContent = (offsetMs < 0 ? '−' : '+') + sv;
                b.style.display = 'block';
            } else {
                b.style.display = 'none';
            }
        } catch (e) {}
    }

    // =====================================================================
    // Synchronizacja z chrome.storage (wspólne klucze z popupem)
    // =====================================================================
    chrome.storage.local.get(['subtitleOffsetMs', 'userBlockedPhrases'], function (r) {
        if (typeof r.subtitleOffsetMs === 'number') offsetMs = r.subtitleOffsetMs;
        if (Array.isArray(r.userBlockedPhrases)) blocked = r.userBlockedPhrases;
        window.__LIVEDUB_OFFSET_MS__ = offsetMs;

        // ensureGear() WYŁĄCZONY — panel ustawień zastąpiony przez lektor-controls.js.
        // updateGearBadge();
        if (sheet) { renderOffset(); renderBlocked(); }
    });

    chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        if (changes.subtitleOffsetMs !== undefined) {
            var oldOff = offsetMs;
            offsetMs = Number(changes.subtitleOffsetMs.newValue) || 0;
            window.__LIVEDUB_OFFSET_MS__ = offsetMs;
            notifyOffsetHooks(offsetMs, oldOff);
            updateGearBadge();

            if (sheet) renderOffset();
        }
        if (changes.userBlockedPhrases !== undefined) {
            blocked = Array.isArray(changes.userBlockedPhrases.newValue) ? changes.userBlockedPhrases.newValue : [];
            if (sheet) renderBlocked();
        }
    });

    // =====================================================================
    // Start
    // =====================================================================
    // Odświeżaj wskaźnik trybu, dopóki arkusz jest otwarty (tryb może się zmienić,
    // np. gdy oś czasu YouTube dociągnie się dopiero po chwili od otwarcia filmu).
    setInterval(function () {
        try { if (sheet && sheet.style.display === 'flex') renderMode(); } catch (e) {}
    }, 3000);
    // Panel ustawień (gear + sheet) WYŁĄCZONY — zastąpiony przez lektor-controls.js (pasek po lewej).
    // if (document.body) ensureGear();
    // else document.addEventListener('DOMContentLoaded', ensureGear);
})();