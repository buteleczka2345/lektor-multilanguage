// lowca_cc_stub.js — lekki przycisk CC na każdej stronie z filmem (świat izolowany, tylko główna ramka).
// Działa TYLKO gdy zaznaczony jest checkbox „Pokazuj GUI Łowcy (przycisk CC)” (storage: lowcaGui);
// background rejestruje ten skrypt dopiero wtedy (i wyrejestrowuje po odznaczeniu).
// Klik w CC otwiera małe menu:
//   🅾 OCR — włącz/wyłącz, język, ramka: osobne narzędzie (assets/ocr_tool.js), BEZ uruchamiania Łowcy,
//   🔍 Łowca napisów — dopiero to ładuje ciężkiego Łowcę (LOWCA_START) i otwiera jego panel.
// Gdy Łowca już działa na stronie (jego własny przycisk, [data-ush-host]), ten przycisk się chowa.
(function () {
    'use strict';
    if (window.top !== window) return;
    if (window.__LEKTOR_CC_STUB__) return;
    window.__LEKTOR_CC_STUB__ = true;

    const LANGS = [
        ['', 'Automatycznie (przeglądarka + angielski)'],
        ['pol', 'Polski — w paczce'], ['eng', 'Angielski — w paczce'], ['pol+eng', 'Polski + angielski — w paczce'],
        ['chi_sim', 'Chiński uproszczony — w paczce'], ['chi_tra', 'Chiński tradycyjny — w paczce'],
        ['chi_sim+eng', 'Chiński upr. + angielski — w paczce'],
        ['deu', 'Niemiecki (z internetu)'], ['fra', 'Francuski (z internetu)'], ['spa', 'Hiszpański (z internetu)'],
        ['ita', 'Włoski (z internetu)'], ['rus', 'Rosyjski (z internetu)'], ['ukr', 'Ukraiński (z internetu)'],
        ['jpn', 'Japoński (z internetu)'], ['kor', 'Koreański (z internetu)']
    ];
    let on = false, host = null, btn = null, menu = null, ocrBtn = null, langSel = null, info = null, ocrOn = false, busy = false, ocrChk = null, obEl = null, engSelEl = null, trSelEl = null, detSelEl = null, afChkEl = null, bigChkEl = null, bigSelEl = null, bigLinEl = null;   // [AGENT-EXP] trSelEl; afChkEl = 🎯 auto-ramka

    function lowcaVisible() {
        const h = document.querySelector('[data-ush-host]');
        return !!(h && h.style.display !== 'none');
    }
    function send(msg) {
        return new Promise((res) => { try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r || null); }); } catch (e) { res(null); } });
    }
    function paintOcr() {
        if (ocrBtn) { ocrBtn.textContent = ocrOn ? '🅾 OCR: wyłącz' : '🅾 OCR: włącz'; ocrBtn.classList.toggle('on', ocrOn); }
        if (ocrChk) ocrChk.checked = ocrOn;           // mały checkbox „OCR” obok CC
        if (btn) btn.classList.toggle('ocr', ocrOn);
        if (obEl) obEl.classList.toggle('on', ocrOn);
    }
    async function ocrCmd(cmd) {
        if (info) info.textContent = '…';
        const r = await send({ action: 'OCR_TOOL_CMD', cmd });
        if (r && r.ok) { ocrOn = !!r.on; if (info) info.textContent = r.status ? 'OCR: ' + r.status : ''; }
        else if (info) info.textContent = 'Nie widzę filmu — włącz odtwarzanie.';
        paintOcr();
    }
    function build() {
        host = document.createElement('div');
        host.setAttribute('data-lektor-cc', '');
        host.style.cssText = 'all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483646;';
        const root = host.attachShadow({ mode: 'closed' });
        try { if (self.MLi18n) MLi18n.watch(root); } catch (e) {}   // [AGENT-EXP] 2026-10-21: język interfejsu (PL / EN)
        const st = document.createElement('style');
        st.textContent =
            '.cc{all:initial;box-sizing:border-box;width:44px;height:44px;border-radius:50%;background:rgba(18,18,22,.85);border:1px solid rgba(255,255,255,.3);' +
            'color:#7ee0ff;font:bold 13px system-ui,sans-serif;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4);opacity:.75}' +
            '.cc:hover{opacity:1}.cc.ocr{color:#f0abfc;border-color:#e879f9;opacity:1}' +
            '.m{display:none;position:absolute;right:0;bottom:52px;width:250px;background:rgba(18,18,22,.96);border:1px solid #444;border-radius:10px;padding:8px;' +
            'font:12px system-ui,sans-serif;color:#eee;box-shadow:0 4px 16px rgba(0,0,0,.5);flex-direction:column;gap:6px}.m.open{display:flex}' +
            '.h{font-size:10px;color:#aaa}.i{appearance:none;width:100%;box-sizing:border-box;background:#22222a;color:#eee;border:1px solid #555;border-radius:6px;padding:6px 8px;font:12px system-ui,sans-serif;cursor:pointer;text-align:left}' +
            '.i:hover{border-color:#999}.i.on{border-color:#e879f9;color:#f0abfc}select.i{padding:5px}.inf{font-size:10px;color:#e9b5f5;min-height:12px}.sep{border-top:1px solid #333;margin:2px 0}' +
            '.ob{position:absolute;right:50px;bottom:11px;display:flex;align-items:center;gap:3px;background:rgba(18,18,22,.85);border:1px solid rgba(255,255,255,.3);' +
            'border-radius:11px;padding:2px 7px 2px 4px;font:bold 11px system-ui,sans-serif;color:#ddd;cursor:pointer;opacity:.75;white-space:nowrap}' +
            '.ob:hover{opacity:1}.ob input{margin:0;width:13px;height:13px;cursor:pointer;accent-color:#e879f9}.ob.on{color:#f0abfc;border-color:#e879f9;opacity:1}';
        btn = document.createElement('button');
        btn.className = 'cc'; btn.type = 'button'; btn.textContent = 'CC';
        btn.title = 'OCR i Łowca napisów';
        menu = document.createElement('div'); menu.className = 'm';
        const h1 = document.createElement('div'); h1.className = 'h'; h1.textContent = 'OCR — napisy wtopione w obraz (bez Łowcy)';
        ocrBtn = document.createElement('button'); ocrBtn.className = 'i'; ocrBtn.type = 'button';
        ocrBtn.addEventListener('click', (e) => { e.stopPropagation(); ocrCmd('toggle').then(() => { btn.classList.toggle('ocr', ocrOn); }); });
        langSel = document.createElement('select'); langSel.className = 'i'; langSel.title = 'Język napisów dla OCR (jeden = najszybciej)';
        LANGS.forEach((p) => { const o = document.createElement('option'); o.value = p[0]; o.textContent = p[1]; langSel.appendChild(o); });
        langSel.addEventListener('change', (e) => { e.stopPropagation(); try { chrome.storage.local.set({ ocrToolLang: langSel.value }); } catch (e2) {} });
        // [PP-OCR] wybór silnika OCR (zapamiętany; zmiana działa od razu, także w trakcie)
        const engSel = document.createElement('select'); engSel.className = 'i';
        engSel.title = 'Tesseract: dobry na czystym tle i dla polskich znaków. PP-OCR: dużo lepszy na kolorowym/ruchliwym tle i dla chińskiego.';
        [['tesseract', 'Silnik: Tesseract (czyste tło, polskie znaki)'], ['ppocr6t', 'Silnik: PP-OCRv6 tiny (najszybszy)'], ['ppocr6s', 'Silnik: PP-OCRv6 small (najdokładniejszy)']].forEach((p) => { const o = document.createElement('option'); o.value = p[0]; o.textContent = p[1]; engSel.appendChild(o); });
        engSel.addEventListener('change', (e) => { e.stopPropagation(); try { chrome.storage.local.set({ ocrToolEngine: engSel.value }); } catch (e2) {} });
        engSelEl = engSel;
        // [AGENT-EXP] kto tłumaczy tekst z OCR (zmiana działa od razu) + 🏁 wyścig tłumaczy
        const trSel = document.createElement('select'); trSel.className = 'i';
        trSel.title = 'Kto tłumaczy obcy tekst z OCR. Bing był najszybszy w pomiarach (~0,2 s), Google ~1 s. Tłumacz strony wymaga włączonego „Przetłumacz stronę” w Immersive Translate / TWP.';
        [['skrypt', 'Tłumaczy: silnik z ustawień (lokalny → Bing)'], ['lokalny', 'Tłumaczy: tylko lokalny (Translator Chrome, bez sieci)'], ['bing', 'Tłumaczy: Bing — każdy język, najszybszy'], ['google', 'Tłumaczy: Google — każdy język'], ['deepl', 'Tłumaczy: DeepL'],   /* [AGENT-EXP] */ ['strona', 'Tłumaczy: Immersive Translate / TWP (eksperyment)']].forEach((p) => { const o = document.createElement('option'); o.value = p[0]; o.textContent = p[1]; trSel.appendChild(o); });
        trSel.addEventListener('change', (e) => { e.stopPropagation(); try { chrome.storage.local.set({ ocrToolTr: trSel.value }); } catch (e2) {} });
        trSelEl = trSel;
        // [AGENT-EXP] (cz. 4) wykrywanie zmiany napisu (PP-OCR): jasność = jak dawniej (domyślnie), krawędzie = eksperyment
        const detSel = document.createElement('select'); detSel.className = 'i';
        detSel.title = 'Jasność: łapie każdy napis (jak dawniej). Krawędzie liter: mniej zapytań, ale tylko jasne (białe/żółte) napisy — szare lub kolorowe może gubić.';
        [['jasnosc', 'Wykrywanie: jasność (jak dawniej)'], ['krawedzie', 'Wykrywanie: krawędzie liter (eksperyment)']].forEach((p) => { const o = document.createElement('option'); o.value = p[0]; o.textContent = p[1]; detSel.appendChild(o); });
        detSel.addEventListener('change', (e) => { e.stopPropagation(); try { chrome.storage.local.set({ ocrToolDetect: detSel.value }); } catch (e2) {} });
        detSelEl = detSel;
        const raceBtn = document.createElement('button'); raceBtn.className = 'i'; raceBtn.type = 'button'; raceBtn.textContent = '🏁 Wyścig tłumaczy (czas napisu)';
        raceBtn.title = 'Mierzy, który tłumacz najszybciej dostarcza polski napis: Chrome lokalny, Google, Bing, DeepL, Immersive / TWP';
        raceBtn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.remove('open'); ocrCmd('race'); });
        const frameBtn = document.createElement('button'); frameBtn.className = 'i'; frameBtn.type = 'button'; frameBtn.textContent = '▭ Ramka OCR (gdzie są napisy)';
        frameBtn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.remove('open'); ocrCmd('frame'); });
        // [AGENT-EXP] 🎯 auto-ramka: OCR sam znajduje napisy na filmie (model wykrywania tekstu PP-OCR tiny, kilka klatek)
        const afLab = document.createElement('label'); afLab.className = 'i'; afLab.style.cssText = 'display:flex;align-items:center;gap:6px';
        afLab.title = 'Po włączeniu OCR sprawdza kilka klatek, sam ustawia ramkę na napisach i ją zapamiętuje. Szuka ponownie dopiero, gdy przez ~20 s nic nie przeczyta.';
        const afChk = document.createElement('input'); afChk.type = 'checkbox'; afChk.style.cssText = 'margin:0;accent-color:#e879f9;cursor:pointer';
        afChk.addEventListener('change', (e) => { e.stopPropagation(); try { chrome.storage.local.set({ ocrToolAutoFrame: afChk.checked }); } catch (e2) {} });
        afLab.addEventListener('click', (e) => e.stopPropagation());
        afLab.append(afChk, document.createTextNode('🎯 Auto-ramka (sama szuka napisów)'));
        afChkEl = afChk;
        // [AGENT-EXP] 2026-10-19: 🔠 duże napisy (tłumaczenie od razu na obrazie filmu, też bez lektora) + rozmiar
        const bigLab = document.createElement('label'); bigLab.className = 'i'; bigLab.style.cssText = 'display:flex;align-items:center;gap:6px';
        bigLab.title = 'Przetłumaczony napis pojawia się od razu, dużą czcionką na dole filmu — także gdy lektor jest wyłączony. Lektor (gdy włączony) czyta po swojemu.';
        const bigChk = document.createElement('input'); bigChk.type = 'checkbox'; bigChk.style.cssText = 'margin:0;accent-color:#e879f9;cursor:pointer';
        bigChk.addEventListener('change', (e) => { e.stopPropagation(); try { chrome.storage.local.set({ ocrToolBigSubs: bigChk.checked }); } catch (e2) {} });
        bigLab.addEventListener('click', (e) => e.stopPropagation());
        bigLab.append(bigChk, document.createTextNode('🔠 Duże napisy na filmie (tłumaczenie)'));
        bigChkEl = bigChk;
        const bigSel = document.createElement('select'); bigSel.className = 'i'; bigSel.title = 'Wielkość dużych napisów';
        [['m', '🔠 Czcionka: średnia'], ['l', '🔠 Czcionka: duża'], ['xl', '🔠 Czcionka: bardzo duża']].forEach((p) => { const o = document.createElement('option'); o.value = p[0]; o.textContent = p[1]; bigSel.appendChild(o); });
        bigSel.addEventListener('change', (e) => { e.stopPropagation(); try { chrome.storage.local.set({ ocrToolBigSize: bigSel.value }); } catch (e2) {} });
        bigSel.addEventListener('click', (e) => e.stopPropagation());
        bigSelEl = bigSel;
        // [AGENT-EXP] 2026-10-19: ile napis wisi po zniknięciu oryginału (cisza)
        const bigLin = document.createElement('select'); bigLin.className = 'i'; bigLin.title = 'Jak długo duży napis zostaje na ekranie, gdy oryginalny napis już zniknął (cisza). Nowy napis zawsze od razu zastępuje stary.';
        [['0', '⏳ Po ciszy: znika od razu'], ['1000', '⏳ Po ciszy: zostaje 1 s'], ['2500', '⏳ Po ciszy: zostaje 2,5 s'], ['4000', '⏳ Po ciszy: zostaje 4 s'], ['6000', '⏳ Po ciszy: zostaje 6 s']]
            .forEach((p) => { const o = document.createElement('option'); o.value = p[0]; o.textContent = p[1]; bigLin.appendChild(o); });
        bigLin.addEventListener('change', (e) => { e.stopPropagation(); try { chrome.storage.local.set({ ocrToolBigLinger: Number(bigLin.value) }); } catch (e2) {} });
        bigLin.addEventListener('click', (e) => e.stopPropagation());
        bigLinEl = bigLin;
        info = document.createElement('div'); info.className = 'inf';
        const sep = document.createElement('div'); sep.className = 'sep';
        const lowcaBtn = document.createElement('button'); lowcaBtn.className = 'i'; lowcaBtn.type = 'button'; lowcaBtn.textContent = '🔍 Łowca napisów (przeszukaj stronę)';
        lowcaBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (busy) return; busy = true; lowcaBtn.textContent = '🔍 Uruchamiam Łowcę…';
            send({ action: 'LOWCA_START', fromPage: true, openPanel: true }).then(() => {
                busy = false; lowcaBtn.textContent = '🔍 Łowca napisów (przeszukaj stronę)'; menu.classList.remove('open'); update();
            });
        });
        menu.append(h1, ocrBtn, engSel, langSel, trSel, detSel, afLab, bigLab, bigSel, bigLin, frameBtn, raceBtn, info, sep, lowcaBtn);   // [AGENT-EXP] trSel, raceBtn
        // Mały checkbox „OCR” obok CC — szybkie włącz/wyłącz bez otwierania menu
        const ob = document.createElement('label'); ob.className = 'ob'; ob.title = 'OCR napisów z obrazu: zaznaczone = włączony (bez Łowcy)';
        ocrChk = document.createElement('input'); ocrChk.type = 'checkbox';
        ob.append(ocrChk, document.createTextNode('OCR'));
        ocrChk.addEventListener('change', (e) => {
            e.stopPropagation();
            const want = ocrChk.checked;
            ocrCmd(want ? 'start' : 'stop').then(() => {
                if (want && !ocrOn) { menu.classList.add('open'); paintOcr(); } // nie wystartował (np. brak filmu) — pokaż powód w menu
            });
        });
        obEl = ob;
        btn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            const open = !menu.classList.contains('open');
            menu.classList.toggle('open', open);
            if (open) {
                try { chrome.storage.local.get(['ocrToolLang', 'ocrToolEngine', 'ocrToolTr', 'ocrToolDetect', 'ocrToolAutoFrame', 'ocrToolBigSubs', 'ocrToolBigSize', 'ocrToolBigLinger'], (r) => { if (afChkEl) afChkEl.checked = !!(r && r.ocrToolAutoFrame === true); if (bigChkEl) bigChkEl.checked = !(r && r.ocrToolBigSubs === false); if (bigSelEl) bigSelEl.value = (r && (r.ocrToolBigSize === 'm' || r.ocrToolBigSize === 'xl')) ? r.ocrToolBigSize : 'l'; if (bigLinEl) { const L = Number(r && r.ocrToolBigLinger); bigLinEl.value = [0, 1000, 2500, 4000, 6000].indexOf(L) >= 0 ? String(L) : '2500'; } /* [AGENT-EXP] 2026-10-19 🔠 */ /* [AGENT-EXP] 🎯 */ if (detSelEl) detSelEl.value = (r && r.ocrToolDetect) === 'krawedzie' ? 'krawedzie' : 'jasnosc'; langSel.value = (r && r.ocrToolLang) || ''; if (engSelEl) { const v = r && r.ocrToolEngine; engSelEl.value = v === 'ppocr6t' ? 'ppocr6t' : (v === 'ppocr6s' || v === 'ppocr') ? 'ppocr6s' : 'tesseract'; } if (trSelEl) { const t = r && r.ocrToolTr; trSelEl.value = ['bing', 'google', 'deepl', 'strona', 'lokalny'].indexOf(t) !== -1 ? t : 'skrypt'; } }); } catch (e2) {}   // [AGENT-EXP] ocrToolTr
                paintOcr();
                if (ocrOn) ocrCmd('state').then(() => { btn.classList.toggle('ocr', ocrOn); }); // OCR mógł się sam zatrzymać (np. DRM)
            }
        });
        // kliknięcia w przycisk/menu nie sterują odtwarzaczem strony
        ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'keydown', 'click'].forEach((n) => host.addEventListener(n, (e) => e.stopPropagation()));
        // klik poza przyciskiem/menu zamyka menu (kliki w środku — nie)
        document.addEventListener('click', (e) => { if (menu && !(e.composedPath && e.composedPath().indexOf(host) !== -1)) menu.classList.remove('open'); }, true);
        root.append(st, menu, ob, btn);
        paintOcr();
    }
    function mountTarget() {
        try { const fs = document.fullscreenElement; if (fs && fs.tagName !== 'VIDEO' && fs.tagName !== 'IFRAME') return fs; } catch (e) {}
        return document.documentElement;
    }
    function update() {
        const want = on && document.visibilityState === 'visible' && !!document.querySelector('video') && !lowcaVisible();
        if (want) {
            if (!host) build();
            const t = mountTarget();
            if (host.parentNode !== t) t.appendChild(host);
        } else if (host && host.parentNode) {
            host.parentNode.removeChild(host);
        }
    }

    // Stan OCR zgłaszany przez narzędzie (np. zatrzymane ✕ w okienku albo przez DRM) — checkbox i menu się aktualizują
    try {
        chrome.runtime.onMessage.addListener((msg) => {
            if (!msg || msg.action !== 'OCR_TOOL_STATE_PUSH') return;
            ocrOn = !!msg.on;
            if (info && msg.status) info.textContent = 'OCR: ' + msg.status;
            paintOcr();
        });
    } catch (e) {}

    try {
        chrome.storage.local.get('lowcaGui', (r) => { on = !!(r && r.lowcaGui); update(); });
        chrome.storage.onChanged.addListener((ch, area) => {
            if (area !== 'local' || !ch.lowcaGui) return;
            on = !!ch.lowcaGui.newValue;
            update();
        });
    } catch (e) {}
    // Film może pojawić się później (strony typu SPA) — tanie sprawdzenie co 2 s, tylko na widocznej karcie.
    setInterval(() => { if (on && document.visibilityState === 'visible') update(); }, 2000);
    document.addEventListener('visibilitychange', update);
    document.addEventListener('fullscreenchange', update);
})();
