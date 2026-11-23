// 🎙 Głos i napisy — sekcja w popupie lektora (src/popup/popup.html, #gnBox).
// Start/stop obu funkcji (tło: glos/glos_bg.js), ustawienia (zapisują się same) i dziennik diagnostyczny.
import { cfgGet, DEF, locState, locInstall, locSupported, LOC_TXT } from './common.js';

const $ = (id) => document.getElementById(id);

// ---------- Przyciski start/stop ----------
function paint(st) {
    $('gnGlosBtn').classList.toggle('on', !!st.glos);
    $('gnGlosBtn').textContent = st.glos ? '⏹ Mój głos → tekst: WYŁĄCZ' : '🎤 Mój głos → tekst (Alt+Shift+1)';
    $('gnKartaBtn').classList.toggle('on', !!st.karta);
    $('gnKartaBtn').textContent = st.karta ? '⏹ Napisy z filmu: WYŁĄCZ' : '🎧 Film w tej karcie → napisy (Alt+Shift+2)';
}
function refresh() { chrome.runtime.sendMessage({ action: 'GN_STATE' }, (r) => { void chrome.runtime.lastError; if (r) paint(r); }); }
function toggle(action) {
    $('gnMsg').textContent = '';
    chrome.runtime.sendMessage({ action }, (r) => {
        void chrome.runtime.lastError;
        if (r && r.why) { $('gnMsg').textContent = '❌ ' + r.why; return; }
        refresh();
        if (r && r.on) window.close(); // fokus wraca na stronę
    });
}
$('gnGlosBtn').addEventListener('click', () => toggle('GN_GLOS_TOGGLE'));
$('gnKartaBtn').addEventListener('click', () => toggle('GN_KARTA_TOGGLE'));
$('gnHistBtn').addEventListener('click', () => chrome.runtime.sendMessage({ action: 'GN_HIST_OPEN' }, () => { void chrome.runtime.lastError; window.close(); }));
refresh();

// ---------- Ustawienia: każdy element z data-gk zapisuje się sam ----------
(async () => {
    const cfg = await cfgGet();
    document.querySelectorAll('[data-gk]').forEach((el) => {
        const k = el.dataset.gk;
        const show = () => { const v = document.querySelector('[data-gv="' + k + '"]'); if (v) v.textContent = el.value + ' dB'; };
        if (el.type === 'checkbox') el.checked = !!cfg[k];
        else el.value = String(cfg[k]);
        show();
        el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
            let v = el.type === 'checkbox' ? el.checked : el.value;
            if (el.type === 'range' || typeof DEF[k] === 'number') v = Number(v);
            chrome.storage.local.set({ [k]: v });
            show();
        });
    });
})();

// ---------- 🔒 Rozpoznawanie lokalne: stan modeli mowy + pobieranie ----------
const gk = (k) => document.querySelector('[data-gk="' + k + '"]');
const locLangs = () => [...new Set([gk('glosLang').value, gk('kartaLang').value])];
const LOCDL = {}; // język -> trwa pobieranie / błąd
async function locShow() {
    if (!gk('gnLocal').checked) { $('gnLocInfo').textContent = '🌐 wyłączone — mowę rozpoznaje Google (przez internet)'; return; }
    if (!locSupported()) { $('gnLocInfo').textContent = LOC_TXT.unsupported; return; }
    const langs = locLangs();
    const st = await Promise.all(langs.map(locState));
    $('gnLocInfo').textContent = langs.map((l, i) => l + ': ' + (LOCDL[l] === true ? LOC_TXT.downloading : (LOC_TXT[st[i]] || st[i]))
        + (typeof LOCDL[l] === 'string' ? ' (' + LOCDL[l] + ')' : '')).join('\n');
}
$('gnLocGet').addEventListener('click', () => {
    if (!gk('gnLocal').checked) { gk('gnLocal').checked = true; gk('gnLocal').dispatchEvent(new Event('change')); }
    if (!locSupported()) { locShow(); return; }
    for (const l of locLangs()) { // od razu w kliknięciu — Chrome inaczej nie pozwoli pobrać
        LOCDL[l] = true;
        locInstall(l).then((ok) => { LOCDL[l] = ok ? undefined : 'nie udało się'; })
            .catch((e) => { LOCDL[l] = (e && e.name) || String(e); })
            .finally(locShow);
    }
    $('gnLocInfo').textContent = '⏳ pobieram — nie zamykaj tego okienka, aż będzie ✓…';
    locShow();
});
setTimeout(locShow, 200); // po wczytaniu ustawień
setInterval(locShow, 2000);
document.addEventListener('change', (e) => { if (e.target && e.target.dataset && e.target.dataset.gk) setTimeout(locShow, 100); });

// ---------- Dziennik ----------
async function showLog() {
    const { gnDbg = [] } = await chrome.storage.local.get('gnDbg');
    const box = $('gnLog');
    const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 5;
    box.value = gnDbg.join('\n');
    if (atEnd) box.scrollTop = box.scrollHeight;
}
showLog();
setInterval(showLog, 1000);
$('gnCopy').addEventListener('click', async () => {
    const { gnDbg = [] } = await chrome.storage.local.get('gnDbg');
    const head = 'Lektor — Głos i napisy ' + chrome.runtime.getManifest().version + ' | ' + navigator.userAgent.match(/Chrome\/[\d.]+/) + '\n';
    try { await navigator.clipboard.writeText(head + gnDbg.join('\n')); $('gnCopy').textContent = '✓ Skopiowano'; }
    catch (e) { $('gnLog').select(); document.execCommand('copy'); $('gnCopy').textContent = '✓ Skopiowano'; }
    setTimeout(() => { $('gnCopy').textContent = '📋 Kopiuj dziennik'; }, 1500);
});
$('gnClear').addEventListener('click', () => chrome.storage.local.set({ gnDbg: [] }).then(showLog));
