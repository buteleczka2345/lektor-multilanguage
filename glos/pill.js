// Głos i Napisy (test) — plakietka „mój głos → tekst” na stronie (prawy dolny róg): stan + to, co Google właśnie słyszy.
// Wstrzykiwana przez background do karty, w której piszesz. Treść: wiadomość GN_PILL z okienka glos.html.
// Dzięki niej nie trzeba szukać okienka (bywa schowane pod oknem Chrome — i tak działa).
(function () {
    'use strict';
    if (window.__gnPill || window !== window.top) return;
    window.__gnPill = true;

    const pill = document.createElement('div');
    pill.setAttribute('data-gn-glos', '1');
    pill.style.cssText = [
        'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647', 'max-width:420px', 'padding:6px 12px',
        'border-radius:14px', 'background:rgba(30,20,40,.92)', 'border:1px solid #6a4a85', 'color:#e1bee7',
        'font:600 13px/1.35 "Segoe UI",Arial,sans-serif', 'pointer-events:none', 'display:none',
        'box-shadow:0 2px 8px rgba(0,0,0,.4)', 'white-space:pre-wrap'
    ].join(';');
    const head = document.createElement('div');
    const live = document.createElement('div');
    live.style.cssText = 'color:#b3e5fc;font-weight:400;';
    pill.append(head, live);

    function place() {
        const host = document.fullscreenElement || document.documentElement;
        if (pill.parentNode !== host) host.appendChild(pill);
    }
    document.addEventListener('fullscreenchange', place, true);
    place();

    chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || msg.action !== 'GN_PILL') return;
        if (msg.hide) { pill.style.display = 'none'; return; }
        place();
        if (msg.text !== undefined) {
            head.textContent = msg.text;
            pill.style.borderColor = msg.cls === 'err' ? '#c62828' : (msg.cls === 'rec' ? '#e57373' : '#6a4a85');
        }
        if (msg.live !== undefined) { live.textContent = msg.live; live.style.display = msg.live ? '' : 'none'; }
        pill.style.display = '';
    });
})();
