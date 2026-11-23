// subs_db.js — szukanie napisów w zewnętrznych bazach (popup → „🌐 Szukaj w bazach napisów”).
// Dostawcy:
//   • OpenSubtitles.org — stare REST API, bez klucza (X-User-Agent: TemporaryUserAgent), pliki .gz
//   • OpenSubtitles.com — REST API v1, wymaga darmowego klucza (Ustawienia → osApiKey)
//   • SubDL             — REST API v1, wymaga darmowego klucza (Ustawienia → subdlApiKey), pliki .zip
// Inne bazy z listy Bazarr odpadają: Podnapisi i Subscene już nie działają, Napiprojekt szuka po hashu
// pliku wideo (przy streamingu go nie ma), Napisy24 wymaga logowania, Addic7ed/Subf2m/Titlovi blokują automaty.
// Zwracany tekst (UTF-8, MicroDVD przeliczony na SRT wg FPS) parsuje popup tym samym parserem co pliki z dysku.

const ORG_UA = 'TemporaryUserAgent';
const APP_UA = 'LektorMultilanguage v3.0.6';
const LANG3 = { pl: 'pol', en: 'eng', de: 'ger', fr: 'fre', es: 'spa', it: 'ita', ru: 'rus', uk: 'ukr', cs: 'cze', sk: 'slo', pt: 'por', ja: 'jpn', ko: 'kor', zh: 'chi', tr: 'tur', nl: 'dut', sv: 'swe', hu: 'hun', ro: 'rum' };
const SUB_EXT = /\.(srt|vtt|sub|ass|ssa|smi|sami|sbv|txt|lrc|dfxp|ttml)$/i;
// Reklamy wklejane przez bazy w pierwsze kwestie
const AD_LINE = /osdb\.link|opensubtitles|subdl\.com|napiprojekt|watch online movies|do you want subtitles for any video|become vip member|advertise your product|napisy zostały specjalnie dopasowane|naciśnij play\. napisy|tryray\.app|www\.[a-z0-9-]+\.(?:com|org|net|link|pl|info|tv)\b/i;

function withTimeout(ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, ms);
    return { signal: ctrl.signal, done: () => clearTimeout(t) };
}
async function getJson(url, init) {
    const to = withTimeout(20000);
    try {
        const r = await fetch(url, Object.assign({ credentials: 'omit', signal: to.signal }, init || {}));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
    } finally { to.done(); }
}
async function getBytes(url, init) {
    const to = withTimeout(30000);
    try {
        const r = await fetch(url, Object.assign({ credentials: 'omit', signal: to.signal }, init || {}));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return new Uint8Array(await r.arrayBuffer());
    } finally { to.done(); }
}
async function inflate(bytes, format) {
    const ds = new DecompressionStream(format);
    const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
}
function isGzip(b) { return b.length > 2 && b[0] === 0x1f && b[1] === 0x8b; }
function isZip(b) { return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04; }

// Minimalny czytnik ZIP (katalog centralny; metoda 0 = bez kompresji, 8 = deflate).
async function unzipFirstSub(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('uszkodzone archiwum ZIP');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = [];
    for (let k = 0; k < count && p + 46 <= bytes.length; k++) {
        if (dv.getUint32(p, true) !== 0x02014b50) break;
        const method = dv.getUint16(p + 10, true);
        const csize = dv.getUint32(p + 20, true);
        const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
        const loc = dv.getUint32(p + 42, true);
        const name = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nlen));
        entries.push({ name, method, csize, loc });
        p += 46 + nlen + elen + clen;
    }
    // Najpierw SRT, potem inne formaty napisów
    const subs = entries.filter((e) => SUB_EXT.test(e.name) && !/\/$/.test(e.name));
    subs.sort((a, b) => Number(!/\.srt$/i.test(a.name)) - Number(!/\.srt$/i.test(b.name)));
    const e = subs[0];
    if (!e) throw new Error('w archiwum nie ma pliku napisów');
    const lnlen = dv.getUint16(e.loc + 26, true), lelen = dv.getUint16(e.loc + 28, true);
    const start = e.loc + 30 + lnlen + lelen;
    const data = bytes.subarray(start, start + e.csize);
    if (e.method === 0) return { name: e.name, bytes: data };
    if (e.method === 8) return { name: e.name, bytes: await inflate(data, 'deflate-raw') };
    throw new Error('nieobsługiwana kompresja ZIP (' + e.method + ')');
}

function decodeText(bytes, enc) {
    const label = String(enc || '').trim().toLowerCase();
    if (label && label !== 'ascii' && label !== 'utf-8' && label !== 'utf8') {
        try { return new TextDecoder(label).decode(bytes); } catch (e) { /* nieznana etykieta */ }
    }
    let t = new TextDecoder('utf-8').decode(bytes);
    if (t.includes('�')) { try { t = new TextDecoder('windows-1250').decode(bytes); } catch (e) {} }
    return t;
}
function pad(n, w) { return String(n).padStart(w, '0'); }
function msToSrt(ms) {
    ms = Math.max(0, Math.round(ms));
    return pad(Math.floor(ms / 3600000), 2) + ':' + pad(Math.floor(ms / 60000) % 60, 2) + ':' + pad(Math.floor(ms / 1000) % 60, 2) + ',' + pad(ms % 1000, 3);
}
// MicroDVD {klatka}{klatka}tekst → SRT wg FPS z bazy (parser popupu zakłada 23.976).
function microDvdToSrt(text, fps) {
    const lines = text.replace(/\r/g, '').split('\n');
    const out = [];
    let f = Number(fps) > 0 ? Number(fps) : 23.976;
    for (const line of lines) {
        const m = /^\{(\d+)\}\{(\d*)\}(.*)$/.exec(line.trim());
        if (!m) continue;
        // Znacznik FPS na początku pliku, np. {1}{1}23.976 albo {1}{4}25.000
        if (+m[1] <= 1 && !out.length && /^\s*\d{2}(?:[.,]\d+)?\s*$/.test(m[3])) { f = Number(m[3].replace(',', '.')) || f; continue; }
        const s = (+m[1] / f) * 1000, e = m[2] ? (+m[2] / f) * 1000 : s + 3000;
        const t = m[3].replace(/\{[^}]*\}/g, '').split('|').join('\n').trim();
        if (t && e > s) out.push((out.length + 1) + '\n' + msToSrt(s) + ' --> ' + msToSrt(e) + '\n' + t + '\n');
    }
    return out.length ? out.join('\n') : text;
}
function stripAds(text) {
    return text.split(/\r?\n/).filter((l) => !AD_LINE.test(l)).join('\n');
}

// ================= OpenSubtitles.org (bez klucza) =================
async function searchOrg(q) {
    // Kilka języków w jednym zapytaniu daje HTTP 400 — osobne zapytanie na język.
    const langs = q.langs.map((l) => LANG3[l]).filter(Boolean);
    const res = await Promise.allSettled((langs.length ? langs : ['']).map((l) => searchOrgLang(q, l)));
    const ok = res.filter((r) => r.status === 'fulfilled');
    if (!ok.length) throw res[0].reason;
    return [].concat(...ok.map((r) => r.value));
}
async function searchOrgLang(q, lang3) {
    // Parametry w ścieżce MUSZĄ być alfabetycznie: episode, query, season, sublanguageid
    let path = '';
    if (q.episode) path += '/episode-' + q.episode;
    path += '/query-' + encodeURIComponent(q.query.toLowerCase());
    if (q.season) path += '/season-' + q.season;
    if (lang3) path += '/sublanguageid-' + lang3;
    const j = await getJson('https://rest.opensubtitles.org/search' + path, { headers: { 'X-User-Agent': ORG_UA } });
    if (!Array.isArray(j)) return [];
    return j.filter((x) => x && x.SubDownloadLink && /^(srt|sub|ssa|ass|vtt|txt|smi)$/i.test(x.SubFormat || '')).map((x) => ({
        provider: 'org',
        providerName: 'OpenSubtitles.org',
        title: (x.MovieName || '') + (x.MovieYear ? ' (' + x.MovieYear + ')' : '') + (+x.SeriesSeason ? ' S' + pad(x.SeriesSeason, 2) + 'E' + pad(x.SeriesEpisode, 2) : ''),
        release: x.SubFileName || x.MovieReleaseName || '',
        lang: String(x.ISO639 || '').toLowerCase(),
        downloads: +x.SubDownloadsCnt || 0,
        hi: x.SubHearingImpaired === '1',
        dl: x.SubDownloadLink, enc: x.SubEncoding || '', fps: +x.MovieFPS || 0, format: String(x.SubFormat || '').toLowerCase()
    }));
}
async function getOrg(it) {
    let b = await getBytes(it.dl);
    if (isGzip(b)) b = await inflate(b, 'gzip');
    let t = decodeText(b, it.enc);
    if (it.format === 'sub' || /^\s*\{\d+\}\{\d*\}/.test(t)) t = microDvdToSrt(t, it.fps);
    return t;
}

// ================= OpenSubtitles.com (klucz API) =================
function osHeaders(key, json) {
    const h = { 'Api-Key': key, 'Accept': 'application/json', 'X-User-Agent': APP_UA };
    if (json) h['Content-Type'] = 'application/json';
    return h;
}
async function searchCom(q, key) {
    // API wymaga parametrów posortowanych alfabetycznie i małymi literami (inaczej przekierowanie 301)
    const p = { languages: q.langs.join(','), query: q.query.toLowerCase() };
    if (q.season) p.season_number = String(q.season);
    if (q.episode) p.episode_number = String(q.episode);
    const qs = Object.keys(p).sort().map((k) => k + '=' + encodeURIComponent(p[k])).join('&');
    const j = await getJson('https://api.opensubtitles.com/api/v1/subtitles?' + qs, { headers: osHeaders(key) });
    const data = (j && Array.isArray(j.data)) ? j.data : [];
    return data.map((d) => {
        const a = d.attributes || {};
        const f = (a.files || [])[0];
        if (!f || !f.file_id) return null;
        const fd = a.feature_details || {};
        return {
            provider: 'com',
            providerName: 'OpenSubtitles.com',
            title: (fd.title || fd.movie_name || '') + (fd.year ? ' (' + fd.year + ')' : '') + (fd.season_number ? ' S' + pad(fd.season_number, 2) + 'E' + pad(fd.episode_number || 0, 2) : ''),
            release: a.release || f.file_name || '',
            lang: String(a.language || '').toLowerCase().slice(0, 2),
            downloads: +a.download_count || 0,
            hi: !!a.hearing_impaired,
            fileId: f.file_id
        };
    }).filter(Boolean);
}
async function getCom(it, key) {
    const j = await getJson('https://api.opensubtitles.com/api/v1/download', {
        method: 'POST', headers: osHeaders(key, true), body: JSON.stringify({ file_id: it.fileId, sub_format: 'srt' })
    });
    if (!j || !j.link) throw new Error((j && j.message) || 'OpenSubtitles.com nie dał linku (limit pobrań?)');
    return decodeText(await getBytes(j.link), 'utf-8');
}

// ================= SubDL (klucz API) =================
async function searchSubdl(q, key) {
    const p = new URLSearchParams({ api_key: key, film_name: q.query, languages: q.langs.map((l) => l.toUpperCase()).join(','), subs_per_page: '30' });
    if (q.season) { p.set('season_number', String(q.season)); p.set('type', 'tv'); }
    if (q.episode) p.set('episode_number', String(q.episode));
    const j = await getJson('https://api.subdl.com/api/v1/subtitles?' + p.toString());
    if (!j || j.status === false) throw new Error((j && (j.error || j.message)) || 'SubDL: błąd');
    const film = (j.results && j.results[0]) || {};
    return (j.subtitles || []).filter((s) => s && s.url).map((s) => ({
        provider: 'subdl',
        providerName: 'SubDL',
        title: (film.name || q.query) + (film.year ? ' (' + film.year + ')' : '') + (s.season ? ' S' + pad(s.season, 2) + (s.episode ? 'E' + pad(s.episode, 2) : '') : ''),
        release: s.release_name || s.name || '',
        lang: String(s.lang || s.language || '').toLowerCase().slice(0, 2),
        downloads: 0,
        hi: !!s.hi,
        dl: 'https://dl.subdl.com' + (s.url[0] === '/' ? '' : '/') + s.url
    }));
}
async function getSubdl(it) {
    const b = await getBytes(it.dl);
    const f = isZip(b) ? await unzipFirstSub(b) : { bytes: b, name: '' };
    let t = decodeText(f.bytes, '');
    if (/\.sub$/i.test(f.name) && /^\s*\{\d+\}\{\d*\}/.test(t)) t = microDvdToSrt(t, 0);
    return t;
}

// ================= Wspólne =================
async function subsDbKeys() {
    const r = await chrome.storage.local.get(['osApiKey', 'subdlApiKey']);
    return { os: String(r.osApiKey || '').trim(), subdl: String(r.subdlApiKey || '').trim() };
}
export async function subsDbSearch(q) {
    const query = String(q.query || '').trim();
    if (!query) return { ok: false, error: 'Wpisz tytuł' };
    const langs = (Array.isArray(q.langs) && q.langs.length ? q.langs : ['pl', 'en']).map((l) => String(l).toLowerCase());
    const qq = { query, langs, season: +q.season || 0, episode: +q.episode || 0 };
    const keys = await subsDbKeys();
    const jobs = [['OpenSubtitles.org', searchOrg(qq)]];
    if (keys.os) jobs.push(['OpenSubtitles.com', searchCom(qq, keys.os)]);
    if (keys.subdl) jobs.push(['SubDL', searchSubdl(qq, keys.subdl)]);
    const settled = await Promise.allSettled(jobs.map((j) => j[1]));
    let items = [];
    const errors = [];
    settled.forEach((s, i) => {
        if (s.status === 'fulfilled') items = items.concat(s.value);
        else errors.push(jobs[i][0] + ': ' + ((s.reason && s.reason.message) || s.reason));
    });
    // Kolejność: tytuł pasuje do zapytania, język wg listy (pl przed en), bez napisów dla niesłyszących, popularność
    const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const nq = norm(query);
    const miss = (it) => Number(!(' ' + norm(it.title) + ' ').includes(' ' + nq + ' '));
    const rank = (it) => { const i = langs.indexOf(it.lang); return i < 0 ? 99 : i; };
    items.sort((a, b) => miss(a) - miss(b) || rank(a) - rank(b) || Number(a.hi) - Number(b.hi) || b.downloads - a.downloads);
    return { ok: true, items: items.slice(0, 40), errors, providers: jobs.map((j) => j[0]) };
}
export async function subsDbGet(it) {
    if (!it || !it.provider) throw new Error('brak pozycji');
    const keys = await subsDbKeys();
    let text;
    if (it.provider === 'org') text = await getOrg(it);
    else if (it.provider === 'com') text = await getCom(it, keys.os);
    else if (it.provider === 'subdl') text = await getSubdl(it);
    else throw new Error('nieznany dostawca');
    return stripAds(String(text || '').replace(/^﻿/, ''));
}
