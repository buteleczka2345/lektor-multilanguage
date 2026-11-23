// [AGENT-EXP] 2026-10-26: liczby → słowa po polsku, przed czytaniem głosem znakowym (Coqui/VITS, np. Maja).
// Taki model ma w tokens.txt tylko litery i interpunkcję — cyfry po prostu pomija.
// Obsługa: liczby całkowite (też „10 000”), ułamki „3,5”/„3.5”, „-5”, „50%”, godziny „12:30”,
// daty „3.10.2026”, lata „2026 r.”/„w 2026 roku”, kwoty i miary „5 zł”, „10 km”, „2 kg”.

const JEDN = ['zero', 'jeden', 'dwa', 'trzy', 'cztery', 'pięć', 'sześć', 'siedem', 'osiem', 'dziewięć'];
const NASTKI = ['dziesięć', 'jedenaście', 'dwanaście', 'trzynaście', 'czternaście', 'piętnaście',
    'szesnaście', 'siedemnaście', 'osiemnaście', 'dziewiętnaście'];
const DZIES = ['', '', 'dwadzieścia', 'trzydzieści', 'czterdzieści', 'pięćdziesiąt', 'sześćdziesiąt',
    'siedemdziesiąt', 'osiemdziesiąt', 'dziewięćdziesiąt'];
const SETKI = ['', 'sto', 'dwieście', 'trzysta', 'czterysta', 'pięćset', 'sześćset', 'siedemset',
    'osiemset', 'dziewięćset'];
const RZEDY = [null, ['tysiąc', 'tysiące', 'tysięcy'], ['milion', 'miliony', 'milionów'],
    ['miliard', 'miliardy', 'miliardów'], ['bilion', 'biliony', 'bilionów']];

// Porządkowe w dopełniaczu (r. męski): „trzeciego”, „dwa tysiące dwudziestego szóstego”.
const P_JEDN = ['', 'pierwszego', 'drugiego', 'trzeciego', 'czwartego', 'piątego', 'szóstego',
    'siódmego', 'ósmego', 'dziewiątego'];
const P_NASTKI = ['dziesiątego', 'jedenastego', 'dwunastego', 'trzynastego', 'czternastego',
    'piętnastego', 'szesnastego', 'siedemnastego', 'osiemnastego', 'dziewiętnastego'];
const P_DZIES = ['', '', 'dwudziestego', 'trzydziestego', 'czterdziestego', 'pięćdziesiątego',
    'sześćdziesiątego', 'siedemdziesiątego', 'osiemdziesiątego', 'dziewięćdziesiątego'];
const P_SETKI = ['', 'setnego', 'dwusetnego', 'trzechsetnego', 'czterechsetnego', 'pięćsetnego',
    'sześćsetnego', 'siedemsetnego', 'osiemsetnego', 'dziewięćsetnego'];
const P_TYS = ['', 'tysięcznego', 'dwutysięcznego', 'trzytysięcznego', 'czterotysięcznego',
    'pięciotysięcznego', 'sześciotysięcznego', 'siedmiotysięcznego', 'ośmiotysięcznego',
    'dziewięciotysięcznego'];

const MIESIACE = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia',
    'września', 'października', 'listopada', 'grudnia'];

// Jednostki: [1, 2–4, 5+, ułamek]
const JEDNOSTKI = {
    'zł': ['złoty', 'złote', 'złotych', 'złotego'],
    'gr': ['grosz', 'grosze', 'groszy', 'grosza'],
    'km': ['kilometr', 'kilometry', 'kilometrów', 'kilometra'],
    'kg': ['kilogram', 'kilogramy', 'kilogramów', 'kilograma'],
    'cm': ['centymetr', 'centymetry', 'centymetrów', 'centymetra'],
    'mm': ['milimetr', 'milimetry', 'milimetrów', 'milimetra'],
    'km/h': ['kilometr na godzinę', 'kilometry na godzinę', 'kilometrów na godzinę', 'kilometra na godzinę'],
};

// 0 = „jeden tysiąc”, 1 = „dwa tysiące”, 2 = „pięć tysięcy”
function forma(n) {
    if (n === 1) return 0;
    const d = n % 10, s = n % 100;
    return (d >= 2 && d <= 4 && !(s >= 12 && s <= 14)) ? 1 : 2;
}

function trojka(n) {
    const out = [];
    const s = Math.floor(n / 100), r = n % 100;
    if (s) out.push(SETKI[s]);
    if (r >= 10 && r < 20) out.push(NASTKI[r - 10]);
    else {
        if (r >= 20) out.push(DZIES[Math.floor(r / 10)]);
        if (r % 10) out.push(JEDN[r % 10]);
    }
    return out.join(' ');
}

function cyfraPoCyfrze(cyfry) {
    return cyfry.split('').map((c) => JEDN[+c]).join(' ');
}

// Liczba całkowita (string z samych cyfr) → słowa.
export function slownie(cyfry) {
    cyfry = String(cyfry);
    if (cyfry.length > 1 && cyfry[0] === '0') return cyfraPoCyfrze(cyfry);  // „007”
    if (cyfry.length > 15) return cyfraPoCyfrze(cyfry);
    let n = Number(cyfry);
    if (n === 0) return JEDN[0];
    const grupy = [];
    for (let i = 0; n > 0; i++, n = Math.floor(n / 1000)) {
        const g = n % 1000;
        if (!g) continue;
        if (i === 0) grupy.unshift(trojka(g));
        else if (g === 1) grupy.unshift(RZEDY[i][0]);               // „tysiąc”, nie „jeden tysiąc”
        else grupy.unshift(trojka(g) + ' ' + RZEDY[i][forma(g)]);
    }
    return grupy.join(' ');
}

// Porządkowa w dopełniaczu, do 9999 (dni, lata).
export function porzadkowaDop(n) {
    n = Number(n);
    if (!(n > 0 && n < 10000)) return slownie(String(n));
    const t = Math.floor(n / 1000), s = Math.floor(n / 100) % 10, r = n % 100;
    const out = [];
    if (t && !s && !r) return P_TYS[t];
    if (t) out.push(t === 1 ? 'tysiąc' : JEDN[t] + ' ' + RZEDY[1][forma(t)]);
    if (s && !r) { out.push(P_SETKI[s]); return out.join(' '); }
    if (s) out.push(SETKI[s]);
    if (r >= 10 && r < 20) out.push(P_NASTKI[r - 10]);
    else {
        if (r >= 20) out.push(P_DZIES[Math.floor(r / 10)]);
        if (r % 10) out.push(P_JEDN[r % 10]);
    }
    return out.join(' ');
}

function ulamek(calk, frac) {
    const zera = frac.match(/^0*/)[0].length;
    const reszta = frac.slice(zera);
    const czesci = [slownie(calk), 'przecinek'];
    for (let i = 0; i < zera; i++) czesci.push(JEDN[0]);
    if (reszta) czesci.push(slownie(reszta));
    return czesci.join(' ');
}

export function liczbySlownie(text) {
    let t = String(text || '');
    if (!/\d/.test(t)) return t;

    // Daty „3.10.2026” / „03.10.2026 r.” → „trzeciego października dwa tysiące dwudziestego szóstego roku”
    t = t.replace(/(?<!\d)(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s*r\.|\s*roku)?(?!\d)/g, (m, d, mi, r) => {
        d = +d; mi = +mi;
        if (d < 1 || d > 31 || mi < 1 || mi > 12) return m;
        return porzadkowaDop(d) + ' ' + MIESIACE[mi - 1] + ' ' + porzadkowaDop(+r) + ' roku';
    });
    // Lata: „2026 r.”, „w 2026 roku”, „1999 r”
    t = t.replace(/(?<![\d,.])(\d{3,4})\s*(?:r\.|r\b|roku\b)/gu, (m, r) => porzadkowaDop(+r) + ' roku');

    // Odstępy tysięcy: „10 000” → „10000”
    t = t.replace(/(?<![\d,.])\d{1,3}(?: \d{3}(?!\d))+(?![,.]\d)/g, (m) => m.replace(/ /g, ''));

    // Godziny „12:30” → „dwanaście trzydzieści”
    t = t.replace(/(?<!\d)(\d{1,2}):(\d{2})(?!\d)/g, (m, h, mi) =>
        slownie(String(+h)) + ' ' + (mi === '00' ? 'zero zero' : (mi[0] === '0' ? 'zero ' + JEDN[+mi[1]] : slownie(mi))));

    // Liczba + jednostka (zł, km...) — odmiana jednostki przez liczbę
    t = t.replace(/(?<![\d\p{L}])(\d+)(?:[,.](\d+))?\s?(km\/h|zł|gr|km|kg|cm|mm)(?!\p{L})/gu,
        (m, c, f, j) => {
            const formy = JEDNOSTKI[j];
            if (f && j === 'zł' && f.length === 2) {   // „21,50 zł” → „dwadzieścia jeden złotych pięćdziesiąt groszy”
                const gr = JEDNOSTKI.gr;
                return slownie(c) + ' ' + formy[forma(Number(c))]
                    + (f === '00' ? '' : ' ' + slownie(String(+f)) + ' ' + gr[forma(+f)]);
            }
            if (f) return ulamek(c, f) + ' ' + formy[3];
            return slownie(c) + ' ' + formy[c.length > 15 ? 2 : forma(Number(c))];
        });

    // Ułamki „3,5” / „3.14”
    t = t.replace(/(?<![\d,.])(\d+)[,.](\d+)(?![\d]|[,.]\d)/g, (m, c, f) => ulamek(c, f));
    // Procenty
    t = t.replace(/\s?%/g, ' procent');
    // Minus: „-5” na początku albo po spacji/nawiasie (nie „COVID-19”)
    t = t.replace(/(^|[\s(])[-−–](?=\d)/g, '$1minus ');
    // Cyfry sklejone z literami: „mp3” → „mp 3”, „4K” → „4 K”
    t = t.replace(/(\p{L})(?=\d)/gu, '$1 ').replace(/(\d)(?=\p{L})/gu, '$1 ');
    // Pozostałe liczby całkowite
    t = t.replace(/\d+/g, (m) => slownie(m));
    return t.replace(/ {2,}/g, ' ');
}
