// Głos i Napisy (test) — nakładka z napisami na stronie z filmem.
// Wstrzykiwana przez tło (chrome.scripting) do karty, której dźwięk słuchamy.
// Treść: wiadomość GN_SUB z okienka karta.html.
(function () {
    'use strict';
    if (window.__gnOverlay) return;
    window.__gnOverlay = true;

    const box = document.createElement('div');
    box.setAttribute('data-gn-karta', '1');
    box.style.cssText = [
        'position:fixed', 'left:50%', 'bottom:9%', 'transform:translateX(-50%)', 'z-index:2147483647',
        'max-width:80vw', 'padding:6px 14px', 'border-radius:8px', 'background:rgba(20,20,20,.82)',
        'font:600 26px/1.3 "Segoe UI",Arial,sans-serif', 'text-align:center', 'pointer-events:none',
        'display:none', 'text-shadow:0 1px 2px #000'
    ].join(';');
    const top = document.createElement('div');
    top.style.cssText = 'color:#bdb46a;font-size:22px;';
    const main = document.createElement('div');
    main.style.cssText = 'color:#ffee58;';
    const second = document.createElement('div');
    second.style.cssText = 'color:#ddd;font:400 17px/1.3 "Segoe UI",Arial,sans-serif;margin-top:2px;';
    box.append(top, main, second);

    // Linijka stanu (lewy górny róg): słucham / błąd — żeby było widać, co się dzieje, bez szukania okienka
    const pill = document.createElement('div');
    pill.setAttribute('data-gn-karta', '1');
    pill.style.cssText = [
        'position:fixed', 'left:16px', 'top:16px', 'z-index:2147483647', 'max-width:60vw', 'padding:5px 10px',
        'border-radius:14px', 'background:rgba(20,20,20,.85)', 'color:#a5d6a7', 'font:600 14px/1.3 "Segoe UI",Arial,sans-serif',
        'pointer-events:none', 'display:none'
    ].join(';');

    // Film na pełnym ekranie: nakładka musi siedzieć w elemencie pełnoekranowym, inaczej jej nie widać
    function place() {
        const host = document.fullscreenElement || document.documentElement;
        if (box.parentNode !== host) host.appendChild(box);
        if (pill.parentNode !== host) host.appendChild(pill);
    }
    document.addEventListener('fullscreenchange', place, true);
    place();

    let hideTimer = null, pillTimer = null;
    chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || msg.action !== 'GN_SUB') return;
        if (msg.status !== undefined) {
            clearTimeout(pillTimer);
            place();
            pill.textContent = msg.status;
            pill.style.color = msg.err ? '#ff9090' : '#a5d6a7';
            pill.style.display = msg.status ? '' : 'none';
            if (msg.statusMs > 0) pillTimer = setTimeout(() => { pill.style.display = 'none'; }, msg.statusMs);
            if (msg.main === undefined && !msg.hide) return;
        }
        clearTimeout(hideTimer);
        if (msg.hide) { box.style.display = 'none'; pill.style.display = 'none'; return; }
        place();
        top.textContent = msg.top || '';
        // gotowy napis piętro wyżej: jasny i czytelny (już się nie zmieni); inaczej przygaszony jak dawniej
        top.style.color = msg.topDone ? '#ffffff' : '#bdb46a';
        top.style.fontSize = msg.topDone ? '24px' : '22px';
        top.style.display = msg.top ? '' : 'none';
        main.textContent = msg.main || '';
        second.textContent = msg.second || '';
        second.style.display = msg.second ? '' : 'none';
        box.style.display = (msg.main || msg.top) ? '' : 'none';
        // cisza w filmie: napis znika sam
        if (msg.keepMs > 0) hideTimer = setTimeout(() => { box.style.display = 'none'; }, msg.keepMs);
    });
})();
