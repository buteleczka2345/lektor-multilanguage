/* Lowca auto (ISOLATED world) — napisy znalezione przez Łowcę → lektor, bez klikania.
 * Wstrzykiwany przy „Szukaj napisów” oraz automatycznie (registerContentScripts) na domenach,
 * na których Łowca już raz znalazł napisy (lista lowcaSites w storage, strona opcji).
 * 1) Słucha ush:found → prosi huntera (MAIN) o kwestie najlepszych napisów ({__lowca:'cmd', cmd:'best'}).
 * 2) Odpowiedź {__lowca_best} → background LOWCA_AUTO_CUES (zapamiętuje domenę, dokłada lektora do karty).
 * 3) Background LOWCA_AUTO_APPLY → ramka z <video> podaje kwestie do dom_content.js (__LIVEDUB_AUTO_APPLY__),
 *    nie-polskie tłumaczy paczkami (EXT_TR_LIST), postęp trzyma w pamięci 90 dni (PAMIEC_VIDEO_*).
 * Idempotentny (flaga __LOWCA_AUTO__).
 */
(function () {
  'use strict';
  if (window.__LOWCA_AUTO__) return;
  window.__LOWCA_AUTO__ = true;

  // [AGENT-EXP] 2026-10-15 (z userscriptu Piper 4.2.17): CAŁE ZDANIA ZAMIAST KAWAŁKÓW.
  // Kwestia napisów to często pół zdania („I told you that if you” / „came back, I'd leave.”). Tłumacz dostawał
  // każdą kwestię osobno i oddawał urywki bez sensu (test w Chrome: „I don't think we should” + „go there tonight.”
  // → „Myślę, że nie powinniśmy | Idź tam dziś wieczorem.”, całe zdanie → „Nie sądzę, że powinniśmy tam iść dziś
  // wieczorem.”). Przed tłumaczeniem sklejamy kolejne kwestie w zdanie; grupę zamyka koniec zdania (. ! ? …),
  // przerwa w mowie, myślnik nowej osoby, dźwięk [..] albo limit długości / czasu. Czas zdania: start pierwszej
  // kwestii, koniec ostatniej. Opcja „Tłumacz całe zdania” (extTrJoinSentences, domyślnie WŁ.).
  var ZD_MAX_CHARS = 220, ZD_MAX_MS = 12000, ZD_GAP_MS = 1500;
  var zdOn = true;
  try {
      chrome.storage.local.get('extTrJoinSentences', function (r) { if (r && r.extTrJoinSentences === false) zdOn = false; });
      chrome.storage.onChanged.addListener(function (ch, area) { if (area === 'local' && ch.extTrJoinSentences) zdOn = ch.extTrJoinSentences.newValue !== false; });
  } catch (e) {}
  function zdPlain(t) { return String(t || '').replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '').trim(); }
  function zdEnds(t) { return /[.!?…。！？♪\])]["'”’»]*$/.test(zdPlain(t)); }
  function zdEllipsis(t) { return /(\.\.\.|…)["'”’»]*$/.test(zdPlain(t)); }
  // nowa osoba („- Hi.”) albo dźwięk / muzyka („[wzdycha]”, „♪”) — od tego nie zaczyna się dalszy ciąg zdania
  function zdNewSpeaker(t) { return /^[-–—]\s*\S|^[\[(♪]/.test(zdPlain(t)); }
  // Czy „next” to dalszy ciąg zdania „cur” (gapMs = przerwa między nimi).
  function zdContinues(cur, next, gapMs) {
      var c = zdPlain(cur), n = zdPlain(next);
      if (!c || !n || zdNewSpeaker(n)) return false;
      if (/^[-–—]/.test(c) && /\s[-–—]\s*\S/.test(c)) return false;   // „- Hi. - Hello.” — dwie osoby w jednej kwestii
      var lower = /^(\.\.\.|…)?\s*\p{Ll}/u.test(n);
      if (zdEnds(c) && !(zdEllipsis(c) && lower)) return false;       // „I was thinking...” + „...maybe” — dalej
      if (c.length + 1 + n.length > ZD_MAX_CHARS) return false;
      return gapMs <= (lower ? ZD_GAP_MS * 2 : ZD_GAP_MS);
  }
  function zdJoin(a, b) {
      a = String(a || '').trim(); b = String(b || '').trim();
      if (!a) return b;
      if (!b) return a;
      if (zdEllipsis(a) && /^(\.\.\.|…)/.test(b)) {
          a = a.replace(/(\.\.\.|…)(["'”’»]*)$/, '$2');
          b = b.replace(/^(\.\.\.|…)\s*/, '');
      }
      return (a + ' ' + b).replace(/\s+/g, ' ').trim();
  }
  // Lista {startMs, endMs, [field]} → nowa lista zdań {startMs, endMs, [field]}; wejście bez zmian.
  function zdMerge(list, field) {
      if (!zdOn || !list || list.length < 2) return list;
      field = field || 'text';
      var out = [], g = null;
      for (var i = 0; i < list.length; i++) {
          var c = list[i], t = String((c && c[field]) || '').replace(/\s+/g, ' ').trim();
          if (!t) continue;
          var st = +c.startMs || 0, en = Math.max(+c.endMs || 0, st + 400);
          if (g && en - g.startMs <= ZD_MAX_MS && zdContinues(g[field], t, st - g.endMs)) {
              g[field] = zdJoin(g[field], t);
              g.endMs = Math.max(g.endMs, en);
              continue;
          }
          if (g) out.push(g);
          g = { startMs: st, endMs: en };
          g[field] = t;
      }
      if (g) out.push(g);
      if (out.length < list.length) { try { console.log('[Lektor] Całe zdania: ' + list.length + ' kwestii → ' + out.length + ' zdań do tłumaczenia'); } catch (e) {} }
      return out;
  }


  var LOG = function () { try { console.log.apply(console, ['%c[Lektor Łowca-auto]', 'color:#7ee0ff'].concat([].slice.call(arguments))); } catch (e) {} };
  function post(cmd, extra) {
    try { var m = { __lowca: 'cmd', cmd: cmd }; if (extra) for (var k in extra) m[k] = extra[k]; window.postMessage(m, '*'); } catch (e) {}
  }

  // GUI zgodnie z checkboxem „Pokazuj GUI Łowcy” (hunter domyślnie cichy).
  function syncGui() {
    try { chrome.storage.local.get('lowcaGui', function (r) { if (r && r.lowcaGui) post('gui', { gui: true }); }); } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncGui, { once: true }); else syncGui();
  setTimeout(syncGui, 2000);

  // ---------- 1) znalezisko → poproś o najlepsze kwestie (z opóźnieniem: zbierają się kolejne warstwy) ----------
  var askTimer = 0, lastKey = '';
  // [AGENT-EXP] 2026-11-06: „🔍 Znajdź napisy” w popupie pyta najpierw Łowcę o gotowe kwestie z czasami
  // (LOWCA_TAKE_BEST) — odpowiedź idzie, gdy przyjdzie __lowca_best (albo „nie ma” po 3 s).
  var bestWaiter = null, bestTimer = 0;
  try {
    chrome.runtime.onMessage.addListener(function (m, _s, sendResponse) {
      if (!m || m.action !== 'LOWCA_TAKE_BEST') return;
      post('best');
      bestWaiter = sendResponse;
      clearTimeout(bestTimer);
      bestTimer = setTimeout(function () {
        if (bestWaiter) { try { bestWaiter({ ok: true, found: false }); } catch (e) {} }
        bestWaiter = null;
      }, 3000);
      return true;
    });
  } catch (e) {}
  function askBest(ms) { clearTimeout(askTimer); askTimer = setTimeout(function () { post('best'); }, ms); }
  window.addEventListener('ush:found', function (ev) {
    try { var d = ev && ev.detail; if (d && d.cues === 0 && !d.url) return; } catch (e) {}
    askBest(1500);
  });
  window.addEventListener('ush:reset', function () {
    lastKey = '';
    try { chrome.runtime.sendMessage({ action: 'LOWCA_AUTO_CLEAR' }, function () { void chrome.runtime.lastError; }); } catch (e) {}
  });

  // ---------- 2) odpowiedź huntera → background ----------
  window.addEventListener('message', function (ev) {
    try {
      if (ev.source !== window) return;
      var b = ev.data && ev.data.__lowca_best;
      if (!b || !Array.isArray(b.cues) || b.cues.length < 5) return;
      if (bestWaiter) {   // [AGENT-EXP] 2026-11-06: popup czeka na odpowiedź „🔍 Znajdź napisy”
        try { bestWaiter({ ok: true, found: true, cues: b.cues.length, lang: b.lang || '' }); } catch (e) {}
        bestWaiter = null; clearTimeout(bestTimer);
      }
      var key = b.id + ':' + b.cues.length + ':' + b.lang;
      if (key === lastKey) return;
      lastKey = key;
      LOG('napisy do lektora: ' + b.cues.length + ' kwestii' + (b.lang ? ' [' + b.lang + ']' : ''), b.url || '');
      chrome.runtime.sendMessage({ action: 'LOWCA_AUTO_CUES', lang: b.lang, label: b.label, url: b.url, page: b.page, cues: b.cues },
        function () { void chrome.runtime.lastError; });
    } catch (e) {}
  });

  // ---------- 3) kwestie → lektor (tylko w ramce, w której jest film) ----------
  var runToken = 0, curApplied = '';
  // [AGENT-EXP] 2026-10-25: napisy W CZĘŚCIACH (HBO Max i inne DASH/HLS) — odtwarzacz pobiera je razem z buforem,
  // więc Łowca miał na starcie tylko początek (np. 130 kwestii ≈ 15 min) i lektor potem stał. Teraz:
  //  • fullPath — cały plik (full: true, HBO z manifestu) ma pierwszeństwo: kawałki Łowcy na tej stronie są pomijane;
  //  • gdy Łowca sam poda dłuższą listę, tłumaczymy TYLKO nowe kwestie
  //    (curItems: gotowe tłumaczenia przechodzą na nową listę; stałe id = lektor nie czyta drugi raz).
  var fullPath = '', curItems = null;
  function hasVideo() { try { return !!document.querySelector('video'); } catch (e) { return false; } }
  var curLabel = 'Łowca napisów';   // [AGENT-EXP] 2026-11-06: nazwa źródła w pasku lektora („czytam z: …”)
  function apply(items, keep) { try { if (window.__LIVEDUB_AUTO_APPLY__) window.__LIVEDUB_AUTO_APPLY__(items, keep, curLabel); } catch (e) {} }   // [AGENT-EXP] keep   // [FIX 2026-11-02] etykieta źródła: bez czyszczenia przeczytanych
  function looksPl(cues) {
    var n = 0, m = Math.min(cues.length, 60);
    for (var i = 0; i < m; i++) if (/[ąćęłńśźżĄĆĘŁŃŚŹŻ]/.test(cues[i][2])) n++;
    return m > 0 && n / m > 0.15;
  }
  function hashStr(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  function cacheKey(cues) {
    var host = ''; try { host = location.hostname.replace(/^www\./, ''); } catch (e) {}
    return 'lowca|' + host + '|' + cues.length + '|' + hashStr(cues.slice(0, 30).map(function (c) { return c[0] + c[2]; }).join('|'));
  }
  function msg(m) {
    return new Promise(function (res) {
      try { chrome.runtime.sendMessage(m, function (r) { void chrome.runtime.lastError; res(r); }); } catch (e) { res(null); }
    });
  }
  function cacheSave(key, lang, items) {
    msg({ action: 'PAMIEC_VIDEO_PUT', key: key, data: { site: 'lowca', lang: lang, id: '', title: document.title,
      cues: items.map(function (c) { return [c.startMs, c.endMs, c.src, c.text || '']; }) } });
  }
  // [AGENT-EXP] 2026-10-17: kontekst dla tłumacza — true = tu zaczyna się nowy blok (pauza >= 2 s albo nie-sąsiednia kwestia)
  function ctxBrk(list, batch) {
    return batch.map(function (ix, j) {
      if (!j || ix !== batch[j - 1] + 1) return true;
      var a = list[batch[j - 1]], b = list[ix];
      return !a || !b || !(b.startMs - a.endMs < 2000);
    });
  }
  async function translateAll(items, src, token, onProgress) {
    var v = document.querySelector('video');
    var now = v ? v.currentTime * 1000 : 0;
    var first = items.findIndex(function (c) { return c.endMs >= now; });
    if (first < 0) first = 0;
    var order = [];
    for (var i = first; i < items.length; i++) order.push(i);
    for (var k = 0; k < first; k++) order.push(k);
    order = order.filter(function (ix) { return !items[ix].text; });
    var batches = 0;
    while (order.length) {
      if (token !== runToken) return;
      var batch = [], chars = 0;
      while (order.length && batch.length < 60 && chars < 2500) { var ix = order.shift(); batch.push(ix); chars += items[ix].src.length + 1; }
      // [AGENT-EXP] 2026-10-17: silnik z ustawień (domyślnie „lokalny”) — bez wymuszania lokalnego (local: true)
      var r = await msg({ action: 'EXT_TR_LIST', src: src, brk: ctxBrk(items, batch), texts: batch.map(function (ix) { return items[ix].src; }) });   // [AGENT-EXP] local: angielski lokalnym Translatorem
      if (token !== runToken) return;
      var out = r && r.ok && Array.isArray(r.texts) ? r.texts : null;
      if (!out) { LOG('błąd tłumaczenia paczki — ponawiam za 5 s'); order = batch.concat(order); await new Promise(function (res) { setTimeout(res, 5000); }); continue; }
      batch.forEach(function (ix, j) { if (out[j]) items[ix].text = out[j]; });
      if (onProgress && (++batches % 3 === 0 || !order.length)) onProgress();
    }
  }
  async function run(cues, lang) {
    var token = ++runToken;
    if (!cues) { curItems = null; apply(null); return; }   // [AGENT-EXP] 2026-10-25: przy nowych kwestiach stara lista gra, aż nowa gotowa
    var old = new Map();   // [AGENT-EXP] 2026-10-25: tłumaczenia z poprzedniej (krótszej) listy
    (curItems || []).forEach(function (c) { if (c.text) old.set(c.startMs + '|' + c.src, c.text); });
    // [AGENT-EXP] obce napisy: całe zdania do tłumaczenia (klucz pamięci liczony już z listy zdań)
    if (zdOn && !(/^pl/i.test(lang || '') || (!lang && looksPl(cues)))) {
      cues = zdMerge(cues.map(function (c) { return { startMs: c[0], endMs: c[1], text: c[2] }; }), 'text')
        .map(function (c) { return [c.startMs, c.endMs, c.text]; });
    }
    var key = cacheKey(cues);
    var mem = await msg({ action: 'PAMIEC_VIDEO_GET', key: key });
    if (token !== runToken) return;
    var pl = /^pl/i.test(lang || '') || (!lang && looksPl(cues));
    var items;
    if (mem && mem.ok && mem.data && Array.isArray(mem.data.cues) && mem.data.cues.length === cues.length) {
      items = mem.data.cues.map(function (c) { return { id: 'lowca_' + c[0] + '_' + hashStr(c[2]), startMs: c[0], endMs: c[1], src: c[2], text: c[3] || old.get(c[0] + '|' + c[2]) || '' }; });   // [AGENT-EXP] stałe id
      LOG('z pamięci: ' + items.length + ' kwestii');
    } else {
      items = cues.map(function (c) { return { id: 'lowca_' + c[0] + '_' + hashStr(c[2]), startMs: c[0], endMs: c[1], src: c[2], text: pl ? c[2] : (old.get(c[0] + '|' + c[2]) || '') }; });   // [AGENT-EXP] stałe id + gotowe tłumaczenia
    }
    apply(items, !!curItems);
    curItems = items;
    if (!pl && items.some(function (c) { return !c.text; })) {
      LOG('tłumaczę ' + items.length + ' kwestii na polski');
      cacheSave(key, lang, items);
      await translateAll(items, lang ? lang : 'auto', token, function () { cacheSave(key, lang, items); });
    } else cacheSave(key, lang, items);
  }
  try {
    chrome.runtime.onMessage.addListener(function (m) {
      if (!m || m.action !== 'LOWCA_AUTO_APPLY') return;
      if (!window.__LIVEDUB_AUTO_APPLY__) return;
      if (m.cues && !hasVideo()) return; // kwestie czyta tylko ramka z filmem
      var cues = Array.isArray(m.cues) && m.cues.length ? m.cues : null;
      // [AGENT-EXP] 2026-10-25: cały plik (HBO) wygrywa z kawałkami Łowcy i z jego „wyczyść” na tej samej stronie
      var path = location.pathname;
      curLabel = m.label ? String(m.label) : 'Łowca napisów';   // [AGENT-EXP] 2026-11-06
      if (m.full && cues) { fullPath = path; LOG('cały plik napisów (HBO): ' + cues.length + ' kwestii' + (m.lang ? ' [' + m.lang + ']' : '')); }
      else if (fullPath && fullPath === path) return;
      var k = cues ? cacheKey(cues) : '';
      if (k === curApplied) return; // te same napisy z innej ramki/warstwy — bez ponownego tłumaczenia
      curApplied = k;
      run(cues, m.lang || '');
    });
  } catch (e) {}

  // Start na zapamiętanej domenie: hunter mógł coś złapać, zanim ten skrypt dostał zdarzenie.
  askBest(4000);
  // [AGENT-EXP] 2026-11-06: 📌 domena zapamiętana przyciskiem Łowcy — dopytujemy o najlepsze napisy kilka razy,
  // żeby kolejny film ruszył sam, nawet gdy Łowca znajdzie je dopiero po chwili.
  try {
    chrome.storage.local.get('domainSubPin', function (r) {
      var m = (r && r.domainSubPin) || {}, h = '';
      try { h = location.hostname.replace(/^www\./, '').toLowerCase(); } catch (e) {}
      if (!h || !m[h] || !m[h].on) return;
      [6000, 14000, 30000].forEach(function (ms) { setTimeout(function () { if (!curItems) post('best'); }, ms); });
    });
  } catch (e) {}
  // [AGENT-EXP] 2026-10-25: BEZ dopytywania co 20 s (decyzja użytkownika) — Łowca szuka tylko na starcie, potem nie.
})();
