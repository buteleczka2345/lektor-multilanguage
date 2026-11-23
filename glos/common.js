// Wspólne dla popupu i okienek: ustawienia (domyślne) i dziennik diagnostyczny.

export const DEF = {
    // 🎤 mój głos → tekst
    glosLang: 'pl-PL', glosDfn: true, glosDfnLevel: 40, glosPunct: true,
    // 🎧 film w karcie → napisy (odszumianie filmu na start WYŁĄCZONE — najpierw najprostsza droga)
    kartaLang: 'en-US', kartaDfn: false, kartaDfnLevel: 24, kartaMode: 'lektor',
    // na próbę (przełączniki w popupie): napisy po kropce, lektor po przecinku/kropce, okienko historii razem z napisami
    kartaCutSent: true, kartaLekPunct: true, kartaHistAuto: false, kartaFinUp: true, kartaTopLektor: true, kartaShowLive: true, kartaBoost: true, kartaBoostLvl: '2',
    // 🔒 rozpoznawanie lokalne (model mowy Chrome na tym komputerze — jak wersja lokalna Dyktowania)
    gnLocal: true,
    kartaRefresh: '300', // co ile ms odświeżać napis na ekranie ('0' = jak Google, 'fin' = tylko zatwierdzony tekst)
    kartaShowEn: true, kartaChunk: '5', kartaGap: '500', kartaPause: '1000', kartaKeep: '10',
};

export async function cfgGet() {
    const s = await chrome.storage.local.get(Object.keys(DEF));
    const c = { ...DEF };
    for (const k of Object.keys(DEF)) if (s[k] !== undefined) c[k] = s[k];
    return c;
}

// Każdy krok trafia do dziennika (trzyma go tło) — popup pokazuje go i kopiuje jednym kliknięciem.
export function log(src, msg) {
    try { console.log('[' + src + ']', msg); } catch (e) { /* bez konsoli */ }
    try { chrome.runtime.sendMessage({ action: 'GN_LOG', src, msg: String(msg) }, () => { void chrome.runtime.lastError; }); }
    catch (e) { /* tło śpi — trudno */ }
}

// Odszumianie DeepFilterNet3 (WASM) jako węzeł AudioWorklet; wejście/wyjście 48 kHz mono
export async function dfnNode(ctx, level) {
    const get = (p) => fetch(chrome.runtime.getURL(p)).then((r) => { if (!r.ok) throw new Error(p + ': ' + r.status); return r.arrayBuffer(); });
    const [wasm, model] = await Promise.all([get('glos/dfn/v3/pkg/df_bg.wasm'), get('glos/dfn/v3/models/DeepFilterNet3_onnx.tar.gz')]);
    const wasmModule = await WebAssembly.compile(wasm);
    await ctx.audioWorklet.addModule(chrome.runtime.getURL('glos/dfn/deepfilter-worklet.js'));
    return new AudioWorkletNode(ctx, 'deepfilter-audio-processor', {
        processorOptions: { wasmModule, modelBytes: model, suppressionLevel: level },
    });
}

// Miernik poziomu: co 100 ms szczyt sygnału → callback; co 10 s wpis do dziennika (czy w ogóle coś gra)
export function levelMeter(ctx, node, src, onLevel) {
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    node.connect(an);
    const a = new Float32Array(an.fftSize);
    let max = 0, n = 0;
    setInterval(() => {
        an.getFloatTimeDomainData(a);
        let p = 0;
        for (const v of a) p = Math.max(p, Math.abs(v));
        max = Math.max(max, p);
        onLevel(p);
        if (++n % 100 === 0) { log(src, 'poziom dźwięku (szczyt z 10 s): ' + max.toFixed(3) + (max < 0.003 ? '  ← CISZA' : '')); max = 0; }
    }, 100);
}

// Wzmacniacz mowy — tylko dźwięk dla rozpoznawania (film słyszysz bez zmian):
// 1) mocno obcina basy/dudnienie muzyki (< 150 Hz) i syk/talerze (> 7,5 kHz),
// 2) podbija wyrazistość mowy (ok. 2,5 kHz) i „ciało” głosu (ok. 1 kHz),
// 3) kompresor podciąga ciche kwestie, a głośne efekty przycisza, 4) wzmocnienie + ogranicznik (bez przesterowania).
export const BOOST_LVL = {
    1: { pres: 4, body: 1, thr: -36, ratio: 3, gain: 1.6 },  // lekko
    2: { pres: 6, body: 2, thr: -42, ratio: 6, gain: 2.5 },  // średnio
    3: { pres: 9, body: 3, thr: -48, ratio: 10, gain: 4 },   // mocno
};
export function speechBoost(ctx) {
    const f = (type, freq, q, gain) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = freq; n.Q.value = q; if (gain != null) n.gain.value = gain; return n; };
    const hp = f('highpass', 150, 0.7), hp2 = f('highpass', 150, 0.7), lp = f('lowpass', 7500, 0.7), body = f('peaking', 1000, 0.8, 2), pres = f('peaking', 2500, 1, 6);
    const comp = ctx.createDynamicsCompressor();
    comp.knee.value = 12; comp.attack.value = 0.005; comp.release.value = 0.25;
    const gain = ctx.createGain();
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.1;
    // podwójny filtr basów: muzyka nie „pompuje” kompresora
    hp.connect(hp2); hp2.connect(lp); lp.connect(body); body.connect(pres); pres.connect(comp); comp.connect(gain); gain.connect(lim);
    return {
        input: hp, output: lim,
        set(level) {
            const p = BOOST_LVL[level] || BOOST_LVL[2];
            pres.gain.value = p.pres; body.gain.value = p.body;
            comp.threshold.value = p.thr; comp.ratio.value = p.ratio; gain.gain.value = p.gain;
        },
    };
}

// ---------- Rozpoznawanie lokalne (jak wersja lokalna Dyktowania) ----------
// processLocally = true: Chrome rozpoznaje mowę własnym modelem na tym komputerze, nic nie idzie do Google.
// Model pobiera się raz na język (Chrome pozwala zacząć tylko po kliknięciu). Bez modelu NIE ma cichego
// powrotu do Google — okienko pokazuje, że czeka, i przycisk „Pobierz”.
export const SRClass = () => self.SpeechRecognition || self.webkitSpeechRecognition;
export const locSupported = () => { const SR = SRClass(); return !!(SR && typeof SR.available === 'function'); };
export const LOC_TXT = {
    available: '✓ gotowy — rozpoznaje lokalnie',
    downloadable: '⬇ do pobrania',
    downloading: '⏳ pobieram model…',
    unavailable: '✗ ten język nie ma modelu lokalnego',
    unsupported: '✗ ten Chrome nie umie rozpoznawać lokalnie',
    error: '✗ błąd sprawdzania',
};
export async function locState(lang) {
    if (!locSupported()) return 'unsupported';
    try { return await SRClass().available({ langs: [lang], processLocally: true }); } catch (e) { return 'error'; }
}
export function locInstall(lang) { return SRClass().install({ langs: [lang], processLocally: true }); }

// Strażnik okienka: sprawdza model (stan w infoEl), pokazuje przycisk pobierania (btnEl),
// po gotowości woła onReady(), w przeciwnym razie onWait(stan).
export function locGate(getLang, infoEl, btnEl, onReady, onWait, L) {
    const g = { state: '', checking: false };
    g.reset = () => { g.state = ''; };
    g.check = () => {
        if (g.checking) return;
        g.checking = true;
        const lang = getLang();
        locState(lang).then((st) => {
            g.checking = false;
            if (st !== g.state) L('🔒 model mowy ' + lang + ': ' + (LOC_TXT[st] || st));
            g.state = st;
            infoEl.textContent = '🔒 Rozpoznawanie lokalne (' + lang + '): ' + (LOC_TXT[st] || st);
            btnEl.style.display = st === 'downloadable' ? '' : 'none';
            if (st === 'available') onReady(); else onWait(st);
        });
    };
    btnEl.addEventListener('click', () => {
        const lang = getLang();
        btnEl.disabled = true; btnEl.textContent = '⏳ Pobieram model mowy (nie zamykaj okienka)…';
        locInstall(lang) // od razu w kliknięciu — Chrome inaczej nie pozwoli pobrać
            .then((ok) => L(ok ? '🔒 model mowy ' + lang + ' pobrany' : '❌ pobieranie modelu się nie udało'))
            .catch((e) => L('❌ pobieranie modelu: ' + (e && e.name) + ' ' + (e && e.message)))
            .finally(() => { btnEl.disabled = false; btnEl.textContent = '⬇ Pobierz lokalny model mowy'; g.state = ''; g.check(); });
    });
    return g;
}
