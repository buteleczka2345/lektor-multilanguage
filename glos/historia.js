// 📜 Napisy na bieżąco — czyta chrome.storage.session 'gnHist' (dopisuje karta.js) i dokłada nowe wpisy na dole.
// Wpis: { t, pl, en } albo separator nowego filmu { sep: true, t, pl }.
// [AGENT-EXP] szukamy w #app, bo #app bywa przeniesiony do okienka „📌 na wierzchu”
const APP = document.getElementById('app');
const $ = (id) => APP.querySelector('#' + id) || document.getElementById(id);
const list = $('list');
let shown = 0;

// Ustawienia okienka (tylko wygoda: wielkość czcionki, oryginał) — w chrome.storage.local
const V = { size: 18, en: true };
function applyView() {
    list.style.fontSize = V.size + 'px';
    APP.classList.toggle('noen', !V.en);
    $('showEn').checked = V.en;
}

function item(h) {
    const d = document.createElement('div');
    d.setAttribute('data-noi18n', '');   // [AGENT-EXP] 2026-10-21: napis z filmu — bez tłumaczenia interfejsu
    if (h.sep) { d.className = 'sep'; d.textContent = h.t + '  ' + h.pl; return d; }
    d.className = 'it';
    const pl = document.createElement('div');
    pl.className = 'pl';
    const t = document.createElement('span');
    t.className = 't'; t.textContent = h.t || '';
    pl.append(t, document.createTextNode(h.pl || h.en || ''));
    d.appendChild(pl);
    if (h.en && h.en !== h.pl) { const en = document.createElement('div'); en.className = 'en'; en.textContent = h.en; d.appendChild(en); }
    return d;
}

function render(hist) {
    if (hist.length <= shown) { list.textContent = ''; shown = 0; } // wyczyszczone albo przycięte (limit 1000) — od nowa
    if (!hist.length) {
        list.innerHTML = '<div id="empty">Tu pojawią się gotowe napisy z filmu (całe zdania, już bez zmian).<br>Włącz „🎧 Film w tej karcie → napisy” (Alt+Shift+2).</div>';
    } else {
        const empty = $('empty'); if (empty) empty.remove();
        for (let i = shown; i < hist.length; i++) list.appendChild(item(hist[i]));
    }
    shown = hist.length;
    $('count').textContent = hist.filter((h) => !h.sep).length + ' napisów';
    if ($('follow').checked) list.scrollTop = list.scrollHeight;
}

async function load() {
    const { gnHist = [] } = await chrome.storage.session.get('gnHist');
    render(gnHist);
}
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'session' && ch.gnHist) render(ch.gnHist.newValue || []); });

$('smaller').addEventListener('click', () => { V.size = Math.max(11, V.size - 2); applyView(); chrome.storage.local.set({ gnHistView: V }); });
$('bigger').addEventListener('click', () => { V.size = Math.min(40, V.size + 2); applyView(); chrome.storage.local.set({ gnHistView: V }); });
$('showEn').addEventListener('change', () => { V.en = $('showEn').checked; applyView(); chrome.storage.local.set({ gnHistView: V }); });
$('follow').addEventListener('change', () => { if ($('follow').checked) list.scrollTop = list.scrollHeight; });
$('copy').addEventListener('click', async () => {
    const { gnHist = [] } = await chrome.storage.session.get('gnHist');
    const txt = gnHist.map((h) => h.sep ? '\n' + h.pl : (h.t + '  ' + (h.pl || h.en))).join('\n').trim();
    try { await navigator.clipboard.writeText(txt); $('copy').textContent = '✓ Skopiowano'; }
    catch (e) { $('copy').textContent = '✗ Nie skopiowano'; }
    setTimeout(() => { $('copy').textContent = '📋 Kopiuj'; }, 1500);
});
$('clear').addEventListener('click', () => chrome.storage.session.set({ gnHist: [] }));

// [AGENT-EXP] 📌 Na wierzchu: zwykłe okienko chowa się za Chrome po kliknięciu w stronę, a okienko
// Document Picture-in-Picture zostaje nad wszystkimi oknami. Chrome otwiera je tylko po kliknięciu, więc gdy
// raz było włączone (V.pip), wraca samo przy pierwszym kliknięciu w to okienko.
let PIP = null;
const pipOk = () => 'documentPictureInPicture' in self;
async function pipOpen() {
    if (PIP || !pipOk()) return;
    try {
        PIP = await documentPictureInPicture.requestWindow({ width: Math.max(320, innerWidth), height: Math.max(300, innerHeight) });
    } catch (e) { $('pip').title = 'nie udało się: ' + (e && e.message || e); PIP = null; return; }
    for (const st of document.querySelectorAll('style')) PIP.document.head.appendChild(st.cloneNode(true));
    PIP.document.title = document.title;
    PIP.document.body.appendChild(APP);
    try { if (self.MLi18n) MLi18n.watch(APP); } catch (e) {}   // [AGENT-EXP] 2026-10-21: w okienku na wierzchu też PL / EN
    $('pipNote').style.display = 'block';
    $('pip').classList.add('on'); $('pip').textContent = '📌 Na wierzchu ✓';
    if ($('follow').checked) list.scrollTop = list.scrollHeight;
    PIP.addEventListener('pagehide', pipBack, { once: true });
    if (!V.pip) { V.pip = true; chrome.storage.local.set({ gnHistView: V }); }
}
function pipBack() {
    if (!PIP) return;
    const w = PIP; PIP = null;
    document.body.appendChild(APP);
    $('pipNote').style.display = 'none';
    $('pip').classList.remove('on'); $('pip').textContent = '📌 Na wierzchu';
    if ($('follow').checked) list.scrollTop = list.scrollHeight;
    try { w.close(); } catch (_) { }
}
$('pip').addEventListener('click', () => {
    if (PIP) { pipBack(); V.pip = false; chrome.storage.local.set({ gnHistView: V }); } else pipOpen();
});
$('pipBack').addEventListener('click', () => { pipBack(); V.pip = false; chrome.storage.local.set({ gnHistView: V }); });
document.addEventListener('pointerdown', (e) => { if (V.pip && !PIP && !e.target.closest('#pip, #pipBack')) pipOpen(); });
if (!pipOk()) { $('pip').disabled = true; $('pip').title = 'ten Chrome nie ma okienka na wierzchu (Document Picture-in-Picture)'; }

(async () => {
    try { const { gnHistView } = await chrome.storage.local.get('gnHistView'); if (gnHistView) Object.assign(V, gnHistView); } catch (_) { }
    applyView();
    await load();
    list.scrollTop = list.scrollHeight;
})();
