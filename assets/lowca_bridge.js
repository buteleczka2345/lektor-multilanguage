/* Lowca bridge (ISOLATED world) — MOST MAIN<->chrome.runtime.
 * Wstrzykiwany PRZED hunterem (assets/lowca_napisow.js, world MAIN).
 * 1) Przekazuje komendy popup->background->hunter: LOWCA_CMD {cmd:start|stop|state}
 *    jako window.postMessage({__lowca:'cmd', cmd}).
 * 2) Slucha zdarzen huntera (CustomEvent ush:container / ush:found / ush:session)
 *    i wysyla zagregowane LOWCA_RESULTS do backgroundu.
 * 3) Proxy GM_xmlhttpRequest: window.postMessage {__lowca_xhr:{id,url,headers}}
 *    -> chrome.runtime LOWCA_XHR -> odpowiedz {__lowca_xhr_res} z powrotem do MAIN.
 * Brak zmian w DOM strony. Idempotentny (flaga __LOWCA_BRIDGE__).
 */
(function () {
  'use strict';
  if (window.__LOWCA_BRIDGE__) return;
  window.__LOWCA_BRIDGE__ = true;

  var host = '';
  try { host = location.hostname.replace(/^www\./, '').toLowerCase(); } catch (e) {}

  var containers = [];   // selektory CSS (tylko shadow-less, !closedShadow)
  var seenSel = {};      // dedup selektorow
  var items = [];        // znaleziska ush:found (max 25)
  var seenItem = {};     // dedup po id/url
  var lastSent = 0;

  function cleanStr(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) : s;
  }

  function pushResults(force) {
    var now = Date.now();
    if (!force && now - lastSent < 800) return; // throttle 0.8 s
    lastSent = now;
    try {
      chrome.runtime.sendMessage({
        action: 'LOWCA_RESULTS',
        host: host,
        selectors: containers.slice(),
        items: items.slice()
      });
    } catch (e) {}
  }

  // Kontener: zapis TYLKO gdy selector dziala przez document.querySelectorAll
  // (shadow-chain i closedShadow NIE nadaja sie do Kreatora napisow).
  window.addEventListener('ush:container', function (ev) {
    try {
      var d = ev && ev.detail;
      if (!d || typeof d.selector !== 'string') return;
      if ((d.shadow && d.shadow.length) || d.closedShadow) return;
      var sel = d.selector.trim();
      if (!sel || sel.length > 300 || seenSel[sel]) return;
      seenSel[sel] = 1;
      containers.push(sel);
      if (containers.length > 12) containers = containers.slice(-12);
      pushResults(false);
    } catch (e) {}
  });

  // Znalezisko pliku: krotki opis do podgladu w popupie (max 25).
  window.addEventListener('ush:found', function (ev) {
    try {
      var d = ev && ev.detail;
      if (!d) return;
      var key = d.id || d.url || (d.label + '|' + d.lang);
      if (!key || seenItem[key]) return;
      seenItem[key] = 1;
      items.push({
        label: cleanStr(d.label || d.format || 'napisy', 60),
        lang: cleanStr(d.lang || '', 12),
        url: cleanStr(d.url || '', 200)
      });
      if (items.length > 25) items = items.slice(-25);
      pushResults(false);
    } catch (e) {}
  });

  // [AGENT-EXP] 2026-11-06: 📌 „Zapamiętaj to źródło” (przycisk przy najlepszym znalezisku Łowcy) — zapis dla
  // domeny w chrome.storage.local (domainSubPin) + zapamiętanie strony (lowcaSites), żeby Łowca i lektor startowały
  // same na kolejnych filmach, a napisy były brane z tego źródła.
  function sendPinState() {
    try {
      chrome.storage.local.get('domainSubPin', function (r) {
        var m = (r && r.domainSubPin) || {};
        var e = m[host] || null;
        try { window.postMessage({ __lowca: 'cmd', cmd: 'pin', on: !!(e && e.on), label: (e && e.label) || '' }, '*'); } catch (e2) {}
      });
    } catch (e) {}
  }
  window.addEventListener('ush:pin', function (ev) {
    try {
      var d = (ev && ev.detail) || {};
      chrome.runtime.sendMessage({ action: 'LOWCA_PIN', host: host, on: !!d.on, label: cleanStr(d.label || '', 60), url: cleanStr(d.url || '', 300) }, function () {
        void chrome.runtime.lastError;
        sendPinState();
      });
    } catch (e) {}
  });
  [0, 900, 2600].forEach(function (ms) { setTimeout(sendPinState, ms); });   // hunter może jeszcze nie nasłuchiwać

  // Zmiana stanu sesji huntera -> background (licznik/popup).
  window.addEventListener('ush:session', function (ev) {
    try {
      var d = (ev && ev.detail) || {};
      chrome.runtime.sendMessage({ action: 'LOWCA_STATUS', on: !!d.on, host: host });
      if (d.on === false) pushResults(true);
      else if (d.on === true) pushResults(false);
    } catch (e) {}
  });

  // [CC] Checkbox „Pokazuj GUI Łowcy” zmieniony → od razu pokaż/schowaj przycisk CC Łowcy na tej stronie.
  try {
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== 'local' || !ch.lowcaGui) return;
      try { window.postMessage({ __lowca: 'cmd', cmd: 'gui', gui: !!ch.lowcaGui.newValue }, '*'); } catch (e) {}
    });
  } catch (e) {}

  // [AGENT-EXP] 2026-10-15 🔋 Tryb oszczędny Łowcy (lowcaEco, domyślnie WŁ.) — hunter pyta o niego przy starcie
  // ({__lowca_eco_req}), zmiana w ustawieniach idzie od razu, a przełącznik w panelu Łowcy zapisuje się tutaj.
  function sendEco() {
    try {
      chrome.storage.local.get('lowcaEco', function (r) {
        var on = !(r && r.lowcaEco === false);
        try { window.postMessage({ __lowca: 'cmd', cmd: 'eco', eco: on }, '*'); } catch (e) {}
      });
    } catch (e) {}
  }
  try {
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== 'local' || !ch.lowcaEco) return;
      try { window.postMessage({ __lowca: 'cmd', cmd: 'eco', eco: ch.lowcaEco.newValue !== false }, '*'); } catch (e) {}
    });
  } catch (e) {}
  window.addEventListener('message', function (ev) {
    try {
      var d = ev && ev.data;
      if (!d || ev.source !== window) return;
      if (d.__lowca_eco_req) sendEco();
      else if (typeof d.__lowca_eco_set === 'boolean') chrome.storage.local.set({ lowcaEco: d.__lowca_eco_set });
    } catch (e) {}
  });
  sendEco();

  // Komendy popup->background->(tabs.sendMessage)->bridge->MAIN.
  // Przy starcie doczytuje lowcaGui ze storage i przekazuje hunterowi (pokaz GUI: tak/nie).
  try {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || msg.action !== 'LOWCA_CMD') return;
      if (msg.cmd === 'start') {
        try {
          chrome.storage.local.get('lowcaGui', function (r) {
            var gui = !!(r && r.lowcaGui);
            try { window.postMessage({ __lowca: 'cmd', cmd: 'start', gui: gui }, '*'); } catch (e) {}
          });
        } catch (e) {
          try { window.postMessage({ __lowca: 'cmd', cmd: 'start' }, '*'); } catch (e2) {}
        }
      } else {
        try { window.postMessage({ __lowca: 'cmd', cmd: msg.cmd }, '*'); } catch (e) {}
      }
    });
  } catch (e) {}

  // [OCR-OFFLINE] OCR (świat MAIN) pyta o adres folderu ocr/ w rozszerzeniu — tylko mostek zna chrome.runtime.getURL.
  window.addEventListener('message', function (ev) {
    try {
      var d = ev && ev.data;
      if (!d || !d.__lowca_ocrbase_req || ev.source !== window) return;
      window.postMessage({ __lowca_ocrbase: chrome.runtime.getURL('ocr') }, '*');
    } catch (e) {}
  });

  // [OCR-LEKTOR] Napisy rozpoznane przez OCR czyta lektor.
  // * lektor wyłączony (przełącznik w popupie) albo karta w tle → nic nie czytamy,
  // * polski tekst idzie od razu, obcy — najpierw przez tłumacza sieciowego (EXT_TR_LIVE → polski),
  // * kolejność zachowana (łańcuch), powtórki pomijane, film ściszany na czas kwestii (duckLevel z popupu).
  var ocrLektorOn = true, ocrDuck = 20, ocrChain = Promise.resolve(), ocrLastSaid = '', ocrSeq = 0;
  var ocrDuckVid = null, ocrDuckSaved = null, ocrDuckTimer = 0;
  try {
    chrome.storage.local.get(['enabled', 'duckLevel'], function (r) {
      if (r && r.enabled === false) ocrLektorOn = false;
      if (r && r.duckLevel !== undefined) ocrDuck = Number(r.duckLevel) || 0;
    });
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== 'local') return;
      if (ch.enabled) ocrLektorOn = ch.enabled.newValue !== false;
      if (ch.duckLevel) ocrDuck = Number(ch.duckLevel.newValue) || 0;
    });
  } catch (e) {}
  function ocrLooksPolish(t) { return /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(t) || /\b(nie|jest|się|to|że|jak|co|ale|tak|czy|już|mam|jestem|tylko)\b/i.test(t); }
  function ocrBigVideo() {
    var vs = document.querySelectorAll('video'), best = null, ba = 0;
    for (var i = 0; i < vs.length; i++) { var r = vs[i].getBoundingClientRect(), a = r.width * r.height; if (a > ba) { ba = a; best = vs[i]; } }
    return best;
  }
  function ocrDuckFor(len) {
    var v = ocrBigVideo(); if (!v || v.paused) return;
    try {
      if (ocrDuckVid !== v) { ocrDuckVid = v; ocrDuckSaved = null; }
      if (ocrDuckSaved === null) ocrDuckSaved = v.volume;
      v.volume = Math.min(ocrDuckSaved, ocrDuck / 100);
      clearTimeout(ocrDuckTimer);
      ocrDuckTimer = setTimeout(function () {
        try { if (ocrDuckVid && ocrDuckSaved !== null) ocrDuckVid.volume = ocrDuckSaved; } catch (e) {}
        ocrDuckSaved = null;
      }, Math.min(6000, Math.max(1500, len * 65) + 400));
    } catch (e) {}
  }
  function ocrTranslate(text) {
    return new Promise(function (res) {
      try {
        chrome.runtime.sendMessage({ action: 'EXT_TR_LIVE', text: text }, function (r) {
          void chrome.runtime.lastError;
          res(r && r.ok && r.text ? String(r.text).trim() : '');
        });
      } catch (e) { res(''); }
    });
  }
  window.addEventListener('message', function (ev) {
    try {
      var d = ev && ev.data;
      if (!d || !d.__lowca_ocr_say || ev.source !== window) return;
      if (!ocrLektorOn || document.visibilityState !== 'visible') return;
      var text = String(d.__lowca_ocr_say.text || '').replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
      if (!text) return;
      var lang = String(d.__lowca_ocr_say.lang || '');
      var my = ++ocrSeq;
      var needTr = lang !== 'pol' && !ocrLooksPolish(text);
      var ready = needTr ? ocrTranslate(text) : Promise.resolve(text);
      ocrChain = ocrChain.then(function () { return ready; }).then(function (pl) {
        if (!pl || !ocrLektorOn) return;
        if (ocrSeq - my > 2) return; // OCR jest już 3 napisy dalej — stary pomijamy, żeby lektor nie zostawał w tyle
        if (pl === ocrLastSaid) return;
        ocrLastSaid = pl;
        ocrDuckFor(pl.length);
        try { chrome.runtime.sendMessage({ action: 'TTS_PLAY', id: 'ocr_' + Date.now() + '_' + my, text: pl.slice(0, 600), durationMs: 0 }, function () { void chrome.runtime.lastError; }); } catch (e) {}
      }).catch(function () {});
    } catch (e) {}
  });

  // Proxy GM_xmlhttpRequest: MAIN {__lowca_xhr} -> background LOWCA_XHR -> MAIN {__lowca_xhr_res}.
  window.addEventListener('message', function (ev) {
    try {
      var d = ev && ev.data;
      // [FIX 2026-11-02] tylko z tej samej ramki (Łowca w świecie MAIN) — jak pozostałe kanały mostka; obce ramki
      // (reklamy, odtwarzacze z innych domen) nie mogą już zlecać pobierania przez rozszerzenie.
      if (!d || !d.__lowca_xhr || ev.source !== window) return;
      var q = d.__lowca_xhr;
      chrome.runtime.sendMessage(
        { action: 'LOWCA_XHR', id: q.id, url: q.url, headers: q.headers || {} },
        function (res) {
          try {
            window.postMessage({ __lowca_xhr_res: res || { id: q.id, ok: false, error: 'brak odpowiedzi' } }, '*');
          } catch (e) {}
        }
      );
    } catch (e) {}
  });
})();
