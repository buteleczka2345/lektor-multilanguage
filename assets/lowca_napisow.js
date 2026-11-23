/*
 * Łowca Napisów — port do rozszerzenia Lektor Multilanguage YT (MV3, świat MAIN).
 * Wstrzykiwany na żądanie (chrome.scripting) przyciskiem „Szukaj napisów" w popupie,
 * sterowany SESJĄ NA ŻĄDANIE (start/stop) przez mostek assets/lowca_bridge.js.
 * API Tampermonkey (GM_*) zapewniane lokalnie — patrz shims tuż przed obiektem gm.
 * Oryginalny userscript: v1.3.0 (@match wszystkie URL-e, @connect: gwiazdka, @grant unsafeWindow).
 */

/*
 * SPIS TREŚCI
 *  1. Kontekst i konfiguracja          10. DOM i Shadow DOM (querySelectorAllDeep, template, object/embed, ukryte pola)
 *  2. Narzędzia                        11. TextTracks (HTMLMediaElement)
 *  3. Rozpoznawanie adresów i treści   12. MutationObserver — napisy na żywo (DOM, ARIA, SVG, pseudo-elementy CSS)
 *  4. Parsery i konwertery             13. Window i instancje odtwarzaczy
 *     4b. CEA-608/708, SCC, EBU STL,   14. Magazyny (localStorage, Cache, IndexedDB; 14b: cookies, OPFS, history.state)
 *         Matroska/WebM, MP4/CMAF      15. Pobieranie i eksport (z eskalacją nagłówków)
 *  5. Bufor znalezisk + raport         16. Interfejs   17. Start
 *  6. Analiza obiektów (window/JSON)   18. OCR napisów wtopionych w obraz (eksperyment)
 *  7. Manifesty HLS/DASH, segmenty, napisy zamknięte w wideo i MPEG-TS
 *  8. Obsługa treści z sieci
 *  9. Hooki: fetch, XHR (+send/nagłówki), JSON.parse, Blob, WebSocket/SSE (+Blob, nazwane zdarzenia, send),
 *     TextTrack.addCue, attachShadow, TextDecoder/TextEncoder, atob/btoa;
 *     9b: Worker/SharedWorker, BroadcastChannel, MessageChannel/Port, postMessage (także od rozszerzeń),
 *     Service Worker, WebRTC DataChannel, SpeechRecognition, canvas fillText, Cache API, WebAssembly, sendBeacon
 *  19. Wątek roboczy (ciężkie parsowanie), pamięć podręczna parsowania, budżet CPU i priorytety, strażnik hooków
 *
 * API dla innych skryptów:  window.__USH__  (items, best(), live, containers, textTracks, sources(), snippets,
 *                           scan(), deepScan(), download(), on(), ocr, util)
 * Zdarzenia na window:      "ush:found" (nowe napisy), "ush:cue" (zmiana napisu na ekranie; w detail: tekst, źródło,
 *                           selektor kontenera), "ush:container" (wykryto element strony, w którym wyświetlają się napisy)
 * Znacznik w DOM:           wykryty kontener napisów dostaje atrybut data-ush-captions — inny skrypt lub rozszerzenie
 *                           znajdzie go przez document.querySelector('[data-ush-captions]') bez znajomości strony
 */

(function () {
  'use strict';

  /* ═══════════════ 1. KONTEKST I KONFIGURACJA ═══════════════ */

  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  const doc = W.document;
  if (!doc || W.__USH__) return;
  // Puste ramki (about:blank, srcdoc) obsługuje kopia skryptu ze strony nadrzędnej — tu nie startujemy drugi raz
  try { if (W.parent !== W && /^about:/.test(String(W.location.href)) && W.parent.__USH__) return; } catch (e) {}

  const VERSION = '1.3.1';
  const IS_TOP = (function () { try { return W.top === W; } catch (e) { return false; } })();
  const HOST = (function () { try { return W.location.hostname || ''; } catch (e) { return ''; } })();

  /* ===== Shims dla kontekstu MV3 (świat MAIN, brak API Tampermonkey) =====
   * MUSZĄ być przed const gm — tam oceniane są typeof-y GM_*.
   * W === window w rozszerzeniu (unsafeWindow nie istnieje), więc zwykłe
   * `typeof GM_getValue` (gołe odwołanie w gm) trafia w window.GM_getValue. */
  const GM_MEM = Object.create(null);
  if (typeof W.GM_getValue !== 'function') {
    W.GM_getValue = function (k, d) { return (k in GM_MEM) ? GM_MEM[k] : d; };
    W.GM_setValue = function (k, v) { GM_MEM[k] = v; };
  }
  if (typeof W.GM_setClipboard !== 'function') {
    W.GM_setClipboard = function (t) { try { navigator.clipboard.writeText(String(t)); } catch (e) {} };
  }
  W.GM_registerMenuCommand = W.GM_registerMenuCommand || function () {}; // brak menu — panel ma Alt+N
  if (typeof W.GM_xmlhttpRequest !== 'function') {
    // Proxy przez mostek (lowca_bridge) → background fetch (host *://*/* omija CORS) → odpowiedź:
    // window.postMessage({ __lowca_xhr_res: { id, ok, status, headers, b64 } })
    let gxSeq = 0;
    const gxWait = Object.create(null);
    W.GM_xmlhttpRequest = function (opts) {
      if (!opts || !opts.url) return;
      const id = 'gx' + (++gxSeq);
      const timer = setTimeout(function () {
        if (gxWait[id]) { delete gxWait[id]; try { opts.ontimeout && opts.ontimeout(); } catch (e) {} }
      }, opts.timeout || 30000);
      gxWait[id] = { opts: opts, timer: timer };
      try { W.postMessage({ __lowca_xhr: { id: id, url: String(opts.url), headers: opts.headers || {} } }, '*'); }
      catch (e) { delete gxWait[id]; clearTimeout(timer); try { opts.onerror && opts.onerror({ error: String(e) }); } catch (e2) {} }
    };
    W.addEventListener('message', function (ev) {
      try {
        const d = ev.data;
        if (!d || !d.__lowca_xhr_res) return;
        const p = gxWait[d.__lowca_xhr_res.id]; if (!p) return;
        delete gxWait[d.__lowca_xhr_res.id]; clearTimeout(p.timer);
        const r = d.__lowca_xhr_res;
        if (!r.ok || r.error) { p.opts.onerror && p.opts.onerror({ error: r.error || 'błąd pobierania' }); return; }
        const bin = atob(r.b64 || ''); const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        p.opts.onload && p.opts.onload({ status: r.status || 0, responseHeaders: r.headers || '', response: u8.buffer });
      } catch (e) {}
    }, false);
  }

  /* ===== Sesja na żądanie (integracja z Lektor Multilanguage YT) =====
   * true  = aktywna (wstrzyknięcie = Start z popupu; hooki i obserwatory pracują)
   * false = zatrzymana — wszystkie automatyczne ścieżki mają early-return (zero nasłuchu)
   * GUI: tryb cichy (CFG.guiQuiet) — przycisk CC i panel schowane, aż użytkownik sam
   * otworzy panel (Alt+N). Skanowanie w tle działa niezależnie od GUI.
   * Sterowanie: window.postMessage({__lowca:'cmd', cmd:'start'|'stop'}) z mostka. */
  const UI_QUIET = { reveal: false }; // true = użytkownik poprosił o GUI (Alt+N) w tej sesji
  let SESJA = true;

  const gm = {
    get: function (k, d) { try { return typeof GM_getValue === 'function' ? GM_getValue(k, d) : d; } catch (e) { return d; } },
    set: function (k, v) { try { if (typeof GM_setValue === 'function') GM_setValue(k, v); } catch (e) {} },
    xhr: typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : null,
    clip: typeof GM_setClipboard === 'function' ? GM_setClipboard : null,
    menu: typeof GM_registerMenuCommand === 'function' ? GM_registerMenuCommand : null
  };

  // Wyłączanie skryptu na wybranej domenie (menu Tampermonkey)
  const offHosts = (function () { const v = gm.get('ush_off_hosts', []); return Array.isArray(v) ? v : []; })();
  const DISABLED = offHosts.indexOf(HOST) !== -1;
  if (gm.menu && IS_TOP) {
    try {
      gm.menu((DISABLED ? 'Włącz na ' : 'Wyłącz na ') + HOST, function () {
        const i = offHosts.indexOf(HOST);
        if (i === -1) offHosts.push(HOST); else offHosts.splice(i, 1);
        gm.set('ush_off_hosts', offHosts);
        W.location.reload();
      });
    } catch (e) {}
  }
  if (DISABLED) return;

  // [AGENT-EXP] 2026-10-15 (z userscriptu Piper 4.2.17): 🔋 TRYB OSZCZĘDNY (domyślnie WŁ.;
  // checkbox „Łowca: tryb oszczędny” w ustawieniach → lowcaEco, przekazuje go mostek komendą 'eco').
  // Łowca na zapamiętanych domenach działa od startu strony i szukał bez końca. Teraz przestaje szukać:
  // * gdy złapie plik z napisami (min. ECO_MIN_CUES kwestii) — po ECO_SETTLE_MS (zdążą dojść inne języki),
  // * gdy film gra ECO_NOFIND_MS, a napisów brak (pomiar na YouTube: plik napisów przychodzi kilka ms
  //   po starcie odtwarzania, więc 4 s to duży zapas); reklama YouTube i krótkie klipy zegara nie ruszają,
  // * gdy na stronie nie ma filmu przez ECO_NOVIDEO_MS (pojawienie się filmu budzi go znowu).
  // Haki i obserwatory zasypiają, znaleziska zostają (panel, pobieranie, lektor). Budzi go nowy film /
  // nowa podstrona, „Szukaj dalej” w panelu (Alt+N) albo „Szukaj napisów” w popupie. Po „Szukaj napisów”
  // przez ECO_HUNT_MS nie wycisza się z braku napisów (czas na włączenie napisów w odtwarzaczu).
  // [AGENT-EXP] 2026-10-17: RAZ NA STRONĘ — Łowca szuka tylko raz: gdy na stronie jest film, szuka ~2 s gry
  // (ECO_NOFIND_MS); nie znalazł → wyłącza się; znalazł → też koniec. Potem już się sam NIE budzi
  // (ani nowy film / podstrona, ani nowy film na stronie) — dopiero odświeżenie strony (eco.done).
  // Strona bez filmu: od razu śpi i czeka na film (onReady; w trakcie — ECO_NOVIDEO_MS = 0, pierwszy takt bez filmu)
  // — pierwszy film go włączy (ten jeden raz). [AGENT-EXP] 2026-10-17: było 2 s włączenia także bez filmu.
  // Ręczne „Szukaj dalej” / „Szukaj napisów” w popupie dalej działają.
  let ECO = true;
  const ECO_MIN_CUES = 15, ECO_SETTLE_MS = 2000, ECO_NOFIND_MS = 2000, ECO_NOVIDEO_MS = 0,   /* [AGENT-EXP] bez filmu = nie szukaj wcale */ ECO_MAIN_MIN_SEC = 90, ECO_HUNT_MS = 6000;   /* [FIX 2026-11-22] było 60 s — napisy łapią się w pierwszych sekundach, dłużej nic nie daje */
  const eco = { parked: false, empty: false, video: false, done: false, why: '', timer: 0, cues: 0, label: '', huntUntil: 0, noParkKey: null, playMs: 0, idleMs: 0, lastAt: 0 };
  function toggleEco() {
    ecoSet(!ECO);
    try { W.postMessage({ __lowca_eco_set: ECO }, '*'); } catch (e) {}   // mostek zapisuje w chrome.storage
    toast(ECO ? 'Tryb oszczędny WŁ. — Łowca szuka raz na stronę (2 s gry filmu) i się wyłącza; znowu po odświeżeniu strony.' : 'Tryb oszczędny WYŁ. — Łowca szuka bez przerwy.');   // [AGENT-EXP] raz na stronę
  }
  function ecoSet(on) {
    ECO = on !== false;
    if (!ECO) { if (eco.timer) { clearTimeout(eco.timer); eco.timer = 0; } if (eco.parked) ecoWake('tryb oszczędny wyłączony'); }
    else guard(ecoCheck);
    guard(ecoUi);
  }
  try { W.postMessage({ __lowca_eco_req: 1 }, '*'); } catch (e) {}   // mostek odpowie komendą 'eco' (ustawienie z chrome.storage)

  // Ustawienia. Możesz je zmienić tutaj albo w konsoli: __USH__.config.debug = true
  // UWAGA (Lektor Multilanguage YT): skrypt pracuje TYLKO na żądanie (przycisk w popupie).
  // GUI (pływający przycisk CC + panel) jest domyślnie SCHOWANE — bramka UI_QUIET.
  // Otworzysz je skrótem Alt+N albo przyciskiem „Sesja: start/stop" w panelu.
  const CFG = Object.assign({
    button: 'never',          // 'never' = GUI schowane (tryb cichy na żądanie) | 'auto' | 'always'
    guiQuiet: true,           // true = nie pokazuj przycisku CC ani panelu automatycznie; skanowanie w tle działa
    preferredLangs: [],      // np. ['pl', 'en']; puste = języki przeglądarki
    logFinds: true,          // kolorowy raport w konsoli
    debug: false,            // dodatkowe komunikaty diagnostyczne
    hotkeys: true,           // Alt+N panel, Alt+P pobierz najlepsze, Alt+K kopiuj napis z ekranu
    resetOnNavigate: true,   // czyść bufor po przejściu do innego filmu (strony typu SPA)
    autoDeepScan: true,      // raz po załadowaniu przejrzyj Cache Storage i IndexedDB
    forceLoadTracks: false,  // od razu wymuszaj wczytanie wyłączonych ścieżek <track>
    followFullscreen: true,  // przenoś przycisk do odtwarzacza w trybie pełnoekranowym
    markContainers: true,    // oznaczaj wykryte kontenery napisów atrybutem data-ush-captions (dla innych skryptów)
    bom: true,               // BOM UTF-8 w plikach .srt/.txt (polskie znaki w starszych odtwarzaczach)
    hookFetch: true, hookXHR: true, hookJSON: true, hookBlob: true, hookSockets: true,
    hookTextTrack: true, hookShadow: true, hookTextDecoder: true,
    hookWorker: true,        // podsłuch komunikatów z Worker/SharedWorker
    hookMessages: true,      // postMessage (też od rozszerzeń), BroadcastChannel, MessageChannel, Service Worker
    hookOutbound: true,      // to, co strona sama wysyła: XHR.send, fetch(body), WebSocket.send, sendBeacon, postMessage do workera
    hookEncoding: true,      // atob/btoa, TextEncoder, sendBeacon
    hookRTC: true, hookSpeech: true, hookCanvas: true, hookCacheAPI: true, hookWasm: true,
    injectWorkers: false,    // EKSPERYMENT: wstrzyknij podsłuch fetch/XHR do wnętrza Workerów (może zepsuć strony, które w workerze używają self.location)
    inbandCC: true,          // napisy zamknięte CEA-608/708 w obrazie (SEI H.264/HEVC, MPEG-2, AV1, MPEG-TS, ścieżki c608/c708)
    maxVideoBytes: 10 * 1024 * 1024,   // największy segment wideo sprawdzany pod kątem napisów zamkniętych
    sweepAttrs: true,        // przejrzyj atrybuty data-*/title/alt/aria-label wszystkich elementów (porcjami, w bezczynności)
    scanCookies: true,       // przejrzyj document.cookie
    referer: 'page',         // Referer przy pobieraniu przez GM_xmlhttpRequest: 'page' | 'origin' | 'self' (domena pliku) | 'none' | własny adres
    acceptLanguage: '',      // puste = języki przeglądarki
    gmUserAgent: '',         // puste = bez zmiany; ustawiany tylko w trzecim, ostatnim kroku eskalacji nagłówków
    gmHeaders: {},           // dodatkowe nagłówki dla GM_xmlhttpRequest, np. { 'X-Token': '…' }
    ocr: false,              // EKSPERYMENT: rozpoznawanie napisów wtopionych w obraz (włączane też przyciskiem w panelu / Alt+O)
    ocrLang: '',             // np. 'pol+eng'; puste = języki przeglądarki + angielski
    ocrRegion: [0, 0.62, 1, 0.38],   // część kadru do czytania: [x, y, szerokość, wysokość] w ułamkach
    ocrIntervalMs: 500, ocrMinConf: 55, ocrThreshold: 0,   // 0 = próg jasności automatycznie
    ocrBase: '',             // własny katalog z plikami Tesseract.js (zamiast CDN jsDelivr)
    useWorker: true,         // ciężkie parsowanie (duże pliki, segmenty wideo, MKV) w osobnym wątku — strona się nie zacina
    workerMinBytes: 256 * 1024,   // od jakiego rozmiaru tekst napisów idzie do wątku roboczego
    cpuBudgetMs: 60,         // ile ms na sekundę mogą zająć analizy w tle (okno, magazyny, JSON.parse); sieć ma pierwszeństwo
    hookFrames: true,        // podpinaj ramki w chwili dostępu do contentWindow/contentDocument
    watchdog: true,          // co 2 s sprawdzaj, czy strona nie podmieniła hooków, i podpinaj ponownie
    maxBodyBytes: 8 * 1024 * 1024,   // największa odpowiedź czytana w całości
    maxSniffBytes: 768 * 1024,       // największa odpowiedź binarna sprawdzana „na wszelki wypadek"
    maxItems: 400,
    maxLiveCues: 20000
  }, (function () { const v = gm.get('ush_cfg', null); const o = {}; if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { if (!/^(__proto__|constructor|prototype)$/.test(k)) o[k] = v[k]; }); return o; })());

  // Oryginały zapisane PRZED założeniem hooków (używane przez sam skrypt)
  const O = {
    Worker: W.Worker, workerPost: W.Worker && W.Worker.prototype && W.Worker.prototype.postMessage,
    log: (W.console && W.console.log) ? W.console.log.bind(W.console) : function () {},
    fetch: typeof W.fetch === 'function' ? W.fetch : null,
    jsonParse: W.JSON.parse,
    createObjectURL: (W.URL && W.URL.createObjectURL) || null,
    attachShadow: (W.Element && W.Element.prototype.attachShadow) || null,
    decode: (W.TextDecoder && W.TextDecoder.prototype.decode) || null
  };

  /* ═══════════════ 2. NARZĘDZIA ═══════════════ */

  const noop = function () {};
  const dict = function (o) { return Object.assign(Object.create(null), o); }; // tabela bez prototypu: klucze z danych strony („constructor", „__proto__") nie trafią w Object.prototype
  const now = function () { return (W.performance && W.performance.now) ? W.performance.now() : Date.now(); };
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const pad = function (n, w) { let s = String(n); while (s.length < w) s = '0' + s; return s; };
  const plKw = function (n) { const a = n % 10, b = n % 100; return n + (n === 1 ? ' kwestia' : (a >= 2 && a <= 4 && !(b >= 12 && b <= 14)) ? ' kwestie' : ' kwestii'); };
  const clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  const tagOf = function (v) { return Object.prototype.toString.call(v); };

  function dbg() { if (CFG.debug) { try { O.log.apply(null, ['%c USH debug ', 'background:#444;color:#fff'].concat([].slice.call(arguments))); } catch (e) {} } }
  function guard(fn) { try { return fn(); } catch (e) { dbg(e); } }
  function idle(fn, timeout) {
    if (typeof W.requestIdleCallback === 'function') W.requestIdleCallback(function () { guard(fn); }, { timeout: timeout || 1500 });
    else setTimeout(function () { guard(fn); }, 50);
  }
  function throttle(fn, ms) { let t = 0; return function () { if (t) return; t = setTimeout(function () { t = 0; guard(fn); }, ms); }; }
  async function mapLimit(arr, n, fn) {
    let i = 0;
    const worker = async function () { while (i < arr.length) { const k = i++; try { await fn(arr[k], k); } catch (e) {} } };
    const ws = []; for (let k = 0; k < Math.min(n, arr.length); k++) ws.push(worker());
    await Promise.all(ws);
  }
  async function waitFor(test, ms) { const end = Date.now() + ms; while (Date.now() < end) { const v = guard(test); if (v) return v; await sleep(150); } return null; }

  function toAbs(u, base) {
    try {
      u = String(u).trim();
      if (!u) return '';
      if (u.indexOf('\\') !== -1) u = u.replace(/\\u0026/gi, '&').replace(/\\\//g, '/');
      return new URL(u, (base && !/^about:/.test(base)) ? base : (doc.baseURI || W.location.href)).href; // elementy z <template> i pustych ramek mają bazę about:… — wtedy liczymy względem strony
    } catch (e) { return ''; }
  }
  const noHash = function (u) { const i = u.indexOf('#'); return i === -1 ? u : u.slice(0, i); };
  function sameOrigin(u) { try { return new URL(u, W.location.href).origin === W.location.origin; } catch (e) { return false; } }
  function shortUrl(u, max) {
    try {
      if (/^blob:/.test(u)) return 'blob (pamięć przeglądarki)';
      if (/^data:/.test(u)) return 'data: (treść w adresie)';
      const x = new URL(u); const parts = x.pathname.split('/').filter(Boolean);
      let s = x.hostname + (parts.length > 1 ? '/…/' : '/') + (parts[parts.length - 1] || '');
      if (x.search) s += '?…';
      return s.length > (max || 60) ? s.slice(0, (max || 60) - 1) + '…' : s;
    } catch (e) { return String(u).slice(0, max || 60); }
  }
  function hashStr(s) {
    let h = 5381; const n = s.length, step = n > 6000 ? Math.floor(n / 3000) : 1;
    for (let i = 0; i < n; i += step) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return n + ':' + (h >>> 0).toString(36);
  }
  function own(o, k) { // odczyt własnej właściwości bez wywoływania getterów strony
    try { const d = Object.getOwnPropertyDescriptor(o, k); return d && ('value' in d) ? d.value : undefined; } catch (e) { return undefined; }
  }

  const ENT = dict({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', bdquo: '„', rdquo: '”', ldquo: '“', rsquo: '’', lsquo: '‘' });
  function decodeEntities(s) {
    if (s.indexOf('&') === -1) return s;
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, function (m, e) {
      if (e[0] === '#') {
        const c = (e[1] === 'x' || e[1] === 'X') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { return String.fromCodePoint(c); } catch (x) { return ''; }
      }
      const k = e.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENT, k) ? ENT[k] : m;
    });
  }
  const tidyLines = function (s) { return s.split('\n').map(function (l) { return l.replace(/[ \t\u00A0\u200B]+/g, ' ').trim(); }).filter(Boolean).join('\n'); };
  // Tekst kwestii: bez znaczników VTT/SRT/ASS, z rozwiniętymi encjami
  function cleanCueText(s) {
    return tidyLines(decodeEntities(String(s)
      .replace(/\r/g, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/<\/?(?:c|v|i|b|u|s|ruby|rt|rp|lang|font|span|p|div|em|strong|\d)(?:[\s.:][^>]*)?>/gi, '')
      .replace(/<\d[\d:.,]*>/g, '')));
  }
  // Tekst z fragmentu XML/HTML: bez żadnych znaczników
  function cleanXmlText(s) {
    return tidyLines(decodeEntities(decodeEntities(String(s)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<(?:\w+:)?br\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ''))));
  }

  // Dekodowanie bajtów: UTF-8, UTF-16 z BOM, a przy błędzie strona kodowa z nagłówka lub typowa dla języka
  function legacyCharset() {
    const l = String((W.navigator && W.navigator.language) || '').slice(0, 2).toLowerCase();
    if (/^(pl|cs|sk|hu|hr|sl|ro|bs|sq)$/.test(l)) return 'windows-1250';
    if (/^(ru|uk|bg|sr|mk|be)$/.test(l)) return 'windows-1251';
    if (l === 'el') return 'windows-1253';
    if (l === 'tr') return 'windows-1254';
    return 'windows-1252';
  }
  function decodeWith(bytes, enc, fatal) {
    const d = new W.TextDecoder(enc, { fatal: !!fatal });
    return O.decode ? O.decode.call(d, bytes) : d.decode(bytes);
  }
  function smartDecode(bytes, ct) {
    if (!bytes || !bytes.length) return '';
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return decodeWith(bytes, 'utf-16le');
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return decodeWith(bytes, 'utf-16be');
    const n = Math.min(bytes.length, 3000); let nul = 0;
    for (let i = 0; i < n; i++) if (bytes[i] === 0) nul++;
    if (nul > n * 0.02) return null; // dane binarne
    try { return decodeWith(bytes, 'utf-8', true); } catch (e) {}
    const m = /charset=["']?([\w-]+)/i.exec(ct || '');
    const tries = [];
    if (m && !/utf-?8/i.test(m[1])) tries.push(m[1]);
    tries.push(legacyCharset(), 'windows-1252');
    for (let i = 0; i < tries.length; i++) { try { return decodeWith(bytes, tries[i]); } catch (e) {} }
    return decodeWith(bytes, 'utf-8');
  }

  /* ═══════════════ 3. ROZPOZNAWANIE ADRESÓW I TREŚCI ═══════════════ */

  const SUB_EXT = 'vtt|webvtt|srt|ttml2?|dfxp|sbv|ass|ssa|smi|sami|lrc|itt|stl|scc';
  const RX = {
    subExt: new RegExp('\\.(' + SUB_EXT + ')(?=$|[?#&/])', 'i'),
    subExtLoose: new RegExp('\\.(?:' + SUB_EXT + ')\\b', 'i'),
    endpoint: /(?:\/api\/timedtext\b|[\/_.-]timedtext(?:[\/?_.-]|$)|\/texttracks?\/[^?#]+|\/get_transcript\b|[?&](?:fmt|format|type|ext)=(?:vtt|webvtt|srt|srv[123]|json3|ttml|dfxp|sbv)(?:&|$))/i,
    ytTimed: /(?:youtube(?:-nocookie)?\.com|youtube\.googleapis\.com)\/api\/timedtext/i,
    manifest: /\.(m3u8|mpd)(?=$|[?#&])/i,
    keyword: /(subtitle|subtitulo|caption|timedtext|timed[_-]text|transcript|closed[_-]?caption|text[_-]?track|napisy|untertitel|sous[_-]?titre|[\/._-]subs?[\/._=-]|[?&]subs?=|[\/._-]cc[\/._=-]|whisper|transcri(?:be|ption)|speech[_-]?to[_-]?text|[\/._-](?:asr|stt)[\/._=-]|sapsan|legendas?|sottotitoli|ondertitel|altyaz|titulky|feliratok|subtitr|субтитр|字幕|자막)/i,
    notSub: /\.(m?js|css|png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot|mp3|m4a|aac|ogg|oga|opus|wav|flac|m4v|webm|mov|mkv|avi|ts|wasm|map|pdf|zip|gz)(?=$|[?#])/i,
    thumbs: /(thumb|storyboard|sprite|preview|scrub|tile|seek[_-]?bar|filmstrip|chapters?|heatmap)[^\/?#]*\.(?:vtt|webvtt|json)/i,
    badKind: /thumb|chapter|metadata|sprite|storyboard|preview/i,
    ctSub: /(text\/vtt|x-subrip|\/srt\b|ttml|dfxp|x-ssa|x-ass|x-sami|smptett)/i,
    ctManifest: /(mpegurl|dash\+xml)/i,
    ctMp4: /(video\/mp4|audio\/mp4|application\/mp4|octet-stream|binary|iso\.segment)/i,
    ctSkip: /^(image|font|audio|video)\/|text\/html|javascript|text\/css|wasm|pdf|zip/i,
    ctVideoSeg: /^(video\/(mp4|mp2t|webm|x-matroska|iso\.segment)|application\/(octet-stream|mp4|x-mpegurl-segment))/i,
    segUrl: /\.(ts|m4s|mp4|m4v|cmfv|fmp4|webm|mkv)(?=$|[?#])/i,
    jsonHint: /captionTracks|timedtext|transcriptSegmentRenderer|tStartMs|WEBVTT|"(?:subtitles?|subtitle_?urls?|captions?|closed_?captions?|text_?tracks?|texttracks|transcripts?|subs|cues|vtt|srt|cc)"\s*:|\.(?:vtt|srt|ttml|dfxp|webvtt)\b/i,
    cueA: /"(?:start|begin|startTime|start_time|from|startMs|offset)"\s*:/, cueB: /"(?:text|content|line|caption|sentence)"\s*:/, cueC: /"(?:end|endTime|end_time|to|dur|duration|endMs)"\s*:/,
    keyHint: /(subtitle|caption|text_?track|timedtext|transcript|closed_?caption|(?:^|\.)subs?(?:\.|$)|(?:^|\.)cc(?:\.|$)|vtt|srt)/i,
    streamHint: /caption|subtitle|transcri|timedtext|WEBVTT|"cues?"/i,
    volatile: /^(token|tok|sig|sign|signature|expires?|exp|st|hash|hmac|policy|key-pair-id|x-amz-.*|_|ts|cb|rnd|rand|nonce|auth|hdnts|hdnea|hdntl|verify|md5)$/i,
    capYes: /caption|subtitle|subtitulo|timedtext|timed-text|text-?track|\bcue\b|cue-|-cue|vtt|napisy|closed-?caption/i,
    capNo: /menu|button|btn|setting|toggle|icon|select|option|control|panel|dialog|modal|tooltip|popup|popover|list|item|label|input|search|badge|credit|image|img|photo|gallery|thumb|figure|heading|header|footer|nav|tab|link|switch|check|radio|slider/i
  };

  const LANG2 = new Set('aa ab af am ar as az be bg bn bo br bs ca cs cy da de el en eo es et eu fa fi fil fo fr ga gl gu he hi hr hu hy id is it iw ja jv ka kk km kn ko ku ky la lb lo lt lv mg mi mk ml mn mr ms mt my nb ne nl nn no pa pl ps pt ro ru sd si sk sl so sq sr sv sw ta te tg th tk tl tr uk ur uz vi xh yi zh zu'.split(' '));
  const LANG_KEY = new Set('en pl de fr es it pt ru uk cs sk hu ro bg hr sr sl nl sv da fi nb el tr ar ja ko zh vi th lt lv et ca'.split(' '));
  const LANG3 = dict({ eng: 'en', pol: 'pl', ger: 'de', deu: 'de', fre: 'fr', fra: 'fr', spa: 'es', ita: 'it', rus: 'ru', ukr: 'uk', cze: 'cs', ces: 'cs', slo: 'sk', slk: 'sk', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', por: 'pt', dut: 'nl', nld: 'nl', swe: 'sv', tur: 'tr', hun: 'hu', dan: 'da', fin: 'fi', nor: 'no', ara: 'ar' });
  function normLang(l) {
    l = String(l || '').trim().replace(/_/g, '-');
    if (!l || l.length > 12) return '';
    const p = l.split('-'); let a = p[0].toLowerCase();
    if (LANG3[a]) a = LANG3[a];
    return p[1] ? a + '-' + (p[1].length === 2 ? p[1].toUpperCase() : p[1]) : a;
  }
  const RX_LANG_Q = /[?&](?:tlang|lang|language|locale|srclang)=([a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{2,4})?)(?=&|$)/;
  const RX_LANG_F = new RegExp('[._\\-/]([a-zA-Z]{2,3}(?:[-_][A-Za-z]{2,4})?)\\.(?:' + SUB_EXT + ')(?=$|[?#])', 'i');
  const RX_LANG_P = /\/(?:subs?|subtitles?|captions?|cc|texttracks?)\/([a-z]{2,3}(?:-[A-Za-z]{2,4})?)(?=\/)/i;
  function langFromUrl(u) {
    const m = RX_LANG_Q.exec(u) || RX_LANG_F.exec(u) || RX_LANG_P.exec(u);
    if (!m) return '';
    const a = m[1].split(/[-_]/)[0].toLowerCase();
    return (LANG2.has(a) || LANG3[a]) ? normLang(m[1]) : '';
  }
  function prefLangs() {
    let l = Array.isArray(CFG.preferredLangs) && CFG.preferredLangs.length ? CFG.preferredLangs : ((W.navigator && (W.navigator.languages || [W.navigator.language])) || []);
    const out = [];
    for (let i = 0; i < l.length; i++) { const a = String(l[i] || '').slice(0, 2).toLowerCase(); if (a && out.indexOf(a) === -1) out.push(a); }
    return out;
  }
  function extOf(u) {
    const m = RX.subExt.exec(u);
    if (m) return m[1].toLowerCase().replace('webvtt', 'vtt');
    if (RX.ytTimed.test(u)) return 'yt';
    if (/\.m3u8(?=$|[?#&])/i.test(u)) return 'hls';
    return '';
  }
  function looksLikeUrl(s) {
    if (s.length < 5 || s.length > 4000 || /\s/.test(s.slice(0, 200))) return false;
    return /^(?:https?:)?\/\/[^\s"'<>]+$/i.test(s) || /^\/[^\s"'<>/][^\s"'<>]*$/.test(s) || /^blob:|^data:text\//i.test(s) ||
      (/^[\w.\-~%/]+(?:\?[^\s"'<>]*)?$/.test(s) && RX.subExt.test(s));
  }

  // Rozpoznanie formatu po treści (pierwsze kilka kB)
  function sniffFormat(t) {
    if (!t || t.length < 8) return '';
    const s = t.slice(0, 4000).replace(/^\uFEFF/, '').replace(/\r/g, '');
    const h = s.replace(/^\s+/, '');
    if (/^WEBVTT(?:[ \t\n]|$)/.test(h)) return 'vtt';
    if (/^#EXTM3U/.test(h)) return 'm3u8';
    if (/^Scenarist_SCC/i.test(h)) return 'scc';
    if (/^\[Script Info\]/i.test(h) || /^\[V4\+? Styles\]/im.test(s)) return 'ass';
    const c = h.charAt(0);
    if (c === '{' || c === '[') {
      if (c === '[' && /^\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/.test(h) && (h.match(/^\[\d{1,3}:\d{2}/gm) || []).length >= 3) return 'lrc';
      return 'json';
    }
    if (c === '<') {
      if (/<MPD[\s>]/.test(s)) return 'mpd';
      if (/<(?:\w+:)?tt[\s>]/.test(s)) return 'ttml';
      if (/<SAMI[\s>]/i.test(s)) return 'sami';
      if (/<(?:text|p|caption|subtitle|cue|line)\b[^>]*\s(?:start|begin|t)="[^"]+"/.test(s)) return 'xml';
      return '';
    }
    if (/(?:^|\n)[ \t]*(?:\d+[ \t]*\n[ \t]*)?(?:\d{1,3}:)?\d{1,2}:\d{2}[,.]\d{1,3}[ \t]*-->[ \t]*(?:\d{1,3}:)?\d{1,2}:\d{2}[,.]\d{1,3}/.test(s)) return 'srt';
    if (/(?:^|\n)\d{1,2}:\d{2}:\d{2}\.\d{1,3},\d{1,2}:\d{2}:\d{2}\.\d{1,3}[ \t]*\n/.test(s)) return 'sbv';
    return '';
  }

  /* ═══════════════ 4. PARSERY I KONWERTERY ═══════════════ */

  function parseClock(s) {
    if (s == null) return NaN;
    if (typeof s === 'number') return s;
    s = String(s).trim();
    let m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,6}))?$/.exec(s);
    if (m) return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (m[4] ? parseFloat('0.' + m[4]) : 0);
    m = /^(\d+):(\d{2}):(\d{2})[:;](\d{1,3})$/.exec(s); // klatki
    if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3] + (+m[4]) / (m[4].length === 3 ? 1000 : 30);
    m = /^(-?[\d.]+)\s*(h|ms|m|s)?$/.exec(s);
    if (m) { const v = parseFloat(m[1]); return m[2] === 'h' ? v * 3600 : m[2] === 'm' ? v * 60 : m[2] === 'ms' ? v / 1000 : v; }
    return NaN;
  }

  // WebVTT i SubRip (ten sam parser; obsługuje też X-TIMESTAMP-MAP z segmentów HLS)
  function parseVTT(text) {
    const cues = []; let tsMap = null;
    const lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    const TIME = /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^X-TIMESTAMP-MAP=/i.test(line)) {
        const a = /MPEGTS:(\d+)/i.exec(line), b = /LOCAL:([\d:.]+)/i.exec(line);
        if (a) tsMap = { mpegts: +a[1], local: b ? parseClock(b[1]) || 0 : 0 };
        i++; continue;
      }
      if (/^(NOTE|STYLE|REGION)\b/.test(line)) { while (i < lines.length && lines[i].trim() !== '') i++; continue; }
      const m = TIME.exec(line);
      if (!m) { i++; continue; }
      const buf = []; i++;
      while (i < lines.length && lines[i].trim() !== '' && !TIME.test(lines[i])) { buf.push(lines[i]); i++; }
      if (i < lines.length && TIME.test(lines[i]) && buf.length && /^\d+$/.test(buf[buf.length - 1].trim())) buf.pop(); // numer następnej kwestii bez pustej linii
      const txt = cleanCueText(buf.join('\n'));
      if (txt) cues.push({ start: parseClock(m[1]), end: parseClock(m[2]), text: txt });
    }
    return { cues: cues, tsMap: tsMap };
  }

  function xmlAttr(s, name) {
    const m = new RegExp('(?:^|\\s)(?:[\\w-]+:)?' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i').exec(s);
    return m ? (m[1] != null ? m[1] : m[2]) : null;
  }
  function ttmlTime(s, fr, tr, sub) {
    if (s == null) return NaN;
    s = String(s).trim(); let m;
    if ((m = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(s))) return +m[1] * 3600 + +m[2] * 60 + +m[3] + (m[4] ? parseFloat('0.' + m[4]) : 0);
    if ((m = /^(\d+):(\d{2}):(\d{2}):(\d+)(?:\.(\d+))?$/.exec(s))) return +m[1] * 3600 + +m[2] * 60 + +m[3] + ((+m[4]) + (m[5] ? (+m[5]) / (sub || 1) : 0)) / fr;
    if ((m = /^([\d.]+)(h|ms|m|s|f|t)$/.exec(s))) { const v = parseFloat(m[1]); switch (m[2]) { case 'h': return v * 3600; case 'm': return v * 60; case 's': return v; case 'ms': return v / 1000; case 'f': return v / fr; default: return v / tr; } }
    const v = parseFloat(s); return isNaN(v) ? NaN : v;
  }
  // TTML / TTML2 / DFXP / IMSC / iTT (bez DOMParsera — działa także na stronach z Trusted Types).
  // Czas kwestii jest liczony względem kontenerów <body> i <div> (dziedziczą begin), obsługiwane są: ticki, klatki
  // (z frameRateMultiplier i subFrameRate), offsety (1.5s) oraz kwestie bez własnego begin w kontenerze z begin/end.
  function parseTTML(xml) {
    const cues = [];
    const root = /<(?:\w+:)?tt\b([^>]*)>/.exec(xml); const ra = root ? root[1] : '';
    const mul = (xmlAttr(ra, 'frameRateMultiplier') || '').trim().split(/\s+/).map(parseFloat);
    const fr = (parseFloat(xmlAttr(ra, 'frameRate')) || 30) * (mul.length === 2 && mul[0] > 0 && mul[1] > 0 ? mul[0] / mul[1] : 1);
    const sub = parseFloat(xmlAttr(ra, 'subFrameRate')) || 1;
    const tr = parseFloat(xmlAttr(ra, 'tickRate')) || 10000000;
    const stack = [{ off: 0, end: Infinity, hasBegin: false }];
    const re = /<(\/?)(?:\w+:)?(body|div|p)\b((?:[^>\/]|\/(?!>))*)(\/?)>/g; let m;
    while ((m = re.exec(xml))) {
      const closing = m[1] === '/', name = m[2], attrs = m[3], self = m[4] === '/';
      const par = stack[stack.length - 1];
      if (name !== 'p') {
        if (closing) { if (stack.length > 1) stack.pop(); continue; }
        if (self) continue;
        const b = ttmlTime(xmlAttr(attrs, 'begin'), fr, tr, sub), e = ttmlTime(xmlAttr(attrs, 'end'), fr, tr, sub);
        stack.push({ off: par.off + (isNaN(b) ? 0 : b), end: isNaN(e) ? par.end : par.off + e, hasBegin: par.hasBegin || !isNaN(b) });
        continue;
      }
      if (closing || self) continue;
      const close = /<\/(?:\w+:)?p>/g; close.lastIndex = re.lastIndex; const cm = close.exec(xml); if (!cm) break;
      const inner = xml.slice(re.lastIndex, cm.index); re.lastIndex = close.lastIndex;
      let b = ttmlTime(xmlAttr(attrs, 'begin'), fr, tr, sub); const e = ttmlTime(xmlAttr(attrs, 'end'), fr, tr, sub), dur = ttmlTime(xmlAttr(attrs, 'dur'), fr, tr, sub);
      if (isNaN(b)) { if (!par.hasBegin) continue; b = 0; }
      const start = par.off + b;
      let end = !isNaN(e) ? par.off + e : (!isNaN(dur) ? start + dur : NaN);
      if (isNaN(end) && isFinite(par.end)) end = par.end;
      const text = cleanXmlText(inner);
      if (text && !isNaN(start)) cues.push({ start: start, end: end, text: text });
    }
    return cues;
  }
  // XML z atrybutami czasu: YouTube srv1 (<text start dur>), srv3 (<p t d>) i podobne
  function parseXmlTimed(xml) {
    const cues = [];
    const re = /<(text|p|caption|subtitle|cue|line)\b((?:[^>\/]|\/(?!>))*)>([\s\S]*?)<\/\1>/g; let m;
    while ((m = re.exec(xml))) {
      const a = m[2]; let start, end = NaN;
      const t = xmlAttr(a, 't'), d = xmlAttr(a, 'd');
      if (t != null && /^\d+$/.test(t)) { start = +t / 1000; if (d != null) end = start + (+d) / 1000; }
      else {
        start = parseClock(xmlAttr(a, 'start') || xmlAttr(a, 'begin'));
        const e = xmlAttr(a, 'end'), du = xmlAttr(a, 'dur') || xmlAttr(a, 'duration');
        if (e != null) end = parseClock(e); else if (du != null) end = start + parseClock(du);
      }
      const text = cleanXmlText(m[3]);
      if (text && !isNaN(start)) cues.push({ start: start, end: end, text: text });
    }
    return cues;
  }
  function parseSBV(text) {
    const cues = [];
    for (const b of text.replace(/\r/g, '').split(/\n\s*\n/)) {
      const ls = b.replace(/^\n+/, '').split('\n');
      const m = /^\s*(\d+:\d{2}:\d{2}\.\d{1,3}),(\d+:\d{2}:\d{2}\.\d{1,3})\s*$/.exec(ls[0] || '');
      if (!m) continue;
      const t = cleanCueText(ls.slice(1).join('\n'));
      if (t) cues.push({ start: parseClock(m[1]), end: parseClock(m[2]), text: t });
    }
    return cues;
  }
  function parseASS(text) {
    const cues = []; let fmt = null;
    for (const line of text.replace(/\r/g, '').split('\n')) {
      if (/^Format:/i.test(line) && /Text/i.test(line)) fmt = line.slice(7).split(',').map(function (s) { return s.trim().toLowerCase(); });
      else if (/^Dialogue:/i.test(line)) {
        const f = fmt || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
        const parts = line.slice(9).split(','); const n = f.length;
        const vals = parts.slice(0, n - 1); vals.push(parts.slice(n - 1).join(','));
        const g = function (k) { const i = f.indexOf(k); return i >= 0 ? (vals[i] || '').trim() : ''; };
        const t = cleanCueText(g('text').replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').replace(/\\h/g, ' '));
        const s = parseClock(g('start'));
        if (t && !isNaN(s)) cues.push({ start: s, end: parseClock(g('end')), text: t });
      }
    }
    return cues;
  }
  function parseLRC(text) {
    const rows = [];
    for (const line of text.replace(/\r/g, '').split('\n')) {
      const tags = line.match(/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g); if (!tags) continue;
      const t = cleanCueText(line.replace(/\[[^\]]*\]/g, '')); if (!t) continue;
      for (const tg of tags) { const m = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/.exec(tg); rows.push({ start: +m[1] * 60 + +m[2] + (m[3] ? parseFloat('0.' + m[3]) : 0), text: t }); }
    }
    rows.sort(function (a, b) { return a.start - b.start; });
    return rows.map(function (r, i) { return { start: r.start, end: i + 1 < rows.length ? Math.min(rows[i + 1].start, r.start + 10) : r.start + 4, text: r.text }; });
  }
  // SAMI (.smi): kilka języków w jednym pliku (<P Class=...>) — każdy język to osobna lista kwestii
  function parseSAMIAll(text) {
    const css = Object.create(null); const st = /<STYLE[^>]*>([\s\S]*?)<\/STYLE>/i.exec(text);
    if (st) { const re = /\.([\w-]+)\s*\{([^}]*)\}/g; let q; while ((q = re.exec(st[1]))) { const lg = /lang\s*:\s*([A-Za-z-]+)/i.exec(q[2]); const nm = /Name\s*:\s*([^;]+)/i.exec(q[2]); css[q[1].toLowerCase()] = { lang: lg ? lg[1] : '', name: nm ? nm[1].trim() : '' }; } }
    const by = Object.create(null); const order = []; const reS = /<SYNC[^>]*\bStart\s*=\s*["']?(\d+)[^>]*>([\s\S]*?)(?=<SYNC|<\/BODY|$)/gi; let m;
    while ((m = reS.exec(text))) {
      const t = +m[1] / 1000; const reP = /<P\b([^>]*)>([\s\S]*?)(?=<P\b|$)/gi; let p, any = false;
      while ((p = reP.exec(m[2]))) {
        any = true; const cl = (/Class\s*=\s*["']?([\w-]+)/i.exec(p[1]) || [])[1] || '_'; const key = cl.toLowerCase();
        if (!by[key]) { by[key] = { cls: cl, rows: [] }; order.push(key); }
        by[key].rows.push({ start: t, text: cleanXmlText(p[2]) });
      }
      if (!any) { if (!by._) { by._ = { cls: '_', rows: [] }; order.push('_'); } by._.rows.push({ start: t, text: cleanXmlText(m[2]) }); }
    }
    return order.map(function (k) {
      const rows = by[k].rows, cues = [];
      for (let i = 0; i < rows.length; i++) if (rows[i].text) cues.push({ start: rows[i].start, end: i + 1 < rows.length ? rows[i + 1].start : rows[i].start + 4, text: rows[i].text });
      const meta = css[k] || {}; let lang = meta.lang ? normLang(meta.lang) : '';
      if (!lang) { const a = k.slice(0, 2); if (LANG2.has(a)) lang = a; }
      return { cls: by[k].cls, lang: lang, label: meta.name || (by[k].cls !== '_' ? by[k].cls : ''), cues: cues };
    }).filter(function (v) { return v.cues.length; });
  }
  function parseSAMI(text) { const all = parseSAMIAll(text); return all.length ? all[0].cues : []; }

  /* ═══ 4b. NAPISY ZAMKNIĘTE CEA-608 / CEA-708 (SCC, SEI w wideo, ścieżki c608/c708), EBU STL, MATROSKA ═══ */

  // Śledzi „życie\" wierszy na ekranie: wiersz pojawia się, ewentualnie rośnie (pisany znak po znaku) i znika.
  // Wiersze otwarte i zamknięte w tej samej chwili tworzą jedną kwestię (pop-on), a przewijane (roll-up) — osobne.
  function createLineTracker() {
    const open = []; const out = [];
    function snap(t, lines, grow) {
      const used = {}; const next = [];
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i]; let k = -1;
        for (let j = 0; j < open.length; j++) {
          if (used[j]) continue; const o = open[j];
          if (o.text === ln || (grow && ln.length > o.text.length && ln.indexOf(o.text) === 0)) { k = j; break; }
        }
        if (k >= 0) { used[k] = true; open[k].text = ln; open[k].pos = i; next.push(open[k]); }
        else next.push({ text: ln, start: t, pos: i });
      }
      for (let j = 0; j < open.length; j++) if (!used[j] && out.length < 40000) out.push({ start: open[j].start, end: Math.max(t, open[j].start + 0.2), text: open[j].text, pos: open[j].pos });
      open.length = 0; for (let i = 0; i < next.length; i++) open.push(next[i]);
    }
    function cues(tEnd) { // bez zmiany stanu — można wołać w trakcie strumienia
      const all = out.slice();
      for (let j = 0; j < open.length; j++) all.push({ start: open[j].start, end: Math.max(tEnd == null ? 0 : tEnd, open[j].start + 1), text: open[j].text, pos: open[j].pos });
      all.sort(function (a, b) { return a.start - b.start || a.pos - b.pos; });
      const res = [];
      for (let i = 0; i < all.length; i++) {
        const c = all[i], p = res[res.length - 1];
        if (p && Math.abs(p.start - c.start) < 0.001 && Math.abs(p.end - c.end) < 0.001) p.text += '\n' + c.text;
        else res.push({ start: c.start, end: c.end, text: c.text });
      }
      return res;
    }
    return { snap: snap, cues: cues, count: function () { return out.length + open.length; } };
  }

  // ── CEA-608 ──
  const C608_BASIC = (function () {
    const t = {}; for (let c = 0x20; c < 0x80; c++) t[c] = String.fromCharCode(c);
    t[0x2A] = 'á'; t[0x5C] = 'é'; t[0x5E] = 'í'; t[0x5F] = 'ó'; t[0x60] = 'ú'; t[0x7B] = 'ç'; t[0x7C] = '÷'; t[0x7D] = 'Ñ'; t[0x7E] = 'ñ'; t[0x7F] = '█';
    return t;
  })();
  const C608_SPECIAL = ['®', '°', '½', '¿', '™', '¢', '£', '♪', 'à', ' ', 'è', 'â', 'ê', 'î', 'ô', 'û'];
  const C608_EXT1 = ['Á', 'É', 'Ó', 'Ú', 'Ü', 'ü', '‘', '¡', '*', '’', '—', '©', '℠', '•', '“', '”', 'À', 'Â', 'Ç', 'È', 'Ê', 'Ë', 'ë', 'Î', 'Ï', 'ï', 'Ô', 'Ù', 'ù', 'Û', '«', '»'];
  const C608_EXT2 = ['Ã', 'ã', 'Í', 'Ì', 'ì', 'Ò', 'ò', 'Õ', 'õ', '{', '}', '\\', '^', '_', '|', '~', 'Ä', 'ä', 'Ö', 'ö', 'ß', '¥', '¤', '│', 'Å', 'å', 'Ø', 'ø', '┌', '┐', '└', '┘'];
  const C608_ROW = { 0x10: [11, 11], 0x11: [1, 2], 0x12: [3, 4], 0x13: [12, 13], 0x14: [14, 15], 0x15: [5, 6], 0x16: [7, 8], 0x17: [9, 10] };

  function createCea608() {
    const blank = function () { const r = []; for (let i = 0; i < 15; i++) r.push(new Array(32)); return r; };
    const lines = function (scr) {
      const out = [];
      for (let r = 0; r < 15; r++) { let s = ''; const row = scr[r]; for (let c = 0; c < 32; c++) s += row[c] || ' '; s = s.replace(/\s+/g, ' ').trim(); if (s) out.push(s); }
      return out;
    };
    const mk = function () { return { mode: 'pop', roll: 2, base: 14, row: 14, col: 0, disp: blank(), non: blank(), text: false, tr: createLineTracker(), t: 0, chars: 0 }; };
    const ch = [mk(), mk()]; let cur = 0, l1 = -1, l2 = -1, any = false;
    const snap = function (c, grow) { c.tr.snap(c.t, lines(c.disp), grow); };
    const putc = function (c, chr) {
      const scr = c.mode === 'pop' ? c.non : c.disp;
      if (c.col > 31) c.col = 31;
      scr[c.row][c.col++] = chr; c.chars++;
      if (scr === c.disp) snap(c, true);
    };
    const back = function (c) { if (c.col > 0) { c.col--; (c.mode === 'pop' ? c.non : c.disp)[c.row][c.col] = undefined; if (c.mode !== 'pop') snap(c, false); } };
    function misc(c, b2) {
      switch (b2) {
        case 0x20: c.mode = 'pop'; c.text = false; break;                       // RCL
        case 0x21: back(c); break;                                              // BS
        case 0x24: { const scr = c.mode === 'pop' ? c.non : c.disp; for (let i = c.col; i < 32; i++) scr[c.row][i] = undefined; if (scr === c.disp) snap(c, false); break; } // DER
        case 0x25: case 0x26: case 0x27: {                                      // RU2–RU4
          c.text = false;
          if (c.mode !== 'roll') { c.disp = blank(); c.non = blank(); snap(c, false); }
          c.mode = 'roll'; c.roll = b2 - 0x23; if (c.base < c.roll - 1) c.base = c.roll - 1; c.row = c.base; c.col = 0; break;
        }
        case 0x28: putc(c, ' '); break;                                          // FON
        case 0x29: c.mode = 'paint'; c.text = false; break;                      // RDC
        case 0x2A: case 0x2B: c.text = true; break;                              // TR, RTD (tryb tekstowy — pomijamy)
        case 0x2C: c.disp = blank(); snap(c, false); break;                      // EDM
        case 0x2D:                                                              // CR
          if (c.mode === 'roll') {
            const top = Math.max(0, c.base - c.roll + 1);
            for (let r = top; r < c.base; r++) c.disp[r] = c.disp[r + 1];
            c.disp[c.base] = new Array(32); for (let r = 0; r < top; r++) c.disp[r] = new Array(32);
            c.col = 0; snap(c, false);
          } else { c.row = Math.min(14, c.row + 1); c.col = 0; }
          break;
        case 0x2E: c.non = blank(); break;                                       // ENM
        case 0x2F: { const x = c.disp; c.disp = c.non; c.non = x; c.mode = 'pop'; snap(c, false); break; } // EOC
      }
    }
    function feed(b1, b2, t) {
      b1 &= 0x7F; b2 &= 0x7F;
      if (b1 === 0 && b2 === 0) return;
      any = true;
      if (b1 >= 0x10 && b1 <= 0x1F) {
        if (b1 === l1 && b2 === l2) { l1 = l2 = -1; return; } // kody sterujące nadawane są dwukrotnie
        l1 = b1; l2 = b2;
      } else { l1 = l2 = -1; }
      if (b1 < 0x10) return;
      if (b1 <= 0x1F) {
        if (b2 < 0x20) return;
        cur = (b1 & 0x08) ? 1 : 0; const c = ch[cur]; c.t = t; const c1 = b1 & 0xF7;
        if (b2 >= 0x40) { // PAC
          const row = C608_ROW[c1][b2 >= 0x60 ? 1 : 0] - 1;
          if (c.mode === 'roll') { c.base = Math.max(row, c.roll - 1); c.row = c.base; } else c.row = row;
          c.col = (b2 & 0x10) ? ((b2 & 0x0E) >> 1) * 4 : 0;
          return;
        }
        if (c1 === 0x11) { if (!c.text) putc(c, b2 < 0x30 ? ' ' : C608_SPECIAL[b2 - 0x30]); return; }
        if (c1 === 0x12 && b2 >= 0x20) { if (!c.text) { back(c); putc(c, C608_EXT1[b2 - 0x20]); } return; }
        if (c1 === 0x13 && b2 >= 0x20) { if (!c.text) { back(c); putc(c, C608_EXT2[b2 - 0x20]); } return; }
        if ((c1 === 0x14 || c1 === 0x15) && b2 < 0x30) { misc(c, b2); return; }
        if (c1 === 0x17 && b2 >= 0x21 && b2 <= 0x23) { c.col = Math.min(31, c.col + (b2 - 0x20)); return; }
        return;
      }
      const c = ch[cur]; c.t = t;
      if (c.text) return;
      putc(c, C608_BASIC[b1]); if (b2 >= 0x20) putc(c, C608_BASIC[b2]);
    }
    return {
      feed: feed, seen: function () { return any; },
      tracks: function (tEnd) { const r = []; for (let i = 0; i < 2; i++) if (ch[i].tr.count()) r.push({ index: i, cues: ch[i].tr.cues(tEnd) }); return r; }
    };
  }

  // ── CEA-708 (DTVCC) — sam tekst usług 1–6, bez układu graficznego ──
  function createDtvcc() {
    const svc = {}; let pkt = null;
    const G2 = { 0x25: '…', 0x2A: 'Š', 0x2C: 'Œ', 0x30: '█', 0x31: '‘', 0x32: '’', 0x33: '“', 0x34: '”', 0x35: '•', 0x39: '™', 0x3A: 'š', 0x3C: 'œ', 0x3D: '℠', 0x3F: 'Ÿ', 0x76: '⅛', 0x77: '⅜', 0x78: '⅝', 0x79: '⅞' };
    function svcState(n) {
      return svc[n] || (svc[n] = { win: [], cur: 0, tr: createLineTracker(), typed: false, chars: 0 });
    }
    function newWin(vis, rows, cols) { return { vis: vis, rows: rows, cols: cols, text: [], pr: 0, pc: 0 }; }
    function winLines(s) {
      const out = [];
      for (let i = 0; i < 8; i++) { const w = s.win[i]; if (!w || !w.vis) continue; for (let r = 0; r < w.text.length; r++) { const row = w.text[r]; if (!row) continue; let t = ''; for (let c = 0; c < row.length; c++) t += row[c] || ' '; t = t.replace(/\s+/g, ' ').trim(); if (t) out.push(t); } }
      return out;
    }
    function put(s, ch) {
      const w = s.win[s.cur]; if (!w) return;
      if (w.pr >= w.rows) { w.text.shift(); w.text.push(null); w.pr = w.rows - 1; }
      while (w.text.length <= w.pr) w.text.push(null);
      const row = w.text[w.pr] || (w.text[w.pr] = []);
      row[w.pc++] = ch; s.chars++; if (w.vis) s.typed = true;
    }
    function cr(s) { const w = s.win[s.cur]; if (!w) return; w.pr++; w.pc = 0; if (w.pr >= w.rows) { w.text.shift(); w.pr = w.rows - 1; while (w.text.length < w.rows) w.text.push(null); } }
    function decode(n, d, t) {
      const s = svcState(n); let i = 0;
      const mask = function (b, fn) { for (let k = 0; k < 8; k++) if (b & (1 << k)) fn(k); };
      while (i < d.length) {
        const b = d[i++];
        if (b <= 0x1F) {
          if (b === 0x0D) cr(s);
          else if (b === 0x0C) { const w = s.win[s.cur]; if (w) { w.text = []; w.pr = w.pc = 0; } }
          else if (b === 0x0E) { const w = s.win[s.cur]; if (w) { w.text[w.pr] = null; w.pc = 0; } }
          else if (b === 0x08) { const w = s.win[s.cur]; if (w && w.pc > 0) { w.pc--; if (w.text[w.pr]) w.text[w.pr][w.pc] = undefined; } }
          else if (b === 0x10) { const e = d[i++]; if (e >= 0x20 && e <= 0x7F) put(s, G2[e] || ''); else if (e >= 0x80 && e <= 0x9F) i += 4; else if (e >= 0xA0) i += 0; }
          else if (b >= 0x11 && b <= 0x17) i += 1;
          else if (b >= 0x18 && b <= 0x1F) i += 2;
        } else if (b <= 0x7F) { put(s, b === 0x7F ? '♪' : String.fromCharCode(b)); }
        else if (b <= 0x9F) {
          if (b <= 0x87) s.cur = b - 0x80;
          else if (b === 0x88) { const m = d[i++]; mask(m, function (k) { const w = s.win[k]; if (w) { w.text = []; w.pr = w.pc = 0; } }); }
          else if (b === 0x89) { const m = d[i++]; mask(m, function (k) { if (s.win[k]) s.win[k].vis = true; }); }
          else if (b === 0x8A) { const m = d[i++]; mask(m, function (k) { if (s.win[k]) s.win[k].vis = false; }); }
          else if (b === 0x8B) { const m = d[i++]; mask(m, function (k) { if (s.win[k]) s.win[k].vis = !s.win[k].vis; }); }
          else if (b === 0x8C) { const m = d[i++]; mask(m, function (k) { s.win[k] = null; }); }
          else if (b === 0x8D) i += 1;
          else if (b === 0x8F) { s.win = []; s.cur = 0; }
          else if (b === 0x90) i += 2;
          else if (b === 0x91) i += 3;
          else if (b === 0x92) { const r = d[i] & 0x0F, c = d[i + 1] & 0x3F; i += 2; const w = s.win[s.cur]; if (w) { w.pr = Math.min(r, w.rows - 1); w.pc = c; } }
          else if (b === 0x97) i += 4;
          else if (b >= 0x98) {
            const id = b - 0x98, p = d.slice(i, i + 6); i += 6; if (p.length < 6) break;
            const vis = !!(p[0] & 0x20), rows = (p[3] & 0x0F) + 1, cols = (p[4] & 0x3F) + 1;
            if (s.win[id]) { s.win[id].vis = vis; s.win[id].rows = rows; s.win[id].cols = cols; } else s.win[id] = newWin(vis, rows, cols);
            s.cur = id;
          }
        } else { put(s, String.fromCharCode(b)); } // G1: Latin-1
      }
      s.tr.snap(t, winLines(s), s.typed); s.typed = false;
    }
    function packet(t) {
      if (!pkt) return; const b = pkt.bytes.slice(0, pkt.size); pkt = null; let i = 0;
      while (i < b.length) {
        const h = b[i++]; if (h === 0) break;
        let n = h >> 5; const sz = h & 0x1F;
        if (n === 7) { if (i >= b.length) break; n = b[i++] & 0x3F; }
        if (n >= 1 && n <= 6) decode(n, b.slice(i, i + sz), t);
        i += sz;
      }
    }
    function feed(type, b1, b2, t) {
      if (type === 3) {
        if (pkt) packet(pkt.t);
        const code = b1 & 0x3F; pkt = { t: t, bytes: [b2], size: code ? code * 2 - 1 : 127 };
      } else if (type === 2 && pkt) { pkt.bytes.push(b1, b2); }
      if (pkt && pkt.bytes.length >= pkt.size) packet(pkt.t);
    }
    return {
      feed: feed, seen: function () { for (const k in svc) if (svc[k].chars) return true; return false; },
      tracks: function (tEnd) { const r = []; for (const k in svc) if (svc[k].tr.count()) r.push({ index: +k, cues: svc[k].tr.cues(tEnd) }); return r; }
    };
  }

  // Zbiera pary bajtów cc_data (z SEI, MPEG-2 user data, AV1 T.35, ścieżek c608/c708) i podaje je dekoderom w kolejności prezentacji
  function createCcSink() {
    const f1 = createCea608(), f2 = createCea608(), dt = createDtvcc(); const ev = []; let seq = 0, lastT = 0;
    function triplets(buf, p, count, end, t) {
      let n = 0;
      for (let k = 0; k < count && p + 3 <= end; k++, p += 3) {
        const b = buf[p]; if (!(b & 0x04)) continue; // cc_valid
        const type = b & 3, d1 = buf[p + 1], d2 = buf[p + 2];
        if (type < 2 && (d1 & 0x7F) === 0 && (d2 & 0x7F) === 0) continue;
        ev.push({ t: t + k * 1e-4, s: seq++, type: type, d1: d1, d2: d2 }); n++;
      }
      if (t > lastT) lastT = t;
      return n;
    }
    // cc_data() z ATSC A/53: flagi+licznik, em_data, trójki
    function ccData(buf, p, end, t) {
      if (p + 2 > end) return 0; const fl = buf[p]; if (!(fl & 0x40)) return 0;
      return triplets(buf, p + 2, fl & 0x1F, end, t);
    }
    // Zawartość ITU-T T.35 z podpisem GA94 (SEI, MPEG-2 user data, AV1 metadata)
    function t35(buf, p, end, t) {
      if (p + 8 <= end && buf[p] === 0xB5 && buf[p + 1] === 0x00 && buf[p + 2] === 0x31 && buf[p + 3] === 0x47 && buf[p + 4] === 0x41 && buf[p + 5] === 0x39 && buf[p + 6] === 0x34 && buf[p + 7] === 0x03) return ccData(buf, p + 8, end, t);
      return 0;
    }
    function flush() {
      if (!ev.length) return;
      ev.sort(function (a, b) { return a.t - b.t || a.s - b.s; });
      for (let i = 0; i < ev.length; i++) { const e = ev[i]; if (e.type === 0) f1.feed(e.d1, e.d2, e.t); else if (e.type === 1) f2.feed(e.d1, e.d2, e.t); else dt.feed(e.type, e.d1, e.d2, e.t); }
      ev.length = 0;
    }
    function result() {
      flush(); const out = [];
      f1.tracks(lastT).forEach(function (x) { out.push({ id: 'CC' + (x.index + 1), kind: 'cea608', cues: x.cues }); });
      f2.tracks(lastT).forEach(function (x) { out.push({ id: 'CC' + (x.index + 3), kind: 'cea608', cues: x.cues }); });
      dt.tracks(lastT).forEach(function (x) { out.push({ id: 'S' + x.index, kind: 'cea708', cues: x.cues }); });
      return out;
    }
    function pair(type, d1, d2, t) {
      if (type < 2 && (d1 & 0x7F) === 0 && (d2 & 0x7F) === 0) return;
      ev.push({ t: t, s: seq++, type: type, d1: d1, d2: d2 }); if (t > lastT) lastT = t;
    }
    return { pair: pair, triplets: triplets, ccData: ccData, t35: t35, flush: flush, result: result, pending: function () { return ev.length; }, seen: function () { return f1.seen() || f2.seen() || dt.seen() || ev.length > 0; } };
  }

  // Przekształca RBSP: usuwa bajty zapobiegające emulacji kodu startowego (00 00 03)
  function unescapeRbsp(u8, s, e) {
    const out = new Uint8Array(e - s); let n = 0, z = 0;
    for (let i = s; i < e; i++) { const b = u8[i]; if (z >= 2 && b === 3) { z = 0; continue; } out[n++] = b; z = b === 0 ? z + 1 : 0; }
    return out.subarray(0, n);
  }
  // Komunikaty SEI: typ 4 = user_data_registered_itu_t_t35
  function seiScan(rbsp, sink, t) {
    let p = 0, n = 0;
    while (p + 2 < rbsp.length) {
      let pt = 0; while (p < rbsp.length && rbsp[p] === 0xFF) { pt += 255; p++; } pt += rbsp[p++] || 0;
      let ps = 0; while (p < rbsp.length && rbsp[p] === 0xFF) { ps += 255; p++; } ps += rbsp[p++] || 0;
      if (p + ps > rbsp.length) break;
      if (pt === 4) n += sink.t35(rbsp, p, p + ps, t);
      p += ps;
      if (rbsp[p] === 0x80 && p === rbsp.length - 1) break;
    }
    return n;
  }
  // Próbki z długością NAL (AVCC/HVCC w MP4)
  function nalSamples(u8, s, e, nalLen, codec, sink, t) {
    let p = s, n = 0, guardN = 0;
    while (p + nalLen < e && guardN++ < 400) {
      let len = 0; for (let i = 0; i < nalLen; i++) len = len * 256 + u8[p + i];
      const ns = p + nalLen; if (len <= 0 || ns + len > e) break;
      const h = u8[ns];
      if (codec === 'hevc') { const ty = (h >> 1) & 0x3F; if (ty === 39 || ty === 40) n += seiScan(unescapeRbsp(u8, ns + 2, ns + len), sink, t); }
      else if ((h & 0x1F) === 6) n += seiScan(unescapeRbsp(u8, ns + 1, ns + len), sink, t);
      p = ns + len;
    }
    return n;
  }
  // Próbki AV1 (ciąg OBU z polem rozmiaru): metadata (5) → ITU-T T.35 (4)
  function av1Samples(u8, s, e, sink, t) {
    let p = s, n = 0, guardN = 0;
    while (p < e && guardN++ < 200) {
      const h = u8[p++]; const ty = (h >> 3) & 15, ext = (h >> 2) & 1, hasSize = (h >> 1) & 1; if (ext) p++;
      let size = e - p;
      if (hasSize) { size = 0; let sh = 0, b; do { b = u8[p++]; size += (b & 0x7F) * Math.pow(2, sh); sh += 7; } while ((b & 0x80) && sh < 35 && p < e); }
      if (size < 0 || p + size > e) break;
      if (ty === 5) { let q = p, mt = 0, sh = 0, b; do { b = u8[q++]; mt += (b & 0x7F) * Math.pow(2, sh); sh += 7; } while ((b & 0x80) && q < p + size); if (mt === 4) n += sink.t35(u8, q, p + size, t); }
      p += size;
    }
    return n;
  }
  // Strumień Annex B (MPEG-TS, surowy .h264/.h265, MPEG-2)
  function annexBScan(u8, vtype, sink, t) {
    const e = u8.length; let n = 0, i = 0;
    const starts = [];
    while (i + 3 < e) {
      if (u8[i + 2] > 1) { i += 3; continue; }
      if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1) { starts.push(i + 3); i += 3; } else i++;
      if (starts.length > 6000) break;
    }
    for (let k = 0; k < starts.length; k++) {
      let s = starts[k], en = k + 1 < starts.length ? starts[k + 1] - 3 : e; while (en > s && u8[en - 1] === 0) en--;
      const h = u8[s];
      if (vtype === 0x02 || vtype === 0x01) { if (h === 0xB2) n += sink.t35(u8, s + 1, en, t); }
      else if (vtype === 0x24) { const ty = (h >> 1) & 0x3F; if (ty === 39 || ty === 40) n += seiScan(unescapeRbsp(u8, s + 2, en), sink, t); }
      else if ((h & 0x1F) === 6) n += seiScan(unescapeRbsp(u8, s + 1, en), sink, t);
    }
    return n;
  }

  // ── MPEG-TS (segmenty HLS .ts): wyciąga strumień wideo (PES) i jego znaczniki PTS ──
  function isTS(b) { return !!b && b.length >= 564 && b[0] === 0x47 && b[188] === 0x47 && b[376] === 0x47; }
  function demuxTSVideo(u8) {
    let pmt = -1, vpid = -1, vtype = 0; const chunks = []; let len = 0; const out = [];
    const readPts = function (d, o) { return ((d[o] >> 1) & 7) * 1073741824 + d[o + 1] * 4194304 + (d[o + 2] >> 1) * 32768 + d[o + 3] * 128 + (d[o + 4] >> 1); };
    const flush = function () {
      if (!len) return; const d = new Uint8Array(len); let p = 0; for (let i = 0; i < chunks.length; i++) { d.set(chunks[i], p); p += chunks[i].length; }
      chunks.length = 0; len = 0;
      if (d.length > 9 && d[0] === 0 && d[1] === 0 && d[2] === 1) { const fl = d[7]; out.push({ pts: (fl & 0x80) && d.length > 14 ? readPts(d, 9) / 90000 : null, data: d.subarray(9 + d[8]) }); }
    };
    for (let p = 0; p + 188 <= u8.length; p += 188) {
      if (u8[p] !== 0x47) continue;
      const pusi = (u8[p + 1] & 0x40) !== 0, pid = ((u8[p + 1] & 0x1F) << 8) | u8[p + 2], afc = (u8[p + 3] >> 4) & 3;
      if (!(afc & 1)) continue; let o = p + 4; if (afc & 2) o += 1 + u8[p + 4];
      if (pid === 0 && pusi && pmt < 0) {
        o += 1 + u8[o]; const secEnd = Math.min(p + 188, o + 3 + (((u8[o + 1] & 0x0F) << 8) | u8[o + 2]) - 4);
        for (let q = o + 8; q + 4 <= secEnd; q += 4) { const prog = (u8[q] << 8) | u8[q + 1]; if (prog) { pmt = ((u8[q + 2] & 0x1F) << 8) | u8[q + 3]; break; } }
      } else if (pid === pmt && pusi && vpid < 0) {
        o += 1 + u8[o]; const secLen = ((u8[o + 1] & 0x0F) << 8) | u8[o + 2]; const secEnd = Math.min(p + 188, o + 3 + secLen - 4);
        let q = o + 12 + (((u8[o + 10] & 0x0F) << 8) | u8[o + 11]);
        while (q + 5 <= secEnd) { const st = u8[q], ep = ((u8[q + 1] & 0x1F) << 8) | u8[q + 2], il = ((u8[q + 3] & 0x0F) << 8) | u8[q + 4]; if (st === 0x1B || st === 0x24 || st === 0x02 || st === 0x01) { vpid = ep; vtype = st; break; } q += 5 + il; }
      } else if (pid === vpid) {
        if (pusi) flush(); const part = u8.subarray(o, p + 188); chunks.push(part); len += part.length;
      }
    }
    flush();
    return { vtype: vtype, pes: out };
  }

  // ── SCC (Scenarist Closed Caption) ──
  function parseSCC(text) {
    const dec = createCea608(); const FPS = 30000 / 1001; let last = 0;
    const lines = String(text).replace(/\r/g, '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*(\d{1,2}):(\d{2}):(\d{2})([:;])(\d{2})\s+([0-9A-Fa-f\s]+)$/.exec(lines[i]); if (!m) continue;
      let fr = ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 30 + (+m[5]);
      if (m[4] === ';') { const mins = (+m[1]) * 60 + (+m[2]); fr -= 2 * (mins - Math.floor(mins / 10)); }
      let t = fr / FPS;
      const words = m[6].trim().split(/\s+/);
      for (let k = 0; k < words.length; k++) { const w = words[k]; if (w.length !== 4) continue; dec.feed(parseInt(w.slice(0, 2), 16), parseInt(w.slice(2), 16), t); t += 1 / FPS; last = t; }
    }
    const tr = dec.tracks(last).sort(function (a, b) { return b.cues.length - a.cues.length; });
    return tr.length ? tr[0].cues : [];
  }

  // ── EBU STL (.stl, binarny) ──
  function isSTL(b) { return !!b && b.length >= 1024 + 128 && b[3] === 0x53 && b[4] === 0x54 && b[5] === 0x4C && (b[6] === 0x32 || b[6] === 0x33) && b[7] !== undefined && /^\d\d\.\d\d/.test(String.fromCharCode(b[6], b[7], b[8], b[9], b[10])); }
  const ISO6937_DIA = { 0xC1: '\u0300', 0xC2: '\u0301', 0xC3: '\u0302', 0xC4: '\u0303', 0xC5: '\u0304', 0xC6: '\u0306', 0xC7: '\u0307', 0xC8: '\u0308', 0xCA: '\u030A', 0xCB: '\u0327', 0xCD: '\u030B', 0xCE: '\u0328', 0xCF: '\u030C' };
  const ISO6937_HI = { 0xA0: ' ', 0xA1: '¡', 0xA2: '¢', 0xA3: '£', 0xA4: '$', 0xA5: '¥', 0xA7: '§', 0xA8: '¤', 0xA9: '‘', 0xAA: '“', 0xAB: '«', 0xB0: '°', 0xB1: '±', 0xB2: '²', 0xB3: '³', 0xB4: '×', 0xB5: 'µ', 0xB6: '¶', 0xB7: '·', 0xB8: '÷', 0xB9: '’', 0xBA: '”', 0xBB: '»', 0xBC: '¼', 0xBD: '½', 0xBE: '¾', 0xBF: '¿', 0xE1: 'Æ', 0xE2: 'Đ', 0xE3: 'ª', 0xE4: 'Ħ', 0xE6: 'Ĳ', 0xE7: 'Ŀ', 0xE8: 'Ł', 0xE9: 'Ø', 0xEA: 'Œ', 0xEB: 'º', 0xEC: 'Þ', 0xED: 'Ŧ', 0xEE: 'Ŋ', 0xEF: 'ŉ', 0xF0: 'ĸ', 0xF1: 'æ', 0xF2: 'đ', 0xF3: 'ð', 0xF4: 'ħ', 0xF5: 'ı', 0xF6: 'ĳ', 0xF7: 'ŀ', 0xF8: 'ł', 0xF9: 'ø', 0xFA: 'œ', 0xFB: 'ß', 0xFC: 'þ', 0xFD: 'ŧ', 0xFE: 'ŋ', 0xFF: '\u00AD' };
  function stlText(u8, s, e, cct) {
    const legacy = { '01': 'iso-8859-5', '02': 'iso-8859-6', '03': 'iso-8859-7', '04': 'iso-8859-8' }[cct];
    let out = '', dia = '';
    const bytes = [];
    for (let i = s; i < e; i++) {
      const b = u8[i];
      if (b === 0x8F) break;
      if (b === 0x8A) { out += legacy ? decodeWith(new Uint8Array(bytes.splice(0)), legacy) : ''; out += '\n'; continue; }
      if (b < 0x20 || (b >= 0x80 && b <= 0x9F)) continue;
      if (legacy) { bytes.push(b); continue; }
      if (ISO6937_DIA[b]) { dia = ISO6937_DIA[b]; continue; }
      let ch = b < 0x80 ? String.fromCharCode(b) : (ISO6937_HI[b] || '');
      if (b === 0x24 || b === 0x23) ch = String.fromCharCode(b);
      if (dia && ch) { ch = (ch + dia).normalize('NFC'); dia = ''; } else if (dia) { ch = ''; dia = ''; }
      out += ch;
    }
    if (legacy && bytes.length) out += decodeWith(new Uint8Array(bytes), legacy);
    return cleanCueText(out);
  }
  function parseSTL(u8) {
    const gsi = String.fromCharCode.apply(null, u8.subarray(0, 16));
    const fps = /STL30/.test(gsi.slice(3, 11)) ? 30 : 25; const cct = gsi.slice(12, 14);
    const tc = function (o) { return u8[o] * 3600 + u8[o + 1] * 60 + u8[o + 2] + u8[o + 3] / fps; };
    const cues = []; let cur = null;
    for (let p = 1024; p + 128 <= u8.length; p += 128) {
      const ebn = u8[p + 3], cf = u8[p + 15]; if (ebn === 0xFE || cf === 1) continue; // SGN(0) SN(1-2) EBN(3) CS(4) TCI(5-8) TCO(9-12) VP JC CF(15) TF(16…)
      const txt = stlText(u8, p + 16, p + 128, cct);
      if (!cur) cur = { start: tc(p + 5), end: tc(p + 9), text: '' };
      cur.text += (cur.text && txt ? '\n' : '') + txt;
      if (ebn === 0xFF || ebn === 0xEF) { if (cur.text) cues.push(cur); cur = null; }
    }
    if (cur && cur.text) cues.push(cur);
    return cues;
  }

  // ── Matroska / WebM (EBML): ścieżki napisów (S_TEXT/UTF8, ASS, SSA, WEBVTT), także skompresowane zlib ──
  function isEBML(b) { return !!b && b.length >= 8 && ((b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) || (b[0] === 0x1F && b[1] === 0x43 && b[2] === 0xB6 && b[3] === 0x75)); }
  function ebmlId(u8, p) {
    const b = u8[p]; if (!b) return null; let len = 0;
    if (b & 0x80) len = 1; else if (b & 0x40) len = 2; else if (b & 0x20) len = 3; else if (b & 0x10) len = 4; else return null;
    if (p + len > u8.length) return null; let id = 0; for (let i = 0; i < len; i++) id = id * 256 + u8[p + i];
    return { id: id, len: len };
  }
  function ebmlSize(u8, p) {
    const b = u8[p]; if (!b) return null; let len = 1, mask = 0x80; while (!(b & mask) && len < 8) { mask >>= 1; len++; }
    if (p + len > u8.length) return null; let v = b & (mask - 1), ones = v === mask - 1;
    for (let i = 1; i < len; i++) { v = v * 256 + u8[p + i]; if (u8[p + i] !== 0xFF) ones = false; }
    return { size: ones ? -1 : v, len: len };
  }
  function ebmlChildren(u8, s, e, cb) {
    let p = s;
    while (p < e) {
      const idr = ebmlId(u8, p); if (!idr) return; const szr = ebmlSize(u8, p + idr.len); if (!szr) return;
      const ds = p + idr.len + szr.len; let de = szr.size < 0 ? e : ds + szr.size; if (de > e) de = e;
      if (cb(idr.id, ds, de) === false) return; p = de;
    }
  }
  const MKV_TOP = { 0x1F43B675: 1, 0x1C53BB6B: 1, 0x1254C367: 1, 0x114D9B74: 1, 0x1549A966: 1, 0x1654AE6B: 1, 0x1043A770: 1, 0x1941A469: 1, 0x18538067: 1, 0x1A45DFA3: 1 };
  async function mkvInflate(u8) {
    const ds = new W.DecompressionStream('deflate'); const w = ds.writable.getWriter(); w.write(u8); w.close();
    return new Uint8Array(await new W.Response(ds.readable).arrayBuffer());
  }
  function mkvText(tr, data) {
    const c = tr.codec; let s = decodeWith(data, 'utf-8');
    if (c === 'S_TEXT/ASS' || c === 'S_TEXT/SSA') { const skip = c === 'S_TEXT/ASS' ? 8 : 7; s = s.split(',').slice(skip).join(','); s = s.replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').replace(/\\h/g, ' '); }
    return cleanCueText(s);
  }
  async function parseMatroska(u8, known) {
    const tracks = new Map(known || []); let scale = 1000000; const blocks = [];
    const num = function (s, e) { let v = 0; for (let i = s; i < e; i++) v = v * 256 + u8[i]; return v; };
    const str = function (s, e) { return decodeWith(u8.subarray(s, e), 'utf-8').replace(/\0+$/, ''); };
    function entry(s, e) {
      const t = { num: 0, type: 0, codec: '', lang: '', name: '', forced: false, comp: null };
      ebmlChildren(u8, s, e, function (id, a, b) {
        if (id === 0xD7) t.num = num(a, b); else if (id === 0x83) t.type = num(a, b); else if (id === 0x86) t.codec = str(a, b);
        else if (id === 0x22B59C) { if (!t.lang) t.lang = str(a, b); } else if (id === 0x22B59D) t.lang = str(a, b);
        else if (id === 0x536E) t.name = str(a, b); else if (id === 0x55AA) t.forced = num(a, b) === 1;
        else if (id === 0x6D80) ebmlChildren(u8, a, b, function (i2, a2, b2) { if (i2 === 0x6240) ebmlChildren(u8, a2, b2, function (i3, a3, b3) { if (i3 === 0x5034) { const c = { algo: 0, settings: null }; ebmlChildren(u8, a3, b3, function (i4, a4, b4) { if (i4 === 0x4254) c.algo = num(a4, b4); else if (i4 === 0x4255) c.settings = u8.subarray(a4, b4); }); t.comp = c; } }); });
      });
      if (t.num) tracks.set(t.num, t);
    }
    function block(s, e, tc, dur) {
      const sz = ebmlSize(u8, s); if (!sz) return; let p = s + sz.len; if (p + 3 > e) return;
      const rel = ((u8[p] << 8) | u8[p + 1]) << 16 >> 16; if (u8[p + 2] & 0x06) return; // bez „laczenia\" (lacing) — napisy go nie używają
      blocks.push({ num: sz.size, t: (tc + rel) * scale / 1e9, dur: dur == null ? null : dur * scale / 1e9, s: p + 3, e: e });
    }
    function cluster(s, e, unknown) {
      let tc = 0, p = s;
      while (p < e) {
        const idr = ebmlId(u8, p); if (!idr) return e; if (unknown && MKV_TOP[idr.id]) return p;
        const szr = ebmlSize(u8, p + idr.len); if (!szr) return e;
        const ds = p + idr.len + szr.len; let de = szr.size < 0 ? e : ds + szr.size; if (de > e) de = e;
        if (idr.id === 0xE7) tc = num(ds, de); else if (idr.id === 0xA3) block(ds, de, tc, null);
        else if (idr.id === 0xA0) { let dur = null, bs = -1, be = -1; ebmlChildren(u8, ds, de, function (i2, a, b) { if (i2 === 0xA1) { bs = a; be = b; } else if (i2 === 0x9B) dur = num(a, b); }); if (bs >= 0) block(bs, be, tc, dur); }
        p = de;
      }
      return e;
    }
    const n = u8.length; let p = 0;
    while (p < n) {
      const idr = ebmlId(u8, p); if (!idr) break; const szr = ebmlSize(u8, p + idr.len); if (!szr) break;
      const ds = p + idr.len + szr.len; const de = szr.size < 0 ? n : Math.min(n, ds + szr.size);
      if (idr.id === 0x18538067) { p = ds; continue; }
      if (idr.id === 0x1549A966) ebmlChildren(u8, ds, de, function (i, a, b) { if (i === 0x2AD7B1) scale = num(a, b) || 1000000; });
      else if (idr.id === 0x1654AE6B) ebmlChildren(u8, ds, de, function (i, a, b) { if (i === 0xAE) entry(a, b); });
      else if (idr.id === 0x1F43B675) { const end = cluster(ds, de, szr.size < 0); p = szr.size < 0 ? end : de; continue; }
      p = de;
    }
    const cues = new Map(); const bitmap = [];
    tracks.forEach(function (t) { if (t.type === 17 && /^S_(HDMV|VOBSUB|DVBSUB|IMAGE)/.test(t.codec)) bitmap.push(t); });
    for (let i = 0; i < blocks.length && i < 200000; i++) {
      const b = blocks[i], tr = tracks.get(b.num); if (!tr || tr.type !== 17 || /^S_(HDMV|VOBSUB|DVBSUB|IMAGE)/.test(tr.codec)) continue;
      let data = u8.subarray(b.s, b.e);
      if (tr.comp) { try { if (tr.comp.algo === 3 && tr.comp.settings) { const d2 = new Uint8Array(tr.comp.settings.length + data.length); d2.set(tr.comp.settings); d2.set(data, tr.comp.settings.length); data = d2; } else if (tr.comp.algo === 0 && W.DecompressionStream) data = await mkvInflate(data); else continue; } catch (e) { continue; } }
      const text = mkvText(tr, data); if (!text) continue;
      (cues.get(b.num) || cues.set(b.num, []).get(b.num)).push({ start: b.t, end: b.dur != null ? b.t + b.dur : NaN, text: text });
    }
    return { tracks: tracks, cues: cues, bitmap: bitmap };
  }

  // ── MP4 / CMAF: informacje o ścieżkach z segmentu inicjującego oraz próbki tekstowe i napisy zamknięte w wideo ──
  const mp4Tracks = new Map(); // katalog segmentów → Map(trackId → { handler, codec, timescale, nalLen })
  function mp4Init(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); const tracks = new Map(); let cur = null;
    const cc4 = function (o) { return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3)); };
    const walk = function (s, e) {
      mp4Boxes(dv, s, e, function (type, bs, be) {
        if (type === 'moov' || type === 'mdia' || type === 'minf' || type === 'stbl') { walk(bs, be); return; }
        if (type === 'trak') { cur = { id: 0, handler: '', codec: '', timescale: 0, nalLen: 4 }; walk(bs, be); if (cur.id) tracks.set(cur.id, cur); cur = null; return; }
        if (!cur) return;
        if (type === 'tkhd') { const v = dv.getUint8(bs); cur.id = dv.getUint32(bs + (v === 1 ? 20 : 12)); }
        else if (type === 'mdhd') { const v = dv.getUint8(bs); cur.timescale = dv.getUint32(bs + (v === 1 ? 20 : 12)); }
        else if (type === 'hdlr' && be - bs >= 12) cur.handler = cc4(bs + 8);
        else if (type === 'stsd' && be - bs >= 16) {
          cur.codec = cc4(bs + 12); const scan = u8.subarray(bs, Math.min(be, bs + 480)); const s2 = decodeWith(scan, 'latin1');
          let k = s2.indexOf('avcC'); if (k >= 0 && k + 9 <= scan.length) cur.nalLen = (scan[k + 8] & 3) + 1;
          k = s2.indexOf('hvcC'); if (k >= 0 && k + 26 <= scan.length) cur.nalLen = (scan[k + 4 + 21] & 3) + 1;
        }
      });
    };
    try { walk(0, u8.byteLength); } catch (e) {}
    return tracks;
  }
  // Zwraca { tracks, texts: Map(trackId → [kwestie]), cc: liczba par z napisami zamkniętymi }
  function parseMP4Media(u8, ctx) {
    ctx = ctx || {};
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); const out = { tracks: null, texts: new Map(), cc: 0 };
    let tracks = ctx.tracks || null;
    const sample = function (tr, tid, s, e, t, dur) {
      const codec = tr ? tr.codec : '';
      if (/^(avc|hvc|hev)/.test(codec) || (!tr && ctx.sink)) {
        if (ctx.sink) { const nl = tr ? tr.nalLen : 4; const hv = /^(hvc|hev)/.test(codec); out.cc += nalSamples(u8, s, e, nl, hv ? 'hevc' : 'avc', ctx.sink, t); if (!out.cc && !tr) out.cc += nalSamples(u8, s, e, 4, 'hevc', ctx.sink, t); }
      } else if (codec === 'av01') { if (ctx.sink) out.cc += av1Samples(u8, s, e, ctx.sink, t); }
      else if (codec === 'c608' || codec === 'c708') {
        mp4Boxes(dv, s, e, function (type, bs, be) {
          if (!ctx.sink) return;
          if (type === 'cdat' || type === 'cdt2') { for (let q = bs; q + 2 <= be; q += 2) { ctx.sink.pair(type === 'cdat' ? 0 : 1, u8[q], u8[q + 1], t); out.cc++; } }
          else if (type === 'ccdp') { const n = ctx.sink.ccData(u8, bs, be, t) || ctx.sink.triplets(u8, bs, Math.floor((be - bs) / 3), be, t); out.cc += n; }
        });
      } else if (codec === 'tx3g' && e - s >= 2) {
        const len = (u8[s] << 8) | u8[s + 1]; if (len > 0 && s + 2 + len <= e) {
          const txt = cleanCueText(decodeWith(u8.subarray(s + 2, s + 2 + len), 'utf-8')); const ts = tr.timescale || 1000;
          if (txt) { const l = out.texts.get(tid) || out.texts.set(tid, []).get(tid); l.push({ start: t, end: t + dur / ts, text: txt }); }
        }
      }
    };
    const top = function (s, e) {
      mp4Boxes(dv, s, e, function (type, bs, be) {
        if (type === 'moov') { const t = mp4Init(u8.subarray(bs - 8, be)); out.tracks = t; tracks = t; }
        else if (type === 'moof') {
          const moofStart = bs - 8; let tid = 0, base = null, defDur = 0, defSize = 0, dts = 0, dflags = 0;
          mp4Boxes(dv, bs, be, function (t2, ts, te) {
            if (t2 !== 'traf') return;
            tid = 0; base = null; defDur = 0; defSize = 0; dts = 0;
            const runs = [];
            mp4Boxes(dv, ts, te, function (t3, a, b) {
              if (t3 === 'tfhd') { const fl = dv.getUint32(a) & 0xFFFFFF; tid = dv.getUint32(a + 4); let q = a + 8; if (fl & 1) { base = dv.getUint32(q) * 4294967296 + dv.getUint32(q + 4); q += 8; } if (fl & 2) q += 4; if (fl & 8) { defDur = dv.getUint32(q); q += 4; } if (fl & 16) { defSize = dv.getUint32(q); q += 4; } if (fl & 32) dflags = dv.getUint32(q); }
              else if (t3 === 'tfdt') { const v = dv.getUint8(a); dts = v === 1 ? dv.getUint32(a + 4) * 4294967296 + dv.getUint32(a + 8) : dv.getUint32(a + 4); }
              else if (t3 === 'trun') runs.push([a, b]);
            });
            const tr = tracks ? tracks.get(tid) : null; const scale = tr && tr.timescale ? tr.timescale : 1000;
            if (tr && !/^(avc|hvc|hev|av01|c608|c708|tx3g)/.test(tr.codec)) return;
            if (!tr && !ctx.sink) return;
            let pos = base != null ? base : moofStart;
            for (let r = 0; r < runs.length; r++) {
              const a = runs[r][0]; const fl = dv.getUint32(a) & 0xFFFFFF, ver = dv.getUint8(a), count = dv.getUint32(a + 4); let q = a + 8;
              if (fl & 1) { pos = (base != null ? base : moofStart) + dv.getInt32(q); q += 4; }
              if (fl & 4) q += 4;
              for (let i = 0; i < count && i < 20000; i++) {
                let dur = defDur, size = defSize, cts = 0;
                if (fl & 0x100) { dur = dv.getUint32(q); q += 4; } if (fl & 0x200) { size = dv.getUint32(q); q += 4; }
                if (fl & 0x400) q += 4; if (fl & 0x800) { cts = ver === 0 ? dv.getUint32(q) : dv.getInt32(q); q += 4; }
                if (size > 0 && pos + size <= u8.length) sample(tr, tid, pos, pos + size, (dts + cts) / scale, dur);
                pos += size; dts += dur;
              }
            }
          });
        }
      });
    };
    try { top(0, u8.byteLength); } catch (e) { dbg('parseMP4Media', e); }
    return out;
  }

  // ── JSON: YouTube json3, transkrypcja YouTube, dowolne tablice {czas, tekst} ──
  const TKEY = ['start', 'startTime', 'start_time', 'begin', 'from', 'startMs', 'start_ms', 'tStartMs', 'startTimeMs', 'beginTime', 'begin_time', 'startOffset', 'start_offset', 'offset', 'timeIn', 'startSec', 'start_sec', 'time', 'timestamp', 'ts', 'st', 'in', 's'];
  const EKEY = ['end', 'endTime', 'end_time', 'to', 'endMs', 'end_ms', 'endTimeMs', 'endOffset', 'end_offset', 'stop', 'finish', 'timeOut', 'endSec', 'end_sec', 'et', 'out', 'e'];
  const DKEY = ['duration', 'dur', 'durationMs', 'duration_ms', 'dDurationMs', 'length', 'd'];
  const XKEY = ['text', 'content', 'line', 'lines', 'caption', 'subtitle', 'sentence', 'transcript', 'utf8', 'txt', 'body', 'payload', 'html', 'segs', 'words', 'snippet', 'value', 'message'];

  function textOf(v) {
    if (v == null) return '';
    if (typeof v === 'string') return cleanCueText(v);
    if (typeof v === 'number') return '';
    if (Array.isArray(v)) {
      const parts = [];
      for (let i = 0; i < v.length && i < 400; i++) { const p = v[i]; const t = typeof p === 'string' ? p : (p && typeof p === 'object') ? (p.utf8 != null ? p.utf8 : p.text != null ? p.text : p.word != null ? p.word : p.content != null ? p.content : '') : ''; if (typeof t === 'string' && t) parts.push(t); }
      const strs = v.length && typeof v[0] === 'string';
      return cleanCueText(parts.join(strs ? '\n' : (parts.some(function (p) { return /^\s|\s$/.test(p); }) ? '' : ' ')));
    }
    if (typeof v === 'object') {
      if (typeof v.simpleText === 'string') return cleanCueText(v.simpleText);
      if (Array.isArray(v.runs)) return textOf(v.runs);
      if (typeof v.text === 'string') return cleanCueText(v.text);
      if (v.text && typeof v.text === 'object') return textOf(v.text);
    }
    return '';
  }
  function numOf(v) {
    if (typeof v === 'number') return { v: v, clock: false };
    if (typeof v === 'string' && v.length < 24) { if (v.indexOf(':') !== -1) return { v: parseClock(v), clock: true }; const f = parseFloat(v); return { v: /^-?[\d.]+$/.test(v.trim()) ? f : NaN, clock: false }; }
    return { v: NaN, clock: false };
  }
  function pickKey(o, keys, wantText) {
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]; const v = o[k];
      if (v == null) continue;
      if (wantText) { if (typeof v === 'string' || (typeof v === 'object')) return k; }
      else if (typeof v === 'number' || (typeof v === 'string' && v.length < 24 && /\d/.test(v))) return k;
    }
    return null;
  }
  function cuesFromArray(arr) {
    const n = arr.length; if (n < 2) return null;
    let sample = null;
    for (let i = 0; i < n && i < 5; i++) if (arr[i] && typeof arr[i] === 'object' && !Array.isArray(arr[i])) { sample = arr[i]; break; }
    if (!sample) return null;
    const tk = pickKey(sample, TKEY), xk = pickKey(sample, XKEY, true);
    if (!tk || !xk || tk === xk) return null;
    const ek = pickKey(sample, EKEY), dk = pickKey(sample, DKEY);
    const raw = []; let ints = true, max = 0, durSum = 0, durN = 0, mono = 0;
    for (let i = 0; i < n && i < 60000; i++) {
      const o = arr[i]; if (!o || typeof o !== 'object') continue;
      const s = numOf(o[tk]); if (isNaN(s.v)) continue;
      const tx = textOf(o[xk]); if (!tx) continue;
      const e = ek ? numOf(o[ek]) : null, d = dk ? numOf(o[dk]) : null;
      if (!s.clock) { if (s.v % 1 !== 0) ints = false; if (s.v > max) max = s.v; }
      if (e && !isNaN(e.v) && !e.clock && !s.clock) { durSum += e.v - s.v; durN++; } else if (d && !isNaN(d.v) && !d.clock) { durSum += d.v; durN++; }
      if (raw.length && s.v >= raw[raw.length - 1].s.v) mono++;
      raw.push({ s: s, e: e, d: d, text: tx });
    }
    if (raw.length < 2 || raw.length < n * 0.5 || mono < (raw.length - 1) * 0.7) return null;
    const ms = /ms$|Ms|milli/.test(tk) || (durN ? durSum / durN > 60 : (ints && max > 36000));
    const k = ms ? 0.001 : 1;
    const cues = [];
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i]; const start = r.s.clock ? r.s.v : r.s.v * k; let end = NaN;
      if (r.e && !isNaN(r.e.v)) end = r.e.clock ? r.e.v : r.e.v * k;
      else if (r.d && !isNaN(r.d.v)) end = start + (r.d.clock ? r.d.v : r.d.v * k);
      else if (i + 1 < raw.length) { const nx = raw[i + 1].s; end = Math.min(nx.clock ? nx.v : nx.v * k, start + 8); }
      cues.push({ start: start, end: end, text: r.text });
    }
    if (cues[cues.length - 1].start > 172800) return null; // to raczej znaczniki czasu (epoka), nie napisy
    return cues;
  }
  function collectByKey(root, key, limit) {
    const out = []; const stack = [root]; let n = 0;
    while (stack.length && n++ < 200000 && out.length < limit) {
      const v = stack.pop(); if (!v || typeof v !== 'object') continue;
      if (Array.isArray(v)) { for (let i = v.length - 1; i >= 0; i--) if (v[i] && typeof v[i] === 'object') stack.push(v[i]); continue; }
      for (const k in v) { const c = v[k]; if (k === key && c && typeof c === 'object') out.push(c); else if (c && typeof c === 'object') stack.push(c); }
    }
    return out;
  }
  function findCueArray(root) {
    const stack = [{ v: root, d: 0 }]; let n = 0, best = null;
    while (stack.length && n++ < 30000) {
      const cur = stack.pop(); const v = cur.v; if (!v || typeof v !== 'object' || cur.d > 8) continue;
      if (Array.isArray(v)) {
        if (v.length >= 2) { const c = cuesFromArray(v); if (c && (!best || c.length > best.length)) { best = c; continue; } }
        for (let i = 0; i < v.length && i < 300; i++) if (v[i] && typeof v[i] === 'object') stack.push({ v: v[i], d: cur.d + 1 });
        continue;
      }
      for (const k in v) { const c = v[k]; if (c && typeof c === 'object') stack.push({ v: c, d: cur.d + 1 }); }
    }
    return best;
  }
  // Zwraca {format, cues} dla całego dokumentu JSON albo null
  function cuesFromJSONDoc(obj, generic) {
    if (!obj || typeof obj !== 'object') return null;
    if (Array.isArray(obj.events) && obj.events.some(function (e) { return e && e.tStartMs != null; })) {
      const cues = [];
      for (const ev of obj.events) {
        if (!ev || !ev.segs) continue;
        const t = textOf(ev.segs); if (!t) continue;
        const s = (ev.tStartMs || 0) / 1000;
        cues.push({ start: s, end: s + (ev.dDurationMs || 2500) / 1000, text: t });
      }
      return { format: 'json3', cues: cues };
    }
    const segs = collectByKey(obj, 'transcriptSegmentRenderer', 20000);
    if (segs.length >= 2) {
      const cues = [];
      for (const sg of segs) { const t = textOf(sg.snippet); if (t) cues.push({ start: (+sg.startMs || 0) / 1000, end: (+sg.endMs || 0) / 1000, text: t }); }
      cues.reverse();
      return { format: 'yt-transcript', cues: cues };
    }
    if (generic) { const c = findCueArray(obj); if (c && c.length >= 2) return { format: 'json', cues: c }; }
    return null;
  }

  // Porządkowanie: sortowanie, scalanie powtórek, przycinanie „toczących się" napisów automatycznych
  function normalizeCues(cues) {
    const arr = [];
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i]; if (!c || !c.text) continue;
      const s = +c.start; if (!isFinite(s) || s < 0) continue;
      let e = +c.end; if (!isFinite(e) || e <= s) e = s + Math.min(6, Math.max(1.5, c.text.length * 0.07));
      arr.push({ start: s, end: e, text: c.text });
    }
    arr.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i], p = out[out.length - 1];
      if (p && p.text === c.text && c.start <= p.end + 0.05) { if (c.end > p.end) p.end = c.end; continue; }
      out.push(c);
    }
    let ov = 0;
    for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].end - 0.01) ov++;
    if (out.length > 4 && ov > out.length * 0.6) {
      for (let i = 1; i < out.length; i++) if (out[i - 1].end > out[i].start && out[i].start > out[i - 1].start + 0.05) out[i - 1].end = out[i].start;
    }
    return out;
  }
  function isThumbTrack(cues) {
    if (!cues || cues.length < 2) return false;
    let n = 0; const lim = Math.min(cues.length, 40);
    for (let i = 0; i < lim; i++) if (/#xywh=|\.(?:jpe?g|png|webp|avif)(?:[?#]|$)/i.test(cues[i].text)) n++;
    return n > lim * 0.6;
  }
  function cueHash(cues) {
    let s = ''; const lim = Math.min(cues.length, 40);
    for (let i = 0; i < lim; i++) s += cues[i].text + '|';
    return 'c' + cues.length + ':' + hashStr(s);
  }

  // Główna brama: tekst → {format, cues} | {format, manifest:true} | null
  // ── Pamięć podręczna parsowania: ta sama treść (np. przy kolejnych skanach okna) nie jest parsowana drugi raz ──
  const pcache = { map: new Map(), chars: 0, hits: 0, misses: 0 };
  function pcKey(text, hint) { return (hint || '') + '|' + hashStr(text); }
  function pcGet(text, hint) {
    const k = pcKey(text, hint), e = pcache.map.get(k);
    if (e && e.text === text) { pcache.map.delete(k); pcache.map.set(k, e); return e; }
    return null;
  }
  function pcPut(text, hint, res) {
    const k = pcKey(text, hint), old = pcache.map.get(k); if (old) { pcache.chars -= old.text.length; pcache.map.delete(k); }
    pcache.map.set(k, { text: text, res: res }); pcache.chars += text.length;
    while (pcache.map.size > 60 || pcache.chars > 40000000) { const f = pcache.map.keys().next().value; pcache.chars -= pcache.map.get(f).text.length; pcache.map.delete(f); }
  }
  function parseAny(text, hint) { // wynik bywa współdzielony — nie wolno go modyfikować (wszyscy wywołujący robią kopie przez normalizeCues)
    if (typeof text !== 'string' || text.length < 64) return parseAnyRaw(text, hint);
    const e = pcGet(text, hint); if (e) { pcache.hits++; return e.res; }
    pcache.misses++; const res = parseAnyRaw(text, hint); pcPut(text, hint, res); return res;
  }
  function parseAnyRaw(text, hint) {
    const fmt = sniffFormat(text) || (hint && /^(vtt|srt|ttml|dfxp|xml|sbv|ass|ssa|lrc|sami|smi|scc)$/.test(hint) ? hint : '');
    switch (fmt) {
      case 'vtt': case 'srt': { const r = parseVTT(text); return { format: fmt, cues: r.cues, tsMap: r.tsMap }; }
      case 'ttml': case 'dfxp': return { format: 'ttml', cues: parseTTML(text) };
      case 'xml': { const c = parseXmlTimed(text); return c.length ? { format: /<transcript[\s>]/.test(text) ? 'srv1' : /<timedtext[^>]*format="3"/.test(text) ? 'srv3' : 'xml', cues: c } : null; }
      case 'sbv': return { format: 'sbv', cues: parseSBV(text) };
      case 'ass': case 'ssa': return { format: 'ass', cues: parseASS(text) };
      case 'lrc': return { format: 'lrc', cues: parseLRC(text) };
      case 'scc': return { format: 'scc', cues: parseSCC(text) };
      case 'sami': case 'smi': {
        const all = parseSAMIAll(text); if (!all.length) return { format: 'sami', cues: [] };
        const langs = prefLangs(); let pi = 0;
        for (let i = 0; i < all.length; i++) if (all[i].lang && langs.indexOf(all[i].lang.slice(0, 2).toLowerCase()) >= 0) { pi = i; break; }
        return { format: 'sami', cues: all[pi].cues, lang: all[pi].lang, variants: all.filter(function (v, i) { return i !== pi; }) };
      }
      case 'm3u8': case 'mpd': return { format: fmt, manifest: true };
      case 'json': { let obj; try { obj = O.jsonParse(text); } catch (e) { return null; } return cuesFromJSONDoc(obj, true); }
    }
    return null;
  }

  function fmtTime(sec, sep) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    let ms = Math.round(sec * 1000);
    const h = Math.floor(ms / 3600000); ms -= h * 3600000;
    const m = Math.floor(ms / 60000); ms -= m * 60000;
    const s = Math.floor(ms / 1000); ms -= s * 1000;
    return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + sep + pad(ms, 3);
  }
  function toSRT(cues) {
    const out = [];
    for (let i = 0; i < cues.length; i++) { const c = cues[i]; out.push((i + 1) + '\r\n' + fmtTime(c.start, ',') + ' --> ' + fmtTime(c.end, ',') + '\r\n' + c.text.replace(/\n/g, '\r\n') + '\r\n'); }
    return out.join('\r\n');
  }
  function toVTT(cues) {
    const out = ['WEBVTT', ''];
    for (let i = 0; i < cues.length; i++) { const c = cues[i]; out.push(fmtTime(c.start, '.') + ' --> ' + fmtTime(c.end, '.'), c.text.replace(/-->/g, '→'), ''); }
    return out.join('\n');
  }
  function toTXT(cues) { // same słowa: bez numerów, czasów i znaczników
    const out = []; let prev = '';
    for (let i = 0; i < cues.length; i++) for (const l of cues[i].text.split('\n')) if (l && l !== prev) { out.push(l); prev = l; }
    return out.join('\r\n');
  }

  /* ═══════════════ 5. BUFOR ZNALEZISK + RAPORT W KONSOLI ═══════════════ */

  const store = { items: new Map(), byHash: new Map(), hlsSeg: new Map(), hlsSubKeys: new Set(), segTime: new Map(), frames: new Map(), seq: 0, listeners: [] };
  const yt = { extras: Object.create(null) };          // parametry żądań napisów YouTube podpatrzone u odtwarzacza (per film)
  const reportedOnce = new Set();
  // Globalna tablica bufora wykrytych adresów (wymóg: „zapisuj do globalnej tablicy")
  const urlBuffer = [];

  const LAYER_COLOR = dict({ Fetch: '#2563eb', XHR: '#7c3aed', DOM: '#c2410c', ShadowDOM: '#be185d', Window: '#0e7490', TextTrack: '#15803d', Blob: '#a16207', 'JSON.parse': '#4338ca', TextDecoder: '#6d28d9', WebSocket: '#be123c', SSE: '#be123c', Mutation: '#047857', Storage: '#57534e', Cache: '#57534e', IndexedDB: '#57534e', Performance: '#475569', HLS: '#0f766e', DASH: '#0f766e', MP4: '#0f766e', Nawigacja: '#334155', Skan: '#334155',
    Worker: '#0369a1', BroadcastChannel: '#0369a1', MessagePort: '#0369a1', ServiceWorker: '#0369a1', postMessage: '#9333ea', Extension: '#9333ea', WebRTC: '#b91c1c', Speech: '#be185d', Canvas: '#ca8a04', ARIA: '#0d9488', CSS: '#64748b', OPFS: '#57534e', Cookie: '#57534e', Okno: '#57534e', History: '#57534e', CC: '#0f766e', MKV: '#0f766e', TS: '#0f766e', OCR: '#c026d3', WASM: '#475569', Beacon: '#334155', Base64: '#6d28d9', TextEncoder: '#6d28d9' });
  function report(layer, msg, extra) {
    if (!CFG.logFinds) return;
    try {
      O.log('%c Napisy %c ' + layer + ' %c ' + msg,
        'background:#10231c;color:#ffd84a;font-weight:700;padding:2px 5px;border-radius:4px 0 0 4px',
        'background:' + (LAYER_COLOR[layer] || '#334155') + ';color:#fff;font-weight:700;padding:2px 6px;border-radius:0 4px 4px 0',
        'color:inherit;font-weight:400', extra || '');
    } catch (e) {}
  }
  function reportOnce(key, layer, msg, extra) { if (reportedOnce.has(key)) return; reportedOnce.add(key); report(layer, msg, extra); }
  function emit(name, detail) {
    for (let i = 0; i < store.listeners.length; i++) { const l = store.listeners[i]; if (l.name === name) { try { l.fn(detail); } catch (e) {} } }
    try { W.dispatchEvent(new W.CustomEvent('ush:' + name, { detail: detail })); } catch (e) {}
  }
  function pub(it) { // odchudzony opis znaleziska dla API i zdarzeń
    return { id: it.id, url: it.url, urls: it.urls.slice(), lang: it.lang, label: it.label, format: it.format, kind: it.kind, layers: Array.from(it.layers), cues: it.cues ? it.cues.length : 0, verified: it.verified, auto: it.auto };
  }

  function keyFor(url) {
    try {
      const u = new URL(url);
      if (RX.ytTimed.test(url)) { const q = u.searchParams; return 'yt:' + q.get('v') + ':' + (q.get('lang') || '') + ':' + (q.get('tlang') || '') + ':' + (q.get('kind') || '') + ':' + (q.get('name') || ''); }
      if (u.protocol === 'blob:' || u.protocol === 'data:') return 'u:' + url.slice(0, 300);
      const keep = [];
      u.searchParams.forEach(function (v, k) { if (!RX.volatile.test(k)) keep.push(k + '=' + v); });
      keep.sort();
      return 'u:' + u.origin + u.pathname + (keep.length ? '?' + keep.join('&') : '');
    } catch (e) { return 'u:' + url; }
  }

  function addItem(info) { try { return addItem0(info); } catch (e) { dbg('addItem', e); return null; } }
  function addItem0(info) {
    let url = info.url ? toAbs(info.url, info.base) : '';
    if (url && !/^(https?|blob|data|file|chrome-extension|moz-extension|safari-web-extension):/i.test(url)) url = '';
    if (info.kindAttr && RX.badKind.test(info.kindAttr)) return null;
    if (url && RX.thumbs.test(url)) return null;
    if (url && ytOtherVideo(url)) return null;   // [AGENT-EXP] 2026-10-22: napisy YouTube innego filmu (miniatury, podglądy) — pomijamy
    if (url && !info.key) { const owner = store.hlsSeg.get(noHash(url)); if (owner) { owner.layers.add(info.layer); return owner; } } // segment znanej playlisty HLS

    if (typeof info.text === 'string' && !info.cues && !info.key && info.text.length >= 64) { // ta sama treść już jest — bez ponownego parsowania i porządkowania
      const ex = store.byHash.get(hashStr(info.text));
      if (ex && ex.text === info.text && ex._rep.has(info.layer) && (!url || ex.urls.indexOf(url) !== -1)) { ex.touched = Date.now(); return ex; }
      if (info.text.length >= CFG.workerMinBytes && pwUsable() && !pcGet(info.text, info.format || '')) { parseInWorker(info.text, info.format || '').then(function () { addItem(info); }); return null; } // duży tekst: parsowanie w wątku roboczym, potem ta sama ścieżka (już z pamięci podręcznej)
    }
    const text = typeof info.text === 'string' ? info.text : null;
    let cues = info.cues || null, format = info.format || '', variants = info.variants || null, pLang = info.pLang || '', norm = !!info.normalized;
    if (text != null && !cues) {
      const p = parseAny(text, format);
      if (p && p.manifest) return null;
      if (p) { cues = p.cues; format = p.format; variants = p.variants || null; pLang = p.lang || ''; norm = !!p.normalized; }
    }
    if (cues) { if (!norm) cues = normalizeCues(cues); if (isThumbTrack(cues)) return null; }
    const hasCues = !!(cues && cues.length);
    if (!hasCues && !info.strong && !info.weakOk) return null;
    if (!url && !hasCues && text == null && !info.key) return null;

    const h = text != null ? hashStr(text) : '';
    const ch = hasCues ? cueHash(cues) : '';
    const key = info.key || (url ? keyFor(url) : (h ? 'h:' + h : 'c:' + ch));
    let it = store.items.get(key) || (h && store.byHash.get(h)) || (ch && store.byHash.get(ch)) || null;
    const isNew = !it;
    if (isNew) {
      if (store.items.size >= CFG.maxItems) return null;
      it = { id: 'n' + (++store.seq), key: key, url: '', urls: [], layers: new Set(), format: '', lang: '', label: '', cues: null, text: null, strong: false, verified: false, auto: false, forced: false, active: false, kind: 'file', segments: 0, note: '', added: Date.now(), _rep: new Set() };
      store.items.set(key, it);
    }
    const firstForLayer = !it._rep.has(info.layer);
    it.layers.add(info.layer); it._rep.add(info.layer);
    if (url) {
      if (it.urls.indexOf(url) === -1) { it.urls.push(url); if (urlBuffer.length < 2000 && !/^(blob|data):/.test(url)) urlBuffer.push({ url: url, layer: info.layer, time: Date.now() }); }
      if (!it.url || info.preferUrl) it.url = url;
    }
    if (hasCues && (!it.cues || cues.length >= it.cues.length)) { it.cues = cues; it.verified = true; if (format) it.format = format; if (text != null) it.text = text; }
    else if (text != null && it.text == null) { it.text = text; if (format && !it.format) it.format = format; }
    if (!it.format) it.format = format || (url ? extOf(url) : '');
    if (info.lang && !it.lang) it.lang = normLang(info.lang);
    if (!it.lang && pLang) it.lang = normLang(pLang);
    if (!it.lang && url) it.lang = langFromUrl(url);
    if (info.label && !it.label) it.label = String(info.label).replace(/\s+/g, ' ').trim().slice(0, 70);
    if (info.auto) it.auto = true;
    if (info.forced) it.forced = true;
    if (info.strong || hasCues) it.strong = true;
    if (info.kind) it.kind = info.kind;
    if (info.note && !it.note) it.note = info.note;
    if (h) store.byHash.set(h, it);
    if (it.cues && it.cues.length) store.byHash.set(cueHash(it.cues), it);
    it.touched = Date.now();
    if (isNew || firstForLayer) {
      const what = (it.lang ? '[' + it.lang + '] ' : '') + (it.label ? it.label + ' ' : '') + (it.format ? '(' + it.format + ') ' : '') + (it.cues && it.cues.length ? plKw(it.cues.length) + ' ' : '') + (it.strong ? '' : '— niepotwierdzone ');
      report(info.layer, (isNew ? 'znaleziono: ' : 'te same napisy także w tej warstwie: ') + what, it.url ? shortUrl(it.url, 110) : '(treść w pamięci)');
    }
    emit('found', pub(it));
    uiDirty(); notifyTop();
    if (hasCues) guard(ecoCheck);   // [AGENT-EXP] 🔋
    if (variants && variants.length) for (let vi = 0; vi < variants.length; vi++) { const v = variants[vi]; addItem({ key: key + '#' + (v.cls || vi), url: info.url, base: info.base, layer: info.layer, cues: v.cues, format: format, lang: v.lang, label: v.label, strong: true }); } // dodatkowe języki z jednego pliku (SAMI)
    return it;
  }

  function score(it) {
    let s = 0;
    if (it.cues && it.cues.length) s += 100 + Math.min(60, it.cues.length / 10);
    else if (it.kind === 'hls') s += 70;
    else if (it.text != null) s += 40;
    else if (it.strong) s += 30;
    else s += 5;
    if (it.verified) s += 20;
    const langs = prefLangs(); const l = (it.lang || '').slice(0, 2).toLowerCase();
    const idx = l ? langs.indexOf(l) : -1;
    if (idx >= 0) s += 50 - idx * 8;
    if (it.active) s += 30;
    if (it.auto) s -= 15;
    if (it.url && ytThisVideo(it.url)) s += 40;   // [AGENT-EXP] 2026-10-22: ścieżka bieżącego filmu YouTube przed resztą
    if (it.forced) s -= 25;
    return s;
  }
  function sortedItems() { return Array.from(store.items.values()).sort(function (a, b) { return score(b) - score(a) || b.touched - a.touched; }); }
  function bestItem() { const l = sortedItems(); return l.length ? l[0] : null; }

  // ── Budżet CPU i priorytety zadań: sieć i odtwarzacz od razu, reszta w bezczynności i w granicach budżetu na sekundę ──
  const sched = { t: 0, used: 0, total: 0, skipped: 0, deferred: 0, memoHits: 0, inTask: 0, rehooks: 0 };
  let objMemo = new WeakMap(); // obiekty już przejrzane (okno, odtwarzacze) → kiedy i jaki miały „podpis\"
  function cpuLeft() { const t = Date.now(); if (t - sched.t >= 1000) { sched.t = t; sched.used = 0; } return (CFG.cpuBudgetMs || 60) - sched.used; }
  function cpuCharge(ms) { cpuLeft(); sched.used += ms; sched.total += ms; }
  function task(fn, prio) { // prio: 'normal' — w bezczynności, 'low' — w tle (scheduler.postTask, gdy jest)
    const run = function () {
      if (cpuLeft() <= 0) { sched.deferred++; setTimeout(function () { task(fn, prio); }, Math.max(50, 1000 - (Date.now() - sched.t))); return; }
      const t0 = now(); sched.inTask++; try { guard(fn); } finally { sched.inTask--; cpuCharge(now() - t0); }
    };
    if (prio === 'low' && W.scheduler && typeof W.scheduler.postTask === 'function') { try { W.scheduler.postTask(run, { priority: 'background' }).catch(noop); return; } catch (e) {} }
    idle(run, prio === 'low' ? 5000 : 1500);
  }

  /* ═══════════════ 6. ANALIZA OBIEKTÓW (window, JSON, konfiguracje odtwarzaczy) ═══════════════ */

  function isForbidden(v) { // bez odczytu pól strony (gettery/Proxy): rozpoznanie po znaczniku typu i deskryptorach
    try {
      if (v === W || v === doc || ArrayBuffer.isView(v)) return true;
      const t = tagOf(v);
      if (/^\[object (ArrayBuffer|SharedArrayBuffer|Promise|Blob|File|WeakMap|WeakSet|WeakRef|Date|RegExp|Window|global|Text|Comment|Document|HTMLDocument|DocumentFragment|ShadowRoot|Attr|CDATASection|ProcessingInstruction|DocumentType|CSSStyleDeclaration|Location|History|Navigator|Storage)\]$|Element\]$/.test(t)) return true;
      const d = Object.getOwnPropertyDescriptor(v, 'window'); if (d && d.value === v) return true;
      try { if (W.Node && v instanceof W.Node) return true; } catch (e) {}
      return false;
    } catch (e) { return true; }
  }

  function metaFrom(holder, path) {
    const m = { lang: '', label: '', kind: '', auto: false };
    if (holder && typeof holder === 'object') {
      const g = function (keys) { for (let i = 0; i < keys.length; i++) { const v = own(holder, keys[i]); if (typeof v === 'string' && v && v.length < 80) return v; if (v && typeof v === 'object' && keys[i] === 'name') { const t = textOf(v); if (t) return t; } } return ''; };
      m.lang = g(['languageCode', 'srclang', 'lang', 'language', 'locale', 'language_code', 'langCode', 'iso', 'code']);
      m.label = g(['label', 'name', 'title', 'displayName', 'language_name', 'languageName']);
      m.kind = g(['kind', 'type', 'role']);
      m.auto = m.kind === 'asr' || /auto/i.test(m.label);
    }
    if (m.lang && !(LANG2.has(m.lang.slice(0, 2).toLowerCase()) || LANG3[m.lang.toLowerCase()])) m.lang = '';
    if (!m.lang && path) {
      const parts = path.split('.').slice(-4);
      for (let i = parts.length - 1; i >= 0; i--) { const a = parts[i].split(/[-_]/)[0].toLowerCase(); if (LANG_KEY.has(a) && parts[i].length <= 6) { m.lang = parts[i]; break; } }
    }
    return m;
  }
  function inspectString(s, cur, layer, o) {
    const len = s.length;
    if (len < 5) return 0;
    if (len > 120) { // być może cała treść napisów trzymana w zmiennej
      if (len < 6000000) {
        const c0 = s.charCodeAt(0);
        if (c0 === 87 || c0 === 0xFEFF || (c0 >= 48 && c0 <= 57) || c0 === 60 || c0 === 91) {
          const f = sniffFormat(s);
          if (f && f !== 'json' && f !== 'm3u8' && f !== 'mpd') { return addItem({ layer: layer, text: s, format: f, label: cur.path }) ? 1 : 0; }
        }
      }
      if (len > 4000) return 0;
    }
    if (!looksLikeUrl(s)) return 0;
    if (RX.thumbs.test(s)) return 0;
    const strong = RX.subExt.test(s) || RX.ytTimed.test(s) || /\/texttracks?\//i.test(s);
    let hint = false;
    if (!strong) {
      if (RX.notSub.test(s) || !/[\/?]/.test(s.replace(/^(?:https?:)?\/\//, ''))) return 0;
      hint = RX.keyHint.test(cur.path.split('.').slice(-3).join('.'));
      if (!hint) { const k = own(cur.holder || {}, 'kind'); hint = typeof k === 'string' && /caption|subtitle/i.test(k); }
      if (!hint) return 0;
    }
    const m = metaFrom(cur.holder, cur.path);
    if (m.kind && RX.badKind.test(m.kind)) return 0;
    const abs = toAbs(s, o.base);
    if (!abs || abs === noHash(W.location.href)) return 0;
    return addItem({ url: abs, layer: layer, strong: strong, weakOk: true, lang: m.lang, label: m.label || (strong ? '' : cur.path.split('.').slice(-2).join('.')), auto: m.auto }) ? 1 : 0;
  }
  /*
   * Ograniczone czasowo i ilościowo przejście po obiekcie. Szuka: adresów napisów, treści napisów
   * w łańcuchach oraz tablic {czas, tekst}. safe:true = czyta tylko zwykłe pola (bez getterów strony).
   */
  function analyzeObject(root, layer, o) {
    o = o || {};
    const t0 = now(), prio = o.prio || (layer === 'Fetch' || layer === 'XHR' ? 'high' : 'normal');
    let budget = o.budget || 50;
    if (prio !== 'high') { const left = cpuLeft(); if (left <= 0) { sched.skipped++; return 0; } budget = Math.min(budget, Math.max(2, left)); }
    if ((o.memo != null ? o.memo : layer === 'Window') && root && typeof root === 'object') { // ten sam obiekt okna nie jest przechodzony ponownie, dopóki się nie zmieni (lub 30 s)
      let sig = -1; try { sig = Array.isArray(root) ? root.length : Object.keys(root).length; } catch (e) {}
      const m = objMemo.get(root); if (m && m.sig === sig && Date.now() - m.t < 30000) { sched.memoHits++; return 0; }
      objMemo.set(root, { t: Date.now(), sig: sig });
    }
    const maxNodes = o.maxNodes || 20000, maxDepth = o.maxDepth || 12, deadline = now() + budget;
    const seen = new WeakSet(); let n = 0, found = 0;
    const stack = [{ v: root, d: 0, holder: null, path: o.name || '' }];
    while (stack.length) {
      const cur = stack.pop(); const v = cur.v;
      if (++n > maxNodes) break;
      if ((n & 127) === 0 && now() > deadline) break;
      if (typeof v === 'string') { try { found += inspectString(v, cur, layer, o); } catch (e) {} continue; }
      if (!v || typeof v !== 'object') continue;
      if (seen.has(v)) continue;
      seen.add(v);
      if (o.safe && isForbidden(v)) continue;
      if (cur.d >= maxDepth) continue;
      if (Array.isArray(v)) {
        if (v.length >= 2 && v[0] && typeof v[0] === 'object' && !Array.isArray(v[0])) {
          let c = null; try { c = cuesFromArray(v); } catch (e) {}
          if (c && c.length >= 3) {
            const m = metaFrom(cur.holder, cur.path);
            if (addItem({ layer: layer, cues: c, format: 'json', url: o.srcUrl || '', key: 'j:' + cueHash(normalizeCues(c)), lang: m.lang, label: m.label || cur.path.split('.').slice(-2).join('.') })) found++;
            continue;
          }
        }
        const lim = Math.min(v.length, 3000);
        for (let i = 0; i < lim; i++) { const c = v[i]; if (c && (typeof c === 'object' || typeof c === 'string')) stack.push({ v: c, d: cur.d + 1, holder: cur.holder, path: cur.path }); }
        continue;
      }
      const tg = o.safe ? tagOf(v) : '';
      if (tg === '[object Map]' || tg === '[object Set]') {
        let k = 0; try { v.forEach(function (c) { if (k++ < 500 && c && (typeof c === 'object' || typeof c === 'string')) stack.push({ v: c, d: cur.d + 1, holder: null, path: cur.path }); }); } catch (e) {}
        continue;
      }
      let keys; try { keys = Object.keys(v); } catch (e) { continue; }
      const lim = Math.min(keys.length, 3000);
      for (let i = 0; i < lim; i++) {
        const k = keys[i]; let c;
        if (o.safe) { c = own(v, k); } else { try { c = v[k]; } catch (e) { continue; } }
        if (c && (typeof c === 'object' || typeof c === 'string')) stack.push({ v: c, d: cur.d + 1, holder: v, path: cur.path ? cur.path + '.' + k : k });
      }
      let syms = null; try { syms = Object.getOwnPropertySymbols(v); } catch (e) {} // dane ukryte pod kluczami Symbol
      if (syms && syms.length) for (let i = 0; i < syms.length && i < 40; i++) {
        const sk = syms[i]; let c; if (o.safe) c = own(v, sk); else { try { c = v[sk]; } catch (e) { continue; } }
        if (c && (typeof c === 'object' || typeof c === 'string')) stack.push({ v: c, d: cur.d + 1, holder: v, path: (cur.path ? cur.path + '.' : '') + '[' + (sk.description || 'Symbol') + ']' });
      }
    }
    if (!sched.inTask) cpuCharge(now() - t0);
    return found;
  }

  // Wyłuskiwanie adresów napisów z dowolnego tekstu (np. kodu skryptu w <script>)
  const RX_URL_ABS = new RegExp('(?:https?:)?//[^\\s"\'<>`\\\\)(,;]+?\\.(?:' + SUB_EXT + ')(?:\\?[^\\s"\'<>`\\\\)]*)?(?=$|["\'\\s<>`\\\\),;])', 'gi');
  const RX_URL_REL = new RegExp('["\'](/[^\\s"\'<>`\\\\]+?\\.(?:' + SUB_EXT + ')(?:\\?[^\\s"\'<>`\\\\]*)?)["\']', 'gi');
  function extractUrlsFromText(text, layer, base) {
    if (!RX.subExtLoose.test(text)) return 0;
    const t = text.indexOf('\\') !== -1 ? text.replace(/\\u0026/gi, '&').replace(/\\\//g, '/') : text;
    let n = 0, m;
    RX_URL_ABS.lastIndex = 0;
    while ((m = RX_URL_ABS.exec(t)) && n < 60) { if (addItem({ url: m[0], base: base, layer: layer, strong: true })) n++; }
    RX_URL_REL.lastIndex = 0;
    while ((m = RX_URL_REL.exec(t)) && n < 60) { if (addItem({ url: m[1], base: base, layer: layer, strong: true })) n++; }
    return n;
  }

  /* ═══════════════ 7. MANIFESTY HLS/DASH, SEGMENTY, MP4 ═══════════════ */

  function parseAttrList(s) {
    const o = {}; const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g; let m;
    while ((m = re.exec(s))) o[m[1]] = m[2].charAt(0) === '"' ? m[2].slice(1, -1) : m[2];
    return o;
  }
  function parseM3U8(text, base) {
    const out = { subs: [], segments: [], durs: [], init: '', master: false, vod: false };
    const lines = text.replace(/\r/g, '').split('\n'); let expect = false, dur = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim(); if (!l) continue;
      if (l.indexOf('#EXT-X-MEDIA:') === 0) {
        out.master = true;
        const a = parseAttrList(l.slice(13));
        if (/^SUBTITLES$/i.test(a.TYPE || '') && a.URI) out.subs.push({ url: toAbs(a.URI, base), lang: a.LANGUAGE || '', label: a.NAME || '', forced: a.FORCED === 'YES', auto: /auto/i.test(a.NAME || '') });
      } else if (l.indexOf('#EXT-X-STREAM-INF') === 0) out.master = true;
      else if (l.indexOf('#EXT-X-MAP:') === 0) { const a = parseAttrList(l.slice(11)); if (a.URI) out.init = toAbs(a.URI, base); }
      else if (l.indexOf('#EXTINF') === 0) { expect = true; dur = parseFloat(l.slice(8)) || 0; }
      else if (l.indexOf('#EXT-X-ENDLIST') === 0 || /^#EXT-X-PLAYLIST-TYPE:VOD/.test(l)) out.vod = true;
      else if (l.charAt(0) !== '#') { if (expect) { const u = toAbs(l, base); if (u) { out.segments.push(u); out.durs.push(dur); } } expect = false; }
    }
    return out;
  }
  function handleM3U8(text, url, layer) {
    const pl = parseM3U8(text, url);
    if (pl.vod && !pl.master && pl.segments.length) { let tt = 0; for (let i = 0; i < pl.segments.length && store.segTime.size < 30000; i++) { store.segTime.set(noHash(pl.segments[i]), tt); tt += pl.durs[i] || 0; } } // czasy segmentów (VOD) — do osadzania napisów zamkniętych na osi czasu
    for (const s of pl.subs) {
      if (!s.url) continue;
      store.hlsSubKeys.add(keyFor(s.url));
      addItem({ url: s.url, layer: 'HLS', kind: 'hls', strong: true, format: 'hls', lang: s.lang, label: s.label, forced: s.forced, auto: s.auto, note: 'ścieżka z manifestu HLS' });
    }
    if (!pl.segments.length || !url) return;
    const isSub = store.hlsSubKeys.has(keyFor(url)) || pl.segments.slice(0, 6).some(function (u) { return /\.(vtt|webvtt)(?=$|[?#])/i.test(u); });
    if (!isSub) return;
    const it = addItem({ url: url, layer: 'HLS', kind: 'hls', strong: true, format: 'hls', note: pl.segments.length + ' segmentów' });
    if (it) { it.layers.add(layer); for (const s of pl.segments) store.hlsSeg.set(noHash(s), it); }
  }
  function handleMPD(text, url) {
    const firstSet = text.indexOf('<AdaptationSet');
    let base = url; const pre = firstSet === -1 ? text : text.slice(0, firstSet);
    const reB = /<BaseURL[^>]*>([^<]+)<\/BaseURL>/g; let m;
    while ((m = reB.exec(pre))) base = toAbs(decodeEntities(m[1].trim()), base) || base;
    const sets = text.match(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/g) || [];
    for (const s of sets) {
      if (!/contentType="text"|mimeType="(?:text\/vtt|application\/ttml\+xml|application\/x-sami)"|codecs="(?:stpp|wvtt)/i.test(s)) continue;
      const head = (/<AdaptationSet\b([^>]*)>/.exec(s) || [])[1] || '';
      const lang = xmlAttr(head, 'lang') || ''; const label = (/<Label[^>]*>([^<]*)</.exec(s) || [])[1] || '';
      const segmented = /<Segment(?:Template|List)\b/.test(s);
      const reps = s.match(/<Representation\b[\s\S]*?(?:<\/Representation>|\/>)/g) || [];
      let direct = 0;
      for (const r of reps) { const bu = /<BaseURL[^>]*>([^<]+)<\/BaseURL>/.exec(r); if (bu && !segmented) { if (addItem({ url: toAbs(decodeEntities(bu[1].trim()), base), layer: 'DASH', strong: true, lang: lang, label: label, note: 'ścieżka z manifestu DASH' })) direct++; } }
      if (!direct) reportOnce('mpd:' + url + lang, 'DASH', 'segmentowana ścieżka tekstowa' + (lang ? ' [' + lang + ']' : '') + ' — złożę ją z segmentów pobieranych przez odtwarzacz');
    }
  }

  function segKey(url) {
    try {
      const u = new URL(url); const parts = u.pathname.split('/'); const last = (parts.pop() || '').replace(/\d+/g, '#');
      return u.origin + parts.join('/').replace(/\/\d+(?=\/|$)/g, '/#') + '/' + last;
    } catch (e) { return String(url).replace(/\d+/g, '#'); }
  }
  function mergeSegments(list) {
    let base = null; const all = [];
    for (const s of list) {
      if (!s || !s.cues) continue; let shift = 0;
      if (s.tsMap) { if (!base) base = s.tsMap; shift = (s.tsMap.mpegts - base.mpegts) / 90000 - (s.tsMap.local - base.local); }
      for (const c of s.cues) all.push({ start: c.start + shift, end: c.end + shift, text: c.text });
    }
    return normalizeCues(all);
  }
  // Segmenty bez znanej playlisty (HLS z X-TIMESTAMP-MAP, tekst w MP4) składamy w jedno znalezisko
  // Leniwe scalanie: kwestie z segmentów łączymy dopiero, gdy ktoś ich potrzebuje (panel, pobieranie, API), a nie po każdym segmencie
  function lazyCues(it, compute) {
    it._compute = compute; it._dirty = true;
    if (it._lazy) return; it._lazy = true;
    let val = it.cues;
    Object.defineProperty(it, 'cues', { configurable: true, enumerable: true,
      get: function () { if (it._dirty && it._compute) { it._dirty = false; val = it._compute(); } return val; },
      set: function (v) { val = v; it._dirty = false; it._compute = null; } });
  }
  function groupSegment(url, id, cues, tsMap, layer, fmt, meta) {
    meta = meta || {};
    const gk = 'g:' + (url ? segKey(url) : layer) + (meta.extra ? '#' + meta.extra : '');
    let it = store.items.get(gk);
    if (!it) it = addItem({ key: gk, url: url, layer: layer, kind: 'segments', strong: true, format: fmt, lang: meta.lang || (url ? langFromUrl(url) : ''), label: meta.label || '', note: 'składane z segmentów' });
    if (!it) return null;
    if (!it.segMap) it.segMap = new Map();
    if (it.segMap.has(id)) return it;
    it.segMap.set(id, { cues: cues, tsMap: tsMap });
    it.segments = it.segMap.size; it.layers.add(layer);
    lazyCues(it, function () { return mergeSegments(Array.from(it.segMap.values())); });
    if (cues && cues.length) it.verified = true;
    it.touched = Date.now();
    uiDirty();
    return it;
  }

  // ── Tekst w kontenerze MP4 (DASH/CMAF): „stpp" = TTML w mdat, „wvtt" = WebVTT w pudełkach vttc/payl ──
  const mp4Scale = new Map(); // katalog segmentów → timescale z segmentu inicjującego
  function isISOBMFF(b) {
    if (!b || b.length < 12) return false;
    const t = String.fromCharCode(b[4], b[5], b[6], b[7]);
    return t === 'ftyp' || t === 'styp' || t === 'moof' || t === 'moov' || t === 'sidx' || t === 'emsg' || t === 'prft';
  }
  function mp4Boxes(dv, start, end, cb) {
    let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p), hdr = 8;
      const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
      if (size === 1) { if (p + 16 > end) return; size = dv.getUint32(p + 8) * 4294967296 + dv.getUint32(p + 12); hdr = 16; }
      else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) return;
      if (cb(type, p + hdr, p + size) === false) return;
      p += size;
    }
  }
  function parseMP4Text(u8, ctx) {
    ctx = ctx || {};
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const out = { cues: [], isText: false, timescale: 0, codec: '' };
    const CONT = { moov: 1, trak: 1, mdia: 1, minf: 1, stbl: 1, moof: 1, traf: 1 };
    let frag = null;
    const push = function (s, e, t) {
      t = cleanCueText(t); if (!t) return;
      const p = out.cues[out.cues.length - 1];
      if (p && p.text === t && Math.abs(p.end - s) < 0.02) p.end = e; else out.cues.push({ start: s, end: e, text: t });
    };
    const mdat = function (bs, be) {
      const head = decodeWith(u8.subarray(bs, Math.min(be, bs + 400)), 'utf-8');
      if (/<\?xml|<(?:\w+:)?tt[\s>]/.test(head)) { // stpp
        out.isText = true; out.codec = 'stpp';
        const c = parseTTML(decodeWith(u8.subarray(bs, be), 'utf-8'));
        for (let i = 0; i < c.length; i++) out.cues.push(c[i]);
        return;
      }
      const ts = ctx.timescale || out.timescale || 1000;
      let t = frag ? frag.base : 0, p = bs;
      const smp = (frag && frag.samples.length && frag.samples.every(function (s) { return s.size > 0; })) ? frag.samples : [{ size: be - bs, dur: frag && frag.samples.length ? frag.samples.reduce(function (a, s) { return a + s.dur; }, 0) : 0 }];
      for (let i = 0; i < smp.length && p < be; i++) {
        const se = Math.min(p + smp[i].size, be); const t0 = t, t1 = t + smp[i].dur;
        mp4Boxes(dv, p, se, function (type, cs, ce) {
          if (type === 'vtte') { out.isText = true; out.codec = 'wvtt'; return; }
          if (type !== 'vttc') return;
          out.isText = true; out.codec = 'wvtt';
          mp4Boxes(dv, cs, ce, function (t2, ps, pe) { if (t2 === 'payl') push(t0 / ts, t1 / ts, decodeWith(u8.subarray(ps, pe), 'utf-8')); });
        });
        t = t1; p = se;
      }
    };
    const walk = function (s, e) {
      mp4Boxes(dv, s, e, function (type, bs, be) {
        if (CONT[type]) { if (type === 'moof') frag = { base: 0, defDur: 0, defSize: 0, samples: [] }; walk(bs, be); return; }
        if (type === 'mdhd' && be - bs >= 24) { const ver = dv.getUint8(bs); out.timescale = dv.getUint32(bs + (ver === 1 ? 20 : 12)); }
        else if (type === 'hdlr' && be - bs >= 12) { const hd = String.fromCharCode(dv.getUint8(bs + 8), dv.getUint8(bs + 9), dv.getUint8(bs + 10), dv.getUint8(bs + 11)); if (hd === 'text' || hd === 'subt' || hd === 'sbtl') out.isText = true; }
        else if (type === 'stsd') { const s2 = decodeWith(u8.subarray(bs, Math.min(be, bs + 64)), 'latin1'); if (s2.indexOf('wvtt') !== -1) { out.codec = 'wvtt'; out.isText = true; } else if (s2.indexOf('stpp') !== -1) { out.codec = 'stpp'; out.isText = true; } }
        else if (type === 'tfhd' && frag) { const fl = dv.getUint32(bs) & 0xFFFFFF; let q = bs + 8; if (fl & 1) q += 8; if (fl & 2) q += 4; if (fl & 8) { frag.defDur = dv.getUint32(q); q += 4; } if (fl & 16) frag.defSize = dv.getUint32(q); }
        else if (type === 'tfdt' && frag) { const ver = dv.getUint8(bs); frag.base = ver === 1 ? dv.getUint32(bs + 4) * 4294967296 + dv.getUint32(bs + 8) : dv.getUint32(bs + 4); }
        else if (type === 'trun' && frag) {
          const fl = dv.getUint32(bs) & 0xFFFFFF; const count = dv.getUint32(bs + 4); let q = bs + 8;
          if (fl & 1) q += 4; if (fl & 4) q += 4;
          for (let i = 0; i < count && q <= be && i < 5000; i++) {
            const sm = { dur: frag.defDur, size: frag.defSize };
            if (fl & 0x100) { sm.dur = dv.getUint32(q); q += 4; }
            if (fl & 0x200) { sm.size = dv.getUint32(q); q += 4; }
            if (fl & 0x400) q += 4; if (fl & 0x800) q += 4;
            frag.samples.push(sm);
          }
        }
        else if (type === 'mdat') { try { mdat(bs, be); } catch (e) {} }
      });
    };
    try { walk(0, u8.byteLength); } catch (e) {}
    return out;
  }

  /* ═══════════════ 8. OBSŁUGA TREŚCI Z SIECI ═══════════════ */

  /* ── Napisy wbudowane w obraz i kontenery: CEA-608/708 (wideo, MPEG-TS, c608/c708), tekst MP4 (tx3g), Matroska/WebM ── */
  const ccState = { groups: new Map() };
  function ccDir(url) { return url ? segKey(url).replace(/\/[^\/]*$/, '') : ''; }
  function ccGroup(url) {
    const key = ccDir(url) || 'x'; let g = ccState.groups.get(key);
    if (!g) { if (ccState.groups.size >= 12) return null; g = { key: key, n: 0, found: false, sink: null, ptsBase: null, timer: 0 }; ccState.groups.set(key, g); }
    return g;
  }
  // Sondujemy kilka pierwszych segmentów każdego strumienia; gdy nie ma w nich napisów zamkniętych, odpuszczamy (z rzadkim ponowieniem)
  function ccWanted(url) { if (!CFG.inbandCC) return false; const g = ccGroup(url); if (!g) return false; return g.found || g.n < 4 || g.n % 25 === 0; }
  function ccApply(g, tracks) {
    tracks.forEach(function (t) {
      if (!t.cues || !t.cues.length) return;
      const it = addItem({ key: 'cc:' + g.key + ':' + t.id, layer: 'CC', kind: 'segments', strong: true, cues: t.cues, normalized: !!t.normalized, format: t.kind, label: t.id + (t.kind === 'cea708' ? ' · CEA-708' : ' · CEA-608'), note: 'napisy zamknięte wbudowane w obraz (' + (t.kind === 'cea708' ? 'CEA-708' : 'CEA-608') + ')' });
      if (it) it.ccKey = g.key;
    });
  }
  function ccPublishNow(g) { // świeży wynik dekodera (z wątku roboczego albo lokalnie)
    if (g.viaWorker && pw.ready) return pwCall({ op: 'ccResult', key: g.key }).then(function (d) { ccApply(g, (d.tracks || []).map(function (t) { return { id: t.id, kind: t.kind, cues: unpackCues(t.cues), normalized: true }; })); });
    if (g.sink) ccApply(g, g.sink.result());
    return Promise.resolve();
  }
  function ccSchedule(g) { if (!g.timer) g.timer = setTimeout(function () { g.timer = 0; ccPublishNow(g).catch(noop); }, 3000); }
  function handleInband(bytes, url, layer, owned) {
    const g = ccGroup(url); if (!g) return false;
    g.n++;
    if (pwUsable() && bytes.length >= 65536) { // duży segment: dekodowanie w wątku roboczym (stan dekoderów trzyma worker)
      const segT = url ? store.segTime.get(noHash(url)) : undefined; const buf = ownBuffer(bytes, owned); g.viaWorker = true;
      pwCall({ op: 'cc', key: g.key, dir: ccDir(url), bytes: buf, segT: segT == null ? null : segT }, [buf]).then(function (d) {
        (d.texts || []).forEach(function (x) { groupSegment(url, url || String(Date.now()), unpackCues(x[1]), null, 'MP4', 'vtt', { extra: 'tx3g' + x[0], label: 'tekst MP4 (tx3g)' }); });
        if (d.n > 0) g.found = true;
        if (g.found) ccSchedule(g);
      }, function () { if (bytes.byteLength) guard(function () { handleInbandLocal(g, bytes, url); }); });
      return true;
    }
    return handleInbandLocal(g, bytes, url);
  }
  function handleInbandLocal(g, bytes, url) {
    let n = 0;
    if (isISOBMFF(bytes)) {
      const dir = ccDir(url); if (!g.sink) g.sink = createCcSink();
      const r = parseMP4Media(bytes, { tracks: mp4Tracks.get(dir) || null, sink: g.sink });
      if (r.tracks && r.tracks.size) mp4Tracks.set(dir, r.tracks);
      n = r.cc;
      r.texts.forEach(function (cues, tid) { groupSegment(url, url || String(Date.now()), cues, null, 'MP4', 'vtt', { extra: 'tx3g' + tid, label: 'tekst MP4 (tx3g)' }); });
    } else if (isTS(bytes)) {
      const d = demuxTSVideo(bytes); let first = null;
      for (let i = 0; i < d.pes.length; i++) if (d.pes[i].pts != null) { first = d.pes[i].pts; break; }
      if (first == null) return false;
      if (!g.sink) g.sink = createCcSink();
      if (g.ptsBase == null) g.ptsBase = first;
      const segT = url ? store.segTime.get(noHash(url)) : undefined;
      for (let i = 0; i < d.pes.length; i++) { const p = d.pes[i]; if (p.pts == null) continue; n += annexBScan(p.data, d.vtype, g.sink, segT != null ? segT + (p.pts - first) : p.pts - g.ptsBase); }
    }
    if (n > 0) g.found = true;
    if (g.found) ccSchedule(g);
    return n > 0;
  }
  const mkvDirs = new Map();
  function handleMatroska(bytes, url, layer, owned) {
    const dir = ccDir(url);
    if (pwUsable()) {
      const buf = ownBuffer(bytes, owned);
      pwCall({ op: 'mkv', bytes: buf, dir: dir }, [buf]).then(function (d) {
        const tm = new Map((d.tracks || []).map(function (t) { return [t.num, t]; }));
        (d.cues || []).forEach(function (x) { const tr = tm.get(x[0]) || {}; groupSegment(url, url || String(Date.now()), unpackCues(x[1]), null, 'MKV', /WEBVTT/i.test(tr.codec || '') ? 'vtt' : 'srt', { lang: tr.lang, label: tr.name || tr.codec, extra: 'mkv' + x[0] }); });
        (d.bitmap || []).forEach(function (t) { reportOnce('bmp:' + dir + t.num, 'MKV', 'ścieżka napisów bitmapowych (' + t.codec + (t.lang ? ', ' + t.lang : '') + ') — to obrazki, nie tekst; do odczytu potrzebny OCR'); });
      }, function () { if (bytes.byteLength) handleMatroskaLocal(bytes, url, dir); });
      return;
    }
    handleMatroskaLocal(bytes, url, dir);
  }
  function handleMatroskaLocal(bytes, url, dir) {
    parseMatroska(bytes, mkvDirs.get(dir)).then(function (r) {
      if (r.tracks.size) mkvDirs.set(dir, r.tracks);
      r.cues.forEach(function (cues, num) {
        const tr = r.tracks.get(num) || {};
        groupSegment(url, url || String(Date.now()), cues, null, 'MKV', /WEBVTT/i.test(tr.codec) ? 'vtt' : 'srt', { lang: tr.lang, label: tr.name || tr.codec, extra: 'mkv' + num });
      });
      r.bitmap.forEach(function (t) { reportOnce('bmp:' + dir + t.num, 'MKV', 'ścieżka napisów bitmapowych (' + t.codec + (t.lang ? ', ' + t.lang : '') + ') — to obrazki, nie tekst; do odczytu potrzebny OCR'); });
    }).catch(function (e) { dbg('mkv', e); });
  }

  /* ═══ 19. WĄTEK ROBOCZY: ciężkie parsowanie poza głównym wątkiem (duże pliki, segmenty wideo, MKV) ═══
   * Worker powstaje dopiero przy pierwszej potrzebie (nie na każdej stronie). Gdy CSP strony go zablokuje,
   * wszystko liczy się jak dawniej na głównym wątku. Kod workera to te same funkcje parserów (serializowane).
   */
  const pw = { w: null, state: 'nieuruchomiony', seq: 0, pend: new Map(), queue: [], ready: false, failed: false, jobs: 0, to: 0, errors: 0, lastErr: '' };
  function pwMain() { // uruchamiane WEWNĄTRZ workera
    const pack = function (cues) { const n = cues.length, s = new Float64Array(n), e = new Float64Array(n), t = new Array(n); for (let i = 0; i < n; i++) { s[i] = cues[i].start; e[i] = cues[i].end; t[i] = cues[i].text; } return { s: s, e: e, t: t.join('\u0001') }; };
    const xfer = function (p, list) { list.push(p.s.buffer, p.e.buffer); return p; };
    const groups = new Map(), mp4T = new Map(), mkvD = new Map();
    self.onmessage = async function (ev) {
      const m = ev.data || {}, out = { id: m.id }, tl = [];
      try {
        if (m.op === 'init') { PREF = m.langs || []; out.ok = true; }
        else if (m.op === 'parse') {
          const p = parseAnyRaw(m.text, m.hint);
          if (!p) out.res = null;
          else if (p.manifest || !p.cues) out.res = { format: p.format, manifest: !!p.manifest };
          else out.res = { format: p.format, cues: xfer(pack(normalizeCues(p.cues)), tl), tsMap: p.tsMap || null, lang: p.lang || '', variants: (p.variants || []).map(function (v) { return { cls: v.cls, lang: v.lang, label: v.label, cues: xfer(pack(normalizeCues(v.cues)), tl) }; }) };
        } else if (m.op === 'cc') {
          const u8 = new Uint8Array(m.bytes); let g = groups.get(m.key); if (!g) { g = { sink: createCcSink(), ptsBase: null }; groups.set(m.key, g); }
          let n = 0; const texts = [];
          if (isISOBMFF(u8)) { const r = parseMP4Media(u8, { tracks: mp4T.get(m.dir) || null, sink: g.sink }); if (r.tracks && r.tracks.size) mp4T.set(m.dir, r.tracks); n = r.cc; r.texts.forEach(function (c, tid) { texts.push([tid, xfer(pack(c), tl)]); }); }
          else if (isTS(u8)) {
            const d = demuxTSVideo(u8); let first = null;
            for (let i = 0; i < d.pes.length; i++) if (d.pes[i].pts != null) { first = d.pes[i].pts; break; }
            if (first != null) { if (g.ptsBase == null) g.ptsBase = first; for (let i = 0; i < d.pes.length; i++) { const p = d.pes[i]; if (p.pts == null) continue; n += annexBScan(p.data, d.vtype, g.sink, m.segT != null ? m.segT + (p.pts - first) : p.pts - g.ptsBase); } }
          }
          out.n = n; out.texts = texts;
        } else if (m.op === 'ccResult') {
          const g = groups.get(m.key);
          out.tracks = g ? g.sink.result().filter(function (t) { return t.cues.length; }).map(function (t) { return { id: t.id, kind: t.kind, cues: xfer(pack(normalizeCues(t.cues)), tl) }; }) : [];
        } else if (m.op === 'mkv') {
          const r = await parseMatroska(new Uint8Array(m.bytes), mkvD.get(m.dir)); if (r.tracks.size) mkvD.set(m.dir, r.tracks);
          out.tracks = Array.from(r.tracks.values()).map(function (t) { return { num: t.num, codec: t.codec, lang: t.lang, name: t.name }; });
          out.cues = Array.from(r.cues.entries()).map(function (x) { return [x[0], xfer(pack(x[1]), tl)]; });
          out.bitmap = r.bitmap.map(function (t) { return { num: t.num, codec: t.codec, lang: t.lang }; });
        }
      } catch (e) { out.err = String((e && e.message) || e); }
      self.postMessage(out, tl);
    };
    self.postMessage({ ready: true });
  }
  function pwSource() {
    const fns = [['decodeEntities', decodeEntities], ['tidyLines', tidyLines], ['cleanCueText', cleanCueText], ['cleanXmlText', cleanXmlText], ['decodeWith', decodeWith], ['parseClock', parseClock], ['parseVTT', parseVTT], ['xmlAttr', xmlAttr], ['ttmlTime', ttmlTime], ['parseTTML', parseTTML], ['parseXmlTimed', parseXmlTimed], ['parseSBV', parseSBV], ['parseASS', parseASS], ['parseLRC', parseLRC], ['sniffFormat', sniffFormat], ['normLang', normLang], ['parseSAMIAll', parseSAMIAll], ['textOf', textOf], ['numOf', numOf], ['pickKey', pickKey], ['cuesFromArray', cuesFromArray], ['collectByKey', collectByKey], ['findCueArray', findCueArray], ['cuesFromJSONDoc', cuesFromJSONDoc], ['normalizeCues', normalizeCues], ['createLineTracker', createLineTracker], ['createCea608', createCea608], ['createDtvcc', createDtvcc], ['createCcSink', createCcSink], ['parseSCC', parseSCC], ['unescapeRbsp', unescapeRbsp], ['seiScan', seiScan], ['nalSamples', nalSamples], ['av1Samples', av1Samples], ['annexBScan', annexBScan], ['isTS', isTS], ['demuxTSVideo', demuxTSVideo], ['mp4Boxes', mp4Boxes], ['isISOBMFF', isISOBMFF], ['mp4Init', mp4Init], ['parseMP4Media', parseMP4Media], ['isEBML', isEBML], ['ebmlId', ebmlId], ['ebmlSize', ebmlSize], ['ebmlChildren', ebmlChildren], ['mkvInflate', mkvInflate], ['mkvText', mkvText], ['parseMatroska', parseMatroska], ['parseAnyRaw', parseAnyRaw]];
    const obj = function (o) { return 'Object.assign(Object.create(null), ' + JSON.stringify(o) + ')'; };
    let s = '"use strict";\nconst W = self, O = { decode: null, jsonParse: JSON.parse }, dbg = function () {}, noop = function () {};\n';
    s += 'const ENT = ' + obj(ENT) + ', LANG3 = ' + obj(LANG3) + ', C608_BASIC = ' + obj(C608_BASIC) + ', C608_ROW = ' + obj(C608_ROW) + ', MKV_TOP = ' + obj(MKV_TOP) + ';\n';
    s += 'const C608_SPECIAL = ' + JSON.stringify(C608_SPECIAL) + ', C608_EXT1 = ' + JSON.stringify(C608_EXT1) + ', C608_EXT2 = ' + JSON.stringify(C608_EXT2) + ', TKEY = ' + JSON.stringify(TKEY) + ', EKEY = ' + JSON.stringify(EKEY) + ', DKEY = ' + JSON.stringify(DKEY) + ', XKEY = ' + JSON.stringify(XKEY) + ';\n';
    s += 'const LANG2 = new Set(' + JSON.stringify(Array.from(LANG2)) + ');\nlet PREF = [];\nfunction prefLangs() { return PREF; }\n';
    for (let i = 0; i < fns.length; i++) { const src = fns[i][1].toString(); s += (/^(async\s+)?function\s*\*?\s*[\w$]+\s*\(/.test(src) ? src : 'const ' + fns[i][0] + ' = ' + src + ';') + '\n'; }
    return s + '(' + pwMain.toString() + ')();\n';
  }
  function pwUsable() { return !!CFG.useWorker && !pw.failed && typeof O.Worker === 'function'; }
  function pwSend(x) {
    x.msg.id = ++pw.seq; pw.pend.set(x.msg.id, x); pw.jobs++;
    try { (O.workerPost || pw.w.postMessage).call(pw.w, x.msg, x.transfer); } catch (e) { pw.pend.delete(x.msg.id); x.reject(e); }
  }
  function pwFail(why) {
    if (pw.failed) return; pw.failed = true; pw.ready = false; pw.state = 'niedostępny (' + why + ')';
    try { if (pw.w) pw.w.terminate(); } catch (e) {} pw.w = null; clearTimeout(pw.to);
    report('Skan', 'wątek roboczy niedostępny (' + why + ') — parsuję na głównym wątku');
    pw.pend.forEach(function (x) { x.reject(new Error('worker')); }); pw.pend.clear();
    pw.queue.splice(0).forEach(function (x) { x.reject(new Error('worker')); });
  }
  function pwStart() {
    if (pw.w || pw.failed) return;
    try {
      const mk = O.createObjectURL || W.URL.createObjectURL; const u = mk.call(W.URL, new W.Blob([pwSource()], { type: 'text/javascript' })); ownWorkerUrls.add(u);
      const w = new O.Worker(u); pw.w = w; pw.state = 'uruchamianie';
      w.onmessage = function (ev) {
        const d = ev.data || {};
        if (d.ready) { pw.ready = true; pw.state = 'działa'; clearTimeout(pw.to); pw.queue.splice(0).forEach(pwSend); return; }
        const x = pw.pend.get(d.id); if (!x) return; pw.pend.delete(d.id);
        if (d.err) { pw.errors++; pw.lastErr = d.err; dbg('worker', d.err); x.reject(new Error(d.err)); } else x.resolve(d);
      };
      w.onerror = function (e) { pwFail((e && e.message) || 'błąd uruchomienia'); };
      pw.to = setTimeout(function () { if (!pw.ready) pwFail('brak odpowiedzi — prawdopodobnie blokada CSP'); }, 4000);
      pw.queue.unshift({ msg: { op: 'init', langs: prefLangs(), __ush: 1 }, transfer: [], resolve: noop, reject: noop });
    } catch (e) { pw.failed = true; pw.state = 'niedostępny (' + errMsg(e) + ')'; }
  }
  function pwCall(msg, transfer) {
    return new Promise(function (resolve, reject) {
      if (!pwUsable()) return reject(new Error('worker'));
      pwStart(); if (pw.failed) return reject(new Error('worker'));
      msg.__ush = 1; const x = { msg: msg, transfer: transfer || [], resolve: resolve, reject: reject };
      if (pw.ready) pwSend(x); else pw.queue.push(x);
    });
  }
  function unpackCues(p) { if (!p || !p.s) return []; const t = p.t ? p.t.split('\u0001') : []; const out = new Array(p.s.length); for (let i = 0; i < out.length; i++) out[i] = { start: p.s[i], end: p.e[i], text: t[i] }; return out; }
  function ownBuffer(bytes, owned) { // bufor do przekazania: własny przekazujemy bez kopiowania, cudzy (strony) — kopiujemy
    return (owned && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) ? bytes.buffer : bytes.slice().buffer;
  }
  // Parsowanie dużego tekstu w wątku; wynik (także awaryjnie liczony lokalnie) ląduje w pamięci podręcznej parsowania
  function parseInWorker(text, hint) {
    return pwCall({ op: 'parse', text: text, hint: hint || '' }).then(function (d) {
      const r = d.res; let res = null;
      if (r) {
        res = { format: r.format, manifest: !!r.manifest };
        if (r.cues) { res.cues = unpackCues(r.cues); res.tsMap = r.tsMap; res.lang = r.lang; res.normalized = true; const v = (r.variants || []).map(function (x) { return { cls: x.cls, lang: x.lang, label: x.label, cues: unpackCues(x.cues) }; }); if (v.length) res.variants = v; }
      }
      pcPut(text, hint || '', res); return res;
    }, function () { const res = parseAnyRaw(text, hint); pcPut(text, hint || '', res); return res; });
  }

  // 0 = pomiń, 1 = sprawdź treść (zapisz tylko rozpoznane), 2 = pewny trop (zapisz adres nawet bez treści)
  function interest(url, ct, len) {
    if (!url) return 0;
    if (RX.thumbs.test(url)) return 0;
    if (RX.subExt.test(url) || RX.endpoint.test(url) || RX.ctSub.test(ct)) return 2;
    if (RX.manifest.test(url) || RX.ctManifest.test(ct)) return 2;
    if (CFG.inbandCC && (RX.ctVideoSeg.test(ct) || (RX.segUrl.test(url) && !/^(image|font|audio)\/|text\/html|json|javascript|css/i.test(ct))) && (!len || len <= CFG.maxVideoBytes) && ccWanted(url)) return 3; // segment wideo: szukamy napisów zamkniętych i ścieżek tekstowych
    const kw = RX.keyword.test(url);
    if (RX.ctMp4.test(ct)) return (len > 0 && len <= (kw ? CFG.maxSniffBytes : 300000)) ? 1 : 0;
    if (RX.ctSkip.test(ct)) return 0;
    if (RX.notSub.test(url)) return 0;
    if (len > CFG.maxBodyBytes) return 0;
    if (!ct) return kw ? 1 : 0;
    return 1; // json, xml, text/plain i podobne
  }
  function ytRemember(url) { // zapamiętaj parametry, z którymi odtwarzacz YouTube pobrał napisy
    try {
      if (!url || !RX.ytTimed.test(url)) return;
      const q = new URL(url).searchParams; const v = q.get('v'); if (!v || !q.get('pot')) return;
      const ex = {};
      ['pot', 'potc', 'c', 'cver', 'cplayer', 'cos', 'cosver', 'cplatform', 'cbr', 'cbrver', 'xorb', 'xobt', 'xovt', 'fmt'].forEach(function (k) { const val = q.get(k); if (val != null) ex[k] = val; });
      yt.extras[v] = ex;
    } catch (e) {}
  }
  function handleSubText(text, fmt, url, layer) {
    ytRemember(url);
    const h = hashStr(text);
    const known = store.byHash.get(h);
    if (known) { // ta sama treść już jest — dopisz tylko warstwę/adres
      if (!known._rep.has(layer)) { known._rep.add(layer); known.layers.add(layer); report(layer, 'te same napisy także w tej warstwie', known.url ? shortUrl(known.url, 110) : ''); uiDirty(); }
      if (url && known.urls.indexOf(url) === -1 && known.kind === 'file') known.urls.push(url);
      return known;
    }
    if (text.length >= CFG.workerMinBytes && pwUsable() && !pcGet(text, fmt)) { parseInWorker(text, fmt).then(function () { guard(function () { handleSubText(text, fmt, url, layer); }); }); return null; }
    const p = parseAny(text, fmt); const cues = p && p.cues ? p.cues : null;
    const owner = url ? store.hlsSeg.get(noHash(url)) : null;
    if (owner) { // segment znanej playlisty HLS — odkładamy do jej pamięci podręcznej
      if (!owner.segMap) owner.segMap = new Map();
      owner.segMap.set(noHash(url), { cues: cues || [], tsMap: p ? p.tsMap : null });
      owner.segments = owner.segMap.size; owner.layers.add(layer); store.byHash.set(h, owner); uiDirty();
      return owner;
    }
    if (p && p.tsMap) { const g = groupSegment(url, url || h, cues || [], p.tsMap, layer, 'vtt'); if (g) store.byHash.set(h, g); return g; }
    return addItem({ url: url, layer: layer, text: text, format: p ? p.format : fmt, cues: cues, strong: true, preferUrl: RX.ytTimed.test(url || ''), variants: p ? p.variants : null, pLang: p ? p.lang : '', normalized: !!(p && p.normalized) });
  }
  function handleParsed(obj, url, layer, rawText, prio) {
    if (!obj || typeof obj !== 'object') return 0;
    const d = cuesFromJSONDoc(obj, false);
    if (d && d.cues.length >= 2) { ytRemember(url); return addItem({ url: url, layer: layer, cues: d.cues, format: d.format, text: rawText, strong: true, preferUrl: RX.ytTimed.test(url || '') }) ? 1 : 0; }
    return analyzeObject(obj, layer, { base: url || undefined, srcUrl: url || '', maxNodes: 25000, budget: 40, prio: prio });
  }
  function handleText(text, url, ct, layer, level) {
    if (!text) { if (level === 2 && url && (RX.subExt.test(url) || RX.ytTimed.test(url))) addItem({ url: url, layer: layer, strong: true }); return; }
    const fmt = sniffFormat(text);
    if (fmt === 'm3u8') return handleM3U8(text, url, layer);
    if (fmt === 'mpd') return handleMPD(text, url);
    if (fmt === 'json') {
      if (text.length < 40) return;
      if (level < 2 && !RX.jsonHint.test(text) && !(RX.cueA.test(text) && RX.cueB.test(text) && RX.cueC.test(text))) return;
      if (text.length >= CFG.workerMinBytes && pwUsable()) { // duży JSON: kwestie rozpoznaje wątek roboczy, adresy w środku — analiza w tle
        parseInWorker(text, 'json').then(function (p) {
          if (p && p.cues && p.cues.length >= 2) { ytRemember(url); addItem({ url: url, layer: layer, cues: p.cues, normalized: !!p.normalized, format: p.format, text: text.length < 3000000 ? text : null, strong: true, preferUrl: RX.ytTimed.test(url || '') }); }
          else task(function () { let o2; try { o2 = O.jsonParse(text); } catch (e) { return; } handleParsed(o2, url, layer, null, 'normal'); }, 'normal');
        });
        return;
      }
      let obj; try { obj = O.jsonParse(text); } catch (e) { return; }
      return handleParsed(obj, url, layer, text.length < 3000000 ? text : null);
    }
    if (fmt) return handleSubText(text, fmt, url, layer);
    if (level === 2 && url && RX.subExt.test(url)) addItem({ url: url, layer: layer, strong: true, text: text });
  }
  function handleBody(bytes, url, ct, layer, level, owned) {
    const lv = level === 3 ? 1 : level;
    if (!bytes || !bytes.length) return handleText('', url, ct, layer, lv);
    if (isEBML(bytes)) { handleMatroska(bytes, url, layer, owned); return; }
    if (isSTL(bytes)) { const c = parseSTL(bytes); if (c.length) addItem({ url: url, layer: layer, cues: c, format: 'stl', strong: true }); return; }
    if (isTS(bytes)) { if (CFG.inbandCC && ccWanted(url)) handleInband(bytes, url, layer, owned); return; }
    if (isISOBMFF(bytes)) {
      const dir = url ? segKey(url).replace(/\/[^\/]*$/, '') : '';
      const r = parseMP4Text(bytes, { timescale: mp4Scale.get(dir) || 0 });
      if (r.timescale && r.isText) mp4Scale.set(dir, r.timescale);
      if (r.isText && r.cues.length) {
        const owner = url ? store.hlsSeg.get(noHash(url)) : null;
        if (owner) { if (!owner.segMap) owner.segMap = new Map(); owner.segMap.set(noHash(url), { cues: r.cues, tsMap: null }); owner.segments = owner.segMap.size; uiDirty(); }
        else groupSegment(url, url || String(Date.now()), r.cues, null, 'MP4', r.codec === 'stpp' ? 'ttml' : 'vtt');
      }
      if (CFG.inbandCC && ccWanted(url)) handleInband(bytes, url, layer, owned);
      return;
    }
    const text = smartDecode(bytes, ct);
    if (text == null) return;
    handleText(text, url, ct, layer, lv);
  }
  // Czyta kopię odpowiedzi do limitu bajtów; większe strumienie porzuca
  async function readCapped(res, cap) {
    if (!res.body || !res.body.getReader) { const ab = await res.arrayBuffer(); return ab.byteLength <= cap ? new Uint8Array(ab) : null; }
    const reader = res.body.getReader(); const chunks = []; let total = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      total += r.value.byteLength;
      if (total > cap) { try { reader.cancel(); } catch (e) {} return null; }
      chunks.push(r.value);
    }
    const out = new Uint8Array(total); let p = 0;
    for (let i = 0; i < chunks.length; i++) { out.set(chunks[i], p); p += chunks[i].byteLength; }
    return out;
  }

  /* ═══════════════ 9. HOOKI ═══════════════ */

  function disguise(fn, orig) { // żeby strona widziała „natywną" funkcję
    try {
      Object.defineProperty(fn, 'toString', { value: function () { return Function.prototype.toString.call(orig); }, configurable: true, writable: true });
      Object.defineProperty(fn, 'name', { value: orig.name, configurable: true });
      Object.defineProperty(fn, '__ush', { value: true });
    } catch (e) {}
    return fn;
  }
  function setProp(obj, name, val) { try { obj[name] = val; if (obj[name] === val) return true; } catch (e) {} try { Object.defineProperty(obj, name, { value: val, configurable: true, writable: true }); return obj[name] === val; } catch (e) { return false; } }

  const resSeen = new WeakSet(), xhrTok = new WeakMap(), xhrDone = new WeakSet(); // gdy strona owinie nasz hook swoim, a my jej — bez podwójnej obróbki
  function onFetchResponse(res, url) {
    if (!SESJA) return;
    if (!res || resSeen.has(res)) return; resSeen.add(res);
    const u = toAbs(res.url || url) || String(url || '');
    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    const len = +(res.headers.get('content-length') || 0);
    const level = interest(u, ct, len);
    if (!level) return;
    const strongUrl = level === 2 && (RX.subExt.test(u) || RX.ytTimed.test(u));
    if (res.type === 'opaque' || res.type === 'opaqueredirect' || res.bodyUsed || (!res.ok && res.status !== 0)) { if (strongUrl && (res.ok || res.status === 0)) addItem({ url: u, layer: 'Fetch', strong: true }); return; }
    let clone; try { clone = res.clone(); } catch (e) { if (strongUrl) addItem({ url: u, layer: 'Fetch', strong: true }); return; }
    const cap = level === 3 ? CFG.maxVideoBytes : (RX.ctMp4.test(ct) ? CFG.maxSniffBytes : CFG.maxBodyBytes);
    readCapped(clone, cap).then(function (bytes) {
      if (bytes) guard(function () { handleBody(bytes, u, ct, 'Fetch', level, true); });
      else if (strongUrl) addItem({ url: u, layer: 'Fetch', strong: true });
    }).catch(function () { if (strongUrl) addItem({ url: u, layer: 'Fetch', strong: true }); });
  }
  function hookFetch(win) {
    const orig = win.fetch;
    if (typeof orig !== 'function' || orig.__ush) return;
    const wrapped = function fetch(input, init) {
      const p = orig.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && typeof input.url === 'string') ? input.url : String(input || '');
        if (CFG.hookOutbound && init && init.body != null) afterSend(outboundPrep(init.body, url, 'Fetch'));
        const hd = (init && init.headers) || (input && typeof input === 'object' && input.headers);
        if (hd && (RX.keyword.test(url) || RX.subExt.test(url) || RX.endpoint.test(url))) rememberHeaders(url, hd);
        p.then(function (res) { try { onFetchResponse(res, url); } catch (e) {} }, noop);
      } catch (e) {}
      return p;
    };
    setProp(win, 'fetch', disguise(wrapped, orig));
  }

  function handleXHR(xhr, meta) {
    if (!SESJA) return;
    if (!meta) return;
    const tok = xhrTok.get(xhr); if (tok) { if (xhrDone.has(tok)) return; xhrDone.add(tok); }
    if (xhr.status && (xhr.status < 200 || xhr.status >= 400)) return;
    const u = toAbs(xhr.responseURL || meta.url) || meta.url;
    if (meta.h && (RX.keyword.test(u) || RX.subExt.test(u) || RX.endpoint.test(u))) rememberHeaders(u, meta.h);
    let ct = '', len = 0;
    try { ct = String(xhr.getResponseHeader('content-type') || '').toLowerCase(); len = +(xhr.getResponseHeader('content-length') || 0); } catch (e) {}
    const rt = xhr.responseType;
    if (rt === '' || rt === 'text') {
      const level = interest(u, ct, len); if (!level) return;
      const t = xhr.responseText;
      if (typeof t === 'string' && t.length <= CFG.maxBodyBytes) handleText(t, u, ct, 'XHR', level);
    } else if (rt === 'json') {
      const obj = xhr.response;
      if (obj && typeof obj === 'object' && interest(u, ct || 'application/json', len)) handleParsed(obj, u, 'XHR', null);
    } else if (rt === 'arraybuffer') {
      const b = xhr.response;
      if (b && b.byteLength) { const level = interest(u, ct, b.byteLength); if (level && b.byteLength <= (level === 3 ? CFG.maxVideoBytes : (RX.ctMp4.test(ct) ? CFG.maxSniffBytes : CFG.maxBodyBytes))) handleBody(new Uint8Array(b), u, ct, 'XHR', level); }
    } else if (rt === 'blob') {
      const b = xhr.response;
      if (b && b.size) { const bct = ct || String(b.type || '').toLowerCase(); const level = interest(u, bct, b.size); if (level && b.size <= CFG.maxBodyBytes) b.arrayBuffer().then(function (ab) { guard(function () { handleBody(new Uint8Array(ab), u, bct, 'XHR', level, true); }); }).catch(noop); }
    } else if (rt === 'document') {
      if (RX.subExt.test(u)) addItem({ url: u, layer: 'XHR', strong: true });
    }
  }
  function hookXHR(win) {
    const X = win.XMLHttpRequest;
    if (!X || !X.prototype || X.prototype.open.__ush) return;
    const open = X.prototype.open; const meta = new WeakMap(); const bound = new WeakSet();
    const add = (win.EventTarget && win.EventTarget.prototype.addEventListener) || X.prototype.addEventListener;
    const onLoad = function () { try { handleXHR(this, meta.get(this)); } catch (e) {} };
    const wrapped = function open_(method, url) {
      try {
        meta.set(this, { method: String(method || 'GET'), url: String(url) }); xhrTok.set(this, {});
        if (!bound.has(this)) { bound.add(this); add.call(this, 'load', onLoad); } // przed handlerami strony (zanim np. odda bufor do workera)
      } catch (e) {}
      return open.apply(this, arguments);
    };
    setProp(X.prototype, 'open', disguise(wrapped, open));
    const send = X.prototype.send, srh = X.prototype.setRequestHeader;
    if (typeof send === 'function' && !send.__ush) setProp(X.prototype, 'send', disguise(function send_(body) { let job = null; try { if (body != null && CFG.hookOutbound) { const m = meta.get(this); job = outboundPrep(body, m ? m.url : '', 'XHR'); } } catch (e) {} const r = send.apply(this, arguments); afterSend(job); return r; }, send));
    if (typeof srh === 'function' && !srh.__ush) setProp(X.prototype, 'setRequestHeader', disguise(function setRequestHeader_(k, v) { try { const m = meta.get(this); if (m) (m.h || (m.h = {}))[k] = v; } catch (e) {} return srh.apply(this, arguments); }, srh));
  }

  const jsonSeen = new Set();
  function hookJSON(win) {
    win = win || W; const J = win.JSON; const orig = J && J.parse;
    if (typeof orig !== 'function' || orig.__ush) return;
    const wrapped = function parse(text) {
      const res = orig.apply(this, arguments);
      if (!SESJA) return res;
      try {
        if (typeof text === 'string' && text.length >= 200 && text.length <= 6000000 && res && typeof res === 'object' &&
            (RX.jsonHint.test(text) || (text.length > 600 && RX.cueA.test(text) && RX.cueB.test(text) && RX.cueC.test(text)))) {
          const fp = text.length + ':' + text.charCodeAt(text.length >> 1) + ':' + text.charCodeAt(text.length - 7);
          if (!jsonSeen.has(fp)) {
            if (jsonSeen.size > 3000) jsonSeen.clear();
            jsonSeen.add(fp);
            setTimeout(function () { task(function () { handleParsed(res, '', 'JSON.parse', null, 'low'); }, 'low'); }, 1200); // po warstwie sieciowej i w tle (budżet CPU)
          }
        }
      } catch (e) {}
      return res;
    };
    setProp(J, 'parse', disguise(wrapped, orig));
  }

  function inspectBlob(blob, blobUrl) {
    if (!SESJA) return;
    const type = String(blob.type || '').toLowerCase();
    if (/^(video|audio|image|font)\//.test(type) || blob.size < 12 || blob.size > CFG.maxBodyBytes) return;
    blob.slice(0, 1200).arrayBuffer().then(function (ab) {
      const head = smartDecode(new Uint8Array(ab), type);
      if (!head) return;
      const f = sniffFormat(head);
      if (!f || f === 'json' || f === 'mpd' || f === 'm3u8') return;
      return blob.arrayBuffer().then(function (full) {
        const text = smartDecode(new Uint8Array(full), type);
        if (text) setTimeout(function () { guard(function () { handleSubText(text, f, blobUrl, 'Blob'); }); }, 1500);
      });
    }).catch(noop);
  }
  function hookBlob() {
    const orig = W.URL && W.URL.createObjectURL;
    if (typeof orig !== 'function' || orig.__ush) return;
    const wrapped = function createObjectURL(obj) {
      const url = orig.apply(this, arguments);
      try { if (obj && typeof obj.size === 'number' && typeof obj.slice === 'function' && typeof obj.arrayBuffer === 'function') inspectBlob(obj, url); } catch (e) {}
      return url;
    };
    setProp(W.URL, 'createObjectURL', disguise(wrapped, orig));
  }

  function liveTextFrom(obj) {
    const stack = [obj]; let n = 0;
    while (stack.length && n++ < 400) {
      const v = stack.pop(); if (!v || typeof v !== 'object') continue;
      let ks; try { ks = Object.keys(v); } catch (e) { continue; }
      for (let ki = 0; ki < ks.length && ki < 300; ki++) {
        const k = ks[ki], c = own(v, k);
        if (typeof c === 'string') { if (c.length > 1 && c.length < 500 && /^(text|caption|captions|subtitle|transcript|content|line|utf8|sentence)$/i.test(k)) return cleanCueText(c); }
        else if (c && typeof c === 'object') stack.push(c);
      }
    }
    return '';
  }
  function onStreamMessage(data, url, layer) {
    if (!SESJA) return;
    if (typeof data !== 'string') {
      if (data && tagOf(data) === '[object ArrayBuffer]' && data.byteLength > 20 && data.byteLength < 262144) data = smartDecode(new Uint8Array(data), '') || '';
      else if (data && tagOf(data) === '[object Blob]' && data.size > 20 && data.size < 262144) { data.arrayBuffer().then(function (ab) { const t = smartDecode(new Uint8Array(ab), ''); if (t) onStreamMessage(t, url, layer); }).catch(noop); return; }
      else return;
    }
    if (data.length < 12 || data.length > 2000000 || !RX.streamHint.test(data)) return;
    const fmt = sniffFormat(data);
    if (fmt && fmt !== 'json' && fmt !== 'm3u8' && fmt !== 'mpd') { handleSubText(data, fmt, '', layer); return; }
    if (fmt !== 'json') return;
    let obj; try { obj = O.jsonParse(data); } catch (e) { return; }
    if (analyzeObject(obj, layer, { base: undefined, maxNodes: 4000, budget: 8 })) return;
    const t = liveTextFrom(obj);
    if (t) { reportOnce('live:' + layer, layer, 'napisy na żywo płyną strumieniem', shortUrl(url, 90)); liveUpdate(layer, t); }
  }
  function hookSockets(win) {
    win = win || W;
    if (typeof Proxy !== 'function' || typeof Reflect !== 'object') return;
    [['WebSocket', 'WebSocket'], ['EventSource', 'SSE']].forEach(function (pair) {
      const Orig = win[pair[0]];
      if (typeof Orig !== 'function' || Orig.__ush) return;
      try {
        const P = new Proxy(Orig, {
          construct: function (target, args, nt) {
            const inst = Reflect.construct(target, args, nt);
            try {
              const url = String(args[0] || ''); inst.addEventListener('message', function (ev) { try { onStreamMessage(ev.data, url, pair[1]); } catch (e) {} });
              if (pair[1] === 'SSE') { // nazwane zdarzenia SSE (event: caption) — słuchamy każdego typu, który strona zarejestruje
                const add = inst.addEventListener, seen = Object.create(null);
                inst.addEventListener = function (type) { try { if (type !== 'message' && type !== 'open' && type !== 'error' && !seen[type]) { seen[type] = 1; add.call(this, type, function (ev) { try { onStreamMessage(ev.data, url, 'SSE'); } catch (e) {} }); } } catch (e) {} return add.apply(this, arguments); };
              } else if (CFG.hookOutbound && typeof inst.send === 'function') {
                const osend = inst.send; inst.send = function (d) { let job = null; try { job = outboundPrep(d, url, 'WebSocket'); } catch (e) {} const r = osend.apply(this, arguments); afterSend(job); return r; };
              }
            } catch (e) {}
            return inst;
          },
          get: function (target, prop) { return prop === '__ush' ? true : target[prop]; }
        });
        setProp(win, pair[0], P);
      } catch (e) {}
    });
  }

  function hookTextTrack() {
    const TT = W.TextTrack;
    if (!TT || !TT.prototype || typeof TT.prototype.addCue !== 'function' || TT.prototype.addCue.__ush) return;
    const orig = TT.prototype.addCue;
    const wrapped = function addCue(cue) {
      try { onCueAdded(this, cue); } catch (e) {}
      return orig.apply(this, arguments);
    };
    setProp(TT.prototype, 'addCue', disguise(wrapped, orig));
  }

  const closedRoots = new WeakMap(); // host → zamknięty shadowRoot (dzięki hookowi attachShadow)
  function hookShadow() {
    const orig = W.Element && W.Element.prototype.attachShadow;
    if (typeof orig !== 'function' || orig.__ush) return;
    const wrapped = function attachShadow(init) {
      const root = orig.apply(this, arguments);
      try { if (root) { if (init && init.mode === 'closed') closedRoots.set(this, root); observeRoot(root); scheduleScan(700); } } catch (e) {}
      return root;
    };
    setProp(W.Element.prototype, 'attachShadow', disguise(wrapped, orig));
  }

  function hookTextDecoder() {
    const TD = W.TextDecoder;
    if (!TD || !TD.prototype || typeof TD.prototype.decode !== 'function' || TD.prototype.decode.__ush) return;
    const orig = TD.prototype.decode;
    const wrapped = function decode(input, options) {
      const s = orig.apply(this, arguments);
      if (!SESJA) return s;
      try {
        if (typeof s === 'string' && s.length > 80 && s.length < 6000000 && !(options && options.stream)) {
          const c = s.charCodeAt(0);
          if (c === 87 || c === 0xFEFF || c === 60 || (c >= 48 && c <= 57)) { // 'W', BOM, '<', cyfra
            const f = sniffFormat(s);
            if (f && f !== 'json' && f !== 'm3u8' && f !== 'mpd') setTimeout(function () { guard(function () { handleSubText(s, f, '', 'TextDecoder'); }); }, 1800);
          }
        }
      } catch (e) {}
      return s;
    };
    setProp(TD.prototype, 'decode', disguise(wrapped, orig));
  }

  /* ═══ 9b. DODATKOWE HOOKI: komunikaty, Worker, WebRTC, SpeechRecognition, Canvas, Cache API, WASM, base64 ═══ */

  const msgRate = {};
  function msgBudget(layer, perSec) { const t = Date.now(); const r = msgRate[layer] || (msgRate[layer] = { t: t, n: 0 }); if (t - r.t > 1000) { r.t = t; r.n = 0; } return ++r.n <= (perSec || 40); }
  function hasCapKey(o, d) { // czy obiekt wygląda na niosący napisy; czyta tylko własne pola danych (bez getterów strony)
    if (!o || typeof o !== 'object' || d > 3) return false;
    let ks; try { ks = Object.keys(o); } catch (e) { return false; }
    for (let i = 0; i < ks.length && i < 60; i++) { const k = ks[i]; if (/caption|subtitle|transcript|closed_?cap|\bcc\b/i.test(k)) return true; const c = own(o, k); if (c && typeof c === 'object' && hasCapKey(c, d + 1)) return true; }
    return false;
  }
  // Treść komunikatu (tekst / bufor / Blob / obiekt) trafia tą samą drogą co odpowiedzi sieciowe
  function inspectPayload(data, layer, url) {
    if (!SESJA) return;
    if (data == null || !msgBudget(layer)) return;
    const tp = typeof data;
    if (tp === 'string') {
      if (data.length < 12 || data.length > 6000000) return;
      if (data.length >= 30) inspectLoose(data, layer, url || layer);
      if (data.length <= 2000000) onStreamMessage(data, url || '', layer);
      return;
    }
    if (tp !== 'object') return;
    const tg = tagOf(data);
    if (tg === '[object ArrayBuffer]' || ArrayBuffer.isView(data)) {
      const u8 = tg === '[object ArrayBuffer]' ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (u8.length > 20 && u8.length <= CFG.maxBodyBytes) handleBody(u8, url || '', '', layer, 1);
    } else if (tg === '[object Blob]' || tg === '[object File]') {
      if (data.size > 20 && data.size <= CFG.maxBodyBytes && !/^(video|audio|image|font)\//.test(data.type || '')) data.arrayBuffer().then(function (ab) { guard(function () { handleBody(new Uint8Array(ab), url || '', String(data.type || ''), layer, 1); }); }).catch(noop);
    } else if (!isForbidden(data)) {
      if (data.__ush) return;
      analyzeObject(data, layer, { safe: true, maxNodes: 3000, maxDepth: 8, budget: 6, srcUrl: url || '' });
      if (hasCapKey(data, 0)) { const t = liveTextFrom(data); if (t) { reportOnce('live:' + layer, layer, 'napisy na żywo przychodzą komunikatami', shortUrl(url || layer, 90)); liveUpdate(layer, t); } }
    }
  }
  // Dane WYSYŁANE przez stronę badamy dopiero po udanym wysłaniu (przeglądarka sama odrzuca Proxy i obiekty nieklonowalne),
  // obiekty — wyłącznie przez własne pola danych (bez wywoływania getterów strony), bufory — na kopii zrobionej przed wysłaniem
  // (przy postMessage z listą transferu zostają odłączone). Segmentów wideo nie kopiujemy — te widzi już warstwa sieciowa.
  function bytesWorthy(u8) {
    if (isTS(u8) || isISOBMFF(u8)) return false;
    if (isEBML(u8) || isSTL(u8)) return true;
    const c = u8[0]; return c === 0xEF || c === 0xFF || c === 0xFE || c === 0x57 || c === 0x7B || c === 0x5B || c === 0x3C || c === 0x53 || (c >= 0x30 && c <= 0x39);
  }
  // Czy to prawdziwy ArrayBuffer — sprawdzane po wewnętrznym slocie (getter z prototypu), więc Proxy strony nie dostaje żadnego wywołania pułapki
  const abLen = (function () { try { return Object.getOwnPropertyDescriptor(W.ArrayBuffer.prototype, 'byteLength').get; } catch (e) { return null; } })();
  function outboundPrep(body, url, layer) {
    if (!SESJA || !CFG.hookOutbound || body == null) return null;
    if (typeof body === 'string') return body.length < 30 ? null : function () { inspectPayload(body, layer, url); };
    if (typeof body !== 'object') return null;
    let u8 = null;
    if (ArrayBuffer.isView(body)) { try { u8 = new Uint8Array(body.buffer, body.byteOffset, body.byteLength); } catch (e) { return null; } }
    else if (abLen) { let ab = false; try { abLen.call(body); ab = true; } catch (e) {} if (ab) u8 = new Uint8Array(body); }
    if (u8) { if (u8.length <= 20 || u8.length > CFG.maxBodyBytes || !bytesWorthy(u8)) return null; const copy = u8.slice(); return function () { inspectPayload(copy, layer, url); }; }
    return function () { // pozostałe obiekty — dopiero po udanym wysłaniu (wtedy na pewno nie są Proxy)
      const tg = tagOf(body); if (tg === '[object FormData]' || tg === '[object URLSearchParams]' || tg === '[object ReadableStream]') return;
      inspectPayload(body, layer, url);
    };
  }
  function afterSend(job) { if (job) setTimeout(function () { guard(job); }, 0); }
  function inspectOutbound(body, url, layer) { afterSend(outboundPrep(body, url, layer)); }


  // ── Worker / SharedWorker: podsłuch komunikatów z workera (opcjonalnie: wstrzyknięcie podsłuchu fetch/XHR do środka) ──
  const ownWorkerUrls = new Set();
  function workerHook(base) { // ta funkcja jest serializowana i uruchamiana WEWNĄTRZ workera; base = prawdziwy adres skryptu workera
    try {
      // worker startuje z adresu blob:, więc względne adresy trzeba rozwiązywać względem oryginalnego skryptu
      const abs = function (u) { try { return (typeof u === 'string' || (u && u.href)) ? new URL(String(u.href || u), base).href : u; } catch (e) { return u; } };
      const fixCtor = function (name) { const C = self[name]; if (typeof C !== 'function' || typeof Proxy !== 'function') return; try { self[name] = new Proxy(C, { construct: function (t, a, nt) { a = [].slice.call(a); if (a.length) a[0] = abs(a[0]); return Reflect.construct(t, a, nt); } }); } catch (e) {} };
      ['Request', 'EventSource', 'WebSocket', 'Worker'].forEach(fixCtor);
      if (typeof self.importScripts === 'function') { const oi = self.importScripts; self.importScripts = function () { return oi.apply(self, [].map.call(arguments, abs)); }; }
      const send = function (o) { try { o.__ush = 'w'; self.postMessage(o); } catch (e) {} };
      const SUB = /WEBVTT|-->|<tt[\s>]|\[Script Info\]|Scenarist_SCC|<SAMI|"(?:cues?|captions?|subtitles?|events|segments)"\s*:|tStartMs/;
      const URLRX = /\.(?:vtt|srt|ttml2?|dfxp|ass|ssa|sbv|smi|sami|lrc|scc|stl)(?:[?#]|$)|timedtext|subtitle|caption|transcript/i;
      const peek = function (res, url) {
        try {
          const ct = String(res.headers.get('content-type') || ''); if (/^(image|font|audio|video)\//i.test(ct)) return;
          if (+(res.headers.get('content-length') || 0) > 4e6) return;
          res.clone().text().then(function (t) { if (t && t.length > 8 && t.length < 4e6 && (SUB.test(t.slice(0, 4000)) || URLRX.test(url))) send({ url: String(url), ct: ct, text: t }); }, function () {});
        } catch (e) {}
      };
      if (self.fetch) { const of = self.fetch; self.fetch = function (i) { const a = [].slice.call(arguments); if (typeof a[0] === 'string' || (a[0] && a[0].href && !a[0].url)) a[0] = abs(a[0]); const p = of.apply(this, a); try { const u = typeof a[0] === 'string' ? a[0] : ((a[0] && a[0].url) || String(a[0])); p.then(function (r) { peek(r, u); }, function () {}); } catch (e) {} return p; }; }
      if (self.XMLHttpRequest) { const X = self.XMLHttpRequest.prototype, oo = X.open; X.open = function (m, u) { const a = [].slice.call(arguments); a[1] = abs(u); const uu = String(a[1]); this.addEventListener('load', function () { try { if ((this.responseType === '' || this.responseType === 'text') && this.responseText && this.responseText.length < 4e6) { const t = this.responseText; if (SUB.test(t.slice(0, 4000)) || URLRX.test(uu)) send({ url: uu, ct: '', text: t }); } } catch (e) {} }); return oo.apply(this, a); }; }
    } catch (e) {}
  }
  function injectWorkerArgs(args) {
    const raw = args[0]; const abs = toAbs(String(raw && raw.href ? raw.href : raw));
    if (!abs || !sameOrigin(abs) || /^(blob|data):/.test(abs)) return args;
    const mod = !!(args[1] && args[1].type === 'module');
    const code = '(' + workerHook.toString() + ')(' + JSON.stringify(abs) + ');\n' + (mod ? 'import(' + JSON.stringify(abs) + ');' : 'importScripts(' + JSON.stringify(abs) + ');');
    const mk = O.createObjectURL || W.URL.createObjectURL; const u = mk.call(W.URL, new W.Blob([code], { type: 'text/javascript' }));
    ownWorkerUrls.add(u);
    return [u].concat([].slice.call(args, 1));
  }
  function onWorkerMessage(ev, url, nm) {
    if (!SESJA) return;
    const d = ev.data;
    if (d && typeof d === 'object' && d.__ush === 'w') { try { ev.stopImmediatePropagation(); } catch (e) {} if (typeof d.text === 'string') handleText(d.text, d.url || url, String(d.ct || ''), 'Worker', 1); return; }
    inspectPayload(d, nm, url);
  }
  function proxyCtor(name, onConstruct) {
    const Orig = W[name]; if (typeof Orig !== 'function' || Orig.__ush || typeof Proxy !== 'function') return false;
    try {
      const P = new Proxy(Orig, {
        construct: function (target, args, nt) { let a = args; try { a = onConstruct.before ? onConstruct.before(args) : args; } catch (e) { a = args; } const inst = Reflect.construct(target, a, nt); try { onConstruct.after(inst, args); } catch (e) {} return inst; },
        get: function (target, prop) { return prop === '__ush' ? true : target[prop]; }
      });
      return setProp(W, name, P);
    } catch (e) { return false; }
  }
  function hookWorkers() {
    proxyCtor('Worker', { before: function (args) { return CFG.injectWorkers ? injectWorkerArgs(args) : args; }, after: function (inst, args) { const u = String(args[0] && args[0].href ? args[0].href : args[0] || ''); inst.addEventListener('message', function (ev) { try { onWorkerMessage(ev, u, 'Worker'); } catch (e) {} }); } });
    proxyCtor('SharedWorker', { after: function (inst, args) { const u = String(args[0] && args[0].href ? args[0].href : args[0] || ''); if (inst.port) inst.port.addEventListener('message', function (ev) { try { onWorkerMessage(ev, u, 'Worker'); } catch (e) {} }); } });
  }
  function hookMessages() {
    proxyCtor('BroadcastChannel', { after: function (inst, args) { const nm = String(args[0] || ''); inst.addEventListener('message', function (ev) { try { inspectPayload(ev.data, 'BroadcastChannel', nm); } catch (e) {} }); } });
    proxyCtor('MessageChannel', { after: function (inst) { [inst.port1, inst.port2].forEach(function (p) { try { p.addEventListener('message', function (ev) { try { inspectPayload(ev.data, 'MessagePort', ''); } catch (e) {} }); } catch (e) {} }); } });
    guard(function () { // dane wysyłane portem (np. do workera, który je sparsuje)
      const MP = W.MessagePort; if (!MP || !MP.prototype || typeof MP.prototype.postMessage !== 'function' || MP.prototype.postMessage.__ush) return;
      const orig = MP.prototype.postMessage;
      setProp(MP.prototype, 'postMessage', disguise(function postMessage(msg) { let job = null; try { job = outboundPrep(msg, '', 'MessagePort'); } catch (e) {} const r = orig.apply(this, arguments); afterSend(job); return r; }, orig));
    });
    guard(function () { // dane wysyłane do workera
      const WK = W.Worker; if (!WK || !WK.prototype || typeof WK.prototype.postMessage !== 'function' || WK.prototype.postMessage.__ush) return;
      const orig = WK.prototype.postMessage;
      setProp(WK.prototype, 'postMessage', disguise(function postMessage(msg) { let job = null; try { job = outboundPrep(msg, '', 'Worker'); } catch (e) {} const r = orig.apply(this, arguments); afterSend(job); return r; }, orig));
    });
    // window.postMessage — także komunikaty od rozszerzeń przeglądarki (np. wtyczek do napisów) i od innych ramek
    W.addEventListener('message', function (ev) {
      try { const d = ev.data; if (d && typeof d === 'object' && d.__ush) return; const o = String(ev.origin || ''); inspectPayload(d, /^(chrome|moz|safari-web)-extension:/.test(o) ? 'Extension' : 'postMessage', o); } catch (e) {}
    }, true);
    guard(function () { const sw = W.navigator && W.navigator.serviceWorker; if (sw && sw.addEventListener) sw.addEventListener('message', function (ev) { try { inspectPayload(ev.data, 'ServiceWorker', ''); } catch (e) {} }); });
  }

  // ── WebRTC (kanały danych) ──
  function hookRTC() {
    const attach = function (ch) { try { const lb = String(ch && ch.label || ''); ch.addEventListener('message', function (ev) { try { inspectPayload(ev.data, 'WebRTC', lb); } catch (e) {} }); } catch (e) {} };
    const after = function (inst) {
      inst.addEventListener('datachannel', function (ev) { attach(ev.channel); });
      const cdc = inst.createDataChannel; if (typeof cdc === 'function') inst.createDataChannel = function () { const ch = cdc.apply(this, arguments); attach(ch); return ch; };
    };
    proxyCtor('RTCPeerConnection', { after: after }); proxyCtor('webkitRTCPeerConnection', { after: after });
  }

  // ── SpeechRecognition: napisy tworzone przez samą stronę z rozpoznawania mowy ──
  let speechTimer = 0;
  function onSpeechResult(ev) {
    if (!SESJA) return;
    const res = ev.results; if (!res) return; let txt = '';
    for (let i = ev.resultIndex || 0; i < res.length; i++) { const r = res[i]; if (r && r[0] && r[0].transcript) txt += (txt ? ' ' : '') + String(r[0].transcript).trim(); }
    txt = txt.trim(); if (!txt) return;
    reportOnce('live:Speech', 'Speech', 'strona sama rozpoznaje mowę (SpeechRecognition) — przechwytuję wynik jako napisy na żywo');
    liveUpdate('Speech', txt, undefined, { track: 'SpeechRecognition' });
    clearTimeout(speechTimer); speechTimer = setTimeout(function () { liveUpdate('Speech', ''); }, 3500);
  }
  function hookSpeech() {
    ['SpeechRecognition', 'webkitSpeechRecognition'].forEach(function (nm) { proxyCtor(nm, { after: function (inst) { inst.addEventListener('result', function (ev) { try { onSpeechResult(ev); } catch (e) {} }); } }); });
  }

  // ── Canvas: tekst rysowany przez fillText/strokeText na płótnie leżącym na wideo ──
  const cvs = { buf: new Map(), raf: 0, ok: new WeakMap(), cleared: false };
  function canvasOk(cv) {
    const c = cvs.ok.get(cv), t = Date.now(); if (c && t - c.t < 1500) return c.v;
    let v = false; try { v = media.size > 0 && overlapsMedia(cv); } catch (e) {}
    cvs.ok.set(cv, { t: t, v: v }); return v;
  }
  function flushCanvas() {
    cvs.raf = 0; const parts = [], seen = new Set();
    cvs.buf.forEach(function (rows) { rows.sort(function (a, b) { return a.y - b.y || a.x - b.x; }); rows.forEach(function (r) { if (!seen.has(r.text)) { seen.add(r.text); parts.push(r.text); } }); });
    cvs.buf.clear();
    const txt = parts.join('\n').trim();
    if (txt) { reportOnce('live:Canvas', 'Canvas', 'napisy są rysowane na <canvas> (fillText) — przechwytuję ich tekst'); liveUpdate('Canvas', txt); }
    else if (cvs.cleared) liveUpdate('Canvas', '');
    cvs.cleared = false;
  }
  function canvasSched() { if (!cvs.raf) cvs.raf = (W.requestAnimationFrame ? W.requestAnimationFrame(function () { guard(flushCanvas); }) : setTimeout(function () { guard(flushCanvas); }, 16)); }
  function hookCanvas() {
    const C = W.CanvasRenderingContext2D; if (!C || !C.prototype) return;
    ['fillText', 'strokeText'].forEach(function (fn) {
      const orig = C.prototype[fn]; if (typeof orig !== 'function' || orig.__ush) return;
      setProp(C.prototype, fn, disguise(function (text, x, y) {
        if (SESJA && media.size) { try {
          if (typeof text === 'string' && text.length > 1 && text.length < 300 && /[^\d\s.,:;%\-+×x/]/.test(text)) { const cv = this.canvas; if (cv && canvasOk(cv)) { let rows = cvs.buf.get(cv); if (!rows) cvs.buf.set(cv, rows = []); if (!(fn === 'strokeText' && rows.some(function (r) { return r.text === text; }))) rows.push({ y: +y || 0, x: +x || 0, text: text }); canvasSched(); } }
        } catch (e) {} }
        return orig.apply(this, arguments);
      }, orig));
    });
    const cr = C.prototype.clearRect;
    if (typeof cr === 'function' && !cr.__ush) setProp(C.prototype, 'clearRect', disguise(function (x, y, w, h) {
      if (SESJA && media.size) { try { const cv = this.canvas; if (cv && w >= cv.width * 0.8 && h >= cv.height * 0.8 && canvasOk(cv)) { cvs.cleared = true; canvasSched(); } } catch (e) {} }
      return cr.apply(this, arguments);
    }, cr));
  }

  // ── Cache API: odpowiedzi odczytywane z Cache Storage przez stronę (też z Service Workera) ──
  function hookCacheAPI() {
    const wrap = function (proto, name) {
      const orig = proto && proto[name]; if (typeof orig !== 'function' || orig.__ush) return;
      setProp(proto, name, disguise(function () {
        const p = orig.apply(this, arguments);
        try { const a0 = arguments[0]; const u = typeof a0 === 'string' ? a0 : ((a0 && a0.url) || ''); if (p && p.then) p.then(function (r) { try { if (Array.isArray(r)) r.slice(0, 6).forEach(function (x) { onFetchResponse(x, x.url || u); }); else if (r) onFetchResponse(r, u); } catch (e) {} }, noop); } catch (e) {}
        return p;
      }, orig));
    };
    wrap(W.Cache && W.Cache.prototype, 'match'); wrap(W.Cache && W.Cache.prototype, 'matchAll'); wrap(W.CacheStorage && W.CacheStorage.prototype, 'match');
  }

  // ── WebAssembly: samej treści z wnętrza modułu nie da się podejrzeć — wykrywamy tylko, że strona używa dekodera napisów/OCR ──
  function hookWasm() {
    const WA = W.WebAssembly; if (!WA || !WA.Module) return;
    const RXW = /(?:^|_)(?:ass_|libass|jassub|octopus|subtitle|caption|cea608|cea708|ccx|zvbi|tesseract|whisper|vosk)/i;
    const peek = function (m) {
      try {
        if (!(m instanceof WA.Module)) return;
        const names = WA.Module.exports(m).map(function (e) { return e.name; }).concat(WA.Module.imports(m).map(function (e) { return e.name; }));
        const hit = names.filter(function (n) { return RXW.test(n); }).slice(0, 4);
        if (hit.length) reportOnce('wasm:' + hit.join(), 'WASM', 'moduł WebAssembly dotyczy napisów/rozpoznawania (' + hit.join(', ') + ') — tekst wychwycę tam, gdzie wychodzi poza moduł: sieć, komunikaty, DOM, canvas');
      } catch (e) {}
    };
    ['instantiate', 'compile', 'instantiateStreaming', 'compileStreaming'].forEach(function (fn) {
      const orig = WA[fn]; if (typeof orig !== 'function' || orig.__ush) return;
      setProp(WA, fn, disguise(function () { const p = orig.apply(this, arguments); try { if (p && p.then) p.then(function (r) { try { peek(r && r.module ? r.module : r); } catch (e) {} }, noop); } catch (e) {} return p; }, orig));
    });
  }

  // ── base64 / TextEncoder: strona koduje albo dekoduje napisy ──
  // Szybkie sito na gorącej ścieżce (atob/btoa wołane bywają tysiące razy, np. przy tokenach JWT): tylko początki typowe dla napisów
  let b64Last = '';
  function b64Worth(s) {
    let c = s.charCodeAt(0);
    if (c === 0xEF && s.charCodeAt(1) === 0xBB && s.charCodeAt(2) === 0xBF) { s = s.slice(3); c = s.charCodeAt(0); } // BOM UTF-8 w łańcuchu binarnym
    else if (c === 0xFEFF) { s = s.slice(1); c = s.charCodeAt(0); }
    else if ((c === 0xFF && s.charCodeAt(1) === 0xFE) || (c === 0xFE && s.charCodeAt(1) === 0xFF)) return true; // BOM UTF-16
    if (c === 87) return s.slice(0, 6) === 'WEBVTT';
    if (c === 83) return s.slice(0, 13) === 'Scenarist_SCC';
    if (c === 60) return /^<(?:\?xml|(?:\w+:)?tt[\s>]|SAMI|transcript|timedtext)/i.test(s.slice(0, 80));
    if (c === 91 && /^\[(?:Script Info|V4\+? Styles|\d{1,3}:\d{2})/i.test(s.slice(0, 20))) return true;
    if (c === 123 || c === 91) return s.length > 200 && RX.jsonHint.test(s.length > 4000 ? s.slice(0, 4000) : s);
    if (c >= 48 && c <= 57) return s.slice(0, 300).indexOf('-->') !== -1;
    return false;
  }
  function b64Peek(bin, layer) {
    const n = bin.length; const head = new Uint8Array(Math.min(n, 3000)); let wide = false;
    for (let i = 0; i < head.length; i++) { const c = bin.charCodeAt(i); if (c > 255) { wide = true; break; } head[i] = c; }
    const h = wide ? bin.slice(0, 3000) : smartDecode(head, ''); if (!h) return;
    const f = sniffFormat(h); if (!f || f === 'm3u8' || f === 'mpd') return;
    if (f === 'json' && !RX.jsonHint.test(h)) return;
    let text = bin;
    if (!wide) { const u8 = new Uint8Array(n); for (let i = 0; i < n; i++) u8[i] = bin.charCodeAt(i); text = smartDecode(u8, '') || ''; }
    if (!text) return;
    setTimeout(function () { guard(function () { if (f === 'json') inspectLoose(text, layer, layer); else handleSubText(text, f, '', layer); }); }, 1500);
  }
  function hookEncoding() {
    guard(function () {
      const a = W.atob; if (typeof a === 'function' && !a.__ush) setProp(W, 'atob', disguise(function atob() { const r = a.apply(this, arguments); if (!SESJA) return r; try { if (typeof r === 'string' && r.length > 80 && r.length < 6000000 && r !== b64Last && b64Worth(r)) { b64Last = r; b64Peek(r, 'Base64'); } } catch (e) {} return r; }, a));
      const b = W.btoa; if (typeof b === 'function' && !b.__ush) setProp(W, 'btoa', disguise(function btoa(s) { if (!SESJA) return b.apply(this, arguments); try { if (typeof s === 'string' && s.length > 80 && s.length < 6000000 && s !== b64Last && b64Worth(s)) { b64Last = s; b64Peek(s, 'Base64'); } } catch (e) {} return b.apply(this, arguments); }, b));
    });
    guard(function () {
      const TE = W.TextEncoder; if (!TE || !TE.prototype || typeof TE.prototype.encode !== 'function' || TE.prototype.encode.__ush) return;
      const orig = TE.prototype.encode;
      setProp(TE.prototype, 'encode', disguise(function encode(s) {
        if (!SESJA) return orig.apply(this, arguments);
        try { if (typeof s === 'string' && s.length > 80 && s.length < 6000000) { const c = s.charCodeAt(0); if (c === 87 || c === 0xFEFF || c === 60 || (c >= 48 && c <= 57)) { const f = sniffFormat(s); if (f && f !== 'json' && f !== 'm3u8' && f !== 'mpd') setTimeout(function () { guard(function () { handleSubText(s, f, '', 'TextEncoder'); }); }, 1800); } } } catch (e) {}
        return orig.apply(this, arguments);
      }, orig));
    });
    guard(function () {
      const N = W.Navigator; const orig = N && N.prototype && N.prototype.sendBeacon; if (typeof orig !== 'function' || orig.__ush) return;
      setProp(N.prototype, 'sendBeacon', disguise(function sendBeacon(url, data) { let job = null; try { job = outboundPrep(data, String(url), 'Beacon'); } catch (e) {} const r = orig.apply(this, arguments); afterSend(job); return r; }, orig));
    });
  }

  /* ── Nagłówki żądań podglądnięte u strony (np. Authorization) — użyte przy ponownym pobraniu napisów ── */
  const reqHeaders = new Map();
  const HDR_SKIP = /^(content-length|content-type|host|connection|cookie|origin|referer|user-agent|accept-encoding|sec-.*|priority|range|if-.*|cache-control|pragma)$/i;
  function rememberHeaders(url, h) {
    try {
      const o = Object.create(null); let n = 0;
      const put = function (k, v) { k = String(k); if (HDR_SKIP.test(k) || /^(__proto__|constructor|prototype)$/.test(k) || n >= 10) return; o[k] = String(v).slice(0, 2000); n++; };
      if (!h) return;
      if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach(function (v, k) { put(k, v); });
      else if (Array.isArray(h)) h.forEach(function (p) { if (p && p.length === 2) put(p[0], p[1]); });
      else if (typeof h === 'object') for (const k in h) put(k, h[k]);
      if (!n) return;
      const abs = toAbs(url); if (!abs) return;
      if (reqHeaders.size > 200) reqHeaders.delete(reqHeaders.keys().next().value);
      reqHeaders.set(keyFor(abs), o);
    } catch (e) {}
  }

  const hookedWins = new WeakSet();
  function installHooks() {
    hookedWins.add(W);
    guard(function () { if (doc.documentElement) pageGlobals(); }); // wzorzec czystego okna liczony od razu, zanim ruszą skrypty strony (nie zobaczą ramki-próbki)
    if (CFG.hookFetch) guard(function () { hookFetch(W); });
    if (CFG.hookXHR) guard(function () { hookXHR(W); });
    if (CFG.hookJSON) guard(hookJSON);
    if (CFG.hookBlob) guard(hookBlob);
    if (CFG.hookSockets) guard(hookSockets);
    if (CFG.hookTextTrack) guard(hookTextTrack);
    if (CFG.hookShadow) guard(hookShadow);
    if (CFG.hookTextDecoder) guard(hookTextDecoder);
    if (CFG.hookWorker) guard(hookWorkers);
    if (CFG.hookMessages) guard(hookMessages);
    if (CFG.hookRTC) guard(hookRTC);
    if (CFG.hookSpeech) guard(hookSpeech);
    if (CFG.hookCanvas) guard(hookCanvas);
    if (CFG.hookCacheAPI) guard(hookCacheAPI);
    if (CFG.hookWasm) guard(hookWasm);
    if (CFG.hookEncoding) guard(hookEncoding);
    if (CFG.hookFrames) guard(hookFrameAccess);
    if (CFG.watchdog) setInterval(function () { guard(watchdog); }, 2000);
  }
  // Ramki bez własnej kopii skryptu (about:blank, srcdoc) — strony pożyczają z nich „czysty" fetch
  function hookFrameWindow(win) {
    try {
      if (!win || win === W || hookedWins.has(win)) return;
      hookedWins.add(win);            // najpierw zapamiętaj (cudze domeny rzucą wyjątek przy odczycie poniżej — tylko raz)
      if (win.__USH__) return;
      if (CFG.hookFetch) hookFetch(win);
      if (CFG.hookXHR) hookXHR(win);
      if (CFG.hookJSON) hookJSON(win);
      if (CFG.hookSockets) hookSockets(win);
    } catch (e) {}
  }

  // ── Ramki: strona może „pożyczyć\" czysty fetch/XHR/JSON.parse z nowej ramki zaraz po jej utworzeniu — podpinamy ją przy pierwszym dostępie ──
  function hookFrameAccess() {
    [W.HTMLIFrameElement, W.HTMLFrameElement, W.HTMLObjectElement].forEach(function (C) {
      const P = C && C.prototype; if (!P) return;
      ['contentWindow', 'contentDocument'].forEach(function (name) {
        let d = null; try { d = Object.getOwnPropertyDescriptor(P, name); } catch (e) {}
        if (!d || typeof d.get !== 'function' || d.get.__ush) return;
        const g = d.get;
        const ng = disguise(function () { const v = g.call(this); try { if (this.hasAttribute && this.hasAttribute('data-ush-probe')) return v; const win = name === 'contentWindow' ? v : (v && v.defaultView); if (win) hookFrameWindow(win); } catch (e) {} return v; }, g);
        try { Object.defineProperty(P, name, { get: ng, set: d.set, configurable: true, enumerable: d.enumerable }); } catch (e) {}
      });
    });
  }
  // ── Strażnik: strona może podmienić nasze hooki (własną wersją albo funkcją z ramki) — co 2 s sprawdzamy i podpinamy ponownie ──
  function watchdog() {
    if (!SESJA) return;
    const list = [
      ['fetch', CFG.hookFetch, function () { return W.fetch; }, function () { hookFetch(W); }],
      ['XMLHttpRequest.open', CFG.hookXHR, function () { return W.XMLHttpRequest && W.XMLHttpRequest.prototype.open; }, function () { hookXHR(W); }],
      ['JSON.parse', CFG.hookJSON, function () { return W.JSON && W.JSON.parse; }, function () { hookJSON(W); }],
      ['WebSocket', CFG.hookSockets, function () { return W.WebSocket; }, function () { hookSockets(W); }],
      ['EventSource', CFG.hookSockets, function () { return W.EventSource; }, function () { hookSockets(W); }],
      ['URL.createObjectURL', CFG.hookBlob, function () { return W.URL && W.URL.createObjectURL; }, hookBlob],
      ['TextDecoder.decode', CFG.hookTextDecoder, function () { return W.TextDecoder && W.TextDecoder.prototype.decode; }, hookTextDecoder],
      ['Worker', CFG.hookWorker, function () { return W.Worker; }, hookWorkers]
    ];
    for (let i = 0; i < list.length; i++) {
      const it = list[i]; if (!it[1]) continue; let f; try { f = it[2](); } catch (e) { continue; }
      if (typeof f === 'function' && !f.__ush) { sched.rehooks++; reportOnce('wd:' + it[0], 'Skan', 'strona podmieniła ' + it[0] + ' — podpinam ponownie'); guard(it[3]); }
    }
  }

  /* ═══════════════ 10. DOM I SHADOW DOM ═══════════════ */

  // Zbiera dokument, wszystkie shadowRooty (otwarte i przechwycone zamknięte) oraz ramki tego samego pochodzenia
  function collectRoots(root, out, seen) {
    out = out || []; seen = seen || new Set();
    if (!root || seen.has(root)) return out;
    seen.add(root); out.push(root);
    let els; try { els = root.querySelectorAll('*'); } catch (e) { return out; }
    for (let i = 0; i < els.length; i++) {
      const el = els[i]; let sr = null;
      try { sr = el.shadowRoot || closedRoots.get(el) || null; } catch (e) {}
      if (sr) collectRoots(sr, out, seen);
      const tn = el.tagName;
      if (tn === 'TEMPLATE') { try { if (el.content) collectRoots(el.content, out, seen); } catch (e) {} }
      if (tn === 'IFRAME' || tn === 'FRAME') {
        let d = null; try { d = el.contentDocument; } catch (e) {}
        if (d && d !== doc) { let has = false; try { has = !!(d.defaultView && d.defaultView.__USH__); } catch (e) {} if (!has) collectRoots(d, out, seen); }
      }
    }
    return out;
  }
  // Rekurencyjne querySelectorAll, które wchodzi w głąb przez .shadowRoot (i ramki tego samego pochodzenia)
  function querySelectorAllDeep(selector, root) {
    const res = []; const roots = collectRoots(root || doc);
    for (let r = 0; r < roots.length; r++) { try { const l = roots[r].querySelectorAll(selector); for (let i = 0; i < l.length; i++) res.push(l[i]); } catch (e) {} }
    return res;
  }

  const LINK_SEL = 'a[href*=".vtt" i],a[href*=".srt" i],a[href*=".ass" i],a[href*=".ssa" i],a[href*=".ttml" i],a[href*=".dfxp" i],a[href*=".sbv" i]';
  const DATA_SEL = '[data-subtitles],[data-subtitle],[data-captions],[data-caption],[data-tracks],[data-track],[data-tracks-url],[data-captions-json],[data-vtt],[data-srt],[data-sub],[data-subs],[data-cc],[data-text-tracks],[data-texttracks],[data-transcript],[data-setup],[data-config],[data-player-config],[data-options],[data-video],[data-settings],[data-jwplayer],[data-plyr-config],[data-props],[data-item]';
  const GEN_ATTR = dict({ title: 1, alt: 1, 'aria-label': 1, 'aria-description': 1 }); const hidVals = new WeakMap();
  let attrsSeen = new WeakSet(), scriptsSeen = new WeakSet();
  const media = new Set(); const mediaSeen = new WeakSet();

  function each(root, sel, fn) { let l; try { l = root.querySelectorAll(sel); } catch (e) { return; } for (let i = 0; i < l.length; i++) { try { fn(l[i]); } catch (e) {} } }
  function inspectAttrs(el, layer) {
    if (attrsSeen.has(el)) return; attrsSeen.add(el);
    const at = el.attributes; if (!at) return;
    for (let i = 0; i < at.length; i++) {
      const n = at[i].name; if (!(n.indexOf('data-') === 0 && n.length >= 6) && !GEN_ATTR[n]) continue;
      const v = at[i].value; if (!v || v.length < 5 || v.length > 600000) continue;
      const nameHint = RX.keyHint.test(n); const c0 = v.charCodeAt(0);
      if ((c0 === 123 || c0 === 91) && (nameHint || RX.jsonHint.test(v))) { let obj = null; try { obj = O.jsonParse(v); } catch (e) {} if (obj) analyzeObject(obj, layer, { name: n, base: el.baseURI, maxNodes: 8000, budget: 15 }); }
      else if (looksLikeUrl(v)) { const strong = RX.subExt.test(v) || RX.ytTimed.test(v); if (strong || (nameHint && !RX.notSub.test(v))) addItem({ url: v, base: el.baseURI, layer: layer, strong: strong, weakOk: true, label: n }); }
      else if (RX.subExtLoose.test(v)) extractUrlsFromText(v, layer, el.baseURI);
    }
  }
  function scanDOM() {
    const roots = collectRoots(doc);
    for (let r = 0; r < roots.length; r++) {
      const root = roots[r];
      const layer = root.nodeType === 11 && root.host ? 'ShadowDOM' : 'DOM';
      observeRoot(root);
      if (root.nodeType === 9 && root !== doc) hookFrameWindow(root.defaultView);
      each(root, 'video,audio', registerMedia);
      if (media.size) each(root, KNOWN_CAP, function (el) { const r = captionRootFor(el); if (r && overlapsMedia(r)) noteCapRoot(r); });
      each(root, 'track', function (el) {
        const src = el.getAttribute('src'); const kind = (el.getAttribute('kind') || 'subtitles').toLowerCase();
        if (src) addItem({ url: src, base: el.baseURI, layer: layer, strong: true, kindAttr: kind, lang: el.getAttribute('srclang') || '', label: el.getAttribute('label') || '' });
      });
      each(root, LINK_SEL, function (a) {
        const href = a.getAttribute('href');
        if (href && RX.subExt.test(href)) addItem({ url: href, base: a.baseURI, layer: layer, strong: true, label: (a.textContent || '').trim().slice(0, 50) });
      });
      each(root, DATA_SEL, function (el) { inspectAttrs(el, layer); });
      each(root, 'object[data],embed[src],embed[flashvars],object[flashvars],param[value],iframe[srcdoc]', function (el) { // stare osadzenia (Flash, <object>), ramki srcdoc
        if (attrsSeen.has(el)) return; attrsSeen.add(el);
        ['data', 'src', 'flashvars', 'value', 'srcdoc'].forEach(function (a) { const v = el.getAttribute(a); if (!v || v.length < 8) return; if (RX.subExtLoose.test(v)) extractUrlsFromText(v, layer, el.baseURI); else if (v.length > 80) inspectLoose(v, layer, el.tagName.toLowerCase()); });
      });
      each(root, 'input[type="hidden"],textarea[hidden],input[name*="sub" i],input[name*="caption" i],input[name*="track" i]', function (el) { // ukryte pola formularzy (wartość bywa ustawiana później — sprawdzamy, czy się zmieniła)
        const v = el.value || el.getAttribute('value') || el.textContent || ''; if (v.length < 30 || hidVals.get(el) === v) return; hidVals.set(el, v);
        inspectLoose(v, layer, 'input[' + (el.name || el.id || '') + ']');
      });
      each(root, 'script:not([src])', function (s) {
        if (scriptsSeen.has(s)) return; scriptsSeen.add(s);
        const t = s.textContent; if (!t || t.length < 40 || t.length > 4000000) return;
        if (/json/i.test(s.type || '') || s.id === '__NEXT_DATA__') {
          if (!RX.jsonHint.test(t)) return;
          let obj = null; try { obj = O.jsonParse(t); } catch (e) {}
          if (obj) analyzeObject(obj, layer, { name: s.id || 'script', base: s.baseURI, maxNodes: 30000, budget: 40 });
        } else extractUrlsFromText(t, layer, s.baseURI);
      });
    }
    // atrybuty data-* na przodkach odtwarzacza
    media.forEach(function (el) {
      let a = el, d = 0;
      while (a && d++ < 6) { if (a.nodeType === 1) inspectAttrs(a, 'DOM'); a = a.parentNode || a.host; }
    });
  }

  /* ═══════════════ 11. TEXTTRACKS (HTMLMediaElement) ═══════════════ */

  const trackInfo = new WeakMap(); const trackList = []; let trackSeq = 0;
  function registerMedia(el) {
    if (mediaSeen.has(el)) { media.add(el); return; }
    mediaSeen.add(el); media.add(el);
    try {
      const tt = el.textTracks;
      if (tt) {
        for (let i = 0; i < tt.length; i++) registerTrack(tt[i], el);
        tt.addEventListener('addtrack', function (ev) { if (!SESJA) return; try { if (ev.track) registerTrack(ev.track, el); } catch (e) {} });
      }
    } catch (e) {}
    ['loadedmetadata', 'emptied'].forEach(function (n) { try { el.addEventListener(n, function () { scheduleScan(400); }, { passive: true }); } catch (e) {} });
    uiDirty();
  }
  function registerTrack(track, el) {
    let info = trackInfo.get(track);
    if (info) { if (el && !info.el) info.el = el; return info; }
    const kind = String(track.kind || '');
    if (kind === 'metadata' || kind === 'chapters') return null;
    info = { track: track, el: el || null, uid: ++trackSeq, seen: new Set(), cues: [], timer: 0, item: null, read: 0 };
    trackInfo.set(track, info);
    if (trackList.length < 300) trackList.push(info);
    try { track.addEventListener('cuechange', function () { try { onCueChange(track, info); } catch (e) {} }); } catch (e) {}
    readTrackCues(track, info);
    if (CFG.forceLoadTracks && track.mode === 'disabled') { try { track.mode = 'hidden'; } catch (e) {} }
    return info;
  }
  function addTrackCue(info, start, end, text) {
    if (typeof text !== 'string' || !text) return;
    const t = cleanCueText(text); if (!t) return;
    const k = (Math.round(start * 1000)) + '|' + t;
    if (info.seen.has(k)) return;
    info.seen.add(k); info.cues.push({ start: start, end: end, text: t });
    if (!info.timer) info.timer = setTimeout(function () { info.timer = 0; guard(function () { flushTrack(info); }); }, 500);
  }
  function readTrackCues(track, info) {
    let list = null; try { list = track.cues; } catch (e) {}
    if (!list || list.length === info.read) return;
    info.read = list.length;
    for (let i = 0; i < list.length && i < 50000; i++) { const c = list[i]; if (c) addTrackCue(info, c.startTime, c.endTime, c.text); }
  }
  function trackElementSrc(track, el) {
    try { if (!el) return ''; const ts = el.querySelectorAll('track'); for (let i = 0; i < ts.length; i++) if (ts[i].track === track && ts[i].src) return ts[i].src; } catch (e) {}
    return '';
  }
  function flushTrack(info) {
    if (!info.cues.length) return;
    const tr = info.track; const src = trackElementSrc(tr, info.el);
    const it = addItem({ key: src ? keyFor(src) : 'tt:' + info.uid, url: src, layer: 'TextTrack', cues: info.cues.slice(), format: 'vtt', lang: tr.language || '', label: tr.label || '', strong: true });
    if (it) { info.item = it; try { it.active = tr.mode === 'showing'; } catch (e) {} }
  }
  function onCueAdded(track, cue) {
    if (!SESJA) return; // hook TextTrack.addCue — napisy dokładane przez odtwarzacz (hls.js, Shaka, Video.js…)
    if (!cue || typeof cue.text !== 'string') return;
    const info = registerTrack(track, null);
    if (info) addTrackCue(info, cue.startTime, cue.endTime, cue.text);
  }
  let liveTrack = null;
  function onCueChange(track, info) {
    if (!SESJA) return;
    readTrackCues(track, info);
    let mode = ''; try { mode = track.mode; } catch (e) {}
    if (mode !== 'showing' && liveTrack && liveTrack !== track) { let m2 = ''; try { m2 = liveTrack.mode; } catch (e) {} if (m2 === 'showing') return; }
    liveTrack = track;
    const ac = track.activeCues; const parts = [];
    if (ac) for (let i = 0; i < ac.length; i++) { const c = ac[i]; if (c && typeof c.text === 'string') { addTrackCue(info, c.startTime, c.endTime, c.text); const t = cleanCueText(c.text); if (t && parts.indexOf(t) === -1) parts.push(t); } }
    liveUpdate('TextTrack', parts.join('\n'), info.el ? info.el.currentTime : undefined, { track: String(track.label || track.language || track.kind || ''), video: info.el ? (info.vsel || (info.vsel = cssPath(info.el))) : '' });
  }
  function forceLoadTracks() {
    let n = 0; const changed = [];
    media.forEach(function (el) {
      try { const tt = el.textTracks; for (let i = 0; i < tt.length; i++) { const t = tt[i]; if (t.mode === 'disabled' && t.kind !== 'metadata' && t.kind !== 'chapters') { t.mode = 'hidden'; changed.push(t); n++; registerTrack(t, el); } } } catch (e) {}
    });
    [1200, 3500].forEach(function (ms) { setTimeout(function () { trackList.forEach(function (i) { guard(function () { readTrackCues(i.track, i); }); }); }, ms); });
    setTimeout(function () { changed.forEach(function (t) { try { if (t.mode === 'hidden') t.mode = 'disabled'; } catch (e) {} }); }, 6000);
    return n;
  }
  let mainCache = null, mainAt = 0;
  function mainMedia() {
    if (mainCache && Date.now() - mainAt < 1000 && mainCache.isConnected) return mainCache;
    let best = null, bs = -1;
    media.forEach(function (el) {
      let s = 0;
      try { if (!el.paused && !el.ended) s += 1000000; if (el.readyState > 1) s += 1000; const r = el.getBoundingClientRect(); s += r.width * r.height / 100; } catch (e) {}
      if (s > bs) { bs = s; best = el; }
    });
    mainCache = best; mainAt = Date.now();
    return best;
  }
  const t0 = Date.now();
  function mediaTime() { const m = mainMedia(); try { if (m && isFinite(m.currentTime)) return m.currentTime; } catch (e) {} return (Date.now() - t0) / 1000; }

  /* ═══════════════ 12. MUTATIONOBSERVER — NAPISY NA ŻYWO ═══════════════ */

  const live = { ch: {}, text: '', src: '', at: 0, origin: {} };
  function liveUpdate(src, text, t, origin) {
    if (!SESJA) return;
    text = String(text || '').trim();
    if (origin) live.origin[src] = origin;
    const ch = live.ch[src] || (live.ch[src] = { cues: [], cur: null });
    const cur = ch.cur;
    if (cur ? cur.text === text : !text) return;
    if (t == null || !isFinite(t)) t = mediaTime();
    const wall = Date.now();
    if (cur) {
      const el = (wall - cur.wall) / 1000;
      if (Math.abs(t - cur.start) < 0.05 && el > 0.2) t = cur.start + el; // zegar odtwarzacza stoi — licz czasem rzeczywistym
      if (text.length > cur.text.length && text.indexOf(cur.text) === 0 && t >= cur.start && t - cur.start < 12) { cur.text = text; cur.end = t; setLive(src, text, t); return; } // napis „dopisywany" słowo po słowie
      cur.end = (t > cur.start && t - cur.start < 30) ? t : cur.start + Math.min(6, Math.max(1.2, el));
      if (ch.cues.length < CFG.maxLiveCues) ch.cues.push(cur);
      ch.cur = null;
    }
    if (text) ch.cur = { start: t, end: t, text: text, wall: wall };
    setLive(src, text, t);
  }
  function setLive(src, text, t) {
    const weak = src === 'ARIA' || src === 'OCR'; // słabsze źródła nie zastępują napisu z mocniejszego, dopóki ten jest świeży
    if (weak && live.src !== src && live.text && Date.now() - live.at < 5000) { /* głos ma mocniejsze źródło */ }
    else if (text || live.src === src || !live.text) { live.text = text; live.src = src; live.at = Date.now(); }
    const og = live.origin[src] || {};
    emit('cue', { text: text, source: src, time: t, selector: og.selector || '', shadow: og.shadow || [], leaf: og.leaf || '', track: og.track || '', parts: text && og.parts ? og.parts : [] });
    uiLive();
  }
  function liveCues() {
    let best = null, bn = -1, name = '';
    for (const k in live.ch) { const c = live.ch[k]; const n = c.cues.length + (c.cur ? 1 : 0); if (n > bn) { bn = n; best = c; name = k; } }
    if (!best) return { cues: [], src: '' };
    const arr = best.cues.slice();
    if (best.cur) arr.push({ start: best.cur.start, end: Math.max(best.cur.end, best.cur.start + 2), text: best.cur.text });
    return { cues: normalizeCues(arr), src: name };
  }
  function liveCount() { let n = 0; for (const k in live.ch) n = Math.max(n, live.ch[k].cues.length + (live.ch[k].cur ? 1 : 0)); return n; }
  function currentText() {
    if (live.text) return live.text;
    const b = bestItem(); const t = mediaTime();
    if (b && b.cues && media.size) { const hit = []; for (let i = 0; i < b.cues.length; i++) { const c = b.cues[i]; if (c.start <= t && t <= c.end) hit.push(c.text); else if (c.start > t) break; } if (hit.length) return hit.join('\n'); }
    return '';
  }

  const KNOWN_LIST = ['.ytp-caption-window-container', '.ytp-caption-segment', '.captions-text', '.caption-window',
    '.vjs-text-track-display', '.vjs-text-track-cue', '.jw-text-track-display', '.jw-text-track-cue', '.jw-captions',
    '.shaka-text-container', '.plyr__captions', '.plyr__caption', '.dplayer-subtitle', '.art-subtitle', '.artplayer-subtitle',
    '.bmpui-ui-subtitle-overlay', '.bmpui-ui-subtitle-label', '.fp-captions', '.fp-subtitle', '.mejs__captions-text', '.mejs-captions-text',
    '.player-timedtext', '.player-timedtext-text-container', '.atvwebplayersdk-captions-text', '.atvwebplayersdk-captions-overlay',
    '.dss-subtitle-renderer-cue', '.hive-subtitle-renderer-cue', '.vp-captions', '.theoplayer-texttracks', '.clpp-text-container',
    '.rmp-cc-area', '.cc-text', '.closed-caption-container', '.subtitle-text', '.subtitles-text', '.caption-text', '.vtt-cue',
    '[data-testid="subtitles"]', '[data-testid="captions"]', '[data-purpose="captions-cue-text"]', '[class*="CaptionsRenderer"]', '[class*="SubtitleRenderer"]'];
  const KNOWN_CAP = KNOWN_LIST.join(',');
  const BAD_TAGS = { BUTTON: 1, A: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, LI: 1, UL: 1, OL: 1, LABEL: 1, FIGCAPTION: 1, NAV: 1, HEADER: 1, FOOTER: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, VIDEO: 1, AUDIO: 1, SCRIPT: 1, STYLE: 1, CAPTION: 1, TABLE: 1, FORM: 1, TITLE: 1, SVG: 1 };
  const INTERACTIVE = 'video,audio,button,input,select,textarea,a[href],[role="menu"],[role="menuitem"],[role="button"],[role="listbox"]';
  let capCache = new WeakMap(); const capKnown = new WeakSet(); const capRoots = [];
  const observed = new WeakSet(); const pending = new Set(); let mutTimer = 0, scanTimer = 0, scanWant = 0;
  let uiHost = null;

  function captionish(el) {
    if (BAD_TAGS[el.tagName]) return false;
    let sig = '';
    try { sig = (el.getAttribute('class') || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('data-testid') || ''); } catch (e) { return false; }
    return sig.length > 3 && RX.capYes.test(sig) && !RX.capNo.test(sig);
  }
  function validCapRoot(el) {
    try { if (el.querySelector(INTERACTIVE)) return false; return (el.textContent || '').length <= 800; } catch (e) { return false; }
  }
  // Najwyższy sensowny kontener napisów nad zmienionym węzłem (przechodzi też przez granice Shadow DOM)
  function captionRootFor(node) {
    const cached = capCache.get(node);
    if (cached === false) return null;
    if (cached && cached.isConnected) return cached;
    let el = node, depth = 0, best = null, bestKnown = false, bestAria = false;
    while (el && depth++ < 16) {
      if (el.nodeType === 11) { el = el.host; continue; }
      if (el.nodeType !== 1) { el = el.parentNode; continue; }
      if (el === uiHost) { best = null; break; }
      const tn = el.tagName;
      if (tn === 'BODY' || tn === 'HTML') break;
      let known = false; try { known = el.matches(KNOWN_CAP); } catch (e) {}
      const cap = known || (!bestKnown && captionish(el));
      const svg = !cap && !bestKnown && el.localName === 'svg' && el.namespaceURI === SVG_NS && svgish(el);
      const aria = !cap && !svg && !best && ariaish(el);
      if ((cap || svg || aria) && validCapRoot(el)) { best = el; bestAria = !!aria; if (known) bestKnown = true; }
      el = el.parentNode;
    }
    capCache.set(node, best || false);
    if (best && bestKnown) capKnown.add(best);
    if (best && bestAria && !bestKnown) ariaRoots.add(best);
    return best;
  }
  const SVG_NS = 'http://www.w3.org/2000/svg'; const ariaRoots = new WeakSet(); const ariaLast = new WeakMap(), ariaCount = new WeakMap();
  function overlapsVideo(el) { // dokładnie nad wideo (w odróżnieniu od overlapsMedia, które przy braku wideo mówi „tak\")
    let r; try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    if (!r.width || !r.height) return false; let hit = false;
    media.forEach(function (m) { if (hit || m.tagName !== 'VIDEO' || m.ownerDocument !== el.ownerDocument) return; try { const v = m.getBoundingClientRect(); if (v.width && r.left < v.right && r.right > v.left && r.top < v.bottom && r.bottom > v.top) hit = true; } catch (e) {} });
    return hit;
  }
  function svgish(el) { try { return !!el.querySelector('text') && overlapsVideo(el); } catch (e) { return false; } }
  function ariaish(el) { // region aria-live / role=log|status nad wideo — słabsze źródło napisów (częste są tam komunikaty typu „głośność 50%\")
    let lv = '', role = ''; try { lv = el.getAttribute('aria-live') || ''; role = (el.getAttribute('role') || '').toLowerCase(); } catch (e) { return false; }
    if (!((lv && lv !== 'off') || role === 'log' || role === 'status' || role === 'alert' || role === 'marquee')) return false;
    if (BAD_TAGS[el.tagName]) return false;
    let sig = ''; try { sig = (el.getAttribute('class') || '') + ' ' + (el.id || ''); } catch (e) {}
    if (RX.capNo.test(sig) && !RX.capYes.test(sig)) return false;
    return overlapsVideo(el);
  }
  const PUA = /[\uE000-\uF8FF]/g;
  function altOrPseudo(root) { // napis zapisany w alt obrazka albo w content pseudo-elementu ::before/::after (np. content: attr(data-text))
    const parts = [];
    try {
      const els = [root].concat([].slice.call(root.querySelectorAll('*'), 0, 14));
      for (let i = 0; i < els.length; i++) {
        const e = els[i];
        if (e.tagName === 'IMG') { const a = e.getAttribute('alt'); if (a && a.length > 1) parts.push(a); }
        ['::before', '::after'].forEach(function (ps) { const c = W.getComputedStyle(e, ps).content; if (c && c !== 'none' && c !== 'normal' && /^["']/.test(c) && c.length > 3) parts.push(c.slice(1, -1).replace(/\\(["'\\])/g, '$1')); });
      }
    } catch (e) {}
    return tidyLines(parts.join('\n'));
  }
  function overlapsMedia(el) {
    let r; try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    if (!r.width || !r.height) return false;
    let any = false, hit = false;
    media.forEach(function (m) {
      if (hit || m.tagName !== 'VIDEO' || m.ownerDocument !== el.ownerDocument) return;
      any = true;
      try { const v = m.getBoundingClientRect(); if (v.width && r.left < v.right && r.right > v.left && r.top < v.bottom && r.bottom > v.top) hit = true; } catch (e) {}
    });
    return hit || !any;
  }
  function captionText(root) {
    try { if (!root.getClientRects().length) return ''; } catch (e) {}
    let t = '';
    try {
      const raw = root.getAttribute && root.getAttribute('data-lkc-raw');   // [AGENT-EXP] 2026-11-17: napis z kreskami (tryb „dashes”) — bierzemy oryginał
      if (raw != null) t = raw;
      else if (root.localName === 'svg') t = [].map.call(root.querySelectorAll('text'), function (x) { return x.textContent; }).join('\n');
      else t = root.innerText != null ? root.innerText : root.textContent;
    } catch (e) {}
    t = tidyLines(String(t || ''));
    if (!t) t = altOrPseudo(root);
    if (t) { const pu = t.match(PUA); if (pu && pu.length > t.length * 0.3) { reportOnce('pua:' + (root.className || root.tagName), 'Mutation', 'tekst napisów jest zapisany niestandardową czcionką (znaki z obszaru prywatnego Unicode) — strona szyfruje napisy fontem; odczyta je tylko OCR'); return ''; } }
    if (!t || t.length > 600) return '';
    if (!capKnown.has(root) && !overlapsMedia(root)) return '';
    return t;
  }
  // ── Rejestr kontenerów: z jakich elementów strony idą napisy (do użycia w innych skryptach i rozszerzeniach) ──
  const containers = new Map(); const contByEl = new WeakMap();
  const cssEsc = function (s) { try { if (W.CSS && W.CSS.escape) return W.CSS.escape(s); } catch (e) {} return String(s).replace(/([^\w-])/g, '\\$1'); };
  const RX_STATE_CLASS = /^(?:is-|has-)?(?:active|show|shown|visible|hidden|hide|hover|focus|focused|open|opened|playing|paused|selected|current|fade|in|out|enter|leave|loading|loaded|ready)$/i;
  function classTokens(el) {
    const out = []; const cls = String(el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    for (let i = 0; i < cls.length && out.length < 3; i++) {
      const c = cls[i];
      if (c.length > 50 || RX_STATE_CLASS.test(c)) continue;
      const m = /^([A-Za-z][\w-]*?[A-Za-z])(?:__|--|_|-)([A-Za-z0-9]{5,})$/.exec(c);
      if (m && /\d/.test(m[2]) && /[A-Za-z]/.test(m[2])) { out.push('[class*="' + m[1] + '"]'); continue; } // klasa z losowym haszem (moduły CSS)
      if (/\d{3,}/.test(c) || /^(?:css|sc|jss|jsx|svelte)-/.test(c)) continue;
      out.push('.' + cssEsc(c));
    }
    return out;
  }
  function localSelector(el) {
    const tag = el.tagName.toLowerCase(); const id = el.id;
    if (id && /^[A-Za-z][\w-]*$/.test(id) && !/\d{3,}/.test(id)) return '#' + cssEsc(id);
    const cls = classTokens(el);
    if (cls.length) return (tag.indexOf('-') !== -1 ? tag : '') + cls.join('');
    const tid = el.getAttribute('data-testid');
    if (tid && tid.length < 60) return tag + '[data-testid="' + tid.replace(/"/g, '\\"') + '"]';
    return tag;
  }
  function selCount(root, sel) { try { return root.querySelectorAll(sel).length; } catch (e) { return 99; } }
  // Selektor CSS możliwie jednoznaczny w obrębie swojego korzenia (dokumentu albo shadowRoot)
  function cssPath(el) {
    const root = el.getRootNode ? el.getRootNode() : doc;
    let sel = localSelector(el);
    if (selCount(root, sel) === 1) return sel;
    let cur = el, depth = 0;
    while (cur.parentElement && depth++ < 4) {
      const p = cur.parentElement; if (p.tagName === 'BODY' || p.tagName === 'HTML') break;
      sel = localSelector(p) + ' > ' + sel;
      if (selCount(root, sel) === 1) return sel;
      cur = p;
    }
    return sel;
  }
  // Droga przez Shadow DOM: kolejne elementy-hosty od dokumentu w dół
  function shadowChain(el) {
    const chain = []; let root = el.getRootNode ? el.getRootNode() : null, n = 0;
    while (root && root.nodeType === 11 && root.host && n++ < 8) {
      const host = root.host; let mode = 'closed'; try { if (host.shadowRoot === root) mode = 'open'; } catch (e) {}
      chain.unshift({ host: cssPath(host), mode: mode });
      root = host.getRootNode ? host.getRootNode() : null;
    }
    return chain;
  }
  function bestSelector(el) {
    const root = el.getRootNode ? el.getRootNode() : doc;
    for (let i = 0; i < KNOWN_LIST.length; i++) { let ok = false; try { ok = el.matches(KNOWN_LIST[i]); } catch (e) {} if (ok && selCount(root, KNOWN_LIST[i]) === 1) return KNOWN_LIST[i]; }
    return cssPath(el);
  }
  function pubContainer(c, withEl) {
    const o = { type: 'dom', selector: c.selector, matches: c.matches, shadow: c.shadow.map(function (s) { return { host: s.host, mode: s.mode }; }), closedShadow: c.closed, leaf: c.leaf, known: c.known, sample: c.sample, changes: c.changes, frame: !IS_TOP, frameUrl: IS_TOP ? '' : String(W.location.href), marker: CFG.markContainers ? '[data-ush-captions]' : '' };
    if (withEl) o.element = c.el && c.el.isConnected ? c.el : null; // tylko w API (zdarzenia niosą same dane, żeby docierały też do rozszerzeń)
    return o;
  }
  function containerFor(root) {
    let c = contByEl.get(root);
    if (!c) {
      const chain = shadowChain(root), sel = bestSelector(root);
      const key = chain.map(function (s) { return s.host; }).concat(sel).join(' >>> ');
      c = containers.get(key);
      if (!c) {
        if (containers.size >= 12) return null;
        c = { key: key, selector: sel, matches: selCount(root.getRootNode ? root.getRootNode() : doc, sel), shadow: chain, closed: chain.some(function (s) { return s.mode === 'closed'; }), known: capKnown.has(root), leaf: '', sample: '', changes: 0, el: root, ui: null };
        containers.set(key, c);
        report(chain.length ? 'ShadowDOM' : 'Mutation', 'kontener napisów na ekranie: ' + key + (c.closed ? '  (zamknięty Shadow DOM)' : ''));
        emit('container', pubContainer(c));
        uiDirty();
      }
      contByEl.set(root, c);
    }
    c.el = root;
    if (CFG.markContainers) { try { if (!root.hasAttribute('data-ush-captions')) root.setAttribute('data-ush-captions', ''); } catch (e) {} }
    return c;
  }
  function leafSelector(root) { // element, w którym faktycznie siedzi tekst napisu
    try {
      const tw = doc.createTreeWalker(root, 4); const cnt = {}; let n = 0, node, best = '', bn = 0;
      while ((node = tw.nextNode()) && n < 8) {
        if (!node.nodeValue || !node.nodeValue.trim()) continue; n++;
        const p = node.parentElement; if (!p || p === root) continue;
        const sl = localSelector(p); cnt[sl] = (cnt[sl] || 0) + 1;
        if (cnt[sl] > bn) { bn = cnt[sl]; best = sl; }
      }
      return best;
    } catch (e) { return ''; }
  }
  function noteCapRoot(r) {
    if (capRoots.indexOf(r) !== -1) return true;
    for (let k = capRoots.length - 1; k >= 0; k--) { const x = capRoots[k]; if (x.contains(r)) return false; if (r.contains(x)) capRoots.splice(k, 1); }
    capRoots.push(r); if (capRoots.length > 6) capRoots.shift();
    containerFor(r);
    return true;
  }
  let mutDelay = 70, mutOverflow = false;
  function flushMutations() {
    if (!SESJA) return; // przy burzy zmian DOM zwalniamy (do 0,5 s), gdy jest spokojnie — wracamy do 70 ms
    const t0 = now(), over = mutOverflow; mutOverflow = false;
    flushMutations0();
    const dt = now() - t0;
    if (dt > 8 || over) mutDelay = Math.min(500, mutDelay * 2); else if (mutDelay > 70) mutDelay = Math.max(70, Math.round(mutDelay * 0.75));
  }
  function flushMutations0() {
    mutTimer = 0;
    const nodes = Array.from(pending).slice(0, 250); pending.clear();
    if (!media.size && !capRoots.length) return; // bez odtwarzacza nie szukamy napisów ekranowych
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]; if (!n.isConnected) continue;
      const r = captionRootFor(n); if (r) noteCapRoot(r);
    }
    if (!capRoots.length) return;
    const texts = [], parts = [], ariaT = []; let origin = null;
    for (let i = 0; i < capRoots.length; i++) {
      const r = capRoots[i]; if (!r.isConnected) { capRoots.splice(i--, 1); continue; }
      const t = captionText(r); if (!t) continue;
      if (ariaRoots.has(r)) { // słabsze źródło: osobny kanał, a kontener rejestrujemy dopiero, gdy tekst zmienia się jak napis
        if (ariaT.indexOf(t) === -1) ariaT.push(t);
        if (ariaLast.get(r) !== t) { ariaLast.set(r, t); ariaCount.set(r, (ariaCount.get(r) || 0) + 1); }
        if ((ariaCount.get(r) || 0) >= 4) containerFor(r);
        continue;
      }
      const c = containerFor(r);
      if (c) {
        if (t !== c.sample) { c.sample = t; c.changes++; const lf = leafSelector(r); if (lf) c.leaf = lf; }
        if (!origin) origin = { selector: c.selector, shadow: c.shadow, leaf: c.leaf, key: c.key };
        parts.push({ selector: c.selector, shadow: c.shadow, leaf: c.leaf, text: t });
      }
      if (texts.indexOf(t) === -1) texts.push(t);
    }
    if (origin) origin.parts = parts;
    liveUpdate('Mutation', texts.join('\n'), undefined, origin);
    if (ariaT.length || live.ch.ARIA) liveUpdate('ARIA', ariaT.join('\n'));
  }
  function onMutations(muts) {
    if (!SESJA) return;
    for (let i = 0; i < muts.length; i++) {
      const m = muts[i];
      if (m.type === 'childList' && !scanTimer) {
        const ad = m.addedNodes;
        for (let k = 0; k < ad.length; k++) {
          const a = ad[k]; if (a.nodeType !== 1) continue;
          const tn = a.tagName;
          if (tn === 'VIDEO' || tn === 'AUDIO' || tn === 'TRACK' || tn === 'SOURCE' || tn === 'IFRAME') { scheduleScan(500); break; }
          if (a.firstElementChild) { let q = null; try { q = a.querySelector('video,audio,track'); } catch (e) {} if (q) { scheduleScan(500); break; } }
        }
      }
      if (!media.size && !capRoots.length) continue;
      const node = m.type === 'characterData' ? m.target.parentNode : m.target;
      if (node && node !== uiHost) { if (pending.size < 600) pending.add(node); else mutOverflow = true; }
    }
    if (pending.size && !mutTimer) mutTimer = setTimeout(function () { guard(flushMutations); }, mutDelay);
  }
  let mo = null;
  function observeRoot(root) {
    if (!root || observed.has(root)) return;
    observed.add(root);
    try { if (!mo) mo = new W.MutationObserver(function (m) { try { onMutations(m); } catch (e) {} }); mo.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'data-text', 'data-caption', 'data-subtitle', 'data-content', 'title', 'alt'] }); } catch (e) {}
  }

  /* ═══════════════ 13. WINDOW I INSTANCJE ODTWARZACZY ═══════════════ */

  const KNOWN_GLOBALS = ['playerConfig', 'player_config', 'playerConfiguration', 'videoConfig', 'video_config', 'config', '__INITIAL_STATE__', '__INITIAL_DATA__', 'INITIAL_DATA', 'INITIAL_STATE', '__PRELOADED_STATE__', '__NEXT_DATA__', '__NUXT__', '__APOLLO_STATE__', '__REDUX_STATE__', '__DATA__', '__STATE__', '__playinfo__', '__PLAYER_CONFIG__', 'playerData', 'videoData', 'video_data', 'pageData', 'jwConfig', 'jwplayerConfig', 'flashvars', 'playerOptions', 'player_options', 'playlist', 'sources', 'tracks', 'subtitles', 'captions', 'textTracks', 'subs', 'embedConfig', 'bootstrap', '__remixContext', 'drupalSettings'];
  const PLAYER_GLOBALS = ['player', 'videoPlayer', 'myPlayer', 'plyr', 'hls', 'dp', 'art', 'shakaPlayer', 'dashPlayer', 'vjsPlayer', 'jw'];
  const SKIP_GLOBALS = new Set(['ytInitialPlayerResponse', 'ytInitialData', 'ytcfg', 'yt', 'ytplayer', '__USH__', 'dataLayer', 'google_tag_manager', 'webpackChunk', 'chrome', 'external', 'jQuery', '$', '_', 'React', 'ReactDOM', 'Vue', 'angular', 'videojs', 'jwplayer', 'Hls', 'shaka', 'dashjs', 'Plyr']);
  let baseKeys = null, lastWinScan = 0;

  function ytVideoId() { try { const q = new URL(W.location.href).searchParams.get('v'); if (q) return q; const m = /\/(?:embed|shorts|live)\/([\w-]{6,})/.exec(W.location.pathname); return m ? m[1] : ''; } catch (e) { return ''; } }
  // [AGENT-EXP] 2026-10-22: YouTube podsuwa w danych strony adresy /api/timedtext innych filmów (v= inny niż bieżący,
  // dziwne nazwy i języki). Wygrywały punktami z prawdziwą ścieżką (zwłaszcza polską automatyczną), a „najlepsze → lektor”
  // próbuje tylko 4 pierwszych — prawdziwa nie dochodziła do kolejki, a potem 🔋 usypiał Łowcę.
  function ytTimedVid(url) { try { return RX.ytTimed.test(url) ? (new URL(url, W.location.href).searchParams.get('v') || '') : ''; } catch (e) { return ''; } }
  function ytOtherVideo(url) { const v = ytTimedVid(url); if (!v) return false; const cur = ytVideoId(); return !!cur && v !== cur; }
  function ytThisVideo(url) { const v = ytTimedVid(url); return !!v && v === ytVideoId(); }
  function scanPlayers() {
    // YouTube: aktualna odpowiedź odtwarzacza (nie przeterminowane ytInitialPlayerResponse po przejściu do innego filmu)
    guard(function () {
      if (!/youtube|youtu\.be/.test(HOST)) return;
      const mp = doc.getElementById('movie_player') || doc.querySelector('.html5-video-player');
      let pr = null;
      if (mp && typeof mp.getPlayerResponse === 'function') pr = mp.getPlayerResponse();
      if (!pr) { const init = W.ytInitialPlayerResponse; const vid = ytVideoId(); if (init && (!vid || !init.videoDetails || init.videoDetails.videoId === vid)) pr = init; }
      const list = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks;
      if (list) for (let i = 0; i < list.length; i++) { const t = list[i]; if (t && t.baseUrl) addItem({ url: t.baseUrl, layer: 'Window', strong: true, lang: t.languageCode, label: textOf(t.name), auto: t.kind === 'asr', format: 'yt' }); }
    });
    // JW Player
    guard(function () {
      if (typeof W.jwplayer !== 'function') return;
      const p = W.jwplayer(); if (!p || typeof p.getPlaylistItem !== 'function') return;
      const item = p.getPlaylistItem(); if (item) analyzeObject(item, 'Window', { name: 'jwplayer.playlistItem', safe: true, maxDepth: 6, maxNodes: 4000, budget: 15 });
    });
    // Video.js
    guard(function () {
      const v = W.videojs; if (!v) return;
      const players = typeof v.getAllPlayers === 'function' ? v.getAllPlayers() : (v.players ? Object.keys(v.players).map(function (k) { return v.players[k]; }) : []);
      for (let i = 0; i < players.length && i < 10; i++) {
        const p = players[i]; if (!p) continue;
        try { const tt = typeof p.textTracks === 'function' ? p.textTracks() : null; if (tt) for (let k = 0; k < tt.length; k++) { const t = tt[k]; if (t && t.src && !RX.badKind.test(t.kind || '')) addItem({ url: t.src, layer: 'Window', strong: true, lang: t.language, label: t.label }); } } catch (e) {}
        if (p.options_) analyzeObject(p.options_, 'Window', { name: 'videojs.options_', safe: true, maxDepth: 5, maxNodes: 3000, budget: 10 });
        if (p.cache_) analyzeObject(p.cache_, 'Window', { name: 'videojs.cache_', safe: true, maxDepth: 5, maxNodes: 3000, budget: 10 });
      }
    });
    // Typowe instancje: Hls.js, Shaka, dash.js, Plyr, DPlayer, ArtPlayer…
    for (let i = 0; i < PLAYER_GLOBALS.length; i++) {
      guard(function () {
        const p = own(W, PLAYER_GLOBALS[i]); if (!p || (typeof p !== 'object' && typeof p !== 'function') || isForbidden(p)) return;
        const name = PLAYER_GLOBALS[i];
        ['subtitleTracks', 'allSubtitleTracks'].forEach(function (k) { try { const l = p[k] || (p.hls && p.hls[k]); if (Array.isArray(l)) for (let j = 0; j < l.length; j++) { const t = l[j]; if (t && typeof t.url === 'string') { store.hlsSubKeys.add(keyFor(t.url)); addItem({ url: t.url, layer: 'Window', kind: 'hls', format: 'hls', strong: true, lang: t.lang, label: t.name }); } } } catch (e) {} });
        ['getTextTracks', 'getCaptionsList', 'getSubtitles'].forEach(function (k) { try { if (typeof p[k] === 'function') { const l = p[k](); if (l && typeof l === 'object') analyzeObject(l, 'Window', { name: name + '.' + k + '()', safe: true, maxDepth: 4, maxNodes: 1500, budget: 6 }); } } catch (e) {} });
        if (typeof p === 'object') analyzeObject(p, 'Window', { name: name, safe: true, maxDepth: 6, maxNodes: 6000, budget: 20 });
      });
    }
    // Obiekty „przyklejone" do elementu wideo i jego przodków (player, hls, propsy Reacta…)
    media.forEach(function (el) {
      let a = el, d = 0;
      while (a && d++ < 3) {
        guard(function () {
          const keys = Object.keys(a);
          for (let i = 0; i < keys.length && i < 30; i++) {
            const k = keys[i]; if (/^(__reactFiber|__reactContainer|_reactListening|jQuery)/.test(k)) continue;
            const v = own(a, k); if (v && typeof v === 'object' && !isForbidden(v)) analyzeObject(v, 'Window', { name: a.tagName.toLowerCase() + '.' + k.replace(/\$.*$/, ''), safe: true, maxDepth: 6, maxNodes: 3000, budget: 10 });
          }
        });
        a = a.parentNode;
      }
    });
  }
  function pageGlobals() {
    if (!baseKeys) {
      baseKeys = new Set();
      try {
        // „czyste" okno z pustej ramki = lista wbudowanych właściwości; reszta to dodatki strony
        const f = doc.createElement('iframe'); f.style.display = 'none'; f.setAttribute('data-ush-probe', '');
        (doc.documentElement || doc).appendChild(f);
        try { Object.getOwnPropertyNames(f.contentWindow).forEach(function (k) { baseKeys.add(k); }); } finally { f.remove(); }
      } catch (e) {}
    }
    let names = []; try { names = Object.getOwnPropertyNames(W); } catch (e) {}
    return names.filter(function (n) { return !baseKeys.has(n) && !SKIP_GLOBALS.has(n) && !/^(on|webkit|\d+$|__zone|__core-js|_gaq|ga$|gtag|GoogleAnalytics|adsbygoogle|__tcfapi|google|goog|gapi|closure_)/.test(n); });
  }
  function scanWindow(force) {
    if (!force && Date.now() - lastWinScan < 4000) return;
    lastWinScan = Date.now();
    scanPlayers();
    const deadline = now() + 160;
    for (let i = 0; i < KNOWN_GLOBALS.length; i++) {
      const v = own(W, KNOWN_GLOBALS[i]);
      if (v && typeof v === 'object' && !isForbidden(v)) analyzeObject(v, 'Window', { name: KNOWN_GLOBALS[i], safe: true, maxDepth: 14, maxNodes: 30000, budget: 40 });
      else if (typeof v === 'string' && v.length > 20) inspectString(v, { path: KNOWN_GLOBALS[i], holder: null }, 'Window', {});
    }
    // heurystyka: wszystko, co strona sama dodała do window
    const names = pageGlobals(); const known = new Set(KNOWN_GLOBALS.concat(PLAYER_GLOBALS));
    for (let i = 0; i < names.length && i < 600; i++) {
      if (now() > deadline) break;
      const n = names[i]; if (known.has(n)) continue;
      const v = own(W, n);
      if (v && typeof v === 'object') { if (!isForbidden(v)) analyzeObject(v, 'Window', { name: n, safe: true, maxDepth: 7, maxNodes: 4000, budget: 12 }); }
      else if (typeof v === 'string' && v.length > 20) { try { inspectString(v, { path: n, holder: null }, 'Window', {}); } catch (e) {} }
    }
  }

  /* ═══════════════ 14. MAGAZYNY PRZEGLĄDARKI ═══════════════ */

  function inspectLoose(s, layer, name) { // łańcuch nieznanego rodzaju: treść napisów, JSON albo tekst z adresami
    if (typeof s !== 'string' || s.length < 30 || s.length > 6000000) return 0;
    const f = sniffFormat(s);
    if (f && f !== 'json' && f !== 'm3u8' && f !== 'mpd') return handleSubText(s, f, '', layer) ? 1 : 0;
    if (f === 'json') { if (!RX.jsonHint.test(s)) return 0; let obj = null; try { obj = O.jsonParse(s); } catch (e) {} return obj ? analyzeObject(obj, layer, { name: name, maxNodes: 6000, budget: 12 }) : 0; }
    return extractUrlsFromText(s, layer);
  }
  function scanWebStorage() {
    ['localStorage', 'sessionStorage'].forEach(function (nm) {
      guard(function () {
        const st = W[nm]; if (!st) return;
        const n = Math.min(st.length, 400);
        for (let i = 0; i < n; i++) { const k = st.key(i); if (k == null) continue; let v = null; try { v = st.getItem(k); } catch (e) {} if (v) inspectLoose(v, 'Storage', nm + '.' + k); }
      });
    });
  }
  async function scanCaches() {
    const cs = W.caches; if (!cs || typeof cs.keys !== 'function') return 0;
    let n = 0, names = []; try { names = await cs.keys(); } catch (e) { return 0; }
    for (const name of names.slice(0, 20)) {
      try {
        const c = await cs.open(name); const reqs = await c.keys();
        for (const r of reqs.slice(0, 5000)) { const u = r.url; if (u && !RX.thumbs.test(u) && (RX.subExt.test(u) || RX.ytTimed.test(u))) { if (addItem({ url: u, layer: 'Cache', strong: true, note: 'Cache Storage: ' + name })) n++; } }
      } catch (e) {}
    }
    return n;
  }
  function inspectStored(key, value, where) {
    if (typeof value === 'string') return inspectLoose(value, 'IndexedDB', where);
    if (!value || typeof value !== 'object') return 0;
    const tg = tagOf(value);
    const keyUrl = typeof key === 'string' && looksLikeUrl(key) ? key : '';
    if (tg === '[object Blob]' || tg === '[object File]') {
      if (value.size > 20 && value.size < CFG.maxBodyBytes && !/^(video|audio|image|font)\//.test(value.type || '')) value.slice(0, 1200).arrayBuffer().then(function (ab) { const head = smartDecode(new Uint8Array(ab), value.type); const f = head && sniffFormat(head); if (f && f !== 'json') return value.arrayBuffer().then(function (full) { const t = smartDecode(new Uint8Array(full), value.type); if (t) handleSubText(t, f, keyUrl, 'IndexedDB'); }); }).catch(noop);
      return 0;
    }
    if (tg === '[object ArrayBuffer]' || ArrayBuffer.isView(value)) {
      const u8 = tg === '[object ArrayBuffer]' ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      if (u8.length > 20 && u8.length < 2000000) { const t = smartDecode(u8, ''); const f = t && sniffFormat(t); if (f && f !== 'json') return handleSubText(t, f, keyUrl, 'IndexedDB') ? 1 : 0; }
      return 0;
    }
    return analyzeObject(value, 'IndexedDB', { name: where, maxNodes: 1500, maxDepth: 6, budget: 8 });
  }
  function scanOneDB(idb, name) {
    return new Promise(function (resolve) {
      let done = false, db = null;
      const finish = function (n) { if (done) return; done = true; try { if (db) db.close(); } catch (e) {} clearTimeout(timer); resolve(n || 0); };
      const timer = setTimeout(function () { finish(0); }, 4000);
      let req; try { req = idb.open(name); } catch (e) { return finish(0); }
      req.onupgradeneeded = function () { try { req.transaction.abort(); } catch (e) {} }; // bazy nie było — nie tworzymy jej
      req.onerror = req.onblocked = function () { finish(0); };
      req.onsuccess = function () {
        db = req.result; let n = 0;
        db.onversionchange = function () { finish(n); };
        const names = [].slice.call(db.objectStoreNames, 0, 12);
        if (!names.length) return finish(0);
        let left = names.length;
        const oneDone = function () { if (--left <= 0) finish(n); };
        names.forEach(function (sn) {
          try {
            let c = 0; const cr = db.transaction(sn, 'readonly').objectStore(sn).openCursor();
            cr.onsuccess = function () {
              const cur = cr.result; if (!cur || c++ >= 250 || done) return oneDone();
              try { n += inspectStored(cur.key, cur.value, name + '/' + sn) || 0; } catch (e) {}
              try { cur.continue(); } catch (e) { oneDone(); }
            };
            cr.onerror = function () { oneDone(); };
          } catch (e) { oneDone(); }
        });
      };
    });
  }
  async function scanIndexedDB() {
    const idb = W.indexedDB; if (!idb || typeof idb.databases !== 'function') return 0;
    let dbs = []; try { dbs = await idb.databases(); } catch (e) { return 0; }
    let n = 0;
    for (const d of dbs.slice(0, 15)) { if (d && d.name) { try { n += await scanOneDB(idb, d.name); } catch (e) {} } }
    return n;
  }
  function scanPerformance() { try { W.performance.getEntriesByType('resource').forEach(perfEntry); } catch (e) {} }
  function perfEntry(e) {
    if (!SESJA) return;
    const u = e && e.name; if (typeof u !== 'string' || u.length > 3000 || RX.thumbs.test(u)) return;
    if (RX.subExt.test(u) || RX.ytTimed.test(u) || /\/texttracks?\//i.test(u)) { addItem({ url: u, layer: 'Performance', strong: true }); return; }
    const it = e.initiatorType; // kto zażądał zasobu: <track> to pewny trop, fetch/XHR ze słowem „subtitle…\" w ścieżce — słaby
    if (it === 'track') { addItem({ url: u, layer: 'Performance', strong: true, label: '<track>' }); return; }
    if ((it === 'fetch' || it === 'xmlhttprequest' || it === 'other') && RX.keyword.test(u) && !RX.notSub.test(u) && e.decodedBodySize > 40 && e.decodedBodySize < 3000000 && /subtitle|caption|timedtext|transcript|napisy|subs?[\/._-]/i.test(u.split('?')[0])) addItem({ url: u, layer: 'Performance', strong: false, weakOk: true, note: 'adres z sieci (' + it + '), treść niezweryfikowana' });
  }
  /* ═══ 14b. DODATKOWE MAGAZYNY I ŹRÓDŁA ═══ */

  function scanMisc() {
    guard(function () { // document.cookie
      if (!CFG.scanCookies) return; const ck = String(doc.cookie || ''); if (ck.length < 30) return;
      const parts = ck.split(/;\s*/);
      for (let i = 0; i < parts.length && i < 200; i++) { const eq = parts[i].indexOf('='); if (eq < 0) continue; let v = parts[i].slice(eq + 1); if (v.length < 30) continue; try { v = decodeURIComponent(v); } catch (e) {} inspectLoose(v, 'Cookie', 'cookie.' + parts[i].slice(0, eq)); }
    });
    guard(function () { const nm = W.name; if (typeof nm === 'string' && nm.length >= 30) inspectLoose(nm, 'Okno', 'window.name'); });
    guard(function () { const st = W.history && W.history.state; if (st && typeof st === 'object') analyzeObject(st, 'History', { name: 'history.state', maxNodes: 5000, budget: 10 }); else if (typeof st === 'string') inspectLoose(st, 'History', 'history.state'); });
  }
  // Origin Private File System (nowoczesne PWA trzymają tu pliki)
  async function scanOPFS() {
    const sm = W.navigator && W.navigator.storage; if (!sm || typeof sm.getDirectory !== 'function') return 0;
    let root; try { root = await sm.getDirectory(); } catch (e) { return 0; }
    let n = 0, count = 0;
    const walk = async function (dir, depth) {
      if (depth > 4 || count > 400) return;
      for await (const pair of dir.entries()) {
        if (count++ > 400) return; const name = pair[0], h = pair[1];
        if (h.kind === 'directory') { await walk(h, depth + 1); continue; }
        let f; try { f = await h.getFile(); } catch (e) { continue; }
        if (f.size < 20 || f.size > CFG.maxBodyBytes) continue;
        const looks = RX.subExt.test(name) || RX.keyword.test(name); if (!looks && f.size > 2000000) continue;
        const head = smartDecode(new Uint8Array(await f.slice(0, 1200).arrayBuffer()), ''); const fm = head && sniffFormat(head);
        if (fm && fm !== 'json' && fm !== 'm3u8' && fm !== 'mpd') { const full = smartDecode(new Uint8Array(await f.arrayBuffer()), ''); if (full && handleSubText(full, fm, '', 'OPFS')) n++; }
        else if (fm === 'json' && RX.jsonHint.test(head)) { const full = smartDecode(new Uint8Array(await f.arrayBuffer()), ''); if (full) n += inspectLoose(full, 'OPFS', name) ? 1 : 0; }
      }
    };
    try { await walk(root, 0); } catch (e) {}
    return n;
  }
  function scanStyleSheets() { // tekst w regułach CSS (content: "…") dla selektorów wyglądających na napisy
    let sheets; try { sheets = doc.styleSheets; } catch (e) { return; }
    for (let s = 0; s < sheets.length && s < 40; s++) {
      let rules; try { rules = sheets[s].cssRules; } catch (e) { continue; }
      for (let r = 0; r < rules.length && r < 4000; r++) {
        const ru = rules[r]; const c = ru && ru.style && ru.style.content;
        if (!c || c.length < 30 || !/^["']/.test(c) || !RX.capYes.test(ru.selectorText || '')) continue;
        addItem({ layer: 'CSS', text: c.slice(1, -1), strong: false, weakOk: true, label: String(ru.selectorText).slice(0, 60), note: 'tekst z reguły CSS (content)' });
      }
    }
  }
  // Pełne przeglądanie atrybutów data-*/title/alt/aria-label wszystkich elementów — małymi porcjami, w czasie bezczynności
  let sweepRunning = false;
  function sweepAttributes() {
    if (!CFG.sweepAttrs || sweepRunning) return; sweepRunning = true;
    const roots = collectRoots(doc); const els = [];
    for (let r = 0; r < roots.length && els.length < 80000; r++) { let l; try { l = roots[r].querySelectorAll('*'); } catch (e) { continue; } for (let i = 0; i < l.length && els.length < 80000; i++) els.push(l[i]); }
    let i = 0;
    const step = function () {
      if (!SESJA) { sweepRunning = false; return; }
      const t0 = now(), end = t0 + Math.max(1, Math.min(8, cpuLeft()));
      while (i < els.length && now() < end) { const el = els[i++]; try { if (el.hasAttributes && el.hasAttributes() && !attrsSeen.has(el)) inspectAttrs(el, 'DOM'); } catch (e) {} }
      cpuCharge(now() - t0);
      if (i < els.length) idle(step, 800); else sweepRunning = false;
    };
    idle(step, 800);
  }

  let deepBusy = false;
  async function deepScan() {
    if (deepBusy) return 0; deepBusy = true;
    const before = store.items.size;
    try { scanWebStorage(); scanMisc(); scanStyleSheets(); scanPerformance(); sweepAttributes(); await scanCaches(); await scanIndexedDB(); await scanOPFS(); } catch (e) {}
    deepBusy = false;
    const n = store.items.size - before;
    report('Skan', 'głęboki skan (storage, cookies, CSS, atrybuty, Cache Storage, IndexedDB, OPFS) zakończony, nowych znalezisk: ' + n);
    return n;
  }

  /* ═══════════════ 15. POBIERANIE I EKSPORT ═══════════════ */

  // Nagłówki dla GM_xmlhttpRequest; poziom rośnie przy odmowach serwera (400/401/403/429): 0 = Referer, 1 = + Origin/Accept/Accept-Language, 2 = + Client Hints, Sec-Fetch-* (najlepszy wysiłek: część przeglądarek ignoruje nagłówki zabronione) i ewentualny User-Agent
  function gmHeaders(url, lvl) {
    const h = {}; const ref = CFG.referer;
    if (ref === 'page') h.Referer = W.location.href; else if (ref === 'origin') h.Referer = W.location.origin + '/'; else if (ref === 'self') { try { h.Referer = new URL(url).origin + '/'; } catch (e) {} } else if (ref && ref !== 'none') h.Referer = String(ref);
    const rh = reqHeaders.get(keyFor(url)); if (rh) for (const k in rh) h[k] = rh[k];
    if (lvl >= 1) {
      h.Origin = W.location.origin; if (!h.Accept) h.Accept = '*/*';
      h['Accept-Language'] = CFG.acceptLanguage || ((W.navigator.languages && W.navigator.languages.join(',')) || W.navigator.language || 'en');
    }
    if (lvl >= 2) {
      const ud = W.navigator.userAgentData;
      if (ud) { h['Sec-CH-UA'] = (ud.brands || []).map(function (b) { return '"' + b.brand + '";v="' + b.version + '"'; }).join(', '); h['Sec-CH-UA-Mobile'] = ud.mobile ? '?1' : '?0'; h['Sec-CH-UA-Platform'] = '"' + (ud.platform || '') + '"'; }
      let site = 'cross-site'; try { if (new URL(url).origin === W.location.origin) site = 'same-origin'; } catch (e) {}
      h['Sec-Fetch-Dest'] = 'empty'; h['Sec-Fetch-Mode'] = 'cors'; h['Sec-Fetch-Site'] = site;
      if (CFG.gmUserAgent) h['User-Agent'] = CFG.gmUserAgent;
    }
    const x = CFG.gmHeaders; if (x && typeof x === 'object') for (const k in x) h[k] = x[k];
    return h;
  }
  function gmFetch(url, lvl) {
    return new Promise(function (resolve, reject) {
      if (!gm.xhr) return reject(new Error('strona blokuje pobranie z innej domeny'));
      try {
        gm.xhr({ method: 'GET', url: url, responseType: 'arraybuffer', timeout: 30000, headers: gmHeaders(url, lvl || 0),
          onload: function (r) {
            if (r.status >= 200 && r.status < 400 && r.response) resolve({ bytes: new Uint8Array(r.response), ct: ((/content-type:\s*([^\r\n]+)/i.exec(r.responseHeaders || '') || [])[1] || '').toLowerCase() });
            else reject(new Error('serwer odpowiedział kodem ' + r.status));
          },
          onerror: function () { reject(new Error('błąd sieci')); }, ontimeout: function () { reject(new Error('przekroczono czas oczekiwania')); } });
      } catch (e) { reject(e); }
    });
  }
  async function pageFetch(url, creds) {
    const init = { credentials: creds }; const hd = reqHeaders.get(keyFor(url)); if (hd) init.headers = hd;
    if (CFG.referer === 'none') init.referrerPolicy = 'no-referrer'; else if (CFG.referer === 'origin') init.referrerPolicy = 'origin';
    const res = await O.fetch.call(W, url, init);
    if (!res.ok) throw new Error('serwer odpowiedział kodem ' + res.status);
    return { bytes: new Uint8Array(await res.arrayBuffer()), ct: String(res.headers.get('content-type') || '').toLowerCase() };
  }
  // Kolejno: Cache Storage → fetch strony → GM_xmlhttpRequest (omija CORS)
  async function fetchBytes(url, fromCache) {
    if (fromCache && W.caches) { try { const r = await W.caches.match(url); if (r) return { bytes: new Uint8Array(await r.arrayBuffer()), ct: String(r.headers.get('content-type') || '').toLowerCase() }; } catch (e) {} }
    let last = null;
    if (O.fetch) {
      const modes = (sameOrigin(url) || /^(blob|data):/.test(url)) ? ['include'] : ['omit', 'include'];
      for (let i = 0; i < modes.length; i++) { try { return await pageFetch(url, modes[i]); } catch (e) { last = e; } }
    }
    if (/^https?:/.test(url)) for (let lvl = 0; lvl < 3; lvl++) { try { return await gmFetch(url, lvl); } catch (e) { last = e; if (!/kodem (400|401|403|429)\b/.test(errMsg(e))) break; } }
    throw last || new Error('nie udało się pobrać');
  }

  async function assembleHLS(it, url, depth) {
    const r = await fetchBytes(url);
    const pl = parseM3U8(smartDecode(r.bytes, r.ct) || '', url);
    if (!pl.segments.length && pl.subs.length && !depth) { // dostaliśmy playlistę główną — wybierz język
      const langs = prefLangs();
      const pick = pl.subs.slice().sort(function (a, b) { const ia = langs.indexOf((a.lang || '').slice(0, 2).toLowerCase()), ib = langs.indexOf((b.lang || '').slice(0, 2).toLowerCase()); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); })[0];
      if (pick.lang && !it.lang) it.lang = normLang(pick.lang);
      return assembleHLS(it, pick.url, 1);
    }
    if (!pl.segments.length) throw new Error('playlista HLS nie zawiera segmentów napisów');
    const segs = pl.segments.slice(0, 5000); const cache = it.segMap || (it.segMap = new Map());
    for (const s of segs) store.hlsSeg.set(noHash(s), it); // segmenty tej playlisty nie mają trafiać na listę osobno
    const ctx = { timescale: 0 };
    if (pl.init) { try { const ir = await fetchBytes(pl.init); const p = parseMP4Text(ir.bytes, ctx); if (p.timescale) ctx.timescale = p.timescale; } catch (e) {} }
    let done = 0;
    await mapLimit(segs, 6, async function (u) {
      const k = noHash(u);
      if (!cache.has(k)) {
        const sr = await fetchBytes(u);
        if (isISOBMFF(sr.bytes)) cache.set(k, { cues: parseMP4Text(sr.bytes, ctx).cues, tsMap: null });
        else { const p = parseVTT(smartDecode(sr.bytes, sr.ct) || ''); cache.set(k, { cues: p.cues, tsMap: p.tsMap }); }
      }
      if (++done % 15 === 0) toast('Składam napisy z segmentów: ' + done + ' z ' + segs.length);
    });
    it.segments = cache.size;
    return mergeSegments(segs.map(function (u) { return cache.get(noHash(u)); }));
  }
  function ytVariants(u0) {
    const out = [];
    try {
      if (RX.ytTimed.test(u0)) {
        const u = new URL(u0); const ex = yt.extras[u.searchParams.get('v')];
        if (ex) { const u2 = new URL(u0); for (const k in ex) if (!u2.searchParams.has(k)) u2.searchParams.set(k, ex[k]); out.push(u2.href); }
        if (!u.searchParams.has('fmt')) { u.searchParams.set('fmt', 'json3'); out.push(u.href); }
      }
    } catch (e) {}
    out.push(u0);
    return out;
  }
  // YouTube wydaje napisy tylko z żetonem odtwarzacza: na chwilę włączamy CC, żeby podejrzeć jego żądanie
  async function ytNudge() {
    const btn = doc.querySelector('.ytp-subtitles-button'); const vid = ytVideoId();
    if (!btn || !vid) return false;
    if (yt.extras[vid]) return true;
    const was = btn.getAttribute('aria-pressed') === 'true';
    if (was) { btn.click(); await sleep(350); }
    btn.click();
    const ok = await waitFor(function () { return yt.extras[vid]; }, 6000);
    if (!was) { await sleep(250); btn.click(); }
    return !!ok;
  }
  function ingest(it, bytes, ct, url) {
    if (!bytes || !bytes.length) return false;
    if (isISOBMFF(bytes)) { const r = parseMP4Text(bytes, {}); if (r.cues.length) { it.cues = normalizeCues(r.cues); it.verified = true; return true; } return false; }
    if (isSTL(bytes)) { const c = parseSTL(bytes); if (c.length) { it.cues = normalizeCues(c); it.format = 'stl'; it.verified = true; return true; } return false; }
    const text = smartDecode(bytes, ct);
    if (!text || !text.trim()) return false;
    const f = sniffFormat(text);
    if (f === 'm3u8') { it.kind = 'hls'; it.url = url; return 'hls'; }
    const p = parseAny(text, it.format);
    it.text = text;
    if (p && p.cues && p.cues.length) { it.cues = normalizeCues(p.cues); it.format = p.format; it.verified = true; ytRemember(url); return true; }
    if (/^\s*<(?:!doctype|html)/i.test(text)) { it.text = null; return false; } // strona błędu zamiast napisów
    return true;
  }
  async function ensureCues(it) {
    if (it.ccKey) { const g = ccState.groups.get(it.ccKey); if (g) { try { await ccPublishNow(g); } catch (e) {} } } // napisy zamknięte: świeży stan dekodera
    if (it.kind === 'hls') {
      if (!it.assembled) { const c = await assembleHLS(it, it.url, 0); if (c.length) { it.cues = c; it.verified = true; it.assembled = true; it.format = 'vtt'; } else if (!it.cues || !it.cues.length) throw new Error('w segmentach HLS nie znalazłem kwestii'); }
      return it;
    }
    if (it.cues && it.cues.length) return it;
    if (it.text != null && !it.url) return it;
    if (!it.url) throw new Error('to znalezisko nie ma ani adresu, ani treści');
    const tryAll = async function () {
      let last = null;
      const urls = [it.url].concat(it.urls.filter(function (u) { return u !== it.url; })).slice(0, 3);
      for (const u0 of urls) for (const u of ytVariants(u0)) {
        try {
          const r = await fetchBytes(u, it.layers.has('Cache'));
          const ok = ingest(it, r.bytes, r.ct, u);
          if (ok === 'hls') return ensureCues(it);
          if (ok && it.cues && it.cues.length) return it;
        } catch (e) { last = e; }
      }
      if (last && !(it.text != null)) throw last;
      return null;
    };
    let res = await tryAll();
    if ((!it.cues || !it.cues.length) && RX.ytTimed.test(it.url)) {
      toast('YouTube wymaga żetonu odtwarzacza — na chwilę włączam napisy w filmie…');
      if (await ytNudge()) res = await tryAll();
      if (!it.cues || !it.cues.length) throw new Error('YouTube nie wydał napisów. Włącz napisy (CC) w odtwarzaczu i wybierz ten język — przechwycę je automatycznie.');
    }
    if ((!it.cues || !it.cues.length) && it.text == null) throw new Error('serwer zwrócił pustą odpowiedź albo nieznany format');
    uiDirty();
    return res || it;
  }

  const RAW_EXT = dict({ vtt: 'vtt', srt: 'srt', ttml: 'ttml', xml: 'xml', json: 'json', json3: 'json', 'yt-transcript': 'json', sbv: 'sbv', ass: 'ass', lrc: 'lrc', sami: 'smi', srv1: 'xml', srv3: 'xml', scc: 'scc', stl: 'stl', cea608: 'txt', cea708: 'txt' });
  function fileName(it, ext) {
    let t = ''; try { t = (W.top === W ? doc.title : '') || doc.title || HOST; } catch (e) { t = doc.title || HOST; }
    t = String(t).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').replace(/ - YouTube$/, '').trim().slice(0, 90) || 'napisy';
    return t + (it && it.lang ? '.' + it.lang : '') + '.' + ext;
  }
  let dlRoot = null;
  function saveFile(name, text, ext) {
    const body = (CFG.bom && (ext === 'srt' || ext === 'txt')) ? '\uFEFF' + text : text;
    const blob = new Blob([body], { type: (ext === 'vtt' ? 'text/vtt' : ext === 'json' ? 'application/json' : 'text/plain') + ';charset=utf-8' });
    const mk = O.createObjectURL || W.URL.createObjectURL;
    const url = mk.call(W.URL, blob);
    const a = doc.createElement('a'); a.href = url; a.download = name; a.rel = 'noopener'; a.style.display = 'none';
    (dlRoot || doc.body || doc.documentElement).appendChild(a); a.click(); // w naszym Shadow DOM — routery stron nie widzą kliknięcia
    setTimeout(function () { try { a.remove(); W.URL.revokeObjectURL(url); } catch (e) {} }, 5000);
  }
  async function copyText(t) {
    try { if (gm.clip) { gm.clip(t, 'text'); return true; } } catch (e) {}
    try { await W.navigator.clipboard.writeText(t); return true; } catch (e) {}
    try {
      const ta = doc.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      (dlRoot || doc.body || doc.documentElement).appendChild(ta); ta.select();
      const ok = doc.execCommand('copy'); ta.remove(); return ok;
    } catch (e) { return false; }
  }
  const errMsg = function (e) { return String((e && e.message) || e || 'nieznany błąd'); };
  async function downloadItem(it, fmt) {
    if (!it) { toast('Nie ma jeszcze czego pobrać. Włącz napisy w odtwarzaczu albo kliknij „Skanuj ponownie".', true); return false; }
    toast('Przygotowuję napisy…');
    try {
      await ensureCues(it);
      let data, ext;
      const has = it.cues && it.cues.length;
      if (fmt === 'raw' && it.text != null) { data = it.text; ext = RAW_EXT[it.format] || extOf(it.url) || 'txt'; }
      else if (!has) { if (it.text == null) throw new Error('brak treści do zapisania'); data = it.text; ext = RAW_EXT[it.format] || extOf(it.url) || 'txt'; toast('Nie rozpoznałem formatu — zapisuję plik w oryginale.'); }
      else if (fmt === 'vtt') { data = toVTT(it.cues); ext = 'vtt'; }
      else if (fmt === 'txt') { data = toTXT(it.cues); ext = 'txt'; }
      else { data = toSRT(it.cues); ext = 'srt'; }
      const name = fileName(it, ext);
      saveFile(name, data, ext);
      toast('Pobrano: ' + name);
      uiDirty();
      return true;
    } catch (e) { toast('Nie udało się pobrać: ' + errMsg(e), true); return false; }
  }
  async function copyItem(it) {
    try { await ensureCues(it); const t = it.cues && it.cues.length ? toTXT(it.cues) : (it.text || ''); if (!t) throw new Error('brak treści'); toast((await copyText(t)) ? 'Skopiowano cały tekst napisów.' : 'Przeglądarka zablokowała schowek.', false); }
    catch (e) { toast('Nie udało się skopiować: ' + errMsg(e), true); }
  }
  function downloadBest() {
    const b = bestItem();
    if (b) return downloadItem(b, 'srt');
    const l = liveCues();
    if (l.cues.length) { const name = fileName(null, 'srt'); saveFile(name, toSRT(l.cues), 'srt'); toast('Pobrano zapis z ekranu: ' + name); return Promise.resolve(true); }
    return downloadItem(null);
  }
  async function copyCurrent() {
    const t = currentText();
    if (!t) { toast('Na ekranie nie ma teraz żadnego napisu.', true); return; }
    toast((await copyText(t)) ? 'Skopiowano: „' + t.replace(/\n/g, ' ').slice(0, 60) + (t.length > 60 ? '…' : '') + '”' : 'Przeglądarka zablokowała schowek.');
  }
  function consoleReport() {
    const rows = sortedItems().map(function (it) { return { warstwy: Array.from(it.layers).join(', '), 'język': it.lang, etykieta: it.label, format: it.format, kwestie: it.cues ? it.cues.length : 0, adres: it.url ? shortUrl(it.url, 90) : '(w pamięci)' }; });
    const by = {};
    store.items.forEach(function (it) { it.layers.forEach(function (l) { by[l] = (by[l] || 0) + 1; }); });
    report('Skan', 'podsumowanie: ' + rows.length + ' znalezisk; warstwy: ' + (Object.keys(by).map(function (k) { return k + ' ' + by[k]; }).join(', ') || 'brak'));
    try { if (rows.length && W.console.table) W.console.table(rows); } catch (e) {}
    const cont = Array.from(containers.values()).map(function (c) { return { kontener: c.key, 'element z tekstem': c.leaf, 'Shadow DOM': c.shadow.length ? (c.closed ? 'zamknięty' : 'otwarty') : 'nie', zmian: c.changes, ostatnio: c.sample.replace(/\n/g, ' / ').slice(0, 60) }; });
    try { if (cont.length) { report('Skan', 'kontenery, z których idą napisy na ekranie: ' + cont.length); if (W.console.table) W.console.table(cont); } } catch (e) {}
    return rows;
  }

  /* ═══════════════ 15b. ŹRÓDŁA DLA INNYCH SKRYPTÓW I ROZSZERZEŃ ═══════════════ */

  function trackSources() {
    const out = [];
    for (let i = 0; i < trackList.length && out.length < 8; i++) {
      const inf = trackList[i], tr = inf.track; let mode = '', idx = -1;
      try { mode = tr.mode; } catch (e) {}
      try { const tt = inf.el && inf.el.isConnected ? inf.el.textTracks : null; if (tt) for (let k = 0; k < tt.length; k++) if (tt[k] === tr) idx = k; } catch (e) {}
      if (inf.el && idx === -1) continue;
      if (mode === 'disabled' && !inf.cues.length) continue;
      out.push({ type: 'texttrack', video: inf.el ? (inf.vsel || (inf.vsel = cssPath(inf.el))) : '', shadow: inf.el ? shadowChain(inf.el) : [], index: idx, label: String(tr.label || ''), language: String(tr.language || ''), kind: String(tr.kind || ''), mode: mode, cues: inf.cues.length, live: liveTrack === tr });
    }
    return out;
  }
  // Pełny opis źródeł jako zwykłe dane (JSON) — do wklejenia w innym skrypcie
  function sourcesExport() {
    const og = live.origin[live.src] || {};
    return {
      generator: 'Łowca Napisów ' + VERSION, page: String(W.location.href), host: HOST, frame: !IS_TOP, time: new Date().toISOString(),
      current: { text: live.text, source: live.src, selector: og.selector || '', track: og.track || '' },
      containers: Array.from(containers.values()).map(function (c) { return pubContainer(c); }),
      textTracks: trackSources(),
      streams: Object.keys(live.ch).filter(function (k) { return k === 'WebSocket' || k === 'SSE'; }),
      files: sortedItems().map(pub),
      events: { cue: 'ush:cue', found: 'ush:found', container: 'ush:container' }
    };
  }
  function frameNote() {
    return IS_TOP ? '' : '// Uwaga: odtwarzacz jest w osadzonej ramce (iframe): ' + W.location.origin + W.location.pathname + '\n// Kod musi działać w tej ramce — w Tampermonkey dodaj dla niej osobny @match.\n';
  }
  function snippetEvents(note) {
    return [
      '// ' + (note || 'Odbiór napisów z Łowcy Napisów (musi być włączony). Działa na każdej stronie, także dla zamkniętego Shadow DOM.'),
      '// W skrypcie Tampermonkey z @grant wpisz unsafeWindow zamiast window. W rozszerzeniu (content script) zostaw window.',
      "window.addEventListener('ush:cue', function (e) {",
      '  const d = e.detail; // { text, source, time, selector, shadow, leaf, track, parts }; pusty text = napis zniknął',
      '  // source: "Mutation" = element strony (selector), "TextTrack" = ścieżka wideo (track); parts = tekst osobno dla każdego kontenera',
      "  console.log('[napis]', d.text, '| źródło:', d.source, d.selector || d.track); // ← tu wstaw swój kod",
      '});', ''
    ].join('\n');
  }
  function snippetDom(c) {
    const head = '// Napisy z ekranu — ' + HOST + '\n// Kontener: ' + c.key + '\n// Wygenerował Łowca Napisów ' + VERSION + '.\n' + frameNote();
    if (c.closed) return head + snippetEvents('Ten kontener siedzi w ZAMKNIĘTYM Shadow DOM — inny skrypt nie ma do niego dostępu, więc kod odbiera napisy od Łowcy Napisów (musi być włączony).');
    return head + [
      '// Działa samodzielnie, bez Łowcy.',
      '(function () {',
      "  'use strict';",
      '  const SHADOW_HOSTS = ' + JSON.stringify(c.shadow.map(function (x) { return x.host; })) + '; // kolejne elementy z shadowRoot (puste = zwykły DOM)',
      '  const CONTAINER = ' + JSON.stringify(c.selector) + ';',
      '  const LEAF = ' + JSON.stringify(c.leaf || '') + '; // element z samym tekstem (informacyjnie)',
      '',
      '  function onSubtitle(text) {',
      "    console.log('[napis]', text); // ← tu wstaw swój kod; pusty tekst = napis zniknął",
      '  }',
      '',
      '  function findContainer() {',
      '    let root = document;',
      '    for (const sel of SHADOW_HOSTS) { const host = root.querySelector(sel); if (!host || !host.shadowRoot) return null; root = host.shadowRoot; }',
      '    return root.querySelector(CONTAINER);',
      '  }',
      "  let last = '', watched = null, queued = false;",
      '  function read() {',
      '    queued = false;',
      '    const el = findContainer();',
      "    const text = el ? String(el.innerText || el.textContent || '').split('\\n').map(function (s) { return s.trim(); }).filter(Boolean).join('\\n') : '';",
      '    if (text === last) return;',
      '    last = text;',
      '    onSubtitle(text);',
      '  }',
      '  const mo = new MutationObserver(function () { if (!queued) { queued = true; setTimeout(read, 50); } });',
      '  function attach() {',
      '    const el = findContainer(); const root = el ? el.getRootNode() : null;',
      '    if (root && root !== watched) { mo.disconnect(); mo.observe(root, { childList: true, subtree: true, characterData: true }); watched = root; }',
      '    read();',
      '  }',
      '  setInterval(attach, 500);',
      '  attach();',
      '})();', ''
    ].join('\n');
  }
  function snippetTrack(t) {
    return frameNote() + [
      '// Napisy ze ścieżki tekstowej odtwarzacza (TextTrack) — ' + HOST,
      '// Wygenerował Łowca Napisów ' + VERSION + '. Działa samodzielnie, bez Łowcy.',
      '(function () {',
      "  'use strict';",
      '  const SHADOW_HOSTS = ' + JSON.stringify(t.shadow.map(function (x) { return x.host; })) + '; // kolejne elementy z shadowRoot (puste = zwykły DOM)',
      '  const VIDEO = ' + JSON.stringify(t.video || 'video') + ';',
      '  const LANGUAGE = ' + JSON.stringify(t.language) + ', LABEL = ' + JSON.stringify(t.label) + '; // puste = każda ścieżka',
      '',
      '  function onSubtitle(text, track) {',
      "    console.log('[napis]', text); // ← tu wstaw swój kod; pusty tekst = napis zniknął",
      '  }',
      '',
      '  const hooked = new WeakSet();',
      '  function findVideo() {',
      '    let root = document;',
      '    for (const sel of SHADOW_HOSTS) { const host = root.querySelector(sel); if (!host || !host.shadowRoot) return null; root = host.shadowRoot; }',
      '    return root.querySelector(VIDEO);',
      '  }',
      '  function hook() {',
      '    const v = findVideo(); if (!v || !v.textTracks) return;',
      '    for (const tr of v.textTracks) {',
      "      if (hooked.has(tr) || tr.kind === 'metadata' || tr.kind === 'chapters') continue;",
      '      if ((LANGUAGE && tr.language !== LANGUAGE) || (LABEL && tr.label !== LABEL)) continue;',
      '      hooked.add(tr);',
      '      const fire = function () {',
      "        if (tr.mode === 'disabled') return;",
      "        const text = Array.from(tr.activeCues || []).map(function (c) { return String(c.text || '').replace(/<[^>]+>/g, ''); }).join('\\n').trim();",
      '        onSubtitle(text, tr);',
      '      };',
      "      tr.addEventListener('cuechange', fire);",
      '      if (tr.activeCues && tr.activeCues.length) fire(); // napis, który już jest na ekranie',
      '    }',
      '  }',
      '  setInterval(hook, 1000);',
      '  hook();',
      '})();', ''
    ].join('\n');
  }
  function findContainerEl(c) {
    if (c.el && c.el.isConnected) return c.el;
    try {
      let root = doc;
      for (let i = 0; i < c.shadow.length; i++) { const host = root.querySelector(c.shadow[i].host); if (!host) return null; const sr = host.shadowRoot || closedRoots.get(host); if (!sr) return null; root = sr; }
      return root.querySelector(c.selector);
    } catch (e) { return null; }
  }
  function showContainer(c) {
    const el = findContainerEl(c);
    if (!el) return toast('Tego kontenera nie ma teraz na stronie — odtwarzacz tworzy go razem z napisem.', true);
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return toast('Kontener jest teraz pusty i niewidoczny. Kliknij ponownie, gdy na ekranie będzie napis.', true);
    const st = ui.hl.style; st.left = (r.left - 4) + 'px'; st.top = (r.top - 4) + 'px'; st.width = (r.width + 8) + 'px'; st.height = (r.height + 8) + 'px';
    ui.hl.classList.add('show'); clearTimeout(ui.hlTimer); ui.hlTimer = setTimeout(function () { ui.hl.classList.remove('show'); }, 2600);
  }
  function liveSourceLabel() {
    const og = live.origin[live.src] || {};
    if (live.src === 'Mutation') return 'Źródło: kontener ' + (og.key || og.selector || '');
    if (live.src === 'TextTrack') return 'Źródło: ścieżka tekstowa odtwarzacza' + (og.track ? ' „' + og.track + '”' : '');
    if (live.src === 'OCR') return 'Źródło: OCR (rozpoznawanie napisów wtopionych w obraz)';
    if (live.src === 'Canvas') return 'Źródło: tekst rysowany na <canvas>';
    if (live.src === 'ARIA') return 'Źródło: region ARIA nad wideo (słabsze źródło)';
    if (live.src === 'Speech') return 'Źródło: rozpoznawanie mowy zrobione przez stronę';
    return live.src ? 'Źródło: strumień ' + live.src : '';
  }
  function containerMeta(c) {
    if (!c.changes) return 'wykryty, jeszcze bez napisu';
    return (c.leaf ? 'tekst w: ' + c.leaf + ', ' : '') + 'zmian: ' + c.changes + (c.sample ? ', ostatnio: „' + c.sample.replace(/\n/g, ' / ').slice(0, 56) + '”' : '');
  }

  /* ═══════════════ 16. INTERFEJS ═══════════════ */

  const CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.wrap{--bg:#10231c;--raise:#173428;--line:#28503f;--ink:#eef3ea;--mute:#9db3a6;--go:#1fa35a;--go2:#14804a;--sub:#ffd84a;--err:#ffb4a2;font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:var(--ink)}',
    '.fab{position:fixed;right:18px;bottom:18px;z-index:2147483647;width:54px;height:54px;border:0;border-radius:50%;cursor:pointer;background:linear-gradient(145deg,var(--go),var(--go2));color:#fff;font:700 16px/1 system-ui,"Segoe UI",sans-serif;letter-spacing:.04em;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 18px rgba(0,0,0,.4);transition:transform .12s ease,opacity .2s,filter .2s;user-select:none;-webkit-user-select:none;touch-action:none;padding:0}',
    '.fab:hover{transform:scale(1.06)}',
    '.fab:focus-visible,.b:focus-visible,.x:focus-visible{outline:2px solid var(--sub);outline-offset:2px}',
    '.fab.idle{filter:grayscale(1);opacity:.45}.fab.idle:hover{opacity:.95}',
    '.fab.pulse{animation:p 1.1s ease-out 2}',
    '@keyframes p{0%{box-shadow:0 6px 18px rgba(0,0,0,.4),0 0 0 0 rgba(31,163,90,.75)}100%{box-shadow:0 6px 18px rgba(0,0,0,.4),0 0 0 20px rgba(31,163,90,0)}}',
    '@media (prefers-reduced-motion:reduce){.fab{transition:none}.fab.pulse{animation:none}}',
    '.badge{position:absolute;top:-3px;right:-3px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:var(--bg);color:var(--sub);font:700 11px/20px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 1.5px var(--go)}',
    '.panel{position:fixed;z-index:2147483647;width:520px;max-width:calc(100vw - 16px);height:min(90vh,900px);min-height:200px;display:none;flex-direction:column;background:var(--bg);border:1px solid var(--line);border-radius:12px;box-shadow:0 20px 56px rgba(0,0,0,.6);overflow:hidden}',
    '.panel.open{display:flex}',
    '.head{display:flex;align-items:center;gap:8px;padding:11px 12px 9px 14px}',
    '.head h2{margin:0;font-size:15px;font-weight:650;flex:1;letter-spacing:.01em}',
    '.x{background:none;border:0;color:var(--mute);cursor:pointer;font-size:16px;line-height:1;padding:5px 7px;border-radius:6px}.x:hover{color:var(--ink);background:var(--raise)}',
    /* pasek „jak napis w filmie" — jedyny wyrazisty element panelu */
    '.live{margin:0 12px;padding:12px 12px;min-height:58px;background:#050b08;border-radius:8px;display:flex;align-items:center;justify-content:center;text-align:center;white-space:pre-line;font-size:16px;line-height:1.3;font-weight:650;color:var(--sub);text-shadow:0 1px 0 #000,0 0 6px rgba(0,0,0,.9);overflow:auto;max-height:min(30vh,240px)}',
    '.live.empty{color:var(--mute);font-size:12.5px;font-weight:400;text-shadow:none}',
    '.quick{display:flex;gap:8px;padding:10px 12px 4px}',
    '.b{appearance:none;border:1px solid var(--line);background:var(--raise);color:var(--ink);border-radius:7px;padding:6px 9px;font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap}',
    '.b:hover{border-color:var(--go)}',
    '.b.go{flex:1;background:var(--go);border-color:var(--go);color:#fff;font-weight:650;padding:8px 10px}.b.go:hover{background:var(--go2)}',
    '.b.wide{flex:1;padding:8px 10px}',
    '.b.s{padding:3px 8px;font-size:12px}',
    '.sec{padding:10px 14px 4px;color:var(--mute);font-size:12px}',
    '.list{overflow:auto;padding:0 12px;flex:1;min-height:0;overscroll-behavior:contain}',
    '.it{padding:9px 2px;border-top:1px solid var(--line)}',
    '.it:first-child{border-top:0}',
    '.it.weak{opacity:.7}',
    '.r1{display:flex;align-items:baseline;gap:8px}',
    '.lang{font-weight:700;color:var(--sub);min-width:22px}',
    '.name{font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.meta{color:var(--mute);font-size:12px;white-space:nowrap}',
    '.r2{display:flex;align-items:center;gap:5px;margin:4px 0 6px;flex-wrap:wrap}',
    '.tag{font-size:10.5px;font-weight:650;color:#fff;border-radius:4px;padding:1px 5px;line-height:1.5}',
    '.url{color:var(--mute);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:90px}',
    '.acts{display:flex;gap:5px;flex-wrap:wrap}',
    '.empty-list{padding:14px 2px 10px;color:var(--mute);line-height:1.5}',
    '.rec{display:flex;align-items:center;gap:6px;padding:8px 12px;border-top:1px solid var(--line);color:var(--mute);font-size:12px}',
    '.rec span{flex:1}',
    '.foot{display:flex;gap:6px;flex-wrap:wrap;padding:9px 12px;border-top:1px solid var(--line)}',
    '.status{padding:0 14px 10px;min-height:16px;color:var(--mute);font-size:12px;line-height:1.4}',
    '.status.err{color:var(--err)}',
    '.head,.live,.livesrc,.quick,.rec,.foot,.status{flex:none}',
    '.livesrc{margin:5px 14px 0;min-height:15px;color:var(--mute);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sec.in{padding:10px 2px 2px}',
    '.sec.in.row{display:flex;align-items:center;gap:8px}.sec.in.row span{flex:1}',
    '.code{display:block;margin:5px 0 4px;padding:5px 8px;background:#050b08;border-radius:6px;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;color:var(--sub);word-break:break-all;cursor:copy}',
    '.smeta{color:var(--mute);font-size:12px;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.acts.tail{padding:2px 2px 10px;border-bottom:1px solid var(--line)}',
    '.hl{position:fixed;z-index:2147483646;display:none;pointer-events:none;border:2px solid var(--sub);border-radius:6px;box-shadow:0 0 0 3px rgba(0,0,0,.55),0 0 22px rgba(255,216,74,.65)}.hl.show{display:block}',
    '.toast{position:fixed;z-index:2147483647;right:18px;bottom:82px;max-width:340px;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:8px 11px;font-size:12.5px;line-height:1.4;box-shadow:0 10px 30px rgba(0,0,0,.5);display:none}',
    '.toast.show{display:block}.toast.err{color:var(--err)}'
  ].join('\n');

  const ui = { built: false, host: null, root: null, wrap: null, fab: null, badge: null, panel: null, open: false, els: {}, lastCount: 0, toastTimer: 0, swallow: false };

  function h(tag, attrs) {
    const el = doc.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k]; if (v == null) continue;
      if (k === 'text') el.textContent = v; else if (k === 'class') el.className = v; else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v); else el.setAttribute(k, v);
    }
    for (let i = 2; i < arguments.length; i++) { const c = arguments[i]; if (c == null) continue; el.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c); }
    return el;
  }
  function btn(label, title, fn, cls) { return h('button', { class: 'b ' + (cls || 's'), type: 'button', title: title || null, onclick: function (e) { e.stopPropagation(); guard(fn); } }, label); }

  function buildUI() {
    if (ui.built || !doc.documentElement) return;
    ui.built = true;
    const host = doc.createElement('div');
    host.setAttribute('data-ush-host', '');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    let root = host;
    try { if (O.attachShadow) root = O.attachShadow.call(host, { mode: 'closed' }); } catch (e) { root = host; }
    try { if (W.MLi18n) W.MLi18n.watch(root); } catch (e) {}   // [AGENT-EXP] 2026-10-21: panel po angielsku, gdy tak wybrano (w Piperze MLi18n nie ma)
    try { const sheet = new W.CSSStyleSheet(); sheet.replaceSync(CSS); root.adoptedStyleSheets = [sheet]; }
    catch (e) { const st = doc.createElement('style'); st.textContent = CSS; root.appendChild(st); }
    ui.host = host; ui.root = root; uiHost = host; dlRoot = root;
    // kliknięcia w nasz interfejs nie powinny sterować odtwarzaczem (np. pauza w trybie pełnoekranowym)
    ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'keyup', 'wheel'].forEach(function (n) { host.addEventListener(n, function (e) { e.stopPropagation(); }, { passive: true }); });

    const wrap = h('div', { class: 'wrap' }); ui.wrap = wrap;
    ui.badge = h('span', { class: 'badge', text: '0' });
    ui.fab = h('button', { class: 'fab idle', type: 'button', title: 'Napisy na tej stronie (Alt+N). Przeciągnij, żeby przesunąć.', 'aria-label': 'Napisy na tej stronie' }, 'CC', ui.badge);
    const pos = gm.get('ush_pos', null);
    if (pos && typeof pos.r === 'number' && typeof pos.b === 'number') { ui.fab.style.right = clamp(pos.r, 4, Math.max(4, W.innerWidth - 58)) + 'px'; ui.fab.style.bottom = clamp(pos.b, 4, Math.max(4, W.innerHeight - 58)) + 'px'; }

    let drag = null;
    ui.fab.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      const r = ui.fab.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, moved: false, r0: W.innerWidth - r.right, b0: W.innerHeight - r.bottom };
      try { ui.fab.setPointerCapture(e.pointerId); } catch (x) {}
    });
    ui.fab.addEventListener('pointermove', function (e) {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
      drag.moved = true;
      ui.fab.style.right = clamp(drag.r0 - dx, 4, Math.max(4, W.innerWidth - 58)) + 'px';
      ui.fab.style.bottom = clamp(drag.b0 - dy, 4, Math.max(4, W.innerHeight - 58)) + 'px';
      if (ui.open) placePanel();
    });
    const endDrag = function () {
      const d = drag; drag = null;
      if (d && d.moved) { gm.set('ush_pos', { r: parseFloat(ui.fab.style.right) || 18, b: parseFloat(ui.fab.style.bottom) || 18 }); ui.swallow = true; setTimeout(function () { ui.swallow = false; }, 80); }
    };
    ui.fab.addEventListener('pointerup', endDrag);
    ui.fab.addEventListener('pointercancel', endDrag);
    ui.fab.addEventListener('click', function () { if (ui.swallow) return; togglePanel(); });

    const E = ui.els;
    E.title = h('h2', { text: 'Napisy na tej stronie' });
    E.live = h('div', { class: 'live empty', 'aria-live': 'off' });
    E.liveSrc = h('div', { class: 'livesrc' });
    E.list = h('div', { class: 'list' });
    E.sec = h('div', { class: 'sec' });
    E.recText = h('span');
    E.rec = h('div', { class: 'rec' }, E.recText,
      btn('Kopiuj zapis', 'Skopiuj wszystko, co do tej pory pokazało się na ekranie', function () { const l = liveCues(); if (!l.cues.length) return toast('Zapis z ekranu jest jeszcze pusty.', true); copyText(toTXT(l.cues)).then(function (ok) { toast(ok ? 'Skopiowano zapis z ekranu (' + plKw(l.cues.length) + ').' : 'Przeglądarka zablokowała schowek.'); }); }),
      btn('Pobierz .srt', 'Zapisz to, co pokazało się na ekranie, jako plik .srt z czasami', function () { const l = liveCues(); if (!l.cues.length) return toast('Zapis z ekranu jest jeszcze pusty.', true); const name = fileName(null, 'ekran.srt'); saveFile(name, toSRT(l.cues), 'srt'); toast('Pobrano: ' + name); }));
    E.status = h('div', { class: 'status', role: 'status' });
    // [AGENT-EXP] 🔋 tryb oszczędny — wiersz widoczny, gdy Łowca przestał szukać
    E.ecoText = h('span');
    E.eco = h('div', { class: 'rec' }, E.ecoText,
      btn('Szukaj dalej', 'Obudź Łowcę na tej stronie (do następnego filmu nie zaśnie sam)', function () { ecoWake('ręcznie', true); toast('Szukam dalej — Łowca nie zaśnie sam do następnego filmu.'); }));
    E.eco.style.display = 'none';
    E.ecoBtn = btn(ECO ? 'Oszczędny: WŁ.' : 'Oszczędny: WYŁ.', 'Po znalezieniu napisów (min. ' + ECO_MIN_CUES + ' kwestii) albo gdy film gra ' + Math.round(ECO_NOFIND_MS / 1000) + ' s bez napisów, Łowca przestaje szukać — budzi go nowy film. Zapisywane w ustawieniach rozszerzenia.', toggleEco);
    ui.panel = h('div', { class: 'panel', role: 'dialog', 'aria-label': 'Napisy na tej stronie' },
      h('div', { class: 'head' }, E.title,
        h('button', { class: 'x', type: 'button', title: 'Zamknij (Alt+N)', 'aria-label': 'Zamknij', onclick: function () { togglePanel(false); } }, '✕')),
      E.live, E.liveSrc,
      h('div', { class: 'quick' },
        btn('Pobierz najlepsze .srt', 'Pobierz najlepiej dopasowane napisy jako .srt (Alt+P)', downloadBest, 'go'),
        btn('Kopiuj napis z ekranu', 'Skopiuj napis widoczny teraz w filmie (Alt+K)', copyCurrent, 'wide')),
      E.sec, E.list, E.rec, E.eco,
      h('div', { class: 'foot' },
        btn('Skanuj ponownie', 'Przeszukaj jeszcze raz stronę, odtwarzacz i obiekty window', function () { scanAll(true, true); toast('Przeskanowano stronę ponownie.'); }),
        btn('Głęboki skan', 'Przejrzyj też localStorage, Cache Storage i IndexedDB', function () { toast('Przeglądam magazyny przeglądarki…'); deepScan().then(function (n) { toast('Głęboki skan zakończony. Nowych znalezisk: ' + n + '.'); }); }),
        btn('Wymuś ścieżki', 'Każ przeglądarce wczytać ścieżki <track>, które odtwarzacz trzyma wyłączone', function () { const n = forceLoadTracks(); toast(n ? 'Wymuszono wczytanie ścieżek: ' + n + '. Za chwilę pojawią się na liście.' : 'Nie ma wyłączonych ścieżek do wczytania.'); }),
        btn('OCR (eksperyment)', 'Włącz/wyłącz rozpoznawanie napisów wtopionych w obraz (Alt+O). Silnik i języki „w paczce” działają bez internetu.', ocrToggle),
        ocrLangSelect(),
        btn('Ramka OCR', 'Ustaw, którą część obrazu czyta OCR (przesuń / zmień rozmiar ramki nad filmem). Zapisuje się dla tej strony.', ocrFrameEdit),
        btn('Raport w konsoli', 'Wypisz w konsoli (F12), w której warstwie znaleziono napisy', function () { consoleReport(); toast('Raport wypisany w konsoli (F12).'); }),
        btn('Wyczyść', 'Opróżnij listę i zapis z ekranu', function () { resetStore(); toast('Wyczyszczono.'); }),
        btn('Sesja: start/stop', 'Włącz/wyłącz łowienie na żądanie (bez ciągłego nasłuchu)', function () { if (SESJA) { stopSession(); toast('Sesja zatrzymana — zero nasłuchu.'); } else { ecoWake('ręcznie', eco.parked); toast('Sesja uruchomiona — skanuję stronę.'); } }),
        E.ecoBtn),
      E.status);
    ui.toastEl = h('div', { class: 'toast', role: 'status' });
    ui.hl = h('div', { class: 'hl' });
    wrap.appendChild(ui.hl); wrap.appendChild(ui.panel); wrap.appendChild(ui.toastEl); wrap.appendChild(ui.fab);
    root.appendChild(wrap);
    mountHost();
    doc.addEventListener('fullscreenchange', function () { guard(mountHost); });
    W.addEventListener('resize', function () { if (ui.open) guard(placePanel); });
  }
  function mountHost() {
    if (!ui.host) return;
    let target = doc.documentElement;
    try { const fs = doc.fullscreenElement; if (CFG.followFullscreen && fs && fs.tagName !== 'VIDEO' && fs.tagName !== 'IFRAME') target = fs; } catch (e) {}
    if (ui.host.parentNode !== target) { try { target.appendChild(ui.host); } catch (e) {} }
  }
  function placePanel() {
    const r = ui.fab.getBoundingClientRect(), vw = W.innerWidth, vh = W.innerHeight, p = ui.panel.style;
    p.left = p.right = p.top = p.bottom = 'auto';
    if (r.left + r.width / 2 > vw / 2) p.right = Math.max(8, vw - r.right) + 'px'; else p.left = Math.max(8, r.left) + 'px';
    const above = Math.max(0, r.top - 18), below = Math.max(0, vh - r.bottom - 18);
    const openAbove = above >= below;
    const available = openAbove ? above : below;
    const height = Math.min(900, Math.max(200, vh * 0.9), Math.max(200, available));
    p.height = height + 'px';
    p.maxHeight = height + 'px';
    if (openAbove) p.bottom = Math.max(8, vh - r.top + 10) + 'px';
    else p.top = (r.bottom + 10) + 'px';
  }
  function togglePanel(force) {
    if (!ui.built) { buildUI(); if (!ui.built) return; }
    ui.open = typeof force === 'boolean' ? force : !ui.open;
    // Ręczne otwarcie (Alt+N / klik w CC) wybudza GUI z trybu cichego.
    try { if (ui.open && CFG.guiQuiet) UI_QUIET.reveal = true; } catch (e) {}
    refreshUI();
    if (ui.open) { ui.sig = null; clearTimeout(ui.toastTimer); ui.toastEl.className = 'toast'; ui.els.status.textContent = ''; placePanel(); renderPanel(); renderLive(); ecoUi(); }
    ui.panel.classList.toggle('open', ui.open);
  }
  function toast(msg, isErr) {
    if (isErr) report('Skan', msg);
    if (!ui.built) return;
    if (CFG.guiQuiet && !ui.open && !UI_QUIET.reveal) return; // tryb cichy: brak wyskakujących dymków
    if (ui.open) { ui.els.status.textContent = msg; ui.els.status.className = 'status' + (isErr ? ' err' : ''); return; }
    const t = ui.toastEl; t.textContent = msg; t.className = 'toast show' + (isErr ? ' err' : '');
    try { const r = ui.fab.getBoundingClientRect(); t.style.right = Math.max(8, W.innerWidth - r.right) + 'px'; t.style.bottom = Math.max(8, W.innerHeight - r.top + 10) + 'px'; } catch (e) {}
    clearTimeout(ui.toastTimer); ui.toastTimer = setTimeout(function () { t.className = 'toast'; }, isErr ? 6500 : 3200);
  }
  function framesTotal() { let n = 0; store.frames.forEach(function (v) { n += v.n; }); return n; }
  function uiWanted() {
    // Tryb cichy (Lektor YT): GUI schowane, dopóki użytkownik sam nie otworzy panelu (Alt+N).
    if (CFG.guiQuiet && !ui.open && !UI_QUIET.reveal) return false;
    if (CFG.button === 'never' && !CFG.guiQuiet) return ui.open;
    if (!IS_TOP && (W.innerWidth < 260 || W.innerHeight < 150)) return false;
    if (CFG.button === 'always' && IS_TOP) return true;
    return ui.open || store.items.size > 0 || media.size > 0 || liveCount() > 0 || framesTotal() > 0;
  }
  function refreshUI() {
    if (!doc.documentElement) return;
    const want = uiWanted();
    if (!ui.built) { if (!want) return; buildUI(); if (!ui.built) return; }
    ui.host.style.display = want ? 'block' : 'none';
    const n = store.items.size;
    ui.badge.textContent = String(n); ui.badge.style.display = n ? '' : 'none';
    ui.fab.classList.toggle('idle', !(n > 0 || liveCount() > 0));
    if (n > ui.lastCount && !ui.open) { ui.fab.classList.remove('pulse'); void ui.fab.offsetWidth; ui.fab.classList.add('pulse'); }
    ui.lastCount = n;
    if (ui.open) renderPanel();
  }
  const uiDirty = throttle(refreshUI, 250);
  // [AGENT-EXP] 2026-11-06: 📌 „Zapamiętaj to źródło” — stan dla tej domeny przychodzi z mostka (chrome.storage),
  // przycisk jest tylko przy NAJLEPSZYM znalezisku (pierwszy wiersz listy).
  let pinState = { on: false, label: '' };
  function renderLive() {
    if (!ui.built || !ui.open) return;
    const E = ui.els; const t = live.text;
    if (t) { E.live.textContent = t; E.live.className = 'live'; }
    else { E.live.textContent = media.size ? 'Tu pojawi się napis, gdy odtwarzacz go wyświetli.' : 'Na tej stronie nie widzę jeszcze odtwarzacza.'; E.live.className = 'live empty'; }
    E.liveSrc.textContent = t ? liveSourceLabel() : ((ocr.on || ocr.loading) ? 'OCR: ' + ocr.status : '');
    containers.forEach(function (c) { if (c.ui && c.ui.meta) c.ui.meta.textContent = containerMeta(c); });
    const n = liveCount();
    E.rec.style.display = n ? '' : 'none';
    E.recText.textContent = 'Zapis z ekranu: ' + plKw(n);
  }
  const uiLive = throttle(function () { if (!ui.built || ui.fab.classList.contains('idle') || ui.host.style.display === 'none') refreshUI(); renderLive(); }, 120);
  function itemRow(it, isBest) {
    const cues = it.cues ? it.cues.length : 0;
    const name = it.label || (it.kind === 'hls' ? 'Ścieżka HLS' : it.kind === 'segments' ? 'Napisy składane z segmentów' : it.url ? decodeURIComponentSafe((it.url.split(/[?#]/)[0].split('/').pop() || 'napisy')).slice(0, 48) : 'Napisy z pamięci strony');
    const meta = [];
    if (it.format) meta.push(it.format.toUpperCase());
    if (cues) meta.push(plKw(cues)); else if (it.kind === 'hls') meta.push(it.segments ? it.segments + ' segm. w buforze' : 'do złożenia'); else if (!it.verified) meta.push(it.strong ? 'do pobrania' : 'niepotwierdzone');
    if (it.auto) meta.push('automatyczne');
    const r2 = h('div', { class: 'r2' });
    it.layers.forEach(function (l) { const t = h('span', { class: 'tag', text: l, title: 'Warstwa, w której znaleziono te napisy' }); t.style.background = LAYER_COLOR[l] || '#334155'; r2.appendChild(t); });
    r2.appendChild(h('span', { class: 'url', text: it.url ? shortUrl(it.url, 64) : 'treść w pamięci', title: it.url || it.note || '' }));
    const acts = h('div', { class: 'acts' },
      btn('.srt', 'Pobierz jako SubRip (.srt)', function () { downloadItem(it, 'srt'); }),
      btn('.vtt', 'Pobierz jako WebVTT (.vtt)', function () { downloadItem(it, 'vtt'); }),
      btn('.txt', 'Pobierz sam tekst, bez numerów i czasów', function () { downloadItem(it, 'txt'); }),
      btn('Oryginał', 'Pobierz plik dokładnie w takiej postaci, w jakiej przyszedł z serwera', function () { downloadItem(it, 'raw'); }),
      btn('Kopiuj tekst', 'Skopiuj cały tekst napisów do schowka', function () { copyItem(it); }),
      isBest ? btn(pinState.on ? '📌 Zapamiętane' : '📌 Zapamiętaj to źródło',
        pinState.on
          ? 'Ta strona jest zapamiętana: na każdym filmie napisy brane są z tego źródła automatycznie (lektor czyta, cenzor wycisza). Kliknij, aby wyłączyć.'
          : 'Zapamiętaj to źródło dla tej strony — następne filmy będą brały z niego napisy automatycznie (lektor czyta, cenzor wycisza).',
        function () {
          const next = !pinState.on;
          pinState = { on: next, label: pinState.label || '' };
          try { W.dispatchEvent(new CustomEvent('ush:pin', { detail: { on: next, url: it.url || '', label: it.label || '' } })); } catch (e) {}
          uiDirty();
          toast(next ? '📌 Zapamiętane — ta strona bierze napisy z tego źródła automatycznie.' : 'Wyłączone — ta strona nie jest już zapamiętana.', false);
        }) : null,
      it.url && !/^(blob|data):/.test(it.url) ? btn('Kopiuj adres', it.url, function () { copyText(it.url).then(function (ok) { toast(ok ? 'Skopiowano adres pliku.' : 'Przeglądarka zablokowała schowek.'); }); }) : null);
    return h('div', { class: 'it' + (it.strong ? '' : ' weak') },
      h('div', { class: 'r1' }, h('span', { class: 'lang', text: (it.lang || '··').slice(0, 5) }), h('span', { class: 'name', text: name, title: name }), h('span', { class: 'meta', text: meta.join(', ') })),
      r2, acts);
  }
  function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
  function copyAndSay(text, okMsg) { copyText(text).then(function (ok) { toast(ok ? okMsg : 'Przeglądarka zablokowała schowek.', !ok); }); }
  // Sekcja panelu: z jakich elementów strony / ścieżek odtwarzacza idą napisy widoczne na ekranie
  function sourcesBlock() {
    const box = h('div', { class: 'srcs' });
    const cs = Array.from(containers.values()), ts = trackSources();
    box.appendChild(h('div', { class: 'sec in row' }, h('span', { text: 'Skąd idą napisy na ekranie' }),
      btn('Kopiuj wszystkie źródła', 'Skopiuj jako JSON: kontenery, ścieżki tekstowe i pliki — do wklejenia w innym skrypcie', function () { copyAndSay(JSON.stringify(sourcesExport(), null, 2), 'Skopiowano opis wszystkich źródeł (JSON).'); })));
    if (!cs.length && !ts.length) {
      box.appendChild(h('div', { class: 'empty-list', text: 'Jeszcze nie widziałem napisu na ekranie. Włącz napisy i puść film — pokażę tu element strony, w którym się wyświetlają.' }));
      return box;
    }
    cs.forEach(function (c) {
      const meta = h('div', { class: 'smeta', text: containerMeta(c) });
      c.ui = { meta: meta };
      box.appendChild(h('div', { class: 'it' },
        h('div', { class: 'r1' },
          h('span', { class: 'name', text: c.shadow.length ? 'Kontener w Shadow DOM' + (c.closed ? ' (zamknięty)' : ' (otwarty)') : 'Kontener na stronie' }),
          h('span', { class: 'meta', text: c.matches > 1 ? 'pasuje do ' + c.matches + ' elementów' : (IS_TOP ? '' : 'w ramce') })),
        h('code', { class: 'code', text: c.key, title: 'Kliknij, żeby skopiować selektor', onclick: function () { copyAndSay(c.selector, 'Skopiowano selektor: ' + c.selector); } }),
        meta,
        h('div', { class: 'acts' },
          btn('Kopiuj selektor', 'Skopiuj selektor CSS kontenera' + (c.shadow.length ? ' (bez drogi przez Shadow DOM — ta jest w „Kopiuj kod")' : ''), function () { copyAndSay(c.selector, 'Skopiowano selektor: ' + c.selector); }),
          btn('Kopiuj kod', 'Skopiuj gotowy fragment JavaScript, który czyta napisy z tego kontenera — do wklejenia w innym skrypcie', function () { copyAndSay(snippetDom(c), 'Skopiowano kod czytający napisy z tego kontenera.'); }),
          btn('Pokaż na stronie', 'Zaznacz ten element na stronie żółtą ramką', function () { showContainer(c); }))));
    });
    ts.forEach(function (t) {
      const name = t.label || t.language;
      box.appendChild(h('div', { class: 'it' },
        h('div', { class: 'r1' }, h('span', { class: 'name', text: 'Ścieżka tekstowa wideo' }), h('span', { class: 'meta', text: (t.live ? 'aktywna, ' : '') + t.mode + ', ' + plKw(t.cues) })),
        h('code', { class: 'code', text: (t.shadow.length ? t.shadow.map(function (x) { return x.host; }).join(' >>> ') + ' >>> ' : '') + (t.video || 'video') + (t.index >= 0 ? ' → textTracks[' + t.index + ']' : ' → addTextTrack()') + (name ? '  „' + name + '”' + (t.label && t.language ? ' [' + t.language + ']' : '') : ''), title: 'Kliknij, żeby skopiować selektor elementu wideo', onclick: function () { copyAndSay(t.video || 'video', 'Skopiowano selektor wideo: ' + (t.video || 'video')); } }),
        h('div', { class: 'acts' },
          btn('Kopiuj kod', 'Skopiuj gotowy fragment JavaScript, który czyta napisy z tej ścieżki (zdarzenie cuechange)', function () { copyAndSay(snippetTrack(t), 'Skopiowano kod czytający napisy ze ścieżki tekstowej.'); }))));
    });
    box.appendChild(h('div', { class: 'acts tail' },
      btn('Kopiuj kod odbioru zdarzeń', 'Kod, który odbiera każdy napis wykryty przez Łowcę (zdarzenie ush:cue) — niezależnie od strony i kontenera', function () { copyAndSay(snippetEvents(), 'Skopiowano kod odbioru zdarzeń ush:cue.'); })));
    return box;
  }
  function renderPanel() {
    if (!ui.built || !ui.open) return;
    const E = ui.els; const items = sortedItems(); const fr = framesTotal();
    const sig = items.slice(0, 40).map(function (it) { return it.id + ':' + (it.cues ? it.cues.length : 0) + ':' + it.layers.size + ':' + it.format + ':' + it.lang + ':' + it.segments + ':' + (it.verified ? 1 : 0); }).join('|') + '#' + fr + '#' + Array.from(containers.keys()).join('|') + '#' + trackSources().map(function (t) { return t.index + t.mode + t.label + t.live; }).join('|') + '#' + (pinState.on ? 1 : 0);   // [AGENT-EXP] 2026-11-06: stan 📌 odświeża panel
    if (sig === ui.sig) return;
    if (ui.sig != null && Date.now() - ui.sigAt < 2000) { // kursor nad listą: nie podmieniaj przycisków w trakcie klikania
      let hov = false; try { hov = ui.panel.matches(':hover'); } catch (e) {}
      if (hov) { clearTimeout(ui.reTimer); ui.reTimer = setTimeout(function () { guard(renderPanel); }, 800); return; }
    }
    ui.sig = sig; ui.sigAt = Date.now();
    E.sec.style.display = 'none';
    const frag = doc.createDocumentFragment();
    frag.appendChild(sourcesBlock());
    frag.appendChild(h('div', { class: 'sec in', text: 'Pliki i ścieżki napisów' + (items.length ? ': ' + items.length + (items.length > 40 ? ' (pokazuję 40 najlepszych)' : '') : '') }));
    if (!items.length) {
      frag.appendChild(h('div', { class: 'empty-list' },
        fr ? 'Odtwarzacz jest w osadzonej ramce — tam znalazłem napisy (' + fr + '). Zielony przycisk znajdziesz w rogu samego odtwarzacza.'
           : 'Jeszcze nic nie znalazłem. Włącz napisy w odtwarzaczu i puść film na kilka sekund — wtedy odtwarzacz je pobierze, a ja je przechwycę.'));
    } else {
      for (let i = 0; i < items.length && i < 40; i++) frag.appendChild(itemRow(items[i], i === 0));
      if (fr) frag.appendChild(h('div', { class: 'empty-list', text: 'Dodatkowo ' + fr + ' w osadzonej ramce — przycisk jest w rogu odtwarzacza.' }));
    }
    const st = E.list.scrollTop;
    while (E.list.firstChild) E.list.removeChild(E.list.firstChild);
    E.list.appendChild(frag);
    E.list.scrollTop = st;
  }
  let notifyTimer = 0;
  function notifyTop() { // ramka zgłasza stronie nadrzędnej tylko LICZBĘ znalezisk (żadnych adresów ani treści)
    if (IS_TOP || notifyTimer) return;
    notifyTimer = setTimeout(function () { notifyTimer = 0; try { W.top.postMessage({ __ush: 'count', n: store.items.size }, '*'); } catch (e) {} }, 600);
  }

  /* ═══════════════ 17. START I HARMONOGRAM ═══════════════ */

  // Priorytety: DOM i ścieżki odtwarzacza od razu; obiekty okna w bezczynności; magazyny w tle (w granicach budżetu CPU).
  // fresh = skan zlecony przez użytkownika/API: wszystko od razu i bez pamięci przejrzanych obiektów.
  function scanAll(force, fresh) {
    if (fresh) objMemo = new WeakMap();
    guard(scanDOM);
    trackList.forEach(function (i) { guard(function () { readTrackCues(i.track, i); }); });
    if (fresh) { guard(function () { scanWindow(true); }); guard(scanWebStorage); guard(scanMisc); guard(scanPerformance); }
    else { task(function () { scanWindow(force); }, 'normal'); task(scanPerformance, 'normal'); task(scanWebStorage, 'low'); task(scanMisc, 'low'); }
    uiDirty();
  }
  function scheduleScan(ms) {
    if (!SESJA) return;
    if (scanTimer) return;
    scanTimer = setTimeout(function () { scanTimer = 0; idle(function () { scanAll(false); }, 1200); }, ms || 600);
  }
  function resetStore() {
    store.items.clear(); store.byHash.clear(); store.hlsSeg.clear(); store.hlsSubKeys.clear();
    live.ch = {}; live.text = ''; live.src = ''; live.origin = {}; capRoots.length = 0; capCache = new WeakMap();
    attrsSeen = new WeakSet(); scriptsSeen = new WeakSet(); jsonSeen.clear(); reportedOnce.clear(); lastWinScan = 0;
    ccState.groups.clear(); mp4Tracks.clear(); mkvDirs.clear();
    trackList.forEach(function (i) { i.seen.clear(); i.cues.length = 0; i.read = 0; i.item = null; });
    ui.lastCount = 0;
    uiDirty(); uiLive(); notifyTop();
  }
  function pageKey() {
    try {
      const u = new URL(W.location.href); const keep = [];
      ['v', 'id', 'video', 'vid', 'video_id', 'episode', 'ep', 'watch', 'movie', 'film', 'p'].forEach(function (k) { const x = u.searchParams.get(k); if (x) keep.push(k + '=' + x); });
      return u.pathname + '?' + keep.join('&');
    } catch (e) { return ''; }
  }
  let lastKey = pageKey();
  function tick() {
    if (!SESJA) { if (eco.parked) ecoParkedTick(); return; }   // [AGENT-EXP] 🔋 śpi — sprawdzamy tylko adres (i czy pojawił się film)
    const k = pageKey();
    if (k !== lastKey) {
      lastKey = k;
      ecoClockReset();
      if (CFG.resetOnNavigate) { resetStore(); report('Nawigacja', 'nowy film / nowa podstrona — bufor wyczyszczony, skanuję od nowa'); emit('reset', { page: String(W.location.href) }); }
      [400, 1800, 4500].forEach(function (ms) { setTimeout(function () { if (SESJA) scanAll(true); }, ms); });
    }
    media.forEach(function (el) { if (!el.isConnected) media.delete(el); });
    for (let i = 0; i < trackList.length; i++) { const inf = trackList[i]; if (inf.item) { try { inf.item.active = inf.track.mode === 'showing'; } catch (e) {} } }
    guard(ecoClock);
  }

  /* ── [AGENT-EXP] 🔋 Tryb oszczędny: mam napisy (albo ich nie ma) → przestaję szukać ── */
  // Kandydat = zweryfikowany plik / ścieżka z pełnymi kwestiami (nie składane po kawałku segmenty,
  // nie napisy wymuszone „forced” — te mają zwykle kilka kwestii).
  function ecoCandidate() {
    let best = null;
    store.items.forEach(function (it) {
      if (!it.verified || !it.cues || it.cues.length < ECO_MIN_CUES || it.kind === 'segments' || it.forced) return;
      if (!best || it.cues.length > best.cues.length) best = it;
    });
    return best;
  }
  function ecoCanPark() {
    if (!ECO || !SESJA || eco.parked) return false;
    if (ocr.on || ocr.loading) return false;          // włączony OCR Łowcy czyta obraz — nie usypiamy
    return eco.noParkKey !== lastKey;                  // „Szukaj dalej” na tym filmie
  }
  function ecoCheck() {
    if (eco.timer || !ecoCanPark() || !ecoCandidate()) return;
    eco.timer = setTimeout(function () { eco.timer = 0; guard(ecoPark); }, ECO_SETTLE_MS);
  }
  function ecoPark() {
    if (!ecoCanPark()) return;
    const it = ecoCandidate();
    if (!it) return;
    eco.cues = it.cues.length; eco.empty = false; eco.why = '';
    eco.label = (it.lang ? '[' + it.lang + '] ' : '') + (it.label || it.format || '');
    emit('parked', { cues: eco.cues, lang: it.lang || '', label: it.label || '' });
    stopSession();
    eco.parked = true; eco.done = true;   // [AGENT-EXP] raz na stronę — do odświeżenia już się nie budzi
    report('Skan', '🔋 tryb oszczędny: mam napisy (' + plKw(eco.cues) + (eco.label ? ', ' + eco.label : '') + ') — przestaję szukać; znowu po odświeżeniu strony');
    toast('🔋 Mam napisy (' + plKw(eco.cues) + ') — przestaję szukać.');
    ecoUi();
  }
  // brak napisów — wyciszenie. video = true: film grał i nic nie przyszło; false: strona bez filmu.
  function ecoParkEmpty(why, video) {
    if (!ecoCanPark() || Date.now() < eco.huntUntil || eco.timer || ecoCandidate()) return;   // po „Szukaj napisów” kilka sekund (ECO_HUNT_MS)
    eco.cues = 0; eco.label = ''; eco.empty = true; eco.why = why; eco.video = !!video;
    emit('parked', { cues: 0, empty: true, video: !!video, why: why });
    stopSession();
    eco.parked = true;
    if (video) eco.done = true;   // [AGENT-EXP] raz na stronę: film był, napisów brak → koniec do odświeżenia
    report('Skan', '🔋 tryb oszczędny: ' + why + ' — przestaję szukać; ' + (video ? 'znowu po odświeżeniu strony' : 'film na tej stronie włączy Łowcę (raz)'));
    if (video) toast('🔋 Brak napisów (' + why + ') — przestaję szukać.');
    ecoUi();
  }
  // Czy gra właściwy film (nie reklama, nie krótki klip) — tylko wtedy biegnie zegar „brak napisów”.
  function ecoMainPlaying(v) {
    try {
      if (!v || v.tagName !== 'VIDEO' || v.paused || v.ended || v.readyState < 3) return false;
      if (v.closest && v.closest('.ad-showing,.ad-interrupting')) return false;   // reklama YouTube
      const d = v.duration;
      // [AGENT-EXP] raz na stronę: liczy też krótki film z dźwiękiem; pomija tylko wyciszone zapętlone podglądy
      return d === Infinity || (d >= ECO_MAIN_MIN_SEC) || (!v.muted && !v.loop);   // transmisja, długi film albo zwykły film
    } catch (e) { return false; }
  }
  function ecoClockReset() { eco.playMs = 0; eco.idleMs = 0; eco.lastAt = 0; }
  // co takt (1,2 s): ile czasu gra film bez napisów / ile czasu na stronie nie ma filmu
  function ecoClock() {
    const t = Date.now(), dt = eco.lastAt ? Math.min(3000, Math.max(0, t - eco.lastAt)) : 0;
    eco.lastAt = t;
    if (!ecoCanPark() || t < eco.huntUntil || eco.timer || ecoCandidate()) return;
    const vids = doc.getElementsByTagName('video');
    if (!vids.length && !media.size) {
      eco.idleMs += dt;
      if (eco.idleMs >= ECO_NOVIDEO_MS) ecoParkEmpty('na stronie nie ma filmu', false);
      return;
    }
    eco.idleMs = 0;
    let playing = false;
    for (let i = 0; i < vids.length && !playing; i++) playing = ecoMainPlaying(vids[i]);
    if (!playing) media.forEach(function (el) { if (!playing) playing = ecoMainPlaying(el); });
    if (!playing) return;
    eco.playMs += dt;
    if (eco.playMs >= ECO_NOFIND_MS) ecoParkEmpty('film gra ' + Math.round(eco.playMs / 1000) + ' s, a napisów brak', true);
  }
  // nowy film / nowa podstrona albo „Szukaj dalej”. manual = do następnego filmu nie usypiamy sami.
  function ecoWake(reason, manual) {
    if (eco.timer) { clearTimeout(eco.timer); eco.timer = 0; }
    const was = eco.parked;
    eco.parked = false; eco.empty = false;
    eco.noParkKey = manual ? lastKey : null;
    ecoClockReset();
    if (was) report('Skan', '🔋 tryb oszczędny: budzę Łowcę (' + reason + ')');
    if (!SESJA) startSession();
    ecoUi();
  }
  function ecoParkedTick() {
    const k = pageKey();
    if (k !== lastKey) {
      lastKey = k;
      // [AGENT-EXP] 2026-10-17: nowy film / podstrona = jak nowa strona — stare napisy precz (lektor nie czyta
      // poprzedniego filmu) i jedno szukanie od nowa (~2 s), potem znowu koniec
      eco.done = false;
      if (CFG.resetOnNavigate) { resetStore(); emit('reset', { page: String(W.location.href) }); }
      ecoWake('nowy film / nowa podstrona');
      [400, 1800, 4500].forEach(function (ms) { setTimeout(function () { if (SESJA) scanAll(true); }, ms); });
      return;
    }
    if (eco.done) return;   // [AGENT-EXP] raz na stronę — ten film już przeszukany; budzi tylko nowy film / odświeżenie / ręcznie
    // uśpiony „bez filmu” — film pojawił się na stronie bez zmiany adresu
    if (eco.empty && !eco.video && doc.getElementsByTagName('video').length) ecoWake('na stronie pojawił się film');
  }
  function ecoUi() {
    if (!ui.built) return;
    const E = ui.els;
    if (E.ecoBtn) E.ecoBtn.textContent = ECO ? 'Oszczędny: WŁ.' : 'Oszczędny: WYŁ.';
    if (!E.eco) return;
    E.eco.style.display = eco.parked ? '' : 'none';
    E.ecoText.textContent = eco.empty
      ? '🔋 Nie szukam dalej — ' + eco.why + '. ' + (eco.done ? 'Odśwież stronę, żeby szukać znowu.' : 'Film na stronie włączy Łowcę.')
      : '🔋 Mam napisy (' + plKw(eco.cues) + (eco.label ? ', ' + eco.label : '') + ') — nie szukam dalej. Odśwież stronę, żeby szukać znowu.';   // [AGENT-EXP] raz na stronę
  }

  /* ═══ 18. OCR — napisy wtopione w obraz (EKSPERYMENT; domyślnie wyłączony) ═══
   * Co robi: co ~0,5 s robi zrzut dolnej części <video>, wyciąga jasny tekst, a gdy obraz napisu się zmienił,
   * rozpoznaje go biblioteką Tesseract.js (ładowaną dopiero po włączeniu, z CDN lub z CFG.ocrBase) i podaje wynik
   * jako napisy „na żywo\" (warstwa OCR → panel, zapis z ekranu .srt, zdarzenie ush:cue).
   * Ograniczenia: wideo chronione (DRM, bez CORS) nie pozwala odczytać pikseli; bardzo restrykcyjne CSP może
   * zablokować uruchomienie biblioteki; rozpoznawanie jest przybliżone (zależy od kroju, kontrastu i tła).
   */
  const ocr = { on: false, loading: false, worker: null, lib: null, timer: 0, cv: null, cv2: null, busy: false, sig: null, last: '', status: 'wyłączony', frames: 0, reads: 0, fail: 0 };
  const OCR_LANGS = dict({ pl: 'pol', en: 'eng', de: 'deu', fr: 'fra', es: 'spa', it: 'ita', pt: 'por', ru: 'rus', uk: 'ukr', cs: 'ces', sk: 'slk', hu: 'hun', ro: 'ron', nl: 'nld', sv: 'swe', tr: 'tur', ja: 'jpn', ko: 'kor', zh: 'chi_sim', ar: 'ara', el: 'ell', bg: 'bul', hr: 'hrv', da: 'dan', fi: 'fin', no: 'nor' });
  // [OCR-OFFLINE] Ustawienia OCR zapamiętane dla tej strony (localStorage strony): język i ramka zrzutu.
  const OCR_SAVE_KEY = 'lektor_ocr_v1';
  function ocrSaved() { try { return JSON.parse(W.localStorage.getItem(OCR_SAVE_KEY) || 'null') || {}; } catch (e) { return {}; } }
  function ocrSave(patch) { try { const o = ocrSaved(); Object.keys(patch).forEach(function (k) { o[k] = patch[k]; }); W.localStorage.setItem(OCR_SAVE_KEY, JSON.stringify(o)); } catch (e) {} }
  (function () {
    const sv = ocrSaved();
    if (typeof sv.lang === 'string') CFG.ocrLang = sv.lang;
    if (Array.isArray(sv.region) && sv.region.length === 4 && sv.region.every(function (x) { return typeof x === 'number' && x >= 0 && x <= 1; })) CFG.ocrRegion = sv.region;
  })();
  // Lista języków do wyboru w panelu. „w paczce” = działa bez internetu (folder ocr/ w rozszerzeniu);
  // pozostałe pobierają się z internetu przy pierwszym użyciu (potem są w pamięci strony).
  const OCR_PRESETS = [
    ['', 'Automatycznie (języki przeglądarki + angielski)'],
    ['pol', 'Polski — w paczce'],
    ['eng', 'Angielski — w paczce'],
    ['pol+eng', 'Polski + angielski — w paczce'],
    ['chi_sim', 'Chiński uproszczony — w paczce'],
    ['chi_tra', 'Chiński tradycyjny — w paczce'],
    ['chi_sim+eng', 'Chiński uproszczony + angielski — w paczce'],
    ['deu', 'Niemiecki (z internetu)'], ['fra', 'Francuski (z internetu)'], ['spa', 'Hiszpański (z internetu)'],
    ['ita', 'Włoski (z internetu)'], ['rus', 'Rosyjski (z internetu)'], ['ukr', 'Ukraiński (z internetu)'],
    ['jpn', 'Japoński (z internetu)'], ['kor', 'Koreański (z internetu)']
  ];
  function ocrLangs() {
    let l = String(CFG.ocrLang || '').split(/[+,\s]+/).filter(Boolean);
    if (!l.length) { l = prefLangs().map(function (x) { return OCR_LANGS[x]; }).filter(Boolean); if (l.indexOf('eng') === -1) l.push('eng'); }
    return l.slice(0, 3);
  }
  // [OCR-OFFLINE] Adres folderu ocr/ w rozszerzeniu podaje mostek (świat izolowany zna chrome.runtime.getURL).
  function ocrAskBase() {
    if (CFG.ocrBase) return Promise.resolve(String(CFG.ocrBase));
    if (ocr.base !== undefined) return Promise.resolve(ocr.base);
    return new Promise(function (res) {
      let done = false;
      const fin = function (v) { if (done) return; done = true; W.removeEventListener('message', on); ocr.base = v || ''; res(ocr.base); };
      const on = function (ev) { try { const d = ev.data; if (d && typeof d.__lowca_ocrbase === 'string') fin(d.__lowca_ocrbase); } catch (e) {} };
      W.addEventListener('message', on);
      try { W.postMessage({ __lowca_ocrbase_req: 1 }, '*'); } catch (e) {}
      setTimeout(function () { fin(''); }, 800);
    });
  }
  // Pobierz plik silnika/języka: najpierw z paczki (offline), a gdy go tam nie ma — z CDN.
  async function ocrFetch(what, lang) {
    if (ocr.base) { try { return await fetchBytes(ocrUrl(what, lang, ocr.base)); } catch (e) { dbg('ocr offline brak ' + what + ' ' + (lang || ''), e); } }
    // [AGENT-EXP] 2026-10-21 (Multilektor, Chrome Web Store): kod silnika OCR WYŁĄCZNIE z paczki rozszerzenia —
    // z internetu idą tylko dane języków (.traineddata). Sklep odrzuca rozszerzenia uruchamiające kod z serwera.
    if (what !== 'lang') throw new Error('brak plików silnika OCR w rozszerzeniu (folder ocr/)');
    return fetchBytes(ocrUrl(what, lang, ''));
  }
  function ocrUrl(what, lang, base) {
    const b = String(base !== undefined ? base : (CFG.ocrBase || '')).replace(/\/$/, '');
    if (what === 'lang') return b ? b + '/' + lang + '.traineddata.gz' : 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/' + lang + '/4.0.0_best_int/' + lang + '.traineddata.gz';
    let simd = false; try { simd = W.WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch (e) {}
    const core = simd ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js';
    if (!b) return '';   // [AGENT-EXP] 2026-10-21: kod silnika tylko z folderu ocr/ rozszerzenia (bez CDN)
    if (what === 'core') return b + '/' + core;
    if (what === 'worker') return b + '/worker.min.js';
    return b + '/tesseract.min.js';
  }
  function ocrBlobUrl(text) { const mk = O.createObjectURL || W.URL.createObjectURL; const u = mk.call(W.URL, new W.Blob([text], { type: 'text/javascript' })); ownWorkerUrls.add(u); return u; }
  // Pamięć podręczna danych języka w IndexedDB strony (ten sam magazyn i klucz, z których czyta worker Tesseract: cachePath „ush\")
  function ocrIdb() {
    return new Promise(function (res, rej) {
      const rq = W.indexedDB.open('keyval-store');
      rq.onupgradeneeded = function () { try { if (!rq.result.objectStoreNames.contains('keyval')) rq.result.createObjectStore('keyval'); } catch (e) {} };
      rq.onsuccess = function () { res(rq.result); }; rq.onerror = function () { rej(rq.error); };
    });
  }
  async function ocrEnsureLang(lang) {
    const db = await ocrIdb(); const key = 'ush/' + lang + '.traineddata';
    const has = await new Promise(function (res) { try { const g = db.transaction('keyval', 'readonly').objectStore('keyval').get(key); g.onsuccess = function () { res(!!g.result); }; g.onerror = function () { res(false); }; } catch (e) { res(false); } });
    if (has) { db.close(); return true; }
    ocr.status = 'pobieram dane języka ' + lang + '…'; uiLive();
    const r = await ocrFetch('lang', lang);
    await new Promise(function (res, rej) { try { const tx = db.transaction('keyval', 'readwrite'); tx.objectStore('keyval').put(r.bytes, key); tx.oncomplete = res; tx.onerror = function () { rej(tx.error); }; } catch (e) { rej(e); } });
    db.close(); return true;
  }
  async function ocrLoad() {
    if (ocr.worker) return ocr.worker;
    ocr.status = 'ładuję bibliotekę OCR…'; uiLive();
    await ocrAskBase();
    if (!ocr.lib) {
      // [AGENT-EXP] 2026-10-21: biblioteka OCR jako <script src> z pliku rozszerzenia (ocr/tesseract.min.js, web_accessible)
      // zamiast pobierania tekstu i uruchamiania go jako kod z napisu. Strona z AMD (window.define.amd) przejęłaby
      // bibliotekę jako moduł — na czas wczytania chowamy define, żeby powstało window.Tesseract.
      if (!ocr.base) throw new Error('brak plików silnika OCR w rozszerzeniu (folder ocr/)');
      if (!W.Tesseract || !W.Tesseract.createWorker) {
        const amd = W.define && W.define.amd ? W.define : null;
        if (amd) { try { W.define = undefined; } catch (e) {} }
        try {
          await new Promise(function (res, rej) { const s = doc.createElement('script'); s.onload = res; s.onerror = function () { rej(new Error('nie udało się wczytać biblioteki OCR')); }; s.src = ocrUrl('lib', '', ocr.base); (doc.head || doc.documentElement).appendChild(s); });
        } finally { if (amd) { try { W.define = amd; } catch (e) {} } }
      }
      const T = W.Tesseract;
      if (!T || !T.createWorker) throw new Error('nie udało się uruchomić biblioteki OCR');
      ocr.lib = T;
    }
    const langs = ocrLangs();
    for (let i = 0; i < langs.length; i++) await ocrEnsureLang(langs[i]);
    ocr.status = 'uruchamiam silnik OCR…'; uiLive();
    const workerSrc = decodeWith((await ocrFetch('worker')).bytes, 'utf-8');
    const coreSrc = decodeWith((await ocrFetch('core')).bytes, 'utf-8');
    const opts = { workerPath: ocrBlobUrl(workerSrc), corePath: ocrBlobUrl(coreSrc) + '#core.js', workerBlobURL: false, cachePath: 'ush', logger: function () {}, errorHandler: function (e) { dbg('ocr worker', e); } };
    if (CFG.ocrBase) opts.langPath = String(CFG.ocrBase).replace(/\/$/, '');
    const w = await ocr.lib.createWorker(langs.join('+'), 1, opts);
    try { await w.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' }); } catch (e) {}
    ocr.worker = w; return w;
  }
  function ocrOtsu(hist, total) {
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let wB = 0, sB = 0, best = 0, thr = 128;
    for (let i = 0; i < 256; i++) { wB += hist[i]; if (!wB) continue; const wF = total - wB; if (!wF) break; sB += i * hist[i]; const mB = sB / wB, mF = (sum - sB) / wF; const v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; thr = i; } }
    return thr;
  }
  // Zrzut dolnej części wideo → maska jasnych pikseli (czarny tekst na białym tle) + „odcisk\" do wykrywania zmian napisu
  function ocrCapture(v) {
    const reg = CFG.ocrRegion || [0, 0.62, 1, 0.38];
    const sx = Math.round(v.videoWidth * reg[0]), sy = Math.round(v.videoHeight * reg[1]), sw = Math.max(16, Math.round(v.videoWidth * reg[2])), sh = Math.max(16, Math.round(v.videoHeight * reg[3]));
    const k = Math.min(2, 1100 / sw), dw = Math.max(32, Math.round(sw * k)), dh = Math.max(16, Math.round(sh * k));
    if (!ocr.cv) { ocr.cv = doc.createElement('canvas'); ocr.cv2 = doc.createElement('canvas'); }
    const cv = ocr.cv, c2 = ocr.cv2; cv.width = c2.width = dw; cv.height = c2.height = dh;
    const x = cv.getContext('2d', { willReadFrequently: true }); x.drawImage(v, sx, sy, sw, sh, 0, 0, dw, dh);
    const img = x.getImageData(0, 0, dw, dh), d = img.data, n = dw * dh; const lum = new Uint8Array(n), hist = new Uint32Array(256);
    for (let i = 0, p = 0; i < n; i++, p += 4) { const l = (d[p] * 77 + d[p + 1] * 151 + d[p + 2] * 28) >> 8; lum[i] = l; hist[l]++; }
    const thr = Math.max(150, Math.min(235, CFG.ocrThreshold > 0 ? CFG.ocrThreshold : ocrOtsu(hist, n)));
    const out = x.createImageData(dw, dh), o = out.data; let on = 0; const gw = 48, gh = 12, grid = new Float32Array(gw * gh);
    for (let y = 0; y < dh; y++) for (let xx = 0; xx < dw; xx++) {
      const i = y * dw + xx, t = lum[i] >= thr; const q = i * 4, val = t ? 0 : 255; o[q] = o[q + 1] = o[q + 2] = val; o[q + 3] = 255;
      if (t) { on++; grid[((y * gh / dh) | 0) * gw + ((xx * gw / dw) | 0)] += 1; }
    }
    c2.getContext('2d').putImageData(out, 0, 0);
    return { canvas: c2, ratio: on / n, grid: grid };
  }
  function ocrChanged(a, b) { if (!a) return true; let s = 0, m = 0; for (let i = 0; i < a.length; i++) { s += Math.abs(a[i] - b[i]); m += Math.max(a[i], b[i]); } return m > 0 && s / m > 0.12; }
  function ocrClean(res) {
    const d = (res && res.data) || {}; let lines = d.lines || [];
    if (!lines.length && Array.isArray(d.blocks)) d.blocks.forEach(function (b) { (b.paragraphs || []).forEach(function (p) { (p.lines || []).forEach(function (l) { lines.push(l); }); }); }); // Tesseract.js ≥ 6: wiersze tylko w blocks
    if (!lines.length && d.text) lines = String(d.text).split('\n').map(function (t) { return { text: t, confidence: d.confidence }; });
    const keep = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]; let t = String(l.text || '').replace(/[|\\{}~_`^<>]+/g, ' ').replace(/\s+/g, ' ').trim();
      // [OCR-OFFLINE] chiński/japoński/koreański: Tesseract wstawia spacje między znakami — sklejamy je
      t = t.replace(/([\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff])\s+(?=[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff])/g, '$1');
      // litery łacińskie/cyrylica liczą się po 1, znaki CJK po 2 (jeden znak = całe słowo/sylaba)
      const nLat = t.replace(/[^A-Za-zÀ-ž\u0400-\u04FF]/g, '').length;
      const nCjk = t.replace(/[^\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/g, '').length;
      if (l.confidence < (CFG.ocrMinConf || 55) || nLat + 2 * nCjk < 3) continue;
      keep.push(t);
    }
    return keep.join('\n');
  }
  function ocrSimilar(a, b) { if (!a || !b) return false; a = a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); b = b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); if (a === b) return true; const n = Math.max(a.length, b.length); if (n < 4 || Math.abs(a.length - b.length) > n * 0.3) return false; let same = 0; const m = Math.min(a.length, b.length); for (let i = 0; i < m; i++) if (a[i] === b[i]) same++; return same / n > 0.82; }
  // [OCR-OFFLINE] ocrSimilar porównuje litery dowolnego pisma (wcześniej \W wycinał znaki chińskie)
  async function ocrTick() {
    if (!ocr.on || ocr.busy || !ocr.worker) return;
    const v = mainMedia(); if (!v || v.tagName !== 'VIDEO' || v.readyState < 2 || !v.videoWidth || v.paused || v.ended) return;
    ocr.busy = true;
    try {
      let cap; try { cap = ocrCapture(v); } catch (e) { ocr.status = 'wideo chronione przed odczytem pikseli (DRM/CORS) — OCR niemożliwy'; ocrStop(); toast(ocr.status, true); return; }
      ocr.frames++;
      if (cap.ratio < 0.0015 || cap.ratio > 0.35) { if (ocr.last) { ocr.last = ''; liveUpdate('OCR', ''); } ocr.sig = null; return; }
      if (!ocrChanged(ocr.sig, cap.grid)) return; ocr.sig = cap.grid;
      const res = await ocr.worker.recognize(cap.canvas, {}, { text: true, blocks: true }); ocr.reads++;
      const txt = ocrClean(res); if (!txt) return;
      if (ocrSimilar(txt, ocr.last)) return;
      ocr.last = txt; reportOnce('live:OCR', 'OCR', 'rozpoznaję napisy wtopione w obraz (OCR)'); liveUpdate('OCR', txt, undefined, { track: 'OCR' });
      // [OCR-LEKTOR] napis z OCR → lektor (mostek tłumaczy obcy tekst na polski i wysyła do syntezy)
      try { W.postMessage({ __lowca_ocr_say: { text: txt, lang: ocrLangs().join('+') } }, '*'); } catch (e) {}
    } catch (e) { ocr.fail++; dbg('ocr tick', e); if (ocr.fail > 8) { ocr.status = 'OCR zatrzymany po błędach: ' + errMsg(e); ocrStop(); toast(ocr.status, true); } }
    finally { ocr.busy = false; }
  }
  async function ocrStart() {
    if (ocr.on || ocr.loading) return;
    ocr.loading = true; toast('Włączam OCR (pierwsze uruchomienie pobiera silnik i dane języka, kilka MB)…');
    try { await ocrLoad(); } catch (e) { ocr.loading = false; ocr.status = 'błąd: ' + errMsg(e); toast('OCR: ' + errMsg(e), true); uiLive(); return; }
    ocr.loading = false; ocr.on = true; ocr.fail = 0; ocr.status = 'działa'; ocr.sig = null;
    clearInterval(ocr.timer); ocr.timer = setInterval(function () { guard(ocrTick); }, Math.max(250, CFG.ocrIntervalMs || 500));
    toast('OCR włączony: czytam dolną część wideo (' + ocrLangs().join('+') + ').'); uiLive(); uiDirty();
  }
  function ocrStop() { ocr.on = false; clearInterval(ocr.timer); ocr.timer = 0; if (ocr.last) { ocr.last = ''; liveUpdate('OCR', ''); } ocr.status = ocr.status && /błąd|chronione|zatrzymany/.test(ocr.status) ? ocr.status : 'wyłączony'; uiLive(); uiDirty(); }
  function ocrToggle() { if (ocr.on || ocr.loading) { ocrStop(); toast('OCR wyłączony.'); } else ocrStart(); }
  async function ocrTerminate() { ocrStop(); try { if (ocr.worker) await ocr.worker.terminate(); } catch (e) {} ocr.worker = null; }

  // [OCR-OFFLINE] Zmiana języka: zapis dla strony; gdy OCR działa — silnik startuje od nowa z nowym językiem.
  async function ocrSetLang(v) {
    CFG.ocrLang = String(v || ''); ocrSave({ lang: CFG.ocrLang });
    const was = ocr.on || ocr.loading;
    if (ocr.worker || was) await ocrTerminate();
    toast('OCR — język: ' + (ocrLangs().join('+')) + (was ? ' (uruchamiam ponownie…)' : ''));
    if (was) ocrStart();
  }
  function ocrLangSelect() {
    const sel = h('select', { class: 'b s', title: 'Język napisów dla OCR. Jeden język = najszybciej; kilka = wolniej. „w paczce” działa bez internetu.', onchange: function (e) { e.stopPropagation(); guard(function () { ocrSetLang(sel.value); }); } });
    OCR_PRESETS.forEach(function (p) { const o = h('option', { value: p[0] }, p[1]); if (p[0] === String(CFG.ocrLang || '')) o.selected = true; sel.appendChild(o); });
    if (CFG.ocrLang && !OCR_PRESETS.some(function (p) { return p[0] === CFG.ocrLang; })) sel.appendChild(h('option', { value: CFG.ocrLang, selected: 'selected' }, CFG.ocrLang));
    return sel;
  }

  // [OCR-OFFLINE] Ramka zrzutu: prostokąt nad filmem do przesuwania i zmiany rozmiaru (zapis dla tej strony).
  // Liczona względem OBRAZU filmu (bez czarnych pasów), w ułamkach [x, y, szerokość, wysokość].
  function ocrVideoBox(v) {
    const r = v.getBoundingClientRect(), vw = v.videoWidth || r.width, vh = v.videoHeight || r.height;
    const s = Math.min(r.width / vw, r.height / vh); const w = vw * s, hh = vh * s;
    return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - hh) / 2, width: w, height: hh };
  }
  function ocrFrameEdit() {
    const v = mainMedia();
    if (!v || v.tagName !== 'VIDEO' || !v.videoWidth) { toast('Nie widzę filmu — włącz odtwarzanie i spróbuj jeszcze raz.', true); return; }
    const old = doc.getElementById('lektor-ocr-frame'); if (old) old.remove();
    const vb = ocrVideoBox(v);
    let reg = (CFG.ocrRegion || [0, 0.62, 1, 0.38]).slice();
    const css = function (el, o) { Object.keys(o).forEach(function (k) { el.style.setProperty(k, o[k], 'important'); }); };
    const ov = doc.createElement('div'); ov.id = 'lektor-ocr-frame';
    try { if (W.MLi18n) W.MLi18n.watch(ov); } catch (e) {}   // [AGENT-EXP] 2026-10-21: język interfejsu (PL / EN)
    css(ov, { position: 'fixed', left: vb.left + 'px', top: vb.top + 'px', width: vb.width + 'px', height: vb.height + 'px', 'z-index': '2147483647', background: 'rgba(0,0,0,.35)', 'box-sizing': 'border-box', outline: '1px dashed rgba(255,255,255,.5)' });
    const box = doc.createElement('div');
    css(box, { position: 'absolute', border: '2px solid #e879f9', background: 'rgba(232,121,249,.12)', cursor: 'move', 'box-sizing': 'border-box' });
    const lab = doc.createElement('div'); lab.textContent = 'Ramka OCR — przeciągnij, rogi zmieniają rozmiar';
    css(lab, { position: 'absolute', left: '0', top: '-22px', font: '12px sans-serif', color: '#fff', background: '#a21caf', padding: '2px 6px', 'border-radius': '4px', 'white-space': 'nowrap', 'pointer-events': 'none' });
    box.appendChild(lab);
    const place = function () { css(box, { left: (reg[0] * 100) + '%', top: (reg[1] * 100) + '%', width: (reg[2] * 100) + '%', height: (reg[3] * 100) + '%' }); };
    const corners = { nw: [0, 0], ne: [1, 0], sw: [0, 1], se: [1, 1] };
    Object.keys(corners).forEach(function (k) {
      const c = doc.createElement('div'); c.dataset.corner = k;
      css(c, { position: 'absolute', width: '14px', height: '14px', background: '#e879f9', border: '2px solid #fff', 'border-radius': '50%', left: 'calc(' + (corners[k][0] * 100) + '% - 8px)', top: 'calc(' + (corners[k][1] * 100) + '% - 8px)', cursor: (k === 'nw' || k === 'se') ? 'nwse-resize' : 'nesw-resize' });
      box.appendChild(c);
    });
    const bar = doc.createElement('div');
    css(bar, { position: 'absolute', right: '8px', top: '8px', display: 'flex', gap: '6px' });
    const mkb = function (t, fn, bg) { const b = doc.createElement('button'); b.type = 'button'; b.textContent = t; css(b, { font: 'bold 12px sans-serif', padding: '5px 10px', 'border-radius': '6px', border: '1px solid #fff', background: bg, color: '#fff', cursor: 'pointer' }); b.addEventListener('click', function (e) { e.stopPropagation(); fn(); }); return b; };
    const close = function () { ov.remove(); W.removeEventListener('keydown', onKey, true); };
    const onKey = function (e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    bar.appendChild(mkb('✓ Zapisz', function () { CFG.ocrRegion = reg.map(function (x) { return Math.round(x * 1000) / 1000; }); ocrSave({ region: CFG.ocrRegion }); ocr.sig = null; close(); toast('Ramka OCR zapisana dla tej strony.'); }, '#a21caf'));
    bar.appendChild(mkb('Domyślna', function () { reg = [0, 0.62, 1, 0.38]; place(); }, '#444'));
    bar.appendChild(mkb('✕ Anuluj', close, '#444'));
    ov.appendChild(box); ov.appendChild(bar); place();
    // przeciąganie / zmiana rozmiaru (ułamki względem obrazu filmu)
    let drag = null;
    box.addEventListener('pointerdown', function (e) {
      e.preventDefault(); e.stopPropagation();
      drag = { corner: e.target.dataset && e.target.dataset.corner, x: e.clientX, y: e.clientY, r: reg.slice() };
      try { box.setPointerCapture(e.pointerId); } catch (e2) {}
    });
    box.addEventListener('pointermove', function (e) {
      if (!drag) return;
      const dx = (e.clientX - drag.x) / vb.width, dy = (e.clientY - drag.y) / vb.height, r = drag.r, MIN = 0.04;
      let x = r[0], y = r[1], w = r[2], hh = r[3];
      if (!drag.corner) { x = Math.min(Math.max(0, r[0] + dx), 1 - w); y = Math.min(Math.max(0, r[1] + dy), 1 - hh); }
      else {
        if (drag.corner.indexOf('w') !== -1) { x = Math.min(Math.max(0, r[0] + dx), r[0] + r[2] - MIN); w = r[0] + r[2] - x; }
        if (drag.corner.indexOf('e') !== -1) { w = Math.min(Math.max(MIN, r[2] + dx), 1 - r[0]); }
        if (drag.corner.indexOf('n') !== -1) { y = Math.min(Math.max(0, r[1] + dy), r[1] + r[3] - MIN); hh = r[1] + r[3] - y; }
        if (drag.corner.indexOf('s') !== -1) { hh = Math.min(Math.max(MIN, r[3] + dy), 1 - r[1]); }
      }
      reg = [x, y, w, hh]; place();
    });
    const end = function () { drag = null; };
    box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
    ['click', 'mousedown', 'dblclick'].forEach(function (t) { ov.addEventListener(t, function (e) { e.stopPropagation(); }); });
    W.addEventListener('keydown', onKey, true);
    let target = doc.documentElement;
    try { const fs = doc.fullscreenElement; if (fs && fs.tagName !== 'VIDEO' && fs.tagName !== 'IFRAME') target = fs; } catch (e) {}
    target.appendChild(ov);
    toast('Ustaw ramkę na miejscu napisów i kliknij „Zapisz” (Esc = anuluj).');
  }

  /* ===== Sesja na żądanie: start/stop (komendy z mostka → window.postMessage) ===== */
  function startSession() {
    if (SESJA) return;             // już aktywna (injection = Start) — bez podwójnego skanu
    SESJA = true;
    if (eco.parked) { eco.parked = false; eco.empty = false; ecoUi(); }   // [AGENT-EXP] 🔋
    ecoClockReset();
    report('Skan', 'sesja uruchomiona — skanuję stronę na żądanie');
    scanAll(true, true);
    setTimeout(function () { if (SESJA) sweepAttributes(); }, 300);
    try { deepScan(); } catch (e) {}
    uiDirty();
    emit('session', { on: true });
  }
  function stopSession() {
    if (!SESJA) return;
    SESJA = false;
    if (eco.timer) { clearTimeout(eco.timer); eco.timer = 0; }   // [AGENT-EXP] 🔋
    try { if (ocr.on) ocrStop(); } catch (e) {}
    try { pending.clear(); } catch (e) {}
    try { if (mutTimer) { clearTimeout(mutTimer); mutTimer = 0; } } catch (e) {}
    try { if (scanTimer) { clearTimeout(scanTimer); scanTimer = 0; } } catch (e) {}
    try { sweepRunning = false; } catch (e) {}
    report('Skan', 'sesja zatrzymana — hooki zagrodzone flagą, zero nasłuchu');
    uiDirty();
    emit('session', { on: false });
  }
  // [AGENT-EXP] 🔋 Łowca śpi z gotowymi napisami → popup / lektor dostaje to, co złapano, bez nowego szukania.
  function ecoReplay() {
    containers.forEach(function (c) { if (c.el && c.el.isConnected) emit('container', pubContainer(c)); });
    store.items.forEach(function (it) { emit('found', pub(it)); });
    emit('parked', { cues: eco.cues, lang: '', label: eco.label });
    emit('session', { on: false });
  }
  // Komendy od mostka (świat izolowany → window.postMessage).
  // Start może nieść flagę gui (z checkboxa w Ustawieniach): gui:true = pokaż GUI od razu.
  // Pokaż/schowaj GUI (checkbox „Pokazuj GUI Łowcy”). SESJA startuje jako true (wstrzyknięcie = Start),
  // więc startSession() zwykle wraca od razu — dlatego GUI odświeżamy tu jawnie.
  // 'always' = przycisk CC widoczny od razu, nie dopiero po znalezisku.
  function applyGui(on) {
    if (on) { CFG.guiQuiet = false; CFG.button = 'always'; UI_QUIET.reveal = true; }
    else { CFG.guiQuiet = true; CFG.button = 'never'; UI_QUIET.reveal = false; if (ui.open) togglePanel(false); }
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', refreshUI, { once: true }); else refreshUI();
  }
  W.addEventListener('message', function (ev) {
    try {
      const d = ev.data;
      if (!d || d.__lowca !== 'cmd') return;
      if (d.cmd === 'start') {
        if (d.gui) { try { applyGui(true); } catch (e) {} }
        // [AGENT-EXP] 🔋 „Szukaj napisów”: przez minutę bez wyciszania z braku napisów; uśpiony z gotowymi
        // napisami oddaje je od razu (bez nowego szukania), uśpiony bez napisów — budzi się
        eco.huntUntil = Date.now() + ECO_HUNT_MS;
        if (eco.parked && ecoCandidate()) ecoReplay();
        else if (eco.parked) ecoWake('ręcznie (Szukaj napisów)');
        else startSession();
      }
      else if (d.cmd === 'stop') { eco.huntUntil = 0; if (eco.parked) { eco.parked = false; eco.empty = false; ecoUi(); } stopSession(); }   // ręczny stop: śpi do „Szukaj napisów”, nowy film go nie budzi
      else if (d.cmd === 'eco') ecoSet(d.eco !== false);   // [AGENT-EXP] 🔋 z ustawień (mostek)
      else if (d.cmd === 'state') emit('session', { on: SESJA });
      else if (d.cmd === 'gui') { try { applyGui(!!d.gui); } catch (e) {} }
      else if (d.cmd === 'best') sendBest(); // lowca_auto.js: kwestie najlepszych napisów → lektor
      else if (d.cmd === 'pin') { pinState = { on: !!d.on, label: String(d.label || '') }; uiDirty(); }   // [AGENT-EXP] 2026-11-06: 📌 stan z mostka
    } catch (e) {}
  });
  // Najlepsze znalezisko z kwestiami → window.postMessage({__lowca_best}) (structured clone przechodzi między światami).
  let bestBusy = false;
  async function sendBest() {
    if (bestBusy) return;
    bestBusy = true;
    try {
      const list = sortedItems();
      for (let i = 0; i < list.length && i < 4; i++) {
        const it = list[i];
        try { await ensureCues(it); } catch (e) { continue; }
        if (!it.cues || it.cues.length < 5) continue;
        W.postMessage({ __lowca_best: { id: it.id, lang: it.lang || '', label: it.label || '', url: it.url || '', page: String(W.location.href),
          cues: it.cues.map(function (c) { return [Math.round(c.start * 1000), Math.round(c.end * 1000), c.text]; }) } }, '*');
        return;
      }
    } catch (e) {} finally { bestBusy = false; }
  }

  // API dla innych skryptów (np. lektora TTS): window.__USH__
  const API = {
    version: VERSION, config: CFG, urls: urlBuffer,
    session: { start: startSession, stop: stopSession, get on() { return SESJA; } },
    gui: function (on) { guard(function () { applyGui(!!on); }); },
    panel: function (open) { guard(function () { togglePanel(typeof open === 'boolean' ? open : undefined); }); }, // [CC] otwórz/zamknij panel
    get containers() { return Array.from(containers.values()).map(function (c) { return pubContainer(c, true); }); }, // elementy strony, w których wyświetlają się napisy
    get textTracks() { return trackSources(); },
    sources: sourcesExport,
    snippets: { container: function (i) { const c = Array.from(containers.values())[i || 0]; return c ? snippetDom(c) : ''; }, track: function (i) { const t = trackSources()[i || 0]; return t ? snippetTrack(t) : ''; }, events: function () { return snippetEvents(); } },
    get items() { return sortedItems().map(pub); },
    best: function () { const b = bestItem(); return b ? pub(b) : null; },
    cues: async function (id) { const it = id ? Array.from(store.items.values()).filter(function (x) { return x.id === id; })[0] : bestItem(); if (!it) return []; await ensureCues(it); return (it.cues || []).map(function (c) { return { start: c.start, end: c.end, text: c.text }; }); },
    download: function (id, fmt) { const it = id ? Array.from(store.items.values()).filter(function (x) { return x.id === id; })[0] : bestItem(); return downloadItem(it, fmt || 'srt'); },
    live: { get text() { return currentText(); }, get cues() { return liveCues().cues; } },
    on: function (name, fn) { if (typeof fn === 'function') store.listeners.push({ name: name, fn: fn }); },
    scan: function () { scanAll(true, true); return API.items; },
    deepScan: deepScan, report: consoleReport, panel: togglePanel, querySelectorAllDeep: querySelectorAllDeep,
    ocr: { start: ocrStart, stop: ocrStop, toggle: ocrToggle, terminate: ocrTerminate, get status() { return ocr.status; }, get on() { return ocr.on; }, get stats() { return { klatki: ocr.frames, rozpoznania: ocr.reads, bledy: ocr.fail, ostatni: ocr.last }; } },
    get stats() { return { watek: pw.state, zadaniaWatku: pw.jobs, cacheParsowania: { trafienia: pcache.hits, chybienia: pcache.misses, wpisy: pcache.map.size }, cpu: { msOstatniaSekunda: +sched.used.toFixed(1), msRazem: +sched.total.toFixed(1), odlozone: sched.deferred, pominiete: sched.skipped, pamiecObiektow: sched.memoHits }, opoznienieMutacjiMs: mutDelay, ponownePodpiecia: sched.rehooks }; },
    util: { parse: parseAny, sniff: sniffFormat, toSRT: toSRT, toVTT: toVTT, toTXT: toTXT, parseM3U8: parseM3U8, parseMP4Text: parseMP4Text, normalize: normalizeCues,
            parseSCC: parseSCC, parseSTL: parseSTL, parseTTML: parseTTML, parseSAMIAll: parseSAMIAll, parseMatroska: parseMatroska, parseMP4Media: parseMP4Media, createCea608: createCea608, createCcSink: createCcSink, demuxTSVideo: demuxTSVideo, annexBScan: annexBScan, inspectPayload: inspectPayload }
  };
  try { Object.defineProperty(W, '__USH__', { value: API, configurable: false, writable: false, enumerable: false }); } catch (e) { try { W.__USH__ = API; } catch (x) {} }

  installHooks();          // document-start: zanim odtwarzacz wyśle pierwsze żądanie
  observeRoot(doc);
  try { new W.PerformanceObserver(function (l) { try { l.getEntries().forEach(perfEntry); } catch (e) {} }).observe({ type: 'resource', buffered: true }); } catch (e) {}

  if (IS_TOP) W.addEventListener('message', function (ev) {
    try { const d = ev.data; if (d && d.__ush === 'count' && typeof d.n === 'number' && ev.source) { store.frames.set(ev.source, { n: Math.max(0, d.n | 0) }); uiDirty(); } } catch (e) {}
  });
  if (CFG.hotkeys) W.addEventListener('keydown', function (e) {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return; // sam lewy Alt (AltGr ustawia też Ctrl)
    const act = e.code === 'KeyN' ? togglePanel : e.code === 'KeyP' ? downloadBest : e.code === 'KeyK' ? copyCurrent : e.code === 'KeyO' ? ocrToggle : null;
    if (!act) return;
    if (!IS_TOP && !store.items.size && !media.size) return;
    e.preventDefault(); e.stopPropagation();
    guard(function () { act(); });
  }, true);
  if (gm.menu && IS_TOP) { try { gm.menu('Panel napisów', function () { togglePanel(); }); } catch (e) {} }

  const onReady = function () {
    // [AGENT-EXP] 2026-10-17: 🔋 strona bez filmu — Łowca w ogóle nie rusza (bez skanów i bez czekania 2 s);
    // śpi „bez filmu”, a pierwszy film na stronie / nowa podstrona budzi go (ecoParkedTick) na ~2 s szukania.
    if (SESJA && ECO && !doc.getElementsByTagName('video').length && !media.size) {
      ecoParkEmpty('na stronie nie ma filmu', false);
      if (!SESJA) return;
    }
    if (SESJA) scanAll(true);
    [1200, 3500, 8000].forEach(function (ms) { setTimeout(function () { if (SESJA) scanAll(true); }, ms); });
    setTimeout(function () { if (SESJA) sweepAttributes(); }, 2500); setTimeout(function () { if (SESJA) sweepAttributes(); }, 9000);
    if (CFG.ocr) setTimeout(function () { if (SESJA) ocrStart(); }, 3000);
  };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', onReady, { once: true }); else onReady();
  W.addEventListener('load', function () {
    scheduleScan(300);
    if (CFG.autoDeepScan) setTimeout(function () { if (SESJA && media.size) deepScan(); }, 5000);
    setTimeout(function () { if (SESJA && store.items.size) consoleReport(); }, 9000);
  }, { once: true });
  // przejście do innego filmu bez przeładowania strony wykrywamy od razu (history API), a nie dopiero przy następnym takcie
  ['pushState', 'replaceState'].forEach(function (n) {
    try {
      const orig = W.history[n]; if (typeof orig !== 'function') return;
      const wrapped = function () { const r = orig.apply(this, arguments); setTimeout(function () { guard(tick); }, 0); return r; };
      setProp(W.history, n, disguise(wrapped, orig));
    } catch (e) {}
  });
  W.addEventListener('popstate', function () { setTimeout(function () { guard(tick); }, 0); });
  setInterval(function () { guard(tick); }, 1200);
})();
