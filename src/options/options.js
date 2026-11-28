// options.js — strona ustawień rozszerzenia (wzorowana na DUO-ustawienia.html z Piper.js).
// Tylko opcje Pipera, których NIE ma w popupie. Zapis bezpośrednio w chrome.storage.local
// (zamiast mostu postMessage jak w skrypcie). Nową opcję dopisujesz jednym obiektem w SCHEMA.
// Wszystko związane z tą stroną: komentarze OPTIONS-PAGE w innych plikach.
'use strict';

const SCHEMA = [
  // [VOX] 2026-10-20: 🗣 Silnik mowy — ten sam klucz ttsEngine co w popupie, plus Supertonic (silnik z VoxNemesis).
  // Głos dla serwerów (Matcha, XTTS, Pocket…) dalej wybiera się w popupie.
  // [FIX 2026-11-02] bez dubli: silnik, głos, sprzęt i jakość Supertonic wybiera się TYLKO w popupie („🗣 Silnik mowy”).
  // Tu zostały narzędzia, których popup nie ma: test lektora, restart Supertonic, instrukcja NVIDIA i stan silnika.
  { sec: '🗣 Silnik mowy — narzędzia', id: 'engineSec', sub: 'Silnik, głos, sprzęt (CPU / GPU) i jakość wybierasz w popupie, w karcie „🗣 Silnik mowy”. Tu: test lektora, restart silnika Supertonic i jego stan.', items: [] },
  // [AGENT-EXP] 2026-10-17: sekcja „🎙 Silnik lektora” usunięta — silnik i głos wybiera się w popupie
  // (🗣 Silnik mowy + Głos); buforowanie w pauzie / w tle też jest w popupie.
  // [FIX 2026-11-02] ✂ / 🗣 — tekst lektora przed syntezą (src/offscreen/offscreen.js: shortenText, pronApply)
  { sec: '✂ Tekst lektora', sub: 'Co lektor robi z polskim tekstem tuż przed czytaniem (każdy silnik).', items: [
    { k: 'shortenLong', t: 'bool', def: false, label: '✂ Skracaj za długie kwestie (AI w Chrome)', hint: 'Gdy zdanie wyraźnie nie zmieści się w czasie napisu, Gemini Nano wbudowany w Chrome (lokalnie, bez klucza) skraca je jak lektor — zamiast przyspieszać mowę. Działa przy nagrywaniu do przodu (całe napisy, plik, bazy). Wymaga Chrome z Prompt API i pobranym modelem; bez niego lektor czyta oryginał.' },
    { k: 'pronDict', t: 'textarea', def: '', label: '🗣 Słownik wymowy', hint: 'Jedna reguła w linii: tekst => jak czytać, np. Netflix => Netfliks, AI => aj aj, Mr. => mister. Całe słowa, wielkość liter bez znaczenia; # na początku linii = komentarz.' }
  ]},
  // [FIX 2026-11-02] „Auto-nadrabianie” tylko w popupie (karta prędkości) — było w obu miejscach
  { sec: '⏩ Tempo', sub: 'Jak lektor nadąża za przyspieszonym filmem (np. 1.5×). Auto-nadrabianie (najwyżej 1,8×) włączasz w popupie, przy prędkości lektora.', items: [
    { k: 'tempoMode', t: 'select', def: 'A', label: 'Wariant tempa', hint: 'A — jak film, B — połowa przyspieszenia, C — stałe tempo', options: [
      ['A', 'A — Za wideo 1:1'], ['B', 'B — Za wideo łagodnie'], ['C', 'C — Stałe tempo']] },
    { k: 'compressor', t: 'bool', def: false, label: 'Anty-trzask', hint: 'Kompresor na wyjściu lektora' }
  ]},
  { sec: '🗂️ Karty i pauza', sub: 'Zachowanie przy wielu kartach i pauzie.', items: [
    { k: 'singleTabMode', t: 'bool', def: true, label: 'Tylko jedna karta naraz', hint: 'Audio Focus — druga karta uciszana' },
    { k: 'autoMuteHidden', t: 'bool', def: true, label: 'Wyciszaj kartę w tle', hint: 'Gdy przełączysz okno lub kartę' },
    { k: 'pauseVideoWithLektor', t: 'bool', def: false, label: 'Pauzuj film razem z lektorem', hint: 'Film czeka, aż lektor skończy kwestię' },
    // [AGENT-EXP] 2026-10-22: lektor nie pomija i nie ucina zdań; pauza filmu → dokończ bieżące zdanie
    { k: 'readToEnd', t: 'bool', def: false, label: 'Czytaj zawsze do końca', hint: 'Lektor nie pomija ani nie ucina zdań; po pauzie filmu kończy bieżące zdanie' }
  ]},
  { sec: '📺 YouTube i filtry', sub: 'Wykrywanie polskiego dubbingu i filtrowanie wstawek.', items: [
    { k: 'detectYTPolish', t: 'bool', def: true, label: 'Wyłącz przy polskim dubbingu', hint: 'Gdy wybrana jest polska ścieżka audio' },
    { k: 'detectYTPolishChannel', t: 'bool', def: true, label: 'Wyłącz na polskich filmach/kanałach', hint: 'Język audio PL lub automatyczne polskie napisy (mowa po polsku)' },
    { k: 'soundCuesFilter', t: 'bool', def: true, label: 'Pomijaj wstawki dźwiękowe', hint: '(wiatr), [muzyka], ♪' }
  ]},
  { sec: '🌐 Tłumaczenie sieciowe (eksperyment)', sub: 'Osobny tryb: porcje o różnej wielkości, rzadkie zapytania, rotacja silników. Lokalne tłumaczenie Chrome działa bez zmian.', items: [
    // Jedna lista zamiast osobnego przełącznika: „lokalny” = extTrOn wył., każdy inny silnik = extTrOn wł.
    { k: 'extTrEngine', t: 'select', def: 'lokalny', label: 'Silnik tłumaczenia', hint: 'Lokalny = Translator wbudowany w Chrome (bez sieci). Rotacja = po kolei każdy silnik sieciowy, żeby żaden nie dostał całości ruchu. Kwestie na żywo (🅾 OCR, strony bez pliku napisów) i tak idą przez sieć — przy „lokalnym” najpierw Bing (najszybszy), gdy padnie: Google, DeepL', options: [
      ['lokalny', 'Lokalny Translator Chrome (bez sieci)'], ['rotacja', 'Rotacja: Google → Bing → DeepL'], ['google', 'Google'], ['gtab', 'Google — karta Tłumacza (automat w przypiętej karcie, jak skrypt Tampermonkey)'], ['bing', 'Bing'], ['deepl', 'DeepL']] },
    { k: 'autoSubsOn', t: 'bool', def: true, label: 'Automatycznie pobieraj całe napisy (iQIYI, WeTV, Viki, Bilibili, Bstation)', hint: 'Lektor sam ściąga pełny plik napisów odcinka (polskie → angielskie → inne) i tłumaczy go z wyprzedzeniem wybranym silnikiem. Ręcznie wczytany plik ma pierwszeństwo.' },
    // [AGENT-EXP] 2026-10-15 — „lokalny”: angielski Translatorem Chrome, inne języki Bingiem (src/background/ext_net.js).
    { k: 'extTrNonEnCloud', t: 'bool', def: true, label: 'Angielski lokalnie, inne języki w chmurze', hint: 'Przy silniku „Lokalny”: napisy po angielsku tłumaczy Translator Chrome (ze słownikiem fraz), a każdy inny język od razu Bing (gdy zawiedzie — Google / DeepL). Język ze ścieżki napisów albo z samej kwestii. Wyłączone = jak dawniej (YouTube lokalnie, reszta Bingiem).' },
    { k: 'ytTlangPl', t: 'bool', def: true, label: 'YouTube: polskie napisy z tłumaczenia YouTube (jak Live Dubbing)', hint: 'Lektor najpierw prosi YouTube o „Automatyczne tłumaczenie → polski” — tłumaczy serwer YouTube, bez limitu i bez kluczy. Gdy film tego nie ma, tłumaczy lektor jak dotąd (Translator Chrome / Bing). Dotyczy trybu napisów „auto” na YouTube.' },   // [AGENT-EXP] 2026-10-21
    // [AGENT-EXP] 2026-10-15 — całe zdania zamiast kawałków (lokalny Translator Chrome i silniki sieciowe).
    // [AGENT-EXP] 2026-11-26: opis uzupełniony o to, co było w popupie (dolna linia, ⏱, ⏭)
    { k: 'lektorBar', t: 'bool', def: true, label: '📊 Pasek lektora: nagrany dźwięk do przodu', hint: 'Cienki pasek na dole filmu, zgodny z jego osią czasu. Górna linia: zielone = przeczytane, pomarańczowe = dźwięk lektora już nagrany, jasnoszare = tekst gotowy, dźwięku jeszcze nie ma, ciemne = czeka na tłumaczenie, biała kreska = bieżące miejsce. Dolna linia: białe = obejrzane, pomarańczowe = zapas nagrań. Obok: na ile minut do przodu lektor ma nagrany dźwięk, ⏱ opóźnienie lektora, ⏭ pominięte kwestie (ostatnie 10 min).' },   // [AGENT-EXP] 2026-10-17
    { k: 'extTrContext', t: 'bool', def: true, label: 'Tłumacz z kontekstem (do pauzy w mowie)', hint: 'Kolejne kwestie idą do tłumacza razem — aż do dłuższej przerwy w mowie (2 s), najwyżej 8 kwestii — więc tłumacz widzi, co było przed i po (ty / wy, on / ona). Lektor dalej czyta kwestia po kwestii. Gdy tłumacz pomiesza linie, te kwestie są tłumaczone pojedynczo. Wyłączone = każda kwestia osobno.' },   // [AGENT-EXP] 2026-10-17
    { k: 'extTrJoinSentences', t: 'bool', def: true, label: 'Tłumacz całe zdania', hint: 'Kwestie, które są kawałkami jednego zdania („I told you that if you” + „came back, I’d leave.”), idą do tłumacza razem — tłumaczenie ma sens zamiast urywków (YouTube, całe napisy, Łowca, LIVE, OCR). Na żywo niedokończone zdanie czeka na dalszy ciąg (do ~6 s), więc lektor zaczyna chwilę później.' },
    { k: 'extTrChunk', t: 'select', def: 'mieszane', label: 'Wielkość porcji', hint: 'Ile wyrazów w jednym zapytaniu; „mieszane” losuje za każdym razem', options: [
      ['100', '100 wyrazów'], ['300', '300 wyrazów'], ['400', '400 wyrazów'], ['mieszane', 'Mieszane (100/300/400)']] },
    { k: 'extTrInterval', t: 'select', def: '30s', label: 'Odstęp między porcjami', hint: 'Plus losowe ±50%, żeby nie było jak zegarek; duża porcja starcza na długo', options: [   // [AGENT-EXP] 2026-10-17: ±50%, 1–5 min co minutę, bez 10 min
      ['20s', '20 sekund'], ['30s', '30 sekund'], ['1min', '1 minuta'], ['2min', '2 minuty'], ['3min', '3 minuty'], ['4min', '4 minuty'], ['5min', '5 minut']] },
    // [AGENT-EXP] NOWA OPCJA 1/2 — Google RPC: zamienia główną funkcję Google (gtx) na metodę RPC.
    // [AGENT-EXP] NOWA OPCJA 2/2 — zatrzymanie tłumaczenia razem z lektorem.
    { k: 'extTrStopWithLektor', t: 'bool', def: false, label: 'Zatrzymaj tłumaczenie razem z lektorem', hint: 'Gdy wyłączysz lektora (STOP) lub przejdziesz na inny film — natychmiast ubija kolejkę tłumaczenia w tle (mniej zapytań, brak blokad). Wył. = tłumaczenie dokończy kolejkę samo.' },
    // [AGENT-EXP] NOWA OPCJA 3/3 — Microsoft/Bing: nowa metoda batch (czysta tablica + limit 7 żąd./1250 ms, styl Immersive Translate).
    { k: 'extTrMicrosoftBatch', t: 'bool', def: false, label: 'Microsoft — tryb batch (eksperymentalny)', hint: 'Nowa metoda Microsoft: czysta tablica tekstów + limit 7 żądań/1250 ms (jak Immersive Translate), bez tagów <bN> i regexa. Działa gdy włączone jest tłumaczenie sieciowe i wybrany Bing (lub rotacja). Wył. = dokładnie jak dotychczas (metoda z tagami).' },
    // [AGENT-EXP] 2026-10-17: pola „Włącz silnik AI” i „Klucz API (CometAPI)” usunięte z Ustawień (niepotrzebne).
    // ext_net.js dalej obsługuje aiOn / aiApiKey — powrót: przywróć oba obiekty z kopii kodu z 2026-10-17.
  ]},
  // [AGENT-EXP] 2026-10-19 — 🤐 Cenzor przekleństw (assets/cenzor_main.js + cenzor_bridge.js). Wycisza oryginalny
  // dźwięk filmu (video.muted), głos lektora gra dalej.
  // [FIX 2026-11-02] JEDEN cenzor: włączanie (mowa lektora / dźwięk filmu z napisów / na bieżąco), tryb i JEDNA lista słów
  // (wspólna z lektorem). Włączanie (cenzorOn / cenzorLive) jest dostępne tu i w popupie, w karcie „🤬 Cenzor przekleństw”.
  { sec: '🤬 Cenzor przekleństw — wyciszanie dźwięku filmu', sub: 'Włączanie, tryb i lista słów (wspólna z lektorem) są w popupie i tu. Tu dodatkowo: skąd brać napisy i jak długo trwa cisza w oryginalnym dźwięku. Pracuje tylko na tekście napisów (nie słucha dźwięku); działa także przy wyłączonym lektorze.', items: [
    { k: 'cenzorOn', t: 'bool', def: true, label: 'Włącz wyciszanie z pobranych napisów (cenzorOn)', hint: 'Cenzor pobiera napisy z sieci i planuje ciszę przed wulgaryzmem. Na Prime Video napisy są wyciągane z kontenera napisów na stronie.' },
    { k: 'cenzorPriority', t: 'select', def: 'file', label: 'Kto ma pierwszeństwo: pobrane napisy czy live (lektor + cenzor)', hint: 'Dotyczy też lektora: live = lektor czyta tylko napisy z ekranu (Immersive Translate), file/hybrid = lektor czyta pobrany plik, a ekran gdy pliku brak. file = plik rządzi, live dopiero po jego końcu; hybrid = jak wcześniej (live już 30 s przed końcem pliku); live = ekran rządzi także tam, gdzie jest plik.', options: [
      ['file', 'Priorytet: pobrane napisy (live dopiero po końcu pliku)'], ['hybrid', 'Priorytet: plik + live 30 s przed końcem (jak wcześniej)'], ['live', 'Priorytet: napisy z ekranu (live także w pokryciu pliku)']] },
    { k: 'cenzorLive', t: 'bool', def: true, label: 'Włącz wyciszanie z napisów na bieżąco (cenzorLive)', hint: 'Cenzor skanuje napisy wyświetlane na ekranie w czasie rzeczywistym i wycisza wideo tylko na czas wulgaryzmu.' },
    { k: 'cenzorBufferMs', t: 'range', def: 400, min: 0, max: 3000, step: 50, unit: ' ms', label: 'Wstecz — cisza przed słowem', hint: 'Słychać początek przekleństwa → zwiększ.' },
    { k: 'cenzorHoldMs', t: 'range', def: 200, min: 0, max: 2000, step: 50, unit: ' ms', label: 'Przód — cisza po słowie', hint: 'Słychać końcówkę → zwiększ.' },
    // [AGENT-EXP] 2026-10-20: trzeci suwak z „Netflix Cenzor” — tempo tekstu (Wstecz/Przód liczone w tym tempie).
    { k: 'cenzorTextAuto', t: 'bool', def: false, label: 'Tempo tekstu: auto (= tempo filmu)', hint: 'Wył. = działa suwak niżej, niezależnie od prędkości filmu.' },
    { k: 'cenzorTextRate', t: 'range', def: 0.6, min: 0.25, max: 2.5, step: 0.05, fmt: (v) => String(Math.round(v * 100) / 100).replace('.', ',') + '×', label: 'Tempo tekstu', hint: 'Mnoży Wstecz i Przód (oraz „Długość słowa”). Mniej = krótsza cisza, więcej = dłuższa. Działa, gdy „auto” wyłączone. W starym cenzorze domyślnie 0,6×.' },
    { k: 'cenzorLenMode', t: 'select', def: 'normal', label: 'Długość słowa', hint: 'Dłuższe przekleństwo trzymane dłużej', options: [
      ['off', 'wyłącz'], ['normal', 'normalnie'], ['strong', 'mocno']] },
    // [FIX 2026-11-21] „napis wisi dłużej niż mowa” (cenzor_main.js → tailAltTimes)
    { k: 'cenzorTailFix', t: 'bool', def: true, label: 'Napis wisi dłużej niż mowa — celniejsze cięcie', hint: 'Gdy kwestia trwa wyraźnie dłużej, niż potrzeba na jej tekst, cisza obejmuje oba możliwe miejsca przekleństwa (od początku kwestii i rozłożone na całą); przy wyraźnym ogonie wystarcza to wcześniejsze, więc cisza jest krótsza. Tempo mowy dobierane z wczytanych napisów.' },
    // [FIX 2026-11-21] wybór sposobu liczenia, KIEDY pada słowo w pobranych napisach (cenzor_main.js → wordTimesInCue)
    { k: 'cenzorTimingMode', t: 'select', def: 'legacy', label: 'Celowanie w słowo (pobrane napisy)', hint: 'legacy = proporcje liter + pauzy po przecinku/kropce (bezpieczny). pmtpos = miejsce słowa z modelu PMT, cisza dalej z suwaków Wstecz/Przód. pmt = całe okna z modelu (diagnostyka). Prawdziwe czasy słów z YouTube zawsze wygrywają.', options: [
      ['legacy', 'legacy — proporcje + pauzy (domyślnie)'], ['pmtpos', 'pmtpos — miejsce słowa z modelu PMT'], ['pmt', 'pmt — okna w całości z modelu']] },
  ]},
  // [FIX 2026-11-02] „Pokazuj GUI Łowcy” tylko w popupie (karta Łowcy) — było w obu miejscach
  { sec: '🔍 Łowca napisów', sub: 'Szukanie napisów na żądanie (przycisk w popupie). „Pokazuj GUI Łowcy (przycisk CC)” przełączasz w popupie, w karcie Łowcy.', items: [
    // [AGENT-EXP] 2026-10-15 — 🔋 tryb oszczędny Łowcy (assets/lowca_napisow.js, przekazuje mostek).
    // [AGENT-EXP] 2026-10-17: opis zgodny z kodem — bez filmu Łowca się nie włącza, z filmem ~2 s (było „4 s / 15 s”).
    { k: 'lowcaEco', t: 'bool', def: true, label: 'Łowca: tryb oszczędny', hint: 'Strona bez filmu — Łowca w ogóle się nie włącza (włączy go dopiero film, który się na niej pojawi). Gdy film jest: szuka ok. 2 s gry filmu; po złapaniu napisów albo gdy ich brak (reklama YouTube się nie liczy) przestaje szukać do następnego filmu. „Szukaj napisów” w popupie albo „Szukaj dalej” w panelu Łowcy budzi go od razu.' },
    // [AGENT-EXP] 2026-10-17: pola kluczy API OpenSubtitles.com i SubDL usunięte z Ustawień (niepotrzebne).
    // subs_db.js dalej czyta osApiKey / subdlApiKey — bez klucza te bazy są pomijane; OpenSubtitles.org działa bez klucza.
    // Żeby wrócić: dopisz tu { k: 'osApiKey', t: 'text', secret: true, ... } (wzór w kopii kodu z 2026-10-17).
  ]},
  { sec: '🖥️ Wygląd i bufor', sub: 'Panel lektora, nakładka i nagrania.', items: [
    // [AGENT-EXP] 2026-10-17 — pokazywanie paneli w lewym dolnym rogu (sub_panel.js, dom_content.js, lektor-controls.js)
    { k: 'lektorPanelOn', t: 'bool', def: true, label: 'Pokazuj panel „🎤 Lektor — co mówię”', hint: 'Panel w lewym dolnym rogu filmu z listą czytanych zdań. Wył. = całkiem niewidoczny (także pigułka „🎤 Lektor”); lektor czyta dalej.' },
    // [AGENT-EXP] 2026-11-26: opis po scaleniu paska z panelem 🎤
    { k: 'lektorControlsOn', t: 'bool', def: true, label: 'Pokazuj w panelu rząd ◄ − 1.0x + ► (przewijanie, prędkość lektora)', hint: 'Rząd w panelu „🎤 Lektor — co mówię”: ◄ ► przewija film o 5 s, − + zmienia prędkość lektora. Wył. = rząd ukryty, reszta panelu zostaje.' },
    { k: 'uiScale', t: 'range', def: 100, min: 80, max: 200, step: 10, unit: '%', label: 'Skala panelu', hint: 'Panel „Lektor — co mówię" na filmie' },
    { k: 'captionOverlay', t: 'bool', def: false, label: 'Nakładka z czytanym tekstem', hint: 'Przeciągana na ekranie' },
    { k: 'liveBufTTLDays', t: 'select', def: '0', label: 'Nagrania lektora znikają po', hint: '0 = domyślne 3 dni', options: [
      ['0', 'domyślnie'], ['1', '1 dniu'], ['2', '2 dni'], ['3', '3 dni'], ['7', '7 dni'], ['14', '14 dni'], ['30', '30 dni']] }
  ]}
];

// Klucze nie eksportowane (modele głosów siedzą w IndexedDB, napisy z pliku są duże, __* to diagnostyka,
// aiTranslationMemory to osobna baza tekstów — eksportowana tylko na życzenie z jej własnego panelu).
const EXPORT_SKIP = (k) => k.indexOf('__') === 0 || k === 'fileSubs' || k === 'customVoice' || k === 'builtinVoiceMigratedOnce' || k === 'aiTranslationMemory';

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const statusEl = $('status');
const fields = {};
let statusTimer = null;

function setStatus(txt, cls) {
  statusEl.textContent = txt;
  statusEl.className = cls || '';
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { statusEl.textContent = 'Ustawienia zapisują się automatycznie.'; statusEl.className = ''; }, 3500);
}
function save(obj) {
  chrome.storage.local.set(obj, () => {
    if (chrome.runtime.lastError) setStatus('❌ ' + chrome.runtime.lastError.message, 'err');
    else setStatus('✅ Zapisano', 'ok');
  });
}
function el(tag, props, text) {
  const e = document.createElement(tag);
  if (props) Object.keys(props).forEach((k) => { if (k === 'class') e.className = props[k]; else e.setAttribute(k, props[k]); });
  if (text != null) e.textContent = text;
  return e;
}
function section(title, sub, wide, id) {
  const s = el('section', wide ? { class: 'wide' } : null);
  if (id) s.id = id;   // [VOX]
  s.appendChild(el('h2', null, title));
  s.appendChild(el('p', { class: 'sub' }, sub));
  grid.appendChild(s);
  return s;
}

function buildRow(def) {
  const row = el('div', { class: 'row' });
  const lbl = el('div', { class: 'lbl' });
  lbl.appendChild(el('b', null, def.label));
  lbl.appendChild(el('span', null, def.hint || ''));
  row.appendChild(lbl);
  let input, valSpan = null;
  if (def.t === 'bool') {
    const sw = el('label', { class: 'sw' });
    input = el('input', { type: 'checkbox' });
    sw.appendChild(input); sw.appendChild(el('span'));
    row.appendChild(sw);
    input.addEventListener('change', () => save({ [def.k]: input.checked }));
  } else if (def.t === 'range') {
    input = el('input', { type: 'range', min: def.min, max: def.max, step: def.step });
    valSpan = el('span', { class: 'val' });
    const showVal = (v) => { valSpan.textContent = def.fmt ? def.fmt(Number(v)) : v + (def.unit || ''); };   // [FIX 2026-11-16] def.fmt = własny zapis, np. „0,6×”
    input.addEventListener('input', () => showVal(input.value));
    input.addEventListener('change', () => {
      const v = parseFloat(input.value);
      const patch = { [def.k]: v };
      if (def.k === 'cenzorBufferMs') patch.cenzorPrerollMs = v;
      if (def.k === 'cenzorHoldMs') patch.cenzorPostrollMs = v;
      save(patch);
    });
    row.appendChild(input); row.appendChild(valSpan);
  } else if (def.t === 'text') { // [AGENT-EXP] nowy typ pola: tekstowe (np. klucz API, URL, model)
    input = el('input', { type: def.secret ? 'password' : 'text', placeholder: def.placeholder || '' });
    input.style.width = '100%';   // [VOX] kolory i obramowanie z options.html
    input.addEventListener('change', () => save({ [def.k]: input.value }));
    row.appendChild(input);
  } else if (def.t === 'textarea') { // AI Chrome: edytowalny prompt lektorski
    row.style.cssText = 'flex-direction:column;align-items:stretch;gap:8px;';
    input = el('textarea', { spellcheck: 'false', style: 'min-height:70px;' });
    let t = null;
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => save({ [def.k]: input.value }), 500); });
    row.appendChild(input);
  } else {
    input = el('select');
    def.options.forEach(([v, t]) => input.appendChild(el('option', { value: v }, t)));
    input.addEventListener('change', () => {
      if (def.k === 'extTrEngine') save({ extTrEngine: input.value, extTrOn: input.value !== 'lokalny' });
      else save({ [def.k]: def.num ? Number(input.value) : input.value });   // [VOX] num: liczba zamiast tekstu
    });
    row.appendChild(input);
  }
  fields[def.k] = { def, input, valSpan };
  return row;
}

function applyValues(data) {
  Object.keys(fields).forEach((k) => {
    const f = fields[k];
    if (!f.def) return; // __domainWl/__domainBl — listy domen wypełniane osobno niżej
    let v = data[k];
    if (v === undefined || v === null) v = f.def.def;
    if (k === 'extTrEngine' && data.extTrOn !== true) v = 'lokalny'; // sieć wyłączona = pozycja „lokalny”
    if (k === 'extTrInterval' && v === '10min') v = '5min'; // [AGENT-EXP] 2026-10-17: 10 min usunięte — tło liczy je jak 5 min
    if (f.def.t === 'bool') f.input.checked = !!v;
    else {
      f.input.value = String(v);
      if (f.input.tagName === 'SELECT' && f.input.selectedIndex < 0) f.input.selectedIndex = 0;
      if (f.valSpan) f.valSpan.textContent = f.def.fmt ? f.def.fmt(Number(v)) : f.input.value + (f.def.unit || '');
    }
  });
}

// ---------------- Listy domen ----------------
// [FIX 2026-11-02] 📋 przełącznik „Tylko domeny z listy” (domainListsOn, domyślnie WŁ.) i „📥 Wpisz domeny lektora”;
// zasady list w assets/domain_lists.js (te same w skryptach stron, w tle i w popupie).
function buildDomainLists() {
  const s = section('📋 Białe i czarne listy domen', 'Biała lista: lektor uruchamia się TYLKO na tych domenach (i ich subdomenach, np. youtube.com → m.youtube.com) — na pozostałych stronach nie działa i nie zużywa procesora. Czarna lista: tu lektor zawsze milczy. Jedna domena na linię; linie z # lub // to komentarze.', true, 'domeny');
  s.appendChild(buildRow({ k: 'domainListsOn', t: 'bool', def: true, label: '📋 Tylko domeny z listy', hint: 'Włączone (domyślnie): działają obie listy. Wyłączone: lektor działa na każdej stronie, na której się uruchomi — listy zostają zapisane na później. Ten sam przełącznik jest w popupie.' }));
  const wrap = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-top:10px;' });
  const mk = (key, title, ph) => {
    const box = el('div');
    box.appendChild(el('b', { style: 'font-size:13px;' }, title));
    const ta = el('textarea', { placeholder: ph, spellcheck: 'false' });
    let t = null;
    ta.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => save({ [key]: ta.value }), 500); });
    box.appendChild(ta);
    wrap.appendChild(box);
    return ta;
  };
  const wl = mk('domainWhitelist', '✅ Biała lista (tylko te domeny)', 'np.:\nyoutube.com\nnetflix.com');
  const bl = mk('domainBlacklist', '⛔ Czarna lista (lektor wyłączony)', 'np.:\nrumble.com');
  wl.style.minHeight = '220px';
  s.appendChild(wrap);
  const row = el('div', { class: 'btn-row', style: 'margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;' });
  const fillBtn = el('button', { class: 'btn', type: 'button', title: 'Serwisy z lektorem wbudowanym, strony zapamiętane przez Łowcę (z odtwarzaczami), Kreator napisów, strony z napisami z pliku / baz, OCR. Niczego nie usuwa.' }, '📥 Wpisz domeny lektora');
  const fillInfo = el('span', { class: 'note' }, '');
  fillBtn.addEventListener('click', () => {
    const D = window.__LektorDomains;
    if (!D) return;
    chrome.storage.local.get(D.SOURCE_KEYS, (all) => {
      const r = D.fill(wl.value, Object.assign({}, all || {}, { domainWhitelist: wl.value, domainBlacklist: bl.value }));
      if (!r.added.length) { fillInfo.textContent = '✔ Wszystkie domeny lektora już są na liście.'; return; }
      wl.value = r.text;
      save({ domainWhitelist: r.text });
      fillInfo.textContent = '➕ Dopisano: ' + r.added.join(', ');
    });
  });
  row.appendChild(fillBtn); row.appendChild(fillInfo);
  s.appendChild(row);
  s.appendChild(el('div', { class: 'note' }, 'Zmiana działa od razu na otwartych kartach. Domena z czarnej listy zawsze wygrywa z białą. Liczy się strona z paska adresu — odtwarzacz w ramce z innej domeny działa razem z nią. Nową stronę dopiszesz też w popupie („📋 ➕ Dodaj tę stronę”); „🔍 Szukaj napisów” i „🌐 bazy napisów” dopisują ją same. Pusta biała lista = lektor wszędzie.'));
  fields.__domainWl = { ta: wl }; fields.__domainBl = { ta: bl };
  // zmiana z popupu („➕ Dodaj tę stronę”) albo z tła (Łowca) — pokaż od razu, chyba że ktoś właśnie pisze w polu
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.domainWhitelist && document.activeElement !== wl) wl.value = String(ch.domainWhitelist.newValue || '');
    if (ch.domainBlacklist && document.activeElement !== bl) bl.value = String(ch.domainBlacklist.newValue || '');
  });
}

// ---------------- Kreator napisów ----------------
let customSources = {}, customSourcesOn = {};

function manifestHostPatterns() {
  try {
    return (chrome.runtime.getManifest().host_permissions || []).filter((p) => !/huggingface|hf\.co/.test(p));
  } catch (e) { return []; }
}
function findTargetTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: manifestHostPatterns() }, (tabs) => {
      tabs = (tabs || []).slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      resolve(tabs[0] || null);
    });
  });
}
function tabHost(tab) {
  try { return new URL(tab.url).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; }
}
// [FIX 2026-11-02] karta, na której ostatnio wskazywano / testowano — do „💾 Dodaj” (KREATOR_SITE w tle)
let kTabId = null, kPickTop = '';
const KREATOR_FILES = ['assets/i18n_en.js', 'assets/i18n.js', 'assets/domain_lists.js', 'assets/options_hooks.js'];
function sendToTab(msg) {
  return findTargetTab().then((tab) => new Promise((resolve) => {
    if (!tab) { resolve({ error: 'Brak otwartej karty ze stroną www — otwórz film w karcie obok.' }); return; }
    kTabId = tab.id;
    const ask = (retry) => chrome.tabs.sendMessage(tab.id, msg, (resp) => {
      if (!chrome.runtime.lastError && resp) { resolve(Object.assign({ host: tabHost(tab) }, resp)); return; }
      // [FIX 2026-11-02] strona bez lektora (nie z listy serwisów ani Łowcy): dokładamy narzędzia Kreatora i pytamy jeszcze raz
      if (retry) {
        chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: KREATOR_FILES })
          .then(() => ask(false), () => resolve({ error: 'Ta strona nie pozwala na Kreatora (strona systemowa albo sklep Chrome).', host: tabHost(tab) }));
        return;
      }
      resolve({ error: 'Karta nie odpowiada — odśwież ją (F5) po przeładowaniu rozszerzenia.', host: tabHost(tab) });
    });
    ask(true);
  }));
}

function renderKreatorList() {
  const box = $('kList'); box.textContent = '';
  const host = $('kHost').value.trim().toLowerCase();
  const sels = customSources[host] || [];
  if (host) {
    const on = el('label', { style: 'display:flex;gap:8px;align-items:center;font-size:13px;margin-top:8px;' });
    const cb = el('input', { type: 'checkbox' });
    cb.checked = customSourcesOn[host] !== false;
    cb.addEventListener('change', () => { customSourcesOn[host] = cb.checked; save({ customSourcesOn }); });
    on.appendChild(cb); on.appendChild(document.createTextNode(' Używaj własnych źródeł na tej domenie'));
    box.appendChild(on);
  }
  sels.forEach((sel, i) => {
    const c = el('div', { class: 'chip' });
    c.appendChild(el('b', null, sel));
    const x = el('span', { class: 'x', title: 'Usuń' }, '✕');
    x.addEventListener('click', () => { sels.splice(i, 1); if (!sels.length) delete customSources[host]; save({ customSources }); renderKreatorList(); renderKreatorAll(); });
    c.appendChild(x);
    box.appendChild(c);
  });
  if (host && !sels.length) box.appendChild(el('div', { class: 'note' }, 'Brak zapisanych selektorów dla tej domeny.'));
}
function renderKreatorAll() {
  const box = $('kAll'); box.textContent = '';
  const hosts = Object.keys(customSources);
  if (!hosts.length) { box.appendChild(el('div', { class: 'note' }, 'Nic jeszcze nie zapisano.')); return; }
  hosts.forEach((h) => {
    const c = el('div', { class: 'chip' });
    c.appendChild(el('b', null, h));
    c.appendChild(document.createTextNode(' → ' + customSources[h].join(', ') + (customSourcesOn[h] === false ? '  (wyłączone)' : '')));
    c.addEventListener('click', () => { $('kHost').value = h; renderKreatorList(); });
    box.appendChild(c);
  });
}
function addSelector() {
  const host = $('kHost').value.trim().toLowerCase().replace(/^www\./, '');
  const sel = $('kSel').value.trim();
  if (!host || !sel) { setStatus('Podaj domenę i selektor', 'err'); return; }
  // [FIX 2026-11-02] błędny selektor nie trafia do zapisu (wyłączałby czytanie napisów na tej domenie)
  try { document.createDocumentFragment().querySelector(sel); } catch (e) { setStatus('❌ Błędny selektor CSS: ' + sel, 'err'); return; }
  const l = customSources[host] || (customSources[host] = []);
  if (l.indexOf(sel) === -1) l.push(sel);
  if (customSourcesOn[host] === undefined) customSourcesOn[host] = true;
  save({ customSources, customSourcesOn });
  $('kSel').value = '';
  renderKreatorList(); renderKreatorAll();
  // [FIX 2026-11-02] strona bez wbudowanego lektora: lektor startuje tam sam (jak na stronie Łowcy) + biała lista domen
  chrome.runtime.sendMessage({ action: 'KREATOR_SITE', host, tabId: kTabId, top: kPickTop }, (r) => {
    void chrome.runtime.lastError;
    if (r && r.ok && (r.listed || r.remembered)) $('kResult').textContent = '💾 Zapisano. Lektor będzie czytał z tego miejsca na ' + host + '.' + (r.listed ? '\nDopisano do białej listy domen: ' + r.listed : '');
  });
}

function buildKreator() {
  const s = section('🧪 Kreator napisów — własne źródła', 'Gdy lektor nie widzi napisów na stronie, pokaż mu je: „🎯 Wskaż myszką” → na karcie z filmem niebieska ramka pokazuje, co lektor złapie (z podglądem tekstu); kółkiem myszy albo strzałkami ↑ ↓ poszerzasz / zawężasz ramkę, klikiem wybierasz. Potem „💾 Dodaj”. Działa na każdej stronie z filmem (strony z czytaniem z ekranu: Prime, iQIYI, Dailymotion, Rumble, Viki, WeTV, Bilibili, YouTube i strony Łowcy; Netflix czyta napisy z pliku, nie z ekranu). Narzędzia działają na ostatnio używanej karcie ze stroną www. Napisy obcojęzyczne lektor czyta po przetłumaczeniu — przy włączonym tłumaczeniu sieciowym.', true);
  s.id = 'kreator';   // [FIX 2026-11-22] cel przycisku „⚙ Ręczny selektor i wszystkie domeny” z popupu (#kreator=domena)
  const r1 = el('div', { class: 'row', style: 'border-top:none;' });
  r1.appendChild(el('input', { type: 'text', id: 'kHost', placeholder: 'domena, np. youtube.com', style: 'max-width:240px;flex:none;' }));
  r1.appendChild(el('input', { type: 'text', id: 'kSel', placeholder: '.selektor-kontenera-napisow', spellcheck: 'false' }));
  const add = el('button', { class: 'btn primary' }, '💾 Dodaj'); add.addEventListener('click', addSelector);
  r1.appendChild(add);
  s.appendChild(r1);
  const btns = el('div', { class: 'btns' });
  const test = el('button', { class: 'btn' }, '🧪 Testuj selektor');
  test.addEventListener('click', async () => {
    const sel = $('kSel').value.trim();
    if (!sel) { $('kResult').textContent = 'Wpisz selektor.'; return; }
    $('kResult').textContent = '⏳ Testuję…';
    const r = await sendToTab({ action: 'KREATOR_TEST', selector: sel });
    if (r.host && !$('kHost').value) { $('kHost').value = r.host; renderKreatorList(); }
    $('kResult').textContent = r.error ? '❌ ' + r.error : (r.ok ? ('Znaleziono: ' + r.count + (r.samples && r.samples.length ? '\n• ' + r.samples.join('\n• ') : '')) : '❌ ' + (r.error || 'błąd'));
  });
  const pick = el('button', { class: 'btn' }, '🎯 Wskaż myszką');
  pick.addEventListener('click', async () => {
    // [FIX 2026-11-22] wskazywanie stąd zapisuje strona Ustawień — kasujemy ewentualne niedokończone wskazywanie
    // z popupu, żeby tło nie uznało tego wyboru za „przeterminowany wybór z popupu”
    try { await chrome.storage.local.remove('kreatorPickPending'); } catch (e) {}
    const r = await sendToTab({ action: 'KREATOR_PICK' });
    kPickTop = '';
    $('kResult').textContent = r.error ? '❌ ' + r.error : '🎯 Przełącz się na kartę z filmem (' + (r.host || '?') + ') i najedź myszką na napisy — niebieska ramka pokaże, co lektor złapie. Kółko myszy albo ↑ ↓ — szerzej / węziej, klik — wybierz, Esc — anuluj. Film stoi na czas wskazywania.';
    if (r.host && !$('kHost').value) { $('kHost').value = r.host; renderKreatorList(); }
  });
  const viewAll = el('button', { class: 'btn' }, '📋 Podgląd wszystkich domen');
  viewAll.addEventListener('click', () => { const a = $('kAll'); a.style.display = a.style.display === 'none' ? 'block' : 'none'; });
  btns.appendChild(test); btns.appendChild(pick); btns.appendChild(viewAll);
  s.appendChild(btns);
  s.appendChild(el('div', { id: 'kResult' }));
  s.appendChild(el('div', { id: 'kList' }));
  s.appendChild(el('div', { id: 'kAll', style: 'display:none;margin-top:8px;' }));
  // szukanie tekstu w stronie
  const f = el('div', { class: 'row', style: 'margin-top:10px;' });
  f.appendChild(el('input', { type: 'text', id: 'kFind', placeholder: 'wpisz słowo/zdanie z napisów, żeby znaleźć jego kontener…' }));
  const fb = el('button', { class: 'btn' }, '🔎 Szukaj');
  fb.addEventListener('click', async () => {
    const t = $('kFind').value.trim();
    if (!t) return;
    $('kResult').textContent = '⏳ Szukam…';
    const r = await sendToTab({ action: 'KREATOR_FIND', text: t });
    if (r.error) { $('kResult').textContent = '❌ ' + r.error; return; }
    $('kResult').textContent = (r.results && r.results.length)
      ? r.results.map((x) => '• ' + x.selector + '   <' + x.tag + (x.id ? ' id=' + x.id : '') + (x.cls ? ' class="' + x.cls + '"' : '') + '>').join('\n') + '\n(klik w selektor niżej wstawi go do pola)'
      : 'Nie znaleziono tekstu na stronie.';
    if (r.results && r.results[0]) $('kSel').value = r.results[0].selector;
    if (r.host && !$('kHost').value) { $('kHost').value = r.host; renderKreatorList(); }
  });
  f.appendChild(fb);
  s.appendChild(f);
  $('kHost').addEventListener('input', renderKreatorList);
}

// ---------------- Łowca: zapamiętane domeny (lowcaSites, background.js) ----------------
// Domeny, na których Łowca znalazł napisy — tam Łowca + lektor startują same i napisy idą prosto do lektora.
function renderLowcaSites(sites) {
  const box = $('lowcaSitesList'); if (!box) return;
  box.textContent = '';
  const hosts = Object.keys(sites || {}).sort((a, b) => (sites[b].ts || 0) - (sites[a].ts || 0));
  if (!hosts.length) { box.appendChild(el('div', { class: 'note' }, 'Jeszcze nic. Kliknij „🔍 Szukaj napisów” w popupie na stronie z filmem — gdy Łowca znajdzie napisy, domena zapisze się tutaj sama.')); return; }
  hosts.forEach((h) => {
    const s = sites[h] || {};
    const c = el('div', { class: 'chip' });
    c.appendChild(el('b', null, h));
    const extra = (s.frames && s.frames.length ? ' + odtwarzacz: ' + s.frames.join(', ') : '') + (s.ts ? ' · ostatnio ' + new Date(s.ts).toLocaleDateString() : '');
    if (extra) c.appendChild(document.createTextNode(extra));
    const x = el('span', { class: 'x', title: 'Zapomnij tę domenę' }, '✕');
    x.addEventListener('click', () => {
      chrome.storage.local.get('lowcaSites', (r) => {
        const all = (r && r.lowcaSites) || {};
        delete all[h];
        save({ lowcaSites: all });
        renderLowcaSites(all);
      });
    });
    c.appendChild(x);
    box.appendChild(c);
  });
}
function buildLowcaSites() {
  const s = section('🔍 Łowca — zapamiętane strony', 'Gdy Łowca znajdzie napisy, zapisuje domenę (i domenę odtwarzacza w ramce). Na tych stronach Łowca i lektor uruchamiają się same, a znalezione napisy trafiają prosto do lektora (nie-polskie są tłumaczone). ✕ = zapomnij domenę. Po zmianie odśwież kartę.', true);
  s.appendChild(el('div', { id: 'lowcaSitesList' }));
  chrome.storage.local.get('lowcaSites', (r) => renderLowcaSites((r && r.lowcaSites) || {}));
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.lowcaSites) renderLowcaSites(ch.lowcaSites.newValue || {}); });
}

// ---------------- AI Subtitle Translator ----------------
// Wgraj plik z napisami → (opcjonalnie) własny prompt → tłumaczenie wbudowanym AI Chrome
// (Translator API albo Prompt API / Gemini Nano) kwestia po kwestii, z zachowaniem numerów
// i czasów → pobierz .srt albo wczytaj wprost do lektora (klucz fileSubs, jak w popupie).
// Działa na tej stronie, bez offscreen i bez content-scriptów. Sesje AI zamykane po robocie.
const AI_MEM_KEY = 'aiTranslationMemory';
const AI_MEM_MAX = 5000;
const AIT_PROMPT_KEY = 'aitPrompt';
const AIT_PROMPT_DEF = 'Przetłumacz poniższe napisy na język polski, zachowując czasy i formatowanie, dbając o naturalny kontekst filmowy.';
const AIT_ARROW = /(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})/;
const AIT_LANGS = [
  ['auto', 'Wykryj automatycznie'], ['en', 'angielski'], ['de', 'niemiecki'], ['fr', 'francuski'], ['es', 'hiszpański'],
  ['it', 'włoski'], ['pt', 'portugalski'], ['nl', 'niderlandzki'], ['ru', 'rosyjski'], ['uk', 'ukraiński'], ['cs', 'czeski'],
  ['sv', 'szwedzki'], ['tr', 'turecki'], ['ja', 'japoński'], ['ko', 'koreański'], ['zh', 'chiński'], ['hi', 'hindi'], ['ar', 'arabski']
];

function aitHash(s) { // ten sam hash co aiHash w background/ext_net.js — wspólna pamięć tłumaczeń
  s = String(s || '');
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619);
    h2 = Math.imul(h2 + s.charCodeAt(i), 2246822519);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}
function aitTs(s) {
  s = String(s || '').trim().replace(',', '.');
  const p = s.split(':').map(Number);
  if (p.some((n) => isNaN(n))) return -1;
  if (p.length === 3) return Math.round((p[0] * 3600 + p[1] * 60 + p[2]) * 1000);
  if (p.length === 2) return Math.round((p[0] * 60 + p[1]) * 1000);
  return -1;
}
const aitClean = (t) => String(t || '').replace(/\{[^}]*\}/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\\N|\\n/gi, ' ').replace(/\s+/g, ' ').trim();

// ---- Silnik „Google — karta Tłumacza” (jak skrypt Tampermonkey 2.9) ----
// Cały plik idzie paczkami ≤4500 znaków (podział po pustych liniach), a wynik czyści filtr SRT.
function aitChunk(text, maxSize = 4500) {
  const chunks = [];
  let cur = '';
  for (const block of String(text || '').split(/\r?\n\s*\r?\n/)) {
    const b = block.trim();
    if (!b) continue;
    if (b.length > maxSize) { if (cur) { chunks.push(cur); cur = ''; } chunks.push(b); continue; }
    if (cur && (cur + '\n\n' + b).length > maxSize) { chunks.push(cur); cur = b; }
    else cur = cur ? cur + '\n\n' + b : b;
  }
  if (cur) chunks.push(cur);
  return chunks;
}
// Filtr SRT (ten sam co w skrypcie 2.9): naprawia czasy zepsute przez Google, odkleja numery
// napisów od tekstu („przyszłość. 104”) i składa czysty SRT z kolejną numeracją.
const SRT_TS = '(\\d{1,2})\\s*:\\s*(\\d{2})\\s*:\\s*(\\d{2})\\s*[,.]\\s*(\\d{1,3})';
const SRT_ARROW_FIX = new RegExp(SRT_TS + '\\s*(?:-+\\s*>|[–—]+\\s*>?|→|>)\\s*' + SRT_TS, 'g');
const SRT_TIME_LINE = /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/;
function srtFilter(text) {
  const fmt = (h, m, s, f) => String(h).padStart(2, '0') + ':' + m + ':' + s + ',' + String(f).padEnd(3, '0');
  let t = String(text || '').replace(/\r/g, '')
    .replace(SRT_ARROW_FIX, (_, h1, m1, s1, f1, h2, m2, s2, f2) => '\n' + fmt(h1, m1, s1, f1) + ' --> ' + fmt(h2, m2, s2, f2) + '\n')
    .replace(/[ \t]+(\d+)[ \t]*\n(?=\d{2}:\d{2}:\d{2},\d{3} --> )/g, '\n$1\n');
  const cues = [];
  let cur = null, lastNum = null;
  for (const raw of t.split('\n')) {
    const l = raw.trim();
    if (SRT_TIME_LINE.test(l)) { if (cur) cues.push(cur); cur = { time: l, text: [], num: lastNum }; lastNum = null; continue; }
    if (!l) continue;
    if (/^\d+$/.test(l)) { lastNum = +l; continue; } // sam numer = numer napisu, nie tekst
    if (cur) cur.text.push(l);
  }
  if (cur) cues.push(cur);
  const out = [];
  cues.forEach((c, k) => {
    // Usuwa tylko liczbę równą numerowi tej/następnej kwestii — „Mam 25 lat” zostaje
    const own = c.num != null ? c.num : (cues[k - 1] && cues[k - 1].num != null ? cues[k - 1].num + 1 : null);
    let txt = c.text.join('\n');
    if (own != null) {
      txt = txt.replace(/[ \t]+(\d{1,5})$/, (m, n) => (+n === own + 1 ? '' : m))
        .replace(/^(\d{1,5})[ \t]+/, (m, n) => (+n === own ? '' : m));
    }
    txt = txt.trim();
    if (txt) out.push((out.length + 1) + '\n' + c.time + '\n' + txt + '\n');
  });
  return out.join('\n');
}

// Dzieli tekst na jednostki do tłumaczenia. SRT/VTT/SBV: blok po pustych liniach, linie do
// strzałki „-->” włącznie zostają bez zmian, tłumaczony jest tylko tekst kwestii.
// Bez strzałek (TXT): każda niepusta linia to osobna kwestia.
function aitSplit(raw) {
  // Plik bez pustych linii między blokami (np. po tłumaczeniu) — wstaw je przed „numer + czas”.
  const lines = String(raw || '').replace(/\r/g, '').replace(/(?<!\n|(?:^|\n)\d+)\n(\d+\n)?(?=[^\n]*-->)/g,'\n\n$1').split('\n');
  const timed = lines.some((l) => AIT_ARROW.test(l));
  const units = []; // { head: [linie bez zmian], text: [linie do tłumaczenia] } albo { sep: '' }
  if (!timed) {
    lines.forEach((l) => units.push(l.trim() ? { head: [], text: [l] } : { sep: l }));
    return { timed, units };
  }
  let cur = null;
  const flush = () => { if (cur) { units.push(cur); cur = null; } };
  lines.forEach((l) => {
    if (!l.trim()) { flush(); units.push({ sep: l }); return; }
    if (!cur) cur = { head: [], text: [], gotArrow: false };
    if (!cur.gotArrow) { cur.head.push(l); if (AIT_ARROW.test(l)) cur.gotArrow = true; }
    else cur.text.push(l);
  });
  flush();
  // Blok bez strzałki (np. nagłówek WEBVTT) — w całości bez zmian.
  units.forEach((u) => { if (u.sep === undefined && !u.gotArrow) { u.head = u.head.concat(u.text); u.text = []; } });
  return { timed, units };
}
function aitJoin(units) {
  return units.map((u) => (u.sep !== undefined ? u.sep : u.head.concat(u.text).join('\n'))).join('\n');
}
// Kwestie dla lektora — format { startMs, endMs, text } jak parseSubsFile w popup.js.
function aitCues(raw) {
  const { timed, units } = aitSplit(raw);
  const cues = [];
  if (timed) {
    units.forEach((u) => {
      if (u.sep !== undefined || !u.text.length) return;
      const m = u.head.map((l) => l.match(AIT_ARROW)).find(Boolean);
      if (!m) return;
      const startMs = aitTs(m[1]), endMs = aitTs(m[2]);
      const t = aitClean(u.text.join(' '));
      if (startMs >= 0 && endMs > startMs && t) cues.push({ startMs, endMs, text: t });
    });
  } else {
    let t = 0;
    units.forEach((u) => {
      if (u.sep !== undefined) return;
      const l = aitClean(u.text.join(' '));
      if (l) { cues.push({ startMs: t, endMs: t + 3000, text: l }); t += 3000; }
    });
  }
  cues.sort((a, b) => a.startMs - b.startMs);
  return cues;
}
async function aitReadFile(file) {
  const buf = await file.arrayBuffer();
  let raw = new TextDecoder('utf-8').decode(buf);
  if (raw.includes('�')) {
    // Polskie napisy bywają w CP1250 — gdy UTF-8 daje krzaki, próbujemy tej strony kodowej.
    try { raw = new TextDecoder('windows-1250').decode(buf); } catch (e) { /* ignore */ }
  }
  return raw.replace(/^﻿/, '');
}
async function aitMemSave(pairs, engine) {
  if (!pairs.length) return;
  try {
    const r = await chrome.storage.local.get([AI_MEM_KEY, 'pamiecTlumaczenOn']);
    if (r.pamiecTlumaczenOn === false) return;   // [AGENT-EXP] 2026-11-26: przełącznik 💾 Pamięć tłumaczeń
    const mem = (r && r[AI_MEM_KEY] && typeof r[AI_MEM_KEY] === 'object') ? r[AI_MEM_KEY] : {};
    const now = Date.now();
    pairs.forEach(([src, pl]) => { if (src && pl) mem[aitHash(src)] = { src: String(src).slice(0, 2000), pl: String(pl).slice(0, 2000), engine, ts: now }; });
    const keys = Object.keys(mem);
    if (keys.length > AI_MEM_MAX) {
      keys.sort((a, b) => (mem[a].ts || 0) - (mem[b].ts || 0));
      for (let i = 0; i < keys.length - AI_MEM_MAX; i++) delete mem[keys[i]];
    }
    await chrome.storage.local.set({ [AI_MEM_KEY]: mem });
  } catch (e) { /* quota — tłumaczenie i tak jest w polu wyniku */ }
}
async function aitStatusText() {
  const isAvail = (s) => /\bavailable\b/i.test(s) && !/unavailable/i.test(s);
  let t, p;
  try {
    t = (typeof Translator !== 'undefined' && Translator.availability)
      ? String(await Translator.availability({ sourceLanguage: 'en', targetLanguage: 'pl' }))
      : 'brak API (Chrome 138+)';
  } catch (e) { t = 'błąd: ' + ((e && e.message) || e); }
  try {
    p = (typeof LanguageModel !== 'undefined' && LanguageModel.availability)
      ? String(await LanguageModel.availability())
      : 'brak API';
  } catch (e) { p = 'błąd: ' + ((e && e.message) || e); }
  const ready = isAvail(t) || isAvail(p) || /downloadable|downloading/i.test(t + p);
  return 'Translator: ' + t + ' · Prompt AI: ' + p + (ready ? '' : ' — wymagany Chrome 138+ i model z chrome://components.');
}

function buildSubTranslator() {
  const s = section('🤖 AI Subtitle Translator', 'Wgraj plik z napisami, ustaw prompt i przetłumacz wbudowanym AI Chrome. Numery i czasy kwestii zostają bez zmian. Wynik pobierzesz jako .srt albo wczytasz wprost do lektora.', true);
  s.id = 'ait';
  const rowEl = (lblB, lblS, ...kids) => {
    const r = el('div', { class: 'row' });
    const l = el('div', { class: 'lbl' });
    l.appendChild(el('b', null, lblB)); l.appendChild(el('span', null, lblS));
    r.appendChild(l); kids.forEach((k) => r.appendChild(k));
    s.appendChild(r);
    return r;
  };

  const file = el('input', { type: 'file', accept: '.srt,.vtt,.sbv,.txt', style: 'display:none;' });
  const fileBtn = el('button', { class: 'btn' }, '📂 Wybierz plik');
  const fileName = el('span', { class: 'val', style: 'min-width:0;text-align:left;font-weight:400;color:var(--muted);' }, 'brak pliku');
  rowEl('Plik z napisami', '.srt / .vtt / .sbv / .txt (UTF-8 lub CP1250)', fileName, fileBtn, file).style.borderTop = 'none';

  const lang = el('select');
  AIT_LANGS.forEach(([v, t]) => lang.appendChild(el('option', { value: v }, t)));
  rowEl('Język napisów', 'Tłumaczenie zawsze na polski', lang);

  const engine = el('select');
  [['translator', 'Translator Chrome — szybki, offline'], ['prompt', 'Prompt AI (Gemini Nano) — z Twoim promptem'], ['gtab', 'Google — karta Tłumacza (jak skrypt 2.9, z filtrem numerów)']]
    .forEach(([v, t]) => engine.appendChild(el('option', { value: v }, t)));
  rowEl('Silnik', 'Translator ignoruje prompt; Prompt AI wolniejszy, ale lepiej trzyma kontekst', engine);

  const checkBtn = el('button', { class: 'btn' }, '🔍 Sprawdź model');
  const checkSt = el('span', { class: 'val', style: 'min-width:0;text-align:left;font-weight:400;' }, 'nie sprawdzono');
  rowEl('Model wbudowany', 'Translator / Prompt API z chrome://components', checkSt, checkBtn);

  s.appendChild(el('b', { style: 'font-size:13px;display:block;margin-top:10px;' }, 'Własny prompt / instrukcja'));
  const prompt = el('textarea', { spellcheck: 'false', style: 'min-height:60px;margin-top:6px;' });
  s.appendChild(prompt);
  s.appendChild(el('b', { style: 'font-size:13px;display:block;margin-top:10px;' }, 'Zawartość / wynik'));
  const content = el('textarea', { spellcheck: 'false', placeholder: 'Tutaj pojawią się wczytane napisy lub wynik tłumaczenia…', style: 'min-height:220px;margin-top:6px;' });
  s.appendChild(content);

  const btns = el('div', { class: 'btns' });
  const goBtn = el('button', { class: 'btn primary' }, '🤖 Tłumacz');
  const stopBtn = el('button', { class: 'btn', style: 'display:none;' }, '⏹ Stop');
  const dlBtn = el('button', { class: 'btn' }, '⬇ Pobierz .srt');
  const lektorBtn = el('button', { class: 'btn' }, '🔊 Wczytaj do lektora');
  [goBtn, stopBtn, dlBtn, lektorBtn].forEach((b) => btns.appendChild(b));
  s.appendChild(btns);
  const st = el('div', { class: 'note' }, '—');
  s.appendChild(st);

  let srcName = 'napisy.srt';
  let running = null; // { abort: AbortController, stop: bool }
  const say = (t) => { st.textContent = t; };

  chrome.storage.local.get([AIT_PROMPT_KEY, 'aitEngine', 'aitLang'], (d) => {
    prompt.value = (d && typeof d[AIT_PROMPT_KEY] === 'string' && d[AIT_PROMPT_KEY].trim()) ? d[AIT_PROMPT_KEY] : AIT_PROMPT_DEF;
    if (d && d.aitEngine) engine.value = d.aitEngine;
    if (d && d.aitLang) lang.value = d.aitLang;
    if (engine.selectedIndex < 0) engine.selectedIndex = 0;
    if (lang.selectedIndex < 0) lang.selectedIndex = 0;
  });
  let pt = null;
  prompt.addEventListener('input', () => { clearTimeout(pt); pt = setTimeout(() => save({ [AIT_PROMPT_KEY]: prompt.value }), 500); });
  engine.addEventListener('change', () => save({ aitEngine: engine.value }));
  lang.addEventListener('change', () => save({ aitLang: lang.value }));

  fileBtn.addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0]; if (!f) return;
    try {
      content.value = await aitReadFile(f);
      srcName = f.name;
      fileName.textContent = f.name;
      const n = aitSplit(content.value).units.filter((u) => u.text && u.text.length).length;
      say('📂 Wczytano „' + f.name + '” — ' + n + ' kwestii. Kliknij „Tłumacz”.');
    } catch (e) { say('❌ Błąd czytania pliku: ' + ((e && e.message) || e)); }
    file.value = '';
  });

  checkBtn.addEventListener('click', async () => {
    checkSt.textContent = 'sprawdzam…';
    checkSt.textContent = await aitStatusText();
  });

  async function detectLang(sample) {
    if (lang.value !== 'auto') return lang.value;
    try {
      if (typeof LanguageDetector !== 'undefined' && LanguageDetector.create) {
        const det = await LanguageDetector.create();
        try {
          const r = await det.detect(sample.slice(0, 2000));
          const top = r && r[0] && r[0].detectedLanguage;
          if (top && top !== 'und' && top !== 'pl') return top.split('-')[0];
        } finally { try { det.destroy(); } catch (e) {} }
      }
    } catch (e) { /* brak detektora — zostaje angielski */ }
    return 'en';
  }
  const monitor = (label) => (m) => {
    try { m.addEventListener('downloadprogress', (e) => say('⏬ Pobieram model ' + label + ': ' + Math.round((e.loaded || 0) * 100) + '%')); } catch (e) {}
  };
  // Zwraca { translate(text, signal), destroy() } dla wybranego silnika.
  async function makeEngine(kind, srcLang) {
    if (kind === 'prompt') {
      if (typeof LanguageModel === 'undefined' || !LanguageModel.create) throw new Error('Brak Prompt API (LanguageModel) — Chrome 138+ z Gemini Nano.');
      const sys = (prompt.value.trim() || AIT_PROMPT_DEF) + '\nOdpowiadaj wyłącznie tłumaczeniem podanej kwestii — bez numerów, czasów, cudzysłowów i komentarzy. Zachowaj podział na linie.';
      const opts = { initialPrompts: [{ role: 'system', content: sys }], monitor: monitor('Gemini Nano') };
      let base;
      try { base = await LanguageModel.create(Object.assign({ expectedInputs: [{ type: 'text', languages: [srcLang, 'pl'] }], expectedOutputs: [{ type: 'text', languages: ['pl'] }] }, opts)); }
      catch (e) { base = await LanguageModel.create(opts); }
      return {
        async translate(text, signal) {
          // Każda kwestia w klonie sesji bazowej — kontekst nie rośnie przy długich plikach.
          const sess = base.clone ? await base.clone({ signal }) : base;
          try { return String(await sess.prompt(text, { signal }) || '').trim(); }
          finally { if (sess !== base) { try { sess.destroy(); } catch (e) {} } }
        },
        destroy() { try { base.destroy(); } catch (e) {} }
      };
    }
    if (typeof Translator === 'undefined' || !Translator.create) throw new Error('Brak Translator API — wymagany Chrome 138+.');
    const tr = await Translator.create({ sourceLanguage: srcLang, targetLanguage: 'pl', monitor: monitor('tłumacza') });
    return {
      async translate(text, signal) { return String(await tr.translate(text, { signal }) || ''); },
      destroy() { try { tr.destroy(); } catch (e) {} }
    };
  }

  goBtn.addEventListener('click', async () => {
    if (running) return;
    const raw = content.value;
    if (!raw.trim()) { say('Najpierw wgraj plik z napisami lub wpisz tekst!'); return; }
    if (engine.value === 'gtab') { await runGtab(raw); return; }
    const { units } = aitSplit(raw);
    const todo = units.filter((u) => u.text && u.text.length);
    if (!todo.length) { say('Nie znaleziono kwestii do tłumaczenia.'); return; }
    running = { abort: new AbortController(), stop: false };
    goBtn.disabled = true; stopBtn.style.display = '';
    let eng = null, done = 0, errors = 0;
    const memPairs = [];
    try {
      const srcLang = await detectLang(todo.slice(0, 40).map((u) => u.text.join(' ')).join('\n'));
      say('⏳ Uruchamiam silnik (' + engine.value + ', ' + srcLang + ' → pl)…');
      eng = await makeEngine(engine.value, srcLang);
      for (const u of todo) {
        if (running.stop) break;
        const src = u.text.join('\n');
        try {
          // [AGENT-EXP] 2026-10-15: najpierw słownik fraz (assets/phrase_dict.js) — idiomy, które Translator Chrome bierze
          // dosłownie; trafienia nie idą do pamięci tłumaczeń (słownik i tak jest pierwszy).
          const phrase = (globalThis.__LektorPhrase && globalThis.__LektorPhrase.lookup(src, srcLang)) || '';
          const pl = phrase || await eng.translate(src, running.abort.signal);
          if (pl) { u.text = pl.split('\n'); if (!phrase) memPairs.push([aitClean(src), aitClean(pl)]); }
        } catch (e) {
          if (running.stop) break;
          errors++;
        }
        done++;
        if (done % 5 === 0 || done === todo.length) {
          content.value = aitJoin(units);
          say('⏳ Tłumaczę… ' + done + ' / ' + todo.length + ' kwestii' + (errors ? ' (błędy: ' + errors + ')' : ''));
        }
      }
      content.value = aitJoin(units);
      say((running.stop ? '⏹ Zatrzymano po ' : '✅ Gotowe: ') + done + ' / ' + todo.length + ' kwestii' + (errors ? ' (pominięte z błędem: ' + errors + ')' : '') + '. Możesz pobrać .srt albo wczytać do lektora.');
    } catch (e) {
      console.error(e);
      say('❌ Błąd tłumaczenia: ' + ((e && e.message) || e));
    } finally {
      if (eng) eng.destroy(); // sesja zamknięta — GPU wraca do spoczynku
      aitMemSave(memPairs, engine.value === 'prompt' ? 'ait-prompt' : 'ait-translator');
      running = null;
      goBtn.disabled = false; stopBtn.style.display = 'none';
    }
  });
  // Google w przypiętej karcie: paczka po paczce przez service worker, na końcu filtr SRT.
  async function runGtab(raw) {
    const chunks = aitChunk(raw, 4500);
    if (!chunks.length) { say('Nie znaleziono tekstu do tłumaczenia.'); return; }
    const src = lang.value === 'auto' ? 'auto' : (lang.value === 'zh' ? 'zh-CN' : lang.value);
    running = { abort: new AbortController(), stop: false };
    goBtn.disabled = true; stopBtn.style.display = '';
    let out = '', done = 0;
    try {
      for (const ch of chunks) {
        if (running.stop) break;
        say('⏳ Google: paczka ' + (done + 1) + ' / ' + chunks.length + '…');
        const r = await chrome.runtime.sendMessage({ action: 'EXT_TR_GTAB_TEXT', src, text: ch });
        if (!r || !r.ok) throw new Error((r && r.error) || 'brak odpowiedzi z karty Google');
        out += r.text + '\n\n';
        done++;
      }
      const srt = AIT_ARROW.test(raw) && !/^﻿?WEBVTT/.test(raw.trim());
      if (out) content.value = srt ? srtFilter(out) : out.trim();
      say((running.stop ? '⏹ Zatrzymano po ' : '✅ Gotowe: ') + done + ' / ' + chunks.length + ' paczek' + (srt ? ' (filtr numerów i czasów zastosowany)' : '') + '. Możesz pobrać .srt albo wczytać do lektora.');
    } catch (e) {
      console.error(e);
      if (out) content.value = AIT_ARROW.test(raw) ? srtFilter(out) : out.trim();
      say('❌ Błąd po ' + done + ' / ' + chunks.length + ' paczkach: ' + ((e && e.message) || e) + (out ? ' — w polu jest wynik częściowy.' : ''));
    } finally {
      running = null;
      goBtn.disabled = false; stopBtn.style.display = 'none';
    }
  }
  stopBtn.addEventListener('click', () => {
    if (!running) return;
    running.stop = true;
    try { running.abort.abort(); } catch (e) {}
  });

  const outName = () => srcName.replace(/\.[^.]+$/, '') + '.pl.srt';
  dlBtn.addEventListener('click', () => {
    if (!content.value.trim()) { say('Brak treści do pobrania.'); return; }
    const blob = new Blob([content.value], { type: 'text/plain;charset=utf-8' });
    const a = el('a'); a.href = URL.createObjectURL(blob);
    a.download = outName();
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  lektorBtn.addEventListener('click', () => {
    const cues = aitCues(content.value);
    if (!cues.length) { say('Brak kwestii do wczytania (potrzebne napisy z czasami lub tekst linia po linii).'); return; }
    // [AGENT-EXP] 2026-10-17: plik dla ostatnio używanej karty ze stroną (tam, gdzie jest film)
    chrome.tabs.query({}, (tabs) => {
    const web = (tabs || []).filter((t) => /^https?:/.test(t.url || '')).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    chrome.storage.local.set({ fileSubs: { name: outName(), cues, loadedAt: Date.now(), tabId: web ? web.id : null, page: web ? web.url : '' } }, () => {
      if (chrome.runtime.lastError) { say('❌ ' + chrome.runtime.lastError.message); return; }
      say('🔊 Wczytano do lektora: ' + cues.length + ' kwestii („' + outName() + '”)' + (web ? ' — karta: ' + (web.title || web.url) : '') + '. Odtwórz film — lektor czyta wg czasów z pliku.');
      setStatus('✅ Napisy wczytane do lektora', 'ok');
    });
    });
  });
}

// ---------------- Pamięć tłumaczeń ----------------
// Klucz aiTranslationMemory w chrome.storage.local — { hash -> {src, pl, engine, ts} }.
// Bez TTL: siedzi aż użytkownik sam skasuje. Limit 5000 wpisów (LRU) — ochrona przed limitem ~10 MB.
// ---------------- Pamięć napisów (90 dni) ----------------
// Całe napisy odcinków + pojedyncze tłumaczenia sieciowe w IndexedDB service workera (subs_cache.js).
// [AGENT-EXP] 2026-11-26: przełącznik WŁ./WYŁ. pamięci (klucz w chrome.storage.local, domyślnie WŁ.)
function memToggle(s, key, text) {
  const lab = el('label', { style: 'display:flex;gap:8px;align-items:center;font-size:14px;margin:6px 0;' });
  const cb = el('input', { type: 'checkbox' });
  cb.checked = true;
  chrome.storage.local.get([key], (d) => { cb.checked = !(d && d[key] === false); });
  cb.addEventListener('change', () => chrome.storage.local.set({ [key]: cb.checked }, () => setStatus(cb.checked ? '✅ ' + text + ': włączone' : '⏸ ' + text + ': wyłączone', 'ok')));
  lab.appendChild(cb); lab.appendChild(document.createTextNode(' Włącz — ' + text));
  s.appendChild(lab);
}
function buildSubsMemory() {
  const s = section('🧠 Pamięć napisów (90 dni)', 'Przetłumaczone napisy filmów i odcinków (YouTube, iQIYI, WeTV, Viki, Bilibili) oraz każde zdanie przetłumaczone przez sieć. Po powrocie do filmu lektor bierze je z pamięci — bez pobierania i tłumaczenia. Wpis kasuje się sam po 90 dniach od ostatniego użycia.', true);
  memToggle(s, 'pamiecNapisowOn', 'zapamiętuj napisy');
  const info = el('div', { class: 'note' }, 'Ładuję…');
  s.appendChild(info);
  const btns = el('div', { class: 'btns' });
  const refresh = el('button', { class: 'btn' }, '🔄 Odśwież');
  const clr = el('button', { class: 'btn' }, '🗑 Wyczyść pamięć napisów');
  btns.appendChild(refresh); btns.appendChild(clr);
  s.appendChild(btns);
  const load = () => {
    chrome.runtime.sendMessage({ action: 'PAMIEC_STATS' }, (r) => {
      void chrome.runtime.lastError;
      info.textContent = r && r.ok
        ? 'Filmów/odcinków: ' + r.stats.videos + ' · zapamiętanych zdań: ' + r.stats.texts + ' · automatyczne kasowanie po ' + r.stats.days + ' dniach od ostatniego użycia.'
        : 'Nie udało się odczytać pamięci (przeładuj rozszerzenie).';
    });
  };
  refresh.addEventListener('click', load);
  clr.addEventListener('click', () => {
    if (!confirm('Usunąć wszystkie zapamiętane napisy i tłumaczenia? Przy następnym oglądaniu lektor pobierze i przetłumaczy je od nowa.')) return;
    chrome.runtime.sendMessage({ action: 'PAMIEC_CLEAR' }, (r) => {
      void chrome.runtime.lastError;
      setStatus(r && r.ok ? '🗑 Wyczyszczono pamięć napisów' : '❌ Nie udało się wyczyścić pamięci', r && r.ok ? 'ok' : 'err');
      load();
    });
  });
  load();
}

function buildAiMemory() {
  const s = section('💾 Pamięć tłumaczeń', 'Teksty przetłumaczone przez AI Subtitle Translator i tłumaczenie sieciowe — zapisane na stałe, kasujesz kiedy chcesz.', true);
  memToggle(s, 'pamiecTlumaczenOn', 'zapamiętuj tłumaczenia');
  const search = el('input', { type: 'text', placeholder: 'Szukaj w zapisanych (PL lub oryginał)…', style: 'width:100%;box-sizing:border-box;margin-top:6px;' });
  s.appendChild(search);
  const list = el('div', { id: 'aiMemList' });
  s.appendChild(list);
  const info = el('div', { class: 'note', id: 'aiMemInfo' }, 'Ładuję…');
  s.appendChild(info);
  const btns = el('div', { class: 'btns' });
  const exp = el('button', { class: 'btn' }, '📤 Eksportuj pamięć (JSON)');
  const clr = el('button', { class: 'btn' }, '🗑 Wyczyść wszystko');
  btns.appendChild(exp); btns.appendChild(clr);
  s.appendChild(btns);

  let mem = {};
  const render = (filter) => {
    list.textContent = '';
    const q = String(filter || '').toLowerCase();
    const keys = Object.keys(mem).sort((a, b) => (mem[b].ts || 0) - (mem[a].ts || 0));
    let shown = 0;
    keys.forEach((h) => {
      const e = mem[h] || {};
      const hay = (String(e.src || '') + ' ' + String(e.pl || '')).toLowerCase();
      if (q && hay.indexOf(q) < 0) return;
      if (shown >= 200) return;
      shown++;
      const c = el('div', { class: 'chip' });
      const b = el('b', null, String(e.pl || '').slice(0, 160));
      const small = el('span', { style: 'color:var(--muted);' }, ' ← ' + String(e.src || '').slice(0, 160));
      const x = el('span', { class: 'x', title: 'Usuń ten wpis' }, '✕');
      x.addEventListener('click', () => {
        delete mem[h];
        chrome.storage.local.set({ [AI_MEM_KEY]: mem }, () => { render(search.value); refreshInfo(); setStatus('🗑 Usunięto wpis', 'ok'); });
      });
      c.appendChild(b); c.appendChild(small); c.appendChild(x);
      list.appendChild(c);
    });
    if (!shown) list.appendChild(el('div', { class: 'note' }, q ? 'Brak wyników dla tego zapytania.' : 'Pusto — przetłumacz napisy w AI Subtitle Translator powyżej, a teksty zapiszą się tutaj.'));
  };
  const refreshInfo = () => {
    const n = Object.keys(mem).length;
    const bytes = JSON.stringify(mem).length;
    info.textContent = 'Wpisów: ' + n + ' / ' + AI_MEM_MAX + ' · ~' + (bytes / 1024).toFixed(1) + ' kB. Bez limitu czasu — kasujesz ręcznie.';
  };
  let searchT = null;
  search.addEventListener('input', () => { clearTimeout(searchT); searchT = setTimeout(() => render(search.value), 200); });
  exp.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(mem, null, 2)], { type: 'application/json' });
    const a = el('a'); a.href = URL.createObjectURL(blob);
    a.download = 'lektor-ai-pamiec.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  clr.addEventListener('click', () => {
    if (!Object.keys(mem).length) return;
    if (!confirm('Skasować WSZYSTKIE zapisane tłumaczenia AI (' + Object.keys(mem).length + ')?')) return;
    mem = {};
    chrome.storage.local.set({ [AI_MEM_KEY]: mem }, () => { render(''); search.value = ''; refreshInfo(); setStatus('🗑 Wyczyszczono pamięć AI', 'ok'); });
  });
  chrome.storage.local.get([AI_MEM_KEY], (d) => {
    mem = (d && d[AI_MEM_KEY] && typeof d[AI_MEM_KEY] === 'object') ? d[AI_MEM_KEY] : {};
    render(''); refreshInfo();
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch[AI_MEM_KEY]) {
      mem = (ch[AI_MEM_KEY].newValue && typeof ch[AI_MEM_KEY].newValue === 'object') ? ch[AI_MEM_KEY].newValue : {};
      render(search.value); refreshInfo();
    }
  });
}

// ---------------- Eksport / import ----------------
function buildExport() {
  const s = section('💾 Ustawienia — eksport / import', 'Plik JSON ze wszystkimi ustawieniami rozszerzenia (bez modeli głosów).', true);
  const btns = el('div', { class: 'btns' });
  const ex = el('button', { class: 'btn primary' }, '📤 Eksportuj do pliku');
  const im = el('button', { class: 'btn' }, '📥 Importuj z pliku');
  const file = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none;' });
  ex.addEventListener('click', () => {
    chrome.storage.local.get(null, (all) => {
      const data = {};
      Object.keys(all || {}).forEach((k) => { if (!EXPORT_SKIP(k)) data[k] = all[k]; });
      const blob = new Blob([JSON.stringify({ lektorExport: 1, version: chrome.runtime.getManifest().version, data }, null, 2)], { type: 'application/json' });
      const d = new Date(), p = (n) => String(n).padStart(2, '0');
      const a = el('a'); a.href = URL.createObjectURL(blob);
      a.download = 'lektor-ustawienia_' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      setStatus('📤 Wyeksportowano', 'ok');
    });
  });
  im.addEventListener('click', () => file.click());
  file.addEventListener('change', () => {
    const f = file.files && file.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const j = JSON.parse(String(rd.result || '{}'));
        if (!j || j.lektorExport !== 1 || !j.data || typeof j.data !== 'object') { setStatus('❌ To nie jest plik eksportu Lektora', 'err'); return; }
        const data = {};
        Object.keys(j.data).forEach((k) => { if (!EXPORT_SKIP(k)) data[k] = j.data[k]; });
        chrome.storage.local.set(data, () => { setStatus('✅ Zaimportowano ' + Object.keys(data).length + ' ustawień', 'ok'); setTimeout(() => location.reload(), 800); });
      } catch (e) { setStatus('❌ Błąd importu: ' + e.message, 'err'); }
    };
    rd.readAsText(f);
    file.value = '';
  });
  btns.appendChild(ex); btns.appendChild(im); btns.appendChild(file);
  s.appendChild(btns);
}

// ---------------- [VOX] Silnik mowy: test, restart, stan Supertonic ----------------
// Wzór: buildEngineTools / refreshEngine ze strony ustawień VoxNemesis.
let engineLive = null;
// [FIX 2026-11-02] silnik i sprzęt czytane ze storage (pola wyboru są tylko w popupie)
const engineState = { engine: 'matcha', backend: 'cpu' };
const ENGINE_NAMES = { matcha: 'Matcha-TTS-PL 🌐', sherpa: 'Sherpa / Piper', browser: 'Głos przeglądarki', supertonic: 'Supertonic 3',
  server: 'Serwer lokalny — własny adres', xtts: 'XTTS v2 (serwer :8000)', audio8: 'Audio8 ONNX (serwer :9300)', f5: 'Lektor Marek F5-TTS (serwer :9400)',
  pocket: 'Pocket-TTS-PL (serwer :9200)', omnivoice: 'OmniVoice (serwer :9100)', kokoro: 'Kokoro (serwer :9500)' };
function syncEngineRows() {
  chrome.storage.local.get(['ttsEngine', 'engineBackend'], (r) => {
    engineState.engine = (r && r.ttsEngine) || 'matcha';
    engineState.backend = (r && r.engineBackend) || 'cpu';
    refreshEngine();
  });
}
function describeSupertonic(r) {
  const want = { cpu: 'CPU', igpu: 'GPU zintegrowana', gpu: 'GPU dedykowana' }[engineState.backend] || 'CPU';
  if (!r || !r.running || !r.loaded) {
    return { cls: '', txt: 'Supertonic: ' + want + ' · silnik uruchomi się przy pierwszej kwestii (albo kliknij ▶ Test lektora).'
      + (r && r.running && r.isolated === false ? '\n⚠ Brak izolacji COOP/COEP — CPU liczy na 1 wątku.' : '') };
  }
  const d = r.download || {};
  if (d.phase === 'error' || (r.lastError && !r.slotsReady)) return { cls: 'err', txt: '⛔ Supertonic: ' + (d.error || r.lastError) };
  if (d.phase === 'download' || d.phase === 'check') {
    return { cls: 'warn', txt: '⬇ Pobieram model Supertonic 3 z Hugging Face: ' + (d.done || 0) + '/' + (d.total || 6) + ' plików' + (d.file ? ' (' + d.file + ')' : '') + ' — tylko za pierwszym razem.' };
  }
  if (!r.slotsReady) return { cls: 'warn', txt: r.starting ? '⏳ Uruchamiam silnik Supertonic (' + want + ')…' : 'Supertonic: ' + want + ' · czeka na pierwszą kwestię.' };
  let txt = r.provider === 'webgpu'
    ? '✓ Supertonic na GPU (WebGPU)' + (r.gpuName ? ' · karta: ' + r.gpuName : '')
    : '✓ Supertonic na CPU · ' + r.slotsReady + '/' + r.slotsMax + ' worker(y) × ' + r.threads + ' wątki' + (r.isolated ? '' : ' (brak izolacji — 1 wątek)');
  txt += ' · głos ' + String(r.voice || '').replace('Supertonic ', '') + ' · jakość ' + r.steps;
  if (r.queued) txt += ' · w kolejce: ' + r.queued;
  if (r.gpuFellBack && r.gpuError) txt += '\n⚠ GPU niedostępne, liczy CPU: ' + r.gpuError;
  else if (r.backend === 'gpu' && r.provider === 'webgpu' && r.gpuName && !/nvidia/i.test(r.gpuName)) {
    txt += '\n🛈 Wybrano „GPU dedykowana”, a Chrome dał inną kartę. Masz NVIDIA? Kliknij „📄 NVIDIA na stałe — instrukcja”.';
  }
  return { cls: r.gpuFellBack ? 'warn' : '', txt };
}
function refreshEngine() {
  if (!engineLive) return;
  const eng = engineState.engine;
  if (eng !== 'supertonic') {
    engineLive.className = 'live';
    engineLive.textContent = 'Aktywny silnik: ' + (ENGINE_NAMES[eng] || eng) + ' (zmiana: popup → „🗣 Silnik mowy”).';
    return;
  }
  try {
    chrome.runtime.sendMessage({ action: 'SUPERTONIC_STATUS' }, (r) => {
      void chrome.runtime.lastError;
      const d = describeSupertonic(r);
      engineLive.className = 'live' + (d.cls ? ' ' + d.cls : '');
      engineLive.textContent = d.txt;
    });
  } catch (e) { /* ignore */ }
}
function buildEngineTools() {
  const s = $('engineSec');
  if (!s) return;
  const btns = el('div', { class: 'btns' });
  const test = el('button', { class: 'btn primary' }, '▶ Test lektora');
  const restart = el('button', { class: 'btn' }, '⟳ Restart silnika Supertonic');
  const nvidia = el('button', { class: 'btn' }, '📄 NVIDIA na stałe — instrukcja');
  btns.appendChild(test); btns.appendChild(restart); btns.appendChild(nvidia);
  s.appendChild(btns);
  engineLive = el('div', { class: 'live' }, '…');
  s.appendChild(engineLive);
  test.addEventListener('click', () => {
    test.disabled = true;
    engineLive.className = 'live warn';
    engineLive.textContent = '⏳ Uruchamiam silnik… (Supertonic za pierwszym razem pobiera model — to może potrwać)';
    const done = (txt, cls) => { test.disabled = false; engineLive.className = 'live' + (cls ? ' ' + cls : ''); engineLive.textContent = txt; setTimeout(refreshEngine, 2500); };
    chrome.runtime.sendMessage({ action: 'INIT_TTS' }, (r1) => {
      void chrome.runtime.lastError;
      if (!r1 || r1.status === 'error' || r1.error) { done('⛔ ' + ((r1 && r1.error) || 'brak odpowiedzi silnika'), 'err'); return; }
      chrome.runtime.sendMessage({ action: 'TTS_PLAY', id: 'test_' + Date.now(), text: 'To jest test lektora.', durationMs: 0 }, (r2) => {
        void chrome.runtime.lastError;
        if (!r2 || r2.status === 'error' || r2.error) done('⛔ ' + ((r2 && r2.error) || 'brak odpowiedzi'), 'err');
        else done('✓ Test wysłany — jeśli słyszysz „To jest test lektora”, silnik działa.');
      });
    });
  });
  restart.addEventListener('click', () => {
    restart.disabled = true;
    engineLive.className = 'live warn';
    engineLive.textContent = '⟳ Restartuję silnik Supertonic…';
    chrome.runtime.sendMessage({ action: 'SUPERTONIC_RESTART' }, (r) => {
      void chrome.runtime.lastError;
      restart.disabled = false;
      if (!r || !r.ok) { engineLive.className = 'live err'; engineLive.textContent = '⛔ Restart nieudany: ' + ((r && r.error) || 'brak odpowiedzi'); }
      refreshEngine();
    });
  });
  nvidia.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('supertonic/GPU-NVIDIA-instrukcja.txt') }));
  setInterval(() => { if (!document.hidden) refreshEngine(); }, 2000);
}

// [AGENT-EXP] 2026-10-26: 🧩 Układ popupu — moduły (karty popupu) w kolumnach zakładek: przeciąganie ⠿, ↑ ↓,
// widoczność (zawsze / tylko na stronach / poza stronami / schowany), zwinięty na start, zakładka na start.
// Spis modułów i zapis: src/popup/layout_shared.js (MLLayout); popup widzi zmiany od razu (storage.onChanged).
const LAY_VIS = [['always', 'Zawsze'], ['only', 'Tylko na stronach…'], ['except', 'Poza stronami…'], ['never', 'Nigdy (schowany)']];
let layModel = null;
const layOpen = new Set();   // moduły z rozwiniętymi szczegółami (zostają rozwinięte po przerysowaniu)
let layDragId = '';

function layCommit(rerender) {
  layModel = MLLayout.save(layModel, () => {
    if (chrome.runtime.lastError) setStatus('❌ ' + chrome.runtime.lastError.message, 'err');
    else setStatus('✅ Zapisano', 'ok');
  });
  if (rerender !== false) layRender();
}
function layBadges(box, id) {
  box.textContent = '';
  const v = layModel.vis[id] || 'always';
  if (v === 'never') box.appendChild(el('span', { class: 'lay-b off' }, 'schowany'));
  if (v === 'only' || v === 'except') {
    const b = el('span', { class: 'lay-b site', title: layModel.sites[id] || '' });
    b.appendChild(el('span', null, v === 'only' ? '🌐 tylko' : '🌐 poza'));
    box.appendChild(b);
  }
  if (layModel.fold[id]) box.appendChild(el('span', { class: 'lay-b fold' }, 'zwinięty'));
}
function layChip(id, tabId, list) {
  const m = MLLayout.mod(id);
  const chip = el('div', { class: 'lay-chip' });
  chip.dataset.id = id;
  const v = layModel.vis[id] || 'always';
  if (v === 'never') chip.classList.add('off');

  const top = el('div', { class: 'lay-top', draggable: 'true' });   // przeciąga się za pasek, nie za pola w szczegółach
  top.appendChild(el('span', { class: 'lay-grip', title: 'Przeciągnij, aby przestawić' }, '⠿'));
  top.appendChild(el('span', { class: 'lay-name' }, m.name));
  const badges = el('span', { class: 'lay-badges' });
  layBadges(badges, id);
  top.appendChild(badges);
  const more = el('button', { class: 'lay-more', type: 'button', title: 'Gdzie i kiedy się pokazuje', 'aria-expanded': layOpen.has(id) ? 'true' : 'false' }, layOpen.has(id) ? '▴' : '▾');
  top.appendChild(more);
  chip.appendChild(top);

  const det = el('div', { class: 'lay-det' });
  det.hidden = !layOpen.has(id);
  const r1 = el('label', { class: 'lay-f' });
  r1.appendChild(el('span', null, 'Pokazuj'));
  const visSel = el('select');
  LAY_VIS.forEach(([val, txt]) => visSel.appendChild(el('option', { value: val }, txt)));
  visSel.value = v;
  r1.appendChild(visSel);
  det.appendChild(r1);
  const sites = el('input', { type: 'text', class: 'lay-sites', placeholder: 'np. youtube.com, netflix.com', spellcheck: 'false' });
  sites.value = layModel.sites[id] || '';
  sites.hidden = !(v === 'only' || v === 'except');
  det.appendChild(sites);
  const sitesHint = el('div', { class: 'lay-hint' }, 'Domeny po przecinku lub spacji — subdomeny też pasują (youtube.com = m.youtube.com).');
  sitesHint.hidden = sites.hidden;
  det.appendChild(sitesHint);
  if (!m.noFold) {
    const r2 = el('label', { class: 'lay-f check' });
    const fold = el('input', { type: 'checkbox' });
    fold.checked = !!layModel.fold[id];
    r2.appendChild(fold);
    r2.appendChild(el('span', null, 'Zwinięty (sam tytuł — rozwijasz kliknięciem)'));
    det.appendChild(r2);
    fold.addEventListener('change', () => { if (fold.checked) layModel.fold[id] = true; else delete layModel.fold[id]; layCommit(); });
  }
  const r3 = el('div', { class: 'lay-f' });
  r3.appendChild(el('span', null, 'Zakładka'));
  const tabSel = el('select');
  MLLayout.TABS.forEach((t) => tabSel.appendChild(el('option', { value: t.id }, t.name)));
  tabSel.value = tabId;
  r3.appendChild(tabSel);
  det.appendChild(r3);
  const r4 = el('div', { class: 'lay-move' });
  const i = list.indexOf(id);
  const up = el('button', { class: 'btn lay-ic', type: 'button' }, '↑ W górę');
  const down = el('button', { class: 'btn lay-ic', type: 'button' }, '↓ W dół');
  up.disabled = i <= 0;
  down.disabled = i >= list.length - 1;
  r4.appendChild(up);
  r4.appendChild(down);
  det.appendChild(r4);
  chip.appendChild(det);

  more.addEventListener('click', () => {
    if (layOpen.has(id)) layOpen.delete(id); else layOpen.add(id);
    det.hidden = !layOpen.has(id);
    more.setAttribute('aria-expanded', det.hidden ? 'false' : 'true');
    more.textContent = det.hidden ? '▾' : '▴';
  });
  visSel.addEventListener('change', () => {
    if (visSel.value === 'always') delete layModel.vis[id]; else layModel.vis[id] = visSel.value;
    layCommit();
    if (visSel.value === 'only' || visSel.value === 'except') {
      const again = document.querySelector('.lay-chip[data-id="' + id + '"] .lay-sites');
      if (again && !again.value) again.focus();
    }
  });
  let sitesTimer = 0;
  sites.addEventListener('input', () => {   // zapis bez przerysowania — kursor zostaje w polu
    if (sites.value.trim()) layModel.sites[id] = sites.value; else delete layModel.sites[id];
    clearTimeout(sitesTimer);
    sitesTimer = setTimeout(() => { layCommit(false); layBadges(badges, id); }, 500);
  });
  sites.addEventListener('change', () => { clearTimeout(sitesTimer); layCommit(false); layBadges(badges, id); });
  tabSel.addEventListener('change', () => { MLLayout.move(layModel, id, tabSel.value); layCommit(); });
  up.addEventListener('click', () => { MLLayout.shift(layModel, id, -1); layCommit(); });
  down.addEventListener('click', () => { MLLayout.shift(layModel, id, 1); layCommit(); });

  top.addEventListener('dragstart', (e) => {
    layDragId = id;
    chip.classList.add('dragging');
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); e.dataTransfer.setDragImage(chip, 12, 12); } catch (x) { /* ignore */ }
  });
  top.addEventListener('dragend', () => { layDragId = ''; chip.classList.remove('dragging'); layClearMarks(); });
  return chip;
}
function layClearMarks() {
  document.querySelectorAll('#layBoard .drop-before, #layBoard .drop-after, #layBoard .drop-end').forEach((e) => e.classList.remove('drop-before', 'drop-after', 'drop-end'));
}
function layDropAt(e, listEl) {
  const chips = Array.from(listEl.querySelectorAll(':scope > .lay-chip')).filter((c) => c.dataset.id !== layDragId);
  for (const c of chips) {
    const r = c.getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) return { chip: c, before: c.dataset.id };
  }
  return { chip: null, before: '' };
}
function layRender() {
  const board = $('layBoard');
  if (!board || !layModel) return;
  board.textContent = '';
  MLLayout.TABS.forEach((t) => {
    const list = layModel.tabs[t.id];
    const col = el('div', { class: 'lay-col' });
    const head = el('div', { class: 'lay-col-h' });
    head.appendChild(el('b', null, t.name));
    const shown = list.filter((id) => (layModel.vis[id] || 'always') !== 'never').length;
    head.appendChild(el('span', { class: 'lay-count', title: 'widoczne / wszystkie' }, shown + ' / ' + list.length));
    col.appendChild(head);
    const listEl = el('div', { class: 'lay-list' });
    listEl.dataset.tab = t.id;
    list.forEach((id) => listEl.appendChild(layChip(id, t.id, list)));
    if (!list.length) listEl.appendChild(el('div', { class: 'lay-empty' }, t.id === 'moje' ? 'Twoja zakładka — przeciągnij tu moduły. Pusta jest schowana.' : 'Pusta — w popupie schowana.'));
    listEl.addEventListener('dragover', (e) => {
      if (!layDragId) return;
      e.preventDefault();
      layClearMarks();
      const d = layDropAt(e, listEl);
      if (d.chip) d.chip.classList.add('drop-before'); else listEl.classList.add('drop-end');
    });
    listEl.addEventListener('dragleave', (e) => { if (!listEl.contains(e.relatedTarget)) layClearMarks(); });
    listEl.addEventListener('drop', (e) => {
      if (!layDragId) return;
      e.preventDefault();
      const d = layDropAt(e, listEl);
      MLLayout.move(layModel, layDragId, t.id, d.before);
      layDragId = '';
      layClearMarks();
      layCommit();
    });
    col.appendChild(listEl);
    board.appendChild(col);
  });
  const start = $('layStart');
  if (start) start.value = layModel.start;
}
function buildPopupLayout() {
  if (!self.MLLayout) return;
  const s = section('🧩 Układ popupu', 'Każda karta popupu to moduł. Przeciągnij ⠿ do innej zakładki albo w inne miejsce, a w ▾ ustaw, kiedy ma się pokazywać (np. tylko na YouTube) i czy startuje zwinięty. Pusta zakładka znika z popupu. To samo (bez reguł stron) zrobisz w popupie przyciskiem ✏️.', true, 'uklad');
  const bar = el('div', { class: 'row first lay-toolbar' });
  const lbl = el('div', { class: 'lbl' });
  lbl.appendChild(el('b', null, 'Zakładka na start'));
  lbl.appendChild(el('span', null, 'Która zakładka otwiera się po kliknięciu ikony lektora'));
  bar.appendChild(lbl);
  const start = el('select', { id: 'layStart' });
  start.appendChild(el('option', { value: 'last' }, 'Ostatnio otwarta'));
  MLLayout.TABS.forEach((t) => start.appendChild(el('option', { value: t.id }, t.name)));
  bar.appendChild(start);
  const reset = el('button', { class: 'btn danger', type: 'button' }, '↺ Przywróć domyślny układ');
  bar.appendChild(reset);
  s.appendChild(bar);
  s.appendChild(el('div', { class: 'lay-board', id: 'layBoard' }));
  s.appendChild(el('div', { class: 'note' }, 'Zmiany widać w popupie od razu (otwórz go jeszcze raz). Układ jest też w eksporcie ustawień.'));
  start.addEventListener('change', () => { layModel.start = start.value; layCommit(false); });
  reset.addEventListener('click', () => {
    const q = 'Przywrócić domyślny układ popupu? Wszystkie moduły wrócą na swoje miejsca, reguły stron i zwinięcia znikną.';
    if (!confirm(self.MLi18n ? MLi18n.t(q) : q)) return;
    layModel = MLLayout.defaults();
    layOpen.clear();
    layCommit();
  });
  layModel = MLLayout.readMirror() || MLLayout.defaults();
  layRender();
  MLLayout.load((l) => { if (!MLLayout.same(l, layModel)) { layModel = l; layRender(); } });
  chrome.storage.onChanged.addListener((ch, area) => {   // zmiana z popupu (✏️) — przerysuj, chyba że ktoś pisze w polu
    if (area !== 'local' || !ch[MLLayout.KEY]) return;
    const l = MLLayout.normalize(ch[MLLayout.KEY].newValue);
    if (MLLayout.same(l, layModel)) return;
    layModel = l;
    MLLayout.writeMirror(l);
    const a = document.activeElement;
    if (a && a.closest && a.closest('#layBoard') && a.tagName === 'INPUT') return;
    layRender();
  });
}

function build() {
  SCHEMA.forEach((group) => {
    const s = section(group.sec, group.sub, false, group.id);
    group.items.forEach((def) => s.appendChild(buildRow(def)));
  });
  buildEngineTools();   // [VOX]
  buildPopupLayout();   // [AGENT-EXP] 2026-10-26
  buildSubTranslator();
  buildSubsMemory();
  buildAiMemory();
  buildDomainLists();
  buildKreator();
  buildLowcaSites();
  buildExport();
}

build();
if (location.hash === '#ait') { const a = $('ait'); if (a) a.scrollIntoView(); }
if (location.hash === '#uklad') { const a = $('uklad'); if (a) a.scrollIntoView(); }
if (location.hash === '#domeny') { const a = $('domeny'); if (a) a.scrollIntoView(); }
// [FIX 2026-11-22] z popupu (karta „🧪 Kreator napisów”): #kreator=domena — przewiń i podstaw domenę karty
const kreatorHashHost = /^#kreator(?:=(.*))?$/.test(location.hash) ? decodeURIComponent(RegExp.$1 || '') : null;
if (kreatorHashHost !== null) { const a = $('kreator'); if (a) a.scrollIntoView(); if (kreatorHashHost && $('kHost')) $('kHost').value = kreatorHashHost; }   // [FIX 2026-11-02] z popupu „✏️ Edytuj listy”   // [AGENT-EXP] 2026-10-26: z popupu „⚙ Więcej”
chrome.storage.local.get(null, (all) => {
  all = all || {};
  applyValues(all);
  syncEngineRows();   // [VOX]
  fields.__domainWl.ta.value = String(all.domainWhitelist || '');
  fields.__domainBl.ta.value = String(all.domainBlacklist || '');
  customSources = (all.customSources && typeof all.customSources === 'object') ? all.customSources : {};
  customSourcesOn = (all.customSourcesOn && typeof all.customSourcesOn === 'object') ? all.customSourcesOn : {};
  findTargetTab().then((tab) => { if (tab && !$('kHost').value) $('kHost').value = tabHost(tab); renderKreatorList(); renderKreatorAll(); });
});

// wynik „Wskaż myszką" z karty
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.action === 'KREATOR_PICK_CANCEL') { $('kResult').textContent = '⏹ Wskazywanie anulowane.'; return; }
  if (!msg || msg.action !== 'KREATOR_PICKED') return;
  $('kSel').value = msg.selector || '';
  if (msg.host) $('kHost').value = msg.host;
  kPickTop = msg.top || '';
  $('kResult').textContent = '🎯 Wskazano: ' + (msg.selector || '?') + (msg.count ? '  (pasuje: ' + msg.count + ')' : '')
    + (msg.text ? '\n„' + msg.text + '”' : '') + '\nSprawdź tekst i kliknij „💾 Dodaj”.';
  renderKreatorList();
});

// [VOX] 2026-10-20: zmiany z popupu (silnik, sprzęt, suwaki…) widać tu od razu, bez przeładowania strony.
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  let touched = false;
  Object.keys(ch).forEach((k) => {
    const f = fields[k];
    if (!f || !f.def || document.activeElement === f.input) return;
    const v = ch[k].newValue === undefined ? f.def.def : ch[k].newValue;
    if (f.def.t === 'bool') f.input.checked = !!v;
    else if (k !== 'extTrEngine') {
      f.input.value = String(v);
      if (f.valSpan) f.valSpan.textContent = f.def.fmt ? f.def.fmt(Number(v)) : f.input.value + (f.def.unit || '');
    }
    touched = true;
  });
  if (ch.ttsEngine || ch.engineBackend) syncEngineRows();   // [FIX 2026-11-02] pola są w popupie — stan ze storage
});
