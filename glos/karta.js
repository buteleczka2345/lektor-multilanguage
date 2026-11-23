// 🎧 Film w karcie → napisy (cyfrowo, chrome.tabCapture — bez mikrofonu i bez VB-Cable).
// dźwięk karty → AudioContext 48 kHz ├→ głośniki (przechwycona karta milknie, więc oddajemy dźwięk)
//                                   └→ (DeepFilterNet3) → rozpoznawanie Google → tłumacz Chrome (→ PL)
//                                      → napisy na filmie (overlay.js) + czytanie głosem lektora (Sherpa, TTS_PLAY)
//                                        albo tryb „same napisy”
// Kwestie i paczki do czytania jak w aplikacji „Dyktowanie”.
import { cfgGet, log, dfnNode, levelMeter, speechBoost, locSupported, locGate, LOC_TXT } from './common.js';

const $ = (id) => document.getElementById(id);
const L = (m) => log('🎧', m);
const qs = new URLSearchParams(location.search);
const STREAM_ID = qs.get('sid') || '';
const TAB_ID = Number(qs.get('tab')) || 0;
let cfg;

const join = (a, b) => (a && b) ? a + ' ' + b : (a || b);
const words = (t) => (t ? t.split(/\s+/).filter(Boolean) : []);
const upFirst = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const tail = (t, max) => { if (t.length <= max) return t; const c = t.slice(t.length - max); return '…' + c.slice(c.indexOf(' ') + 1); };
const toTab = (m) => { if (TAB_ID) chrome.tabs.sendMessage(TAB_ID, { action: 'GN_SUB', ...m }, () => { void chrome.runtime.lastError; }); };

// Stan w okienku + linijka stanu na filmie
function state(text, cls, statusMs) {
    $('state').textContent = text; $('state').className = cls || '';
    toTab({ status: text, err: cls === 'err', statusMs: statusMs || 0 });
}

// ---------- Dźwięk karty ----------
const A = { stream: null, ctx: null, node: null, track: null, heardAt: 0, startAt: 0 };
const tabStream = (sid) => navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: sid } }, video: false });

// Id strumienia z tła bywa już nieważne („Error starting tab capture”) — wtedy prosimy Chrome o świeże
// (najpierw dla tego okienka, potem ogólne) i próbujemy jeszcze raz.
async function openTabStream() {
    try { return await tabStream(STREAM_ID); }
    catch (e) { L('⚠ pierwsza próba: ' + (e && e.name) + ' ' + (e && e.message) + ' — biorę świeże id karty'); }
    let me = null;
    try { me = await chrome.tabs.getCurrent(); } catch (_) { }
    const tries = me && me.id != null ? [{ targetTabId: TAB_ID, consumerTabId: me.id }, { targetTabId: TAB_ID }] : [{ targetTabId: TAB_ID }];
    let last = null;
    for (const opt of tries) {
        await new Promise((r) => setTimeout(r, 300));
        try {
            const sid = await chrome.tabCapture.getMediaStreamId(opt);
            const s = await tabStream(sid);
            L('strumień karty otwarty za ' + (opt.consumerTabId != null ? '2.' : '3.') + ' próbą');
            return s;
        } catch (e) { last = e; L('⚠ próba ' + JSON.stringify(opt) + ': ' + (e && e.message || e)); }
    }
    try {
        const caps = await new Promise((r) => chrome.tabCapture.getCapturedTabs(r));
        const busy = (caps || []).filter((c) => c.tabId === TAB_ID && c.status === 'active');
        L('przechwytywane karty (przez lektora): ' + JSON.stringify(caps || []));
        if (busy.length) throw new Error('lektor już słucha tej karty — zamknij poprzednie okienko „🎧 Film → napisy”');
    } catch (e) { if (/już słucha/.test(e.message)) throw e; }
    const msg = String(last && last.message || last || '');
    if (/active stream|already/i.test(msg)) throw new Error('tę kartę przechwytuje już inne rozszerzenie (np. „Głos i Napisy (test)”) — wyłącz je albo zamknij jego okienko');
    throw new Error('Chrome nie dał dźwięku karty (' + msg + '). Odśwież kartę z filmem (F5), wyłącz „Głos i Napisy (test)” i spróbuj ponownie');
}

async function setupAudio() {
    if (!STREAM_ID || !TAB_ID) throw new Error('brak id strumienia karty — uruchom skrótem Alt+Shift+2 na karcie z filmem');
    L('otwieram strumień karty…');
    A.stream = await openTabStream();
    const tr = A.stream.getAudioTracks()[0];
    L('strumień karty OK: ' + (tr ? 'ścieżka „' + tr.label + '”, stan ' + tr.readyState : 'BRAK ścieżki audio'));
    A.ctx = new AudioContext({ sampleRate: 48000 });
    await Promise.race([A.ctx.resume().catch(() => { }), new Promise((r) => setTimeout(r, 1500))]);
    L('AudioContext: ' + A.ctx.state);
    if (A.ctx.state !== 'running') {
        state('🔇 Chrome wstrzymał dźwięk — kliknij w okienko „🎧 Film → napisy”', 'err');
        await new Promise((r) => document.addEventListener('pointerdown', r, { once: true }));
        await A.ctx.resume().catch(() => { });
        L('po kliknięciu AudioContext: ' + A.ctx.state);
    }
    const src = A.ctx.createMediaStreamSource(A.stream);
    src.connect(A.ctx.destination); // film słychać dalej, bez odszumiania
    const dest = A.ctx.createMediaStreamDestination();
    // [AGENT-EXP] odszumianie przełączane na żywo: src → (DeepFilterNet3) → pre → tap/miernik; dfnWire przepina tylko wejście pre
    A.src = src; A.pre = A.ctx.createGain();
    await dfnWire();
    // odnoga do rozpoznawania: tap → (wzmacniacz mowy) → dest; przełączamy tylko tap, film i miernik zostają bez zmian
    A.tap = A.ctx.createGain(); A.dest = dest;
    A.boost = speechBoost(A.ctx); A.boost.output.connect(dest);
    A.pre.connect(A.tap);
    boostWire();
    levelMeter(A.ctx, A.pre, '🎧', (p) => { $('lvl').style.width = Math.min(100, Math.round(p * 140)) + '%'; if (p > 0.01) A.heardAt = Date.now(); });
    A.track = dest.stream.getAudioTracks()[0];
    tr.addEventListener('ended', () => { L('strumień karty zakończony (karta zamknięta?)'); state('Karta przestała grać — zamykam', 'err'); setTimeout(() => window.close(), 2500); });
}

// [AGENT-EXP] Odszumianie filmu (tylko dla rozpoznawania) włączane/wyłączane bez restartu okienka.
// Model ładuje się przy pierwszym włączeniu i zostaje w pamięci; siłę zmienia komunikat do workletu.
let dfnBusy = null;
function dfnWire() {
    if (dfnBusy) return dfnBusy.then(dfnWire); // kolejne przełączenie po zakończeniu trwającego
    dfnBusy = (async () => {
        if (!A.src || !A.pre) return;
        try { A.src.disconnect(A.pre); } catch (_) { }
        if (A.node) { try { A.src.disconnect(A.node); } catch (_) { } }
        if (!cfg.kartaDfn) { A.src.connect(A.pre); $('dfn').textContent = '🎚 Odszumianie filmu wyłączone'; L('odszumianie filmu wyłączone'); return; }
        try {
            let ms = 0;
            if (!A.node) {
                $('dfn').textContent = '🎚 Wczytuję DeepFilterNet3…';
                const t0 = performance.now();
                A.node = await dfnNode(A.ctx, cfg.kartaDfnLevel);
                A.node.connect(A.pre);
                ms = Math.round(performance.now() - t0);
            } else A.node.port.postMessage({ type: 'SET_SUPPRESSION_LEVEL', value: Number(cfg.kartaDfnLevel) });
            if (!cfg.kartaDfn) { A.src.connect(A.pre); return; } // wyłączone w trakcie wczytywania
            A.src.connect(A.node);
            $('dfn').textContent = '🎚 DeepFilterNet3 (tylko dla rozpoznawania): ' + cfg.kartaDfnLevel + ' dB' + (ms ? ', start ' + ms + ' ms' : '');
            L('DeepFilterNet3 OK, ' + cfg.kartaDfnLevel + ' dB' + (ms ? ', start ' + ms + ' ms' : ''));
        } catch (e) { A.src.connect(A.pre); $('dfn').textContent = '🎚 Odszumianie nie ruszyło'; L('❌ DeepFilterNet3: ' + (e && e.message || e)); }
    })().finally(() => { dfnBusy = null; });
    return dfnBusy;
}
function dfnLevel() {
    if (!A.node || !cfg.kartaDfn) return;
    A.node.port.postMessage({ type: 'SET_SUPPRESSION_LEVEL', value: Number(cfg.kartaDfnLevel) });
    $('dfn').textContent = '🎚 DeepFilterNet3 (tylko dla rozpoznawania): ' + cfg.kartaDfnLevel + ' dB';
}

function boostWire() {
    if (!A.tap) return;
    try { A.tap.disconnect(); } catch (_) { }
    if (cfg.kartaBoost) { A.boost.set(cfg.kartaBoostLvl); A.tap.connect(A.boost.input); }
    else A.tap.connect(A.dest);
    L('wzmacniacz mowy: ' + (cfg.kartaBoost ? ({ 1: 'lekko', 2: 'średnio', 3: 'mocno' }[cfg.kartaBoostLvl] || cfg.kartaBoostLvl) : 'wył.'));
}

// 🔒 Rozpoznawanie lokalne: strażnik modelu mowy (stan + przycisk „Pobierz” w tym okienku)
let LG = null;
function locInfo() {
    if (cfg.gnLocal) { if (LG) LG.check(); return; }
    $('loc').textContent = '🌐 Rozpoznawanie: Google (przez internet)'; $('locBtn').style.display = 'none';
}

// ---------- Tłumacz Chrome (lokalnie) ----------
const TR = { tr: null, creating: null, failed: '' };
const srcLang = () => cfg.kartaLang.slice(0, 2);
function trInfo() {
    $('trInfo').textContent = srcLang() === 'pl' ? '🌐 Film po polsku — bez tłumaczenia'
        : TR.tr ? '🌐 Tłumaczę ' + srcLang() + ' → pl (tłumacz Chrome)' : '🌐 ' + (TR.failed || 'przygotowuję tłumacza…');
}
function ensureTranslator() {
    if (TR.tr || TR.creating || srcLang() === 'pl') return;
    if (!('Translator' in self)) { TR.failed = 'tłumacz Chrome niedostępny — napisy w oryginale'; L('❌ ' + TR.failed); trInfo(); return; }
    L('tworzę tłumacza ' + srcLang() + ' → pl…');
    TR.creating = Translator.create({
        sourceLanguage: srcLang(), targetLanguage: 'pl',
        monitor(m) { m.addEventListener('downloadprogress', (e) => { $('trInfo').textContent = '🌐 Pobieram tłumacza… ' + Math.round(e.loaded * 100) + '%'; }); },
    }).then((t) => { TR.tr = t; TR.creating = null; TR.failed = ''; L('tłumacz gotowy'); trInfo(); }, (err) => {
        TR.creating = null;
        TR.failed = err && err.name === 'NotAllowedError' ? 'kliknij raz w to okienko — pobiorę tłumacza' : 'tłumacz niedostępny (' + (err && err.name || err) + ')';
        L('❌ tłumacz: ' + (err && err.name) + ' ' + (err && err.message)); trInfo();
    });
}
document.addEventListener('pointerdown', () => { if (!TR.tr && TR.failed) { TR.failed = ''; ensureTranslator(); } });
// Kolejka do tłumacza: jedno tłumaczenie naraz, pierwszeństwo: 0 = lektor, 1 = historia, 2 = napis na ekranie.
// Gotowe tłumaczenia w pamięci (to samo zdanie idzie zwykle i do lektora, i do historii).
// Tłumacz, który zgłasza błędy albo 3× z rzędu nie zdąży, jest tworzony od nowa.
// Gdy nie ma tłumaczenia, wraca oryginał (lektor go nie czyta — liczy to jako „bez tłumaczenia”).
const TQ = { busy: false, q: [], cache: new Map(), timeouts: 0, inRow: 0, errors: 0 };
function cachePut(key, t) { TQ.cache.set(key, t); if (TQ.cache.size > 400) TQ.cache.delete(TQ.cache.keys().next().value); }
function resetTranslator(why) {
    const tr = TR.tr;
    TR.tr = null; TQ.inRow = 0;
    L('⚠ tłumacz od nowa: ' + why);
    try { if (tr && tr.destroy) tr.destroy(); } catch (_) { }
    ensureTranslator(); trInfo();
}
function translate(en, pri = 2, waitMs = 4000) {
    if (!en) return Promise.resolve(en);
    const key = tail(en, 220).replace(/^…/, '');
    if (TQ.cache.has(key)) return Promise.resolve(TQ.cache.get(key));
    if (!TR.tr) { ensureTranslator(); return Promise.resolve(en); }
    return new Promise((resolve) => {
        let i = TQ.q.length;
        while (i > 0 && TQ.q[i - 1].pri > pri) i--; // za swoimi, przed niższym priorytetem
        TQ.q.splice(i, 0, { key, en, pri, waitMs, resolve });
        tqRun();
    });
}
async function tqRun() {
    if (TQ.busy) return;
    TQ.busy = true;
    try {
        while (TQ.q.length) {
            const it = TQ.q.shift();
            if (TQ.cache.has(it.key)) { it.resolve(TQ.cache.get(it.key)); continue; }
            const tr = TR.tr;
            if (!tr) { ensureTranslator(); it.resolve(it.en); continue; }
            let timer;
            const job = tr.translate(it.key);
            job.then((t) => { if (t) cachePut(it.key, t); }, () => { }); // spóźnione tłumaczenie też się przyda
            const res = await Promise.race([
                job.then((t) => ({ t }), (e) => ({ e })),
                new Promise((r) => { timer = setTimeout(() => r({ timeout: true }), it.waitMs); }),
            ]);
            clearTimeout(timer);
            if (res.t) { TQ.inRow = 0; it.resolve(res.t); continue; }
            if (res.timeout) { TQ.timeouts++; if (++TQ.inRow >= 3 && TR.tr === tr) resetTranslator('3× z rzędu nie zdążył'); }
            else { TQ.errors++; L('❌ tłumacz: ' + (res.e && res.e.name) + ' ' + (res.e && res.e.message)); if (TR.tr === tr) resetTranslator('błąd'); }
            // jedna powtórka na nowym tłumaczu (żeby zdanie z chwili awarii nie przepadło)
            if (!it.retry && TR.tr !== tr && TR.creating) { it.retry = true; await TR.creating.catch(() => { }); TQ.q.unshift(it); continue; }
            it.resolve(it.en);
        }
    } finally { TQ.busy = false; }
}

// ---------- Czytanie głosem lektora (Sherpa w offscreen) — nie może zostawać w tyle ----------
// Tryb „same napisy” (kartaMode = 'napisy') nic nie czyta.
const lektorOn = () => cfg.kartaMode !== 'napisy';
let ttsSeq = 0;
function speak(pl) {
    if (!lektorOn()) return;
    // slotMs = czas na paczkę: lektor dociąga tempo (auto-nadrabianie); noSkip: niczego nie pomija — czyta wszystko do końca.
    // Prędkość i głos — z ustawień lektora (tło dokłada piperSpeed).
    const slotMs = Math.min(30000, Math.max(2000, words(pl).length * 450));
    chrome.runtime.sendMessage({ action: 'TTS_PLAY', id: 'gn_' + Date.now() + '_' + (++ttsSeq), text: pl.slice(0, 600), durationMs: 0, slotMs, noSkip: true }, (r) => {
        const le = chrome.runtime.lastError;
        if (le || !r) { LK.err++; L('❌ lektor nie odpowiedział: ' + (le ? le.message : 'brak odpowiedzi')); }
        else if (r.status === 'error') { LK.err++; L('❌ lektor: ' + r.error); }
        else if (r.status === 'blocked' || r.status === 'muted') L('lektor pominął (czarna lista / cenzura): „' + pl + '”');
        else LK.ok++;
    });
}

// ---------- Interpunkcja w tekście od Google ----------
const PUNCT_END = /[.,?!;:…]["'”)\]]*$/; // słowo kończy fragment (przecinek, kropka…)
const SENT_END = /[.?!…]["'”)\]]*$/;     // słowo kończy zdanie
// indeks za ostatnim słowem z interpunkcją (szukamy od `from`); 0 = brak
function lastCut(w, from, re) { for (let i = w.length - 1; i >= from; i--) if (re.test(w[i])) return i + 1; return 0; }

// ---------- Paczki do czytania: co N słów / pauza w mowie / koniec kwestii ----------
// Opcja kartaLekPunct: tylko tekst zatwierdzony przez Google (już się nie zmieni), cięty po przecinku / kropce.
const LK = { sent: 0, startAt: 0, gapTimer: null, chain: Promise.resolve(), log: [], ok: 0, miss: 0, err: 0, punctAt: 0 };
// czy rozpoznawanie stawia przecinki/kropki (Google w chmurze tak, rozpoznawanie lokalne nie)
const lekPunct = () => cfg.kartaLekPunct && Date.now() - LK.punctAt < 30000;
// Opcja kartaTopLektor: górne piętro (gotowy napis) = dokładnie to tłumaczenie, które dostaje lektor
// (zatwierdzony tekst, sensowne kawałki — lepsze niż tłumaczenie tekstu „w trakcie”). Działa też w trybie „same napisy”.
const LT = { older: '', prev: '', cur: '' };
function ltAdd(pl, en, end) {
    LT.cur = join(LT.cur, pl);
    if (end || SENT_END.test(en.trim()) || LT.cur.length > 140) { LT.older = LT.prev; LT.prev = LT.cur; LT.cur = ''; } // koniec zdania → nowe zdanie
}
const ltText = () => join(LT.prev, LT.cur);
function lekSend(en, why) {
    if (!lektorOn() && !cfg.kartaTopLektor) return; // same napisy bez „napisu lektora” — paczek nie tłumaczymy
    const p = translate(en, 0, 10000); // lektor: pierwszeństwo u tłumacza i dłuższe czekanie
    LK.chain = LK.chain.then(async () => {
        const pl = await p;
        const ok = pl && pl !== en;
        LK.log.push(new Date().toLocaleTimeString().slice(0, 8) + '  ' + (ok ? pl : '✗ bez tłumaczenia: ' + en) + '  ← ' + why);
        if (LK.log.length > 3) LK.log.shift();
        $('lek').textContent = LK.log.join('\n');
        if (cfg.kartaTopLektor) { ltAdd(ok ? pl : en, en, why === 'koniec kwestii'); redraw(); }
        if (!lektorOn()) return;
        if (ok) speak(upFirst(pl));
        else { LK.miss++; L('⚠ do lektora NIE poszło — brak tłumaczenia' + (TR.tr ? '' : ' (tłumacz niegotowy)') + ': „' + en + '”'); }
    }).catch((e) => L('❌ paczka do lektora: ' + (e && e.message || e)));
}
function lekSendWords(w, from, to, why) { lekSend(w.slice(from, to).join(' '), why); LK.sent = to; }
function lekFeed() {
    const fin = words(SQ.open), w = fin.concat(words(SQ.live));
    const n = Number(cfg.kartaChunk);
    if (lekPunct()) {
        const cut = lastCut(fin, LK.sent, PUNCT_END);
        if (cut > LK.sent) lekSendWords(fin, LK.sent, cut, 'przecinek/kropka');
        else if (fin.length - LK.sent >= Math.max(12, n)) lekSendWords(fin, LK.sent, fin.length, 'długo bez kropki'); // awaryjnie
    } else {
        const stable = Math.max(fin.length, w.length - 1);
        if (n > 0 && stable - LK.sent >= n) lekSendWords(w, LK.sent, stable, n + ' słów');
    }
    clearTimeout(LK.gapTimer);
    const gap = Number(cfg.kartaGap);
    if (gap > 0) LK.gapTimer = setTimeout(() => {
        // pauza w mowie: w trybie „po przecinku” tylko tekst zatwierdzony, inaczej także to, co Google jeszcze zgaduje
        const ww = lekPunct() ? words(SQ.open) : words(SQ.open).concat(words(SQ.live));
        if (ww.length > LK.sent) lekSendWords(ww, LK.sent, ww.length, 'pauza');
    }, gap);
}

// ---------- Napisy: dwa piętra ----------
// Opcja kartaCutSent: piętro zamyka się na końcu zdania (. ? !), a napis pokazuje tylko bieżące zdanie — max ~2 linijki.
const SQ = { prev: null, open: '', live: '', cur: null, finAt: 0, pauseTimer: null, dirty: false, busy: false };
function closeFloor(upTo) {
    const w = words(SQ.open), k = upTo == null ? w.length : upTo;
    if (k > LK.sent) lekSendWords(w, LK.sent, k, 'koniec kwestii');
    LK.sent = upTo == null ? 0 : Math.max(0, LK.sent - k);
    if (upTo == null) clearTimeout(LK.gapTimer);
    SQ.prev = { en: w.slice(0, k).join(' '), pl: null };
    SQ.open = w.slice(k).join(' ');
}
function showSub(fin, live) {
    const now = Date.now(), pause = Number(cfg.kartaPause) || 1000;
    if (SQ.open && now - SQ.finAt > pause) closeFloor();
    if (fin) {
        histFeed(fin);
        SQ.open = join(SQ.open, fin); SQ.finAt = now;
        if (cfg.kartaCutSent) { const cut = lastCut(words(SQ.open), 0, SENT_END); if (cut) closeFloor(cut); }
        if (SQ.open.length >= (cfg.kartaCutSent ? 90 : 45)) closeFloor(); // po kropce: dłuższe piętro (całe zdanie)
        else if (!SQ.open) clearTimeout(SQ.pauseTimer);
        else {
            clearTimeout(SQ.pauseTimer);
            SQ.pauseTimer = setTimeout(() => { if (!SQ.open || Date.now() - SQ.finAt < pause) return; closeFloor(); redraw(); }, pause + 50);
        }
    }
    SQ.live = live || '';
    lekFeed();
    redraw();
}
// Odświeżanie napisu na ekranie (kartaRefresh): Google poprawia tekst „na żywo” co ~100 ms, więc napis skacze.
// '0' = od razu jak Google, '300'/'600'/'1000' = najwyżej raz na tyle ms (pokazuje najświeższy stan),
// 'fin' = tylko tekst zatwierdzony przez Google (bez zgadywanych słów — pewniejszy, trochę później).
let redrawTimer = null;
function redraw() {
    SQ.dirty = true;
    const ms = cfg.kartaRefresh === 'fin' ? 0 : Number(cfg.kartaRefresh) || 0;
    if (!ms) { pump(); return; }
    if (!redrawTimer) redrawTimer = setTimeout(() => { redrawTimer = null; pump(); }, ms);
}
function pump() {
    if (SQ.busy) return;
    SQ.busy = true;
    (async () => {
        try {
            while (SQ.dirty) {
                SQ.dirty = false;
                if (SQ.prev && SQ.prev.pl === null && !cfg.kartaTopLektor) SQ.prev.pl = await translate(SQ.prev.en);
                // kartaShowLive = false: bez niegotowych napisów (tego, co Google jeszcze zgaduje) — nic nie „lata”
                const live = cfg.kartaShowLive !== false && cfg.kartaRefresh !== 'fin';
                let en = join(SQ.open, live ? SQ.live : '');
                if (cfg.kartaTopLektor) en = cfg.kartaShowLive === false ? '' : words(en).slice(LK.sent).join(' '); // na dole tylko to, czego lektor jeszcze nie dostał
                if (cfg.kartaCutSent) { // Google długo zgaduje bez pauzy → pokazuj tylko od ostatniego końca zdania
                    const w = words(en);
                    let cut = lastCut(w, 0, SENT_END);
                    if (cut && w.length - cut < 2) cut = lastCut(w.slice(0, cut - 1), 0, SENT_END);
                    if (cut) en = w.slice(cut).join(' ');
                }
                SQ.cur = en ? { en, pl: await translate(en) } : null;
                render();
            }
        } finally { SQ.busy = false; }
    })();
}
// Opcja kartaFinUp: gotowy (zatwierdzony, już bez zmian) napis od razu idzie piętro wyżej i tam zostaje,
// a na dole jest tylko to, co Google jeszcze słyszy. Bez niej: gotowy napis zostaje na dole, dopóki nie przyjdzie nowy.
function render() {
    const tl = !!cfg.kartaTopLektor, up = tl || !!cfg.kartaFinUp, pl = (x) => x.pl || x.en;
    const last = up ? SQ.cur : (SQ.cur || SQ.prev);
    const prev = up ? SQ.prev : (SQ.cur ? SQ.prev : null);
    const prevTxt = tl ? ltText() : (prev ? pl(prev) : ''); // „napis lektora” albo osobne tłumaczenie zamkniętego piętra
    if (!last && !prevTxt) return;
    const sh = !!cfg.kartaCutSent; // krótkie napisy: ~1 linijka na piętro
    let top = prevTxt ? tail(upFirst(prevTxt), sh && !up ? 70 : 110) : '';
    let main = last ? tail(upFirst(pl(last)), sh ? 90 : 140) : '';
    let second = last && cfg.kartaShowEn && pl(last) !== last.en ? tail(upFirst(last.en), sh ? 90 : 120) : '';
    if (tl && cfg.kartaShowLive === false) { // tylko napis lektora: bieżące zdanie na dole, poprzednie nad nim
        const above = LT.cur ? LT.prev : LT.older; // poprzednie zdanie zostaje linijkę wyżej
        top = above ? tail(upFirst(above), 110) : '';
        main = tail(upFirst(LT.cur || LT.prev), sh ? 110 : 140);
        second = '';
    }
    $('pl').textContent = (top ? (up ? '✓ ' : '') + top + '\n' : '') + main;
    $('en').textContent = second;
    toTab({ top, main, second, topDone: up, keepMs: Number(cfg.kartaKeep) * 1000 });
}

// ---------- Historia gotowych napisów (okienko „📜 Napisy na bieżąco”, glos/historia.html) ----------
// Tylko tekst zatwierdzony przez Google, po całym zdaniu (albo po pauzie / 160 znakach, gdy brak kropek).
// Trzyma ją chrome.storage.session 'gnHist' (do zamknięcia Chrome), okienko odświeża się samo.
const HQ = { buf: '', timer: null, chain: Promise.resolve() };
async function histWrite(item) {
    const { gnHist = [] } = await chrome.storage.session.get('gnHist');
    gnHist.push(item);
    if (gnHist.length > 1000) gnHist.splice(0, gnHist.length - 1000);
    await chrome.storage.session.set({ gnHist });
}
function histPush(item) { HQ.chain = HQ.chain.then(() => histWrite(item)).catch(() => { }); }
function histEmit(en) {
    const t = new Date().toLocaleTimeString('pl-PL');
    const p = translate(en, 1, 6000); // tłumaczenie startuje od razu (po lektorze), kolejność wpisów pilnuje HQ.chain
    HQ.chain = HQ.chain.then(() => p).then((pl) => histWrite({ t, en, pl: upFirst(pl || en) })).catch(() => { });
}
function histFeed(fin) {
    const w = words(join(HQ.buf, fin));
    let start = 0;
    for (let i = 0; i < w.length; i++) if (SENT_END.test(w[i])) { histEmit(w.slice(start, i + 1).join(' ')); start = i + 1; }
    HQ.buf = w.slice(start).join(' ');
    if (HQ.buf.length > 160) { histEmit(HQ.buf); HQ.buf = ''; }
    clearTimeout(HQ.timer);
    if (HQ.buf) HQ.timer = setTimeout(() => { if (HQ.buf) { histEmit(HQ.buf); HQ.buf = ''; } }, Math.max(1000, Number(cfg.kartaPause) || 1000) + 800);
}

// ---------- Rozpoznawanie (Google) ----------
const R = { rec: null, starting: false, lastErr: '', startAt: 0, ready: false, gotAt: 0, finals: 0, punct: 0, warned: false };
function startRec() {
    if (R.rec || R.starting || !A.track) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { state('Ta przeglądarka nie rozpoznaje mowy', 'err'); return; }
    if (cfg.gnLocal) { // 🔒 rozpoznawanie lokalne: bez modelu nie startujemy (bez cichego powrotu do Google)
        if (!locSupported()) { state('🔒 Ten Chrome nie umie rozpoznawać lokalnie — odznacz „rozpoznawanie lokalne” w popupie lektora', 'err'); return; }
        if (!LG || LG.state !== 'available') { if (LG) LG.check(); return; }
    }
    R.starting = true; R.startAt = Date.now(); R.lastErr = '';
    const rec = new SR();
    if (cfg.gnLocal) rec.processLocally = true; // na tym komputerze, nic nie idzie do Google
    rec.lang = cfg.kartaLang; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
    rec.onstart = () => {
        R.starting = false;
        if (!R.ready) {
            R.ready = true;
            L('rozpoznawanie wystartowało (' + cfg.kartaLang + ')');
            state('🎧 Słucham tej karty (' + cfg.kartaLang + ') — Alt+Shift+2 = stop', 'rec', 6000);
            chrome.runtime.sendMessage({ action: 'GN_KARTA_READY' }, () => { void chrome.runtime.lastError; });
        }
    };
    rec.onresult = (e) => {
        let fin = '', live = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
            const t = e.results[i][0].transcript.trim();
            if (!t) continue;
            if (e.results[i].isFinal) fin = join(fin, t); else live = join(live, t);
        }
        if (fin) { R.finals++; if (/[.,?!]/.test(fin)) { R.punct++; LK.punctAt = Date.now(); } L('Google zatwierdził: „' + fin + '”'); }
        if (fin || live) { if (!R.gotAt) L('pierwszy wynik od Google ✓'); R.gotAt = Date.now(); showSub(fin, live); }
    };
    rec.onerror = (e) => {
        R.lastErr = e.error;
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        L('❌ błąd rozpoznawania: ' + e.error + (e.message ? ' — ' + e.message : ''));
        if (cfg.gnLocal && (e.error === 'service-not-allowed' || e.error === 'language-not-supported')) {
            if (LG) LG.reset(); // lokalny model nie ruszył (albo nie umie słuchać tej karty) — sprawdź go od nowa
            state('🔒 Lokalne rozpoznawanie nie ruszyło (' + e.error + ') — sprawdzam model mowy…', 'err');
            return;
        }
        state(e.error === 'network' ? 'Brak połączenia z Google — ponawiam…' : 'Błąd rozpoznawania: ' + e.error, 'err');
    };
    rec.onend = () => {
        if (R.rec === rec) R.rec = null;
        R.starting = false;
        // sesja się skończyła, a ostatnie słowa nie zostały zatwierdzone (częste przy rozpoznawaniu lokalnym):
        // bierzemy je jako gotowe — inaczej przepadłyby i z napisów, i z lektora
        if (SQ.live) { const t = SQ.live; L('koniec sesji rozpoznawania — niezatwierdzone słowa biorę jako gotowe: „' + t + '”'); showSub(t, ''); }
        const bad = R.lastErr && R.lastErr !== 'no-speech' && R.lastErr !== 'aborted';
        setTimeout(startRec, bad ? 1500 : 0);
    };
    R.rec = rec;
    try { rec.start(A.track); }
    catch (e) { R.rec = null; R.starting = false; L('❌ rec.start: ' + (e && e.name) + ' ' + (e && e.message)); state('Nie udało się uruchomić rozpoznawania', 'err'); }
}
setInterval(() => {
    if (R.starting && Date.now() - R.startAt > 10000) { L('rozpoznawanie utknęło przy starcie — od nowa'); const r = R.rec; R.rec = null; R.starting = false; if (r) { try { r.abort(); } catch (_) { } } }
    if (!R.rec && !R.starting) startRec();
}, 3000);

// Diagnoza na filmie i w dzienniku: cisza w karcie / dźwięk jest, a Google nic nie oddaje
setInterval(() => {
    if (!A.track || !R.ready) return;
    const now = Date.now();
    const quiet = now - (A.heardAt || A.startAt || now) > 12000;
    const deaf = !quiet && !R.gotAt && now - (A.startAt || now) > 15000;
    if (quiet) state('🎧 Nie słyszę dźwięku z tej karty — czy film gra (i nie jest wyciszony)?', 'err');
    else if (deaf) state('🎧 Dźwięk jest, ale Google nic nie rozpoznaje — język filmu: ' + cfg.kartaLang + '?', 'err');
    else if (R.warned) state('🎧 Słucham tej karty (' + cfg.kartaLang + ')', 'rec', 3000);
    if ((quiet || deaf) && !R.warned) L(quiet ? '⚠ cisza w karcie od 12 s' : '⚠ dźwięk jest, ale od 15 s brak wyników od Google');
    R.warned = quiet || deaf;
}, 4000);
let offErrTs = 0;
setInterval(async () => {
    if (!R.ready) return;
    L('podsumowanie: zatwierdzonych kwestii ' + R.finals + ', w tym z przecinkiem/kropką ' + R.punct
        + (lektorOn() ? ' | lektor: przyjął ' + LK.ok + ', bez tłumaczenia ' + LK.miss + ', błędy ' + LK.err : ' | tryb: same napisy')
        + ' | tłumacz: ' + (TR.tr ? 'gotowy' : 'NIEGOTOWY') + ', nie zdążył ' + TQ.timeouts + ', błędy ' + TQ.errors + ', w kolejce ' + TQ.q.length);
    // błąd z samego lektora (offscreen: synteza Sherpa / odtwarzanie) — zapisuje go tło lektora
    try {
        const { __offscreenError: e } = await chrome.storage.local.get('__offscreenError');
        if (e && e.ts && e.ts > offErrTs) { if (offErrTs) L('❌ lektor (offscreen): ' + String(e.msg).slice(0, 200)); offErrTs = e.ts; }
    } catch (_) { }
}, 30000);

$('stop').addEventListener('click', () => window.close());
// zmiany ustawień z popupu działają od razu (przełączniki „na próbę”)
chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !cfg) return;
    for (const k in ch) if (k in cfg) { cfg[k] = ch[k].newValue; L('ustawienie ' + k + ' = ' + ch[k].newValue); }
    if (ch.kartaBoost || ch.kartaBoostLvl) boostWire();
    if (ch.kartaDfn) dfnWire(); else if (ch.kartaDfnLevel) dfnLevel(); // [AGENT-EXP] odszumianie na żywo
    if (ch.gnLocal || ch.kartaLang) { // rozpoznawanie od nowa z nowym ustawieniem
        if (LG) LG.reset();
        locInfo();
        if (R.rec) { const r = R.rec; R.rec = null; try { r.abort(); } catch (_) { } }
    }
});
$('hist').addEventListener('click', () => chrome.runtime.sendMessage({ action: 'GN_HIST_OPEN' }, () => { void chrome.runtime.lastError; }));
window.addEventListener('pagehide', () => {
    try { if (R.rec) R.rec.abort(); } catch (_) { }
    if (cfg && lektorOn()) { try { chrome.runtime.sendMessage({ action: 'TTS_CLEAR_BUFFER' }, () => { void chrome.runtime.lastError; }); } catch (_) { } }
    try { if (A.stream) A.stream.getTracks().forEach((t) => t.stop()); } catch (_) { }
    try { if (A.ctx) A.ctx.close(); } catch (_) { }
});

(async () => {
    try {
        cfg = await cfgGet();
        LG = locGate(() => cfg.kartaLang, $('loc'), $('locBtn'), () => startRec(),
            (st) => state('🔒 Czekam na lokalny model mowy (' + cfg.kartaLang + '): ' + (LOC_TXT[st] || st)
                + (st === 'downloadable' ? ' — kliknij „Pobierz” w okienku „🎧 Film → napisy”' : ''), st === 'downloading' ? 'wait' : 'err'), L);
        locInfo();
        L('okienko start; język filmu ' + cfg.kartaLang + ', odszumianie ' + (cfg.kartaDfn ? cfg.kartaDfnLevel + ' dB' : 'wył.') + ', tryb ' + (lektorOn() ? 'lektor + napisy' : 'same napisy'));
        let title = '';
        if (TAB_ID) { try { const t = await chrome.tabs.get(TAB_ID); title = (t.title || t.url || '').slice(0, 90); $('src').textContent = '📺 ' + title.slice(0, 70); } catch (_) { } }
        histPush({ sep: true, t: new Date().toLocaleTimeString('pl-PL'), pl: '📺 ' + (title || 'film') });
        L('opcje: napisy po kropce ' + (cfg.kartaCutSent ? 'wł.' : 'wył.') + ', lektor po przecinku/kropce ' + (cfg.kartaLekPunct ? 'wł.' : 'wył.') + ', odświeżanie napisu ' + (cfg.kartaRefresh === 'fin' ? 'tylko zatwierdzony' : (Number(cfg.kartaRefresh) || 0) + ' ms'));
        ensureTranslator(); trInfo();
        state('Łączę się z dźwiękiem karty…', 'wait');
        await setupAudio();
        A.startAt = Date.now();
        startRec();
    } catch (e) {
        L('❌ start: ' + (e && e.name) + ' ' + (e && e.message || e));
        state('Nie mogę słuchać karty: ' + (e && (e.message || e.name) || e), 'err');
    }
})();
