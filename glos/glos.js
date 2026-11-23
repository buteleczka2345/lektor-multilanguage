// 🎤 Mój głos → tekst.
// mikrofon → AudioContext 48 kHz (po przechwyceniu mikrofonu Chrome pozwala mu grać) → (DeepFilterNet3)
// → ścieżka → rozpoznawanie Google → zatwierdzone zdania → tło (GN_GLOS_TEXT) wpisuje w pole z kursorem.
import { cfgGet, log, dfnNode, levelMeter, locSupported, locGate, LOC_TXT } from './common.js';

const $ = (id) => document.getElementById(id);
const L = (m) => log('🎤', m);
let cfg;
const G = { on: true, rec: null, starting: false, lastErr: '', ready: false, mic: null, ctx: null, node: null, track: null,
    sentenceEnd: true, sent: [], results: 0 };

// Stan w okienku + plakietka na stronie (pill.js)
function ui(m) { chrome.runtime.sendMessage({ action: 'GN_GLOS_UI', ...m }, () => { void chrome.runtime.lastError; }); }
function state(text, cls) {
    $('state').textContent = text; $('state').className = cls || '';
    ui({ text: '🎤 ' + text + (cls === 'rec' ? '   (Alt+Shift+1 = stop)' : ''), cls, live: '' });
}
let liveTimer = null;
function uiLive(t) { clearTimeout(liveTimer); liveTimer = setTimeout(() => ui({ live: t }), 120); }

// ---------- Interpunkcja głosem ----------
const PUNCT = {
    pl: [['znak zapytania', '?'], ['pytajnik', '?'], ['znak wykrzyknika', '!'], ['wykrzyknik', '!'],
        ['kropka', '.'], ['przecinek', ','], ['dwukropek', ':'], ['średnik', ';'],
        ['myślnik', ' –'], ['otwórz nawias', ' ('], ['zamknij nawias', ')'], ['nowa linia', '\n']],
    en: [['question mark', '?'], ['exclamation mark', '!'], ['exclamation point', '!'], ['full stop', '.'], ['period', '.'],
        ['comma', ','], ['colon', ':'], ['semicolon', ';'], ['dash', ' –'], ['open parenthesis', ' ('], ['close parenthesis', ')'], ['new line', '\n']],
};
const PUNCT_RE = {};
for (const lang in PUNCT) {
    PUNCT_RE[lang] = PUNCT[lang].map(([w, sign]) => [new RegExp('\\s*(?<!\\p{L})' + w.replace(/ /g, '\\s+') + '(?!\\p{L})', 'giu'), sign]);
}
function punctuate(text) {
    if (!cfg.glosPunct || !text) return text;
    for (const [re, sign] of PUNCT_RE[cfg.glosLang.slice(0, 2)] || []) text = text.replace(re, sign);
    return text.replace(/[ \t]+([.,?!:;)])/g, '$1').replace(/([.,?!:;)])(?=[\p{L}\d(])/gu, '$1 ').replace(/\(\s+/g, '(')
        .replace(/([.,?!:;])[.,:;]+/g, '$1').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').trim();
}
function capitalize(text) {
    if (!cfg.glosPunct || !text) return text;
    text = text.replace(/([.?!\n]\s*)(\p{Ll})/gu, (m, a, b) => a + b.toUpperCase());
    if (G.sentenceEnd) text = text.replace(/^(\P{L}*)(\p{Ll})/u, (m, a, b) => a + b.toUpperCase());
    G.sentenceEnd = /[.?!\n]$/.test(text);
    return text;
}

// ---------- Wpisywanie (po kolei) ----------
let chain = Promise.resolve();
function sendText(raw) {
    const text = capitalize(punctuate(raw.trim()));
    if (!text) return;
    chain = chain.then(async () => {
        let r;
        try { r = await chrome.runtime.sendMessage({ action: 'GN_GLOS_TEXT', text }); } catch (e) { r = { ok: false, why: String(e && e.message || e) }; }
        L((r && r.ok ? '✓ wpisano' + (r.where ? ' (' + r.where + ')' : '') : '✗ NIE wpisano: ' + (r && r.why)) + ' → „' + text + '”');
        G.sent.push((r && r.ok ? '✓ ' : '✗ ') + text + (r && !r.ok && r.why ? '  (' + r.why + ')' : ''));
        if (G.sent.length > 3) G.sent.shift();
        $('sent').textContent = G.sent.join('\n');
        if (r && !r.ok) ui({ text: '🎤 Nie wpisałem: ' + (r.why || 'błąd'), cls: 'err', live: text });
        else ui({ live: '✓ ' + text });
    });
}

// ---------- Dźwięk ----------
async function setupAudio() {
    L('proszę o mikrofon…');
    G.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, autoGainControl: true, noiseSuppression: !cfg.glosDfn } });
    const tr = G.mic.getAudioTracks()[0];
    L('mikrofon OK: „' + (tr && tr.label) + '”');
    G.ctx = new AudioContext({ sampleRate: 48000 });
    await Promise.race([G.ctx.resume().catch(() => { }), new Promise((r) => setTimeout(r, 1500))]);
    L('AudioContext: ' + G.ctx.state + ', ' + G.ctx.sampleRate + ' Hz');
    if (G.ctx.state !== 'running') {
        state('🔇 Chrome wstrzymał dźwięk — kliknij w to okienko', 'err');
        await new Promise((r) => document.addEventListener('pointerdown', r, { once: true }));
        await G.ctx.resume().catch(() => { });
        L('po kliknięciu AudioContext: ' + G.ctx.state);
    }
    const src = G.ctx.createMediaStreamSource(G.mic);
    const dest = G.ctx.createMediaStreamDestination();
    // [AGENT-EXP] odszumianie przełączane na żywo: mikrofon → (DeepFilterNet3) → pre → rozpoznawanie/miernik
    G.src = src; G.pre = G.ctx.createGain();
    await dfnWire();
    G.pre.connect(dest);
    levelMeter(G.ctx, G.pre, '🎤', (p) => { $('lvl').style.width = Math.min(100, Math.round(p * 140)) + '%'; });
    G.track = dest.stream.getAudioTracks()[0];
}

// [AGENT-EXP] Odszumianie mikrofonu włączane/wyłączane bez restartu okienka. Model ładuje się przy pierwszym
// włączeniu i zostaje w pamięci; siłę zmienia komunikat do workletu. Gdy DeepFilterNet3 wyłączony — wraca
// wbudowane odszumianie Chrome (noiseSuppression), gdy włączony — wbudowane gaśnie (nie dublujemy filtrów).
let dfnBusy = null;
function micNs() {
    const tr = G.mic && G.mic.getAudioTracks()[0];
    if (tr && tr.applyConstraints) tr.applyConstraints({ echoCancellation: true, autoGainControl: true, noiseSuppression: !cfg.glosDfn })
        .catch((e) => L('odszumianie Chrome: nie dało się przełączyć (' + (e && e.name || e) + ')'));
}
function dfnWire() {
    if (dfnBusy) return dfnBusy.then(dfnWire); // kolejne przełączenie po zakończeniu trwającego
    dfnBusy = (async () => {
        if (!G.src || !G.pre) return;
        try { G.src.disconnect(G.pre); } catch (_) { }
        if (G.node) { try { G.src.disconnect(G.node); } catch (_) { } }
        if (!cfg.glosDfn) { G.src.connect(G.pre); $('dfn').textContent = '🎚 Odszumianie wyłączone'; L('odszumianie wyłączone'); return; }
        try {
            let ms = 0;
            if (!G.node) {
                $('dfn').textContent = '🎚 Wczytuję DeepFilterNet3…';
                const t0 = performance.now();
                G.node = await dfnNode(G.ctx, cfg.glosDfnLevel);
                G.node.connect(G.pre);
                ms = Math.round(performance.now() - t0);
            } else G.node.port.postMessage({ type: 'SET_SUPPRESSION_LEVEL', value: Number(cfg.glosDfnLevel) });
            if (!cfg.glosDfn) { G.src.connect(G.pre); return; } // wyłączone w trakcie wczytywania
            G.src.connect(G.node);
            $('dfn').textContent = '🎚 DeepFilterNet3: ' + cfg.glosDfnLevel + ' dB' + (ms ? ' (start ' + ms + ' ms)' : '');
            L('DeepFilterNet3 OK, ' + cfg.glosDfnLevel + ' dB' + (ms ? ', start ' + ms + ' ms' : ''));
        } catch (e) {
            G.src.connect(G.pre);
            $('dfn').textContent = '🎚 Odszumianie nie ruszyło — mikrofon bez niego';
            L('❌ DeepFilterNet3: ' + (e && e.message || e));
        }
    })().finally(() => { dfnBusy = null; });
    return dfnBusy;
}
function dfnLevel() {
    if (!G.node || !cfg.glosDfn) return;
    G.node.port.postMessage({ type: 'SET_SUPPRESSION_LEVEL', value: Number(cfg.glosDfnLevel) });
    $('dfn').textContent = '🎚 DeepFilterNet3: ' + cfg.glosDfnLevel + ' dB';
}

// ---------- Rozpoznawanie (Google) ----------
function startRec() {
    if (!G.on || G.rec || G.starting || !G.track) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { state('Ta przeglądarka nie rozpoznaje mowy', 'err'); L('❌ brak SpeechRecognition'); return; }
    if (cfg.gnLocal) { // 🔒 rozpoznawanie lokalne: bez modelu nie startujemy (bez cichego powrotu do Google)
        if (!locSupported()) { state('🔒 Ten Chrome nie umie rozpoznawać lokalnie — odznacz „rozpoznawanie lokalne” w popupie lektora', 'err'); return; }
        if (!LG || LG.state !== 'available') { if (LG) LG.check(); return; }
    }
    G.starting = true; G.lastErr = '';
    const rec = new SR();
    if (cfg.gnLocal) rec.processLocally = true; // na tym komputerze, nic nie idzie do Google
    rec.lang = cfg.glosLang; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
    rec.onstart = () => {
        G.starting = false;
        state('🔴 Słucham (' + cfg.glosLang + ') — mów', 'rec');
        if (!G.ready) { G.ready = true; L('rozpoznawanie wystartowało (' + cfg.glosLang + ')'); chrome.runtime.sendMessage({ action: 'GN_GLOS_READY' }, () => { void chrome.runtime.lastError; }); }
    };
    rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
            const res = e.results[i], t = res[0].transcript;
            if (res.isFinal) { G.results++; L('Google zatwierdził: „' + t.trim() + '”'); sendText(t); }
            else interim += t;
        }
        $('live').textContent = punctuate(interim.trim());
        if (interim.trim()) uiLive('… ' + punctuate(interim.trim()));
    };
    rec.onerror = (e) => {
        G.lastErr = e.error;
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        L('❌ błąd rozpoznawania: ' + e.error + (e.message ? ' — ' + e.message : ''));
        if (cfg.gnLocal && (e.error === 'service-not-allowed' || e.error === 'language-not-supported')) {
            if (LG) LG.reset(); // lokalny model nie ruszył — sprawdź go od nowa
            state('🔒 Lokalne rozpoznawanie nie ruszyło (' + e.error + ') — sprawdzam model mowy…', 'err');
        } else if (e.error === 'network') state('Brak połączenia z Google — ponawiam…', 'err');
        else if (e.error === 'not-allowed' || e.error === 'service-not-allowed') state('Brak zgody na rozpoznawanie mowy / mikrofon', 'err');
        else state('Błąd rozpoznawania: ' + e.error + ' — ponawiam…', 'err');
    };
    rec.onend = () => {
        if (G.rec === rec) G.rec = null;
        G.starting = false;
        $('live').textContent = '';
        if (!G.on) return;
        const bad = G.lastErr && G.lastErr !== 'no-speech' && G.lastErr !== 'aborted';
        setTimeout(startRec, bad ? 1500 : 0);
    };
    G.rec = rec;
    try { rec.start(G.track); }
    catch (e) { G.rec = null; G.starting = false; state('Nie udało się uruchomić rozpoznawania', 'err'); L('❌ rec.start: ' + (e && e.name) + ' ' + (e && e.message)); }
}

$('pause').addEventListener('click', () => {
    G.on = !G.on;
    $('pause').textContent = G.on ? '⏸ Pauza' : '▶ Wznów';
    L(G.on ? 'wznowione' : 'pauza');
    if (G.on) startRec();
    else { if (G.rec) { const r = G.rec; G.rec = null; try { r.abort(); } catch (_) { } } state('⏸ Pauza — nic nie wpisuję', 'pause'); }
});
$('stop').addEventListener('click', () => window.close());
setInterval(() => { if (G.on && !G.rec && !G.starting) startRec(); }, 3000);

// 🔒 Rozpoznawanie lokalne: strażnik modelu mowy (stan + przycisk „Pobierz” w tym okienku)
let LG = null;
function locInfo() {
    if (cfg.gnLocal) { if (LG) LG.check(); return; }
    $('loc').textContent = '🌐 Rozpoznawanie: Google (przez internet)'; $('locBtn').style.display = 'none';
}
// zmiany z popupu działają od razu: rozpoznawanie startuje od nowa z nowym ustawieniem
chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !cfg) return;
    let restart = false;
    for (const k in ch) if (k in cfg) { cfg[k] = ch[k].newValue; if (k === 'gnLocal' || k === 'glosLang') restart = true; }
    if (ch.glosDfn) { micNs(); dfnWire(); } else if (ch.glosDfnLevel) dfnLevel(); // [AGENT-EXP] odszumianie na żywo
    if (!restart) return;
    L('rozpoznawanie: ' + (cfg.gnLocal ? 'lokalne' : 'Google') + ', język ' + cfg.glosLang);
    if (LG) LG.reset();
    locInfo();
    if (G.rec) { const r = G.rec; G.rec = null; try { r.abort(); } catch (_) { } }
});
// co 30 s: ile zdań Google zatwierdził (czy w ogóle coś rozpoznaje)
setInterval(() => { if (G.ready) L('podsumowanie: zatwierdzonych zdań ' + G.results); }, 30000);

window.addEventListener('pagehide', () => {
    try { if (G.rec) G.rec.abort(); } catch (_) { }
    try { if (G.mic) G.mic.getTracks().forEach((t) => t.stop()); } catch (_) { }
    try { if (G.ctx) G.ctx.close(); } catch (_) { }
});

(async () => {
    try {
        cfg = await cfgGet();
        LG = locGate(() => cfg.glosLang, $('loc'), $('locBtn'), () => startRec(),
            (st) => state('🔒 Czekam na lokalny model mowy (' + cfg.glosLang + '): ' + (LOC_TXT[st] || st)
                + (st === 'downloadable' ? ' — kliknij „Pobierz” w tym okienku' : ''), st === 'downloading' ? 'wait' : 'err'), L);
        locInfo();
        L('okienko start; język ' + cfg.glosLang + ', odszumianie ' + (cfg.glosDfn ? cfg.glosDfnLevel + ' dB' : 'wył.'));
        state('Włączam mikrofon…', 'wait');
        await setupAudio();
        startRec();
    } catch (e) {
        const name = e && e.name;
        L('❌ start: ' + name + ' ' + (e && e.message));
        state(name === 'NotAllowedError' ? 'Brak zgody na mikrofon — zezwól (ikona w pasku adresu okienka) i otwórz ponownie'
            : 'Mikrofon nie ruszył: ' + (name || e), 'err');
    }
})();
