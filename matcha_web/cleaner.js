// [AGENT-EXP] 2026-10-24: kopia cleaner.js ze Space machinekind/matcha-tts-pl-v2 (MIT). Zmiany: espeak-phonemizer
// i symbole z plików w rozszerzeniu zamiast CDN (MV3 nie ładuje kodu z sieci).
// Browser port of matcha_patch/polish_cleaners.py + polish_mixed_cleaners: Polish text normalisation, espeak-ng (WASM) IPA,
// English words in {braces} phonemized with the en-us voice, symbol ids. Must match the Python cleaners character for character.
import { initialize, setVoice, getPhonemes } from "./espeak/src/espeak.mjs";
import { SYMBOL_TO_ID } from "./symbols.js";

const PL_WORD = "0-9a-ząćęłńóśźż";
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function abbr(k, v) {
  if (k === "r." || k === "w.") return [new RegExp(`(?<=[0-9ivx])\\s?${esc(k)}`, "g"), ` ${v}`];
  const tail = k.endsWith(".") ? "" : `(?![${PL_WORD}])`;
  return [new RegExp(`(?<![${PL_WORD}])${esc(k)}${tail}`, "g"), v];
}
const ABBREV = [["np.", "na przykład"], ["tzn.", "to znaczy"], ["tj.", "to jest"], ["itd.", "i tak dalej"], ["itp.", "i tym podobne"],
  ["m.in.", "między innymi"], ["dr", "doktor"], ["prof.", "profesor"], ["inż.", "inżynier"], ["mgr", "magister"], ["ul.", "ulica"],
  ["al.", "aleja"], ["r.", "roku"], ["w.", "wieku"], ["godz.", "godzina"], ["min.", "minut"], ["św.", "święty"], ["nr", "numer"],
  ["tel.", "telefon"], ["zł", "złotych"]].map(([k, v]) => abbr(k, v));

export function normalizeText(text) {
  let t = text.toLowerCase();
  t = t.replace(/\s*(?:—|–| - )\s*/g, ", ").replace(/…/g, "...");
  t = t.replace(/[„”“"«»]/g, "");
  for (const [rx, rep] of ABBREV) t = t.replace(rx, rep);
  return t;
}

let ready = null, voice = "";
export function initPhonemizer() {
  if (!ready) ready = (async () => { await initialize(globalThis.process?.versions?.node ? undefined : new URL("./espeak/dist", import.meta.url).href); await setVoice("pl"); voice = "pl"; })();
  return ready;
}
async function useVoice(v) { if (voice !== v) { await setVoice(v); voice = v; } }

// phonemizer (python) splits on punctuation, phonemizes each chunk and glues the punctuation back
const PUNCT = /([;:,.!?]+)/;
function espeakChunks(t) {
  let out = "", prev = "";
  for (const part of t.split(PUNCT)) {
    if (!part) continue;
    if (/^[;:,.!?]+$/.test(part)) { out += (/\s$/.test(prev) && out ? " " : "") + part; prev = part; continue; }   // keep "word ?" like phonemizer
    const afterPunct = /^[;:,.!?]+$/.test(prev), glued = afterPunct && !/^\s/.test(part);   // "Co?Jak": no space, like phonemizer
    prev = part;
    const chunk = part.trim();
    if (!chunk) continue;
    const ph = getPhonemes(chunk).map(c => (c.phonemes || "").trim()).filter(Boolean).join(" ");
    if (!ph) continue;
    out += (out && !out.endsWith(" ") && !glued ? " " : "") + ph;
  }
  return out.replace(/\s+/g, " ").trim();
}
// this espeak-ng WASM build writes "iʲ" before a vowel ("znajomymiʲ albo"); the training phonemizer (espeak-ng 1.50, Linux)
// never does ("iʲ" does not occur in the training data at all) -> normalise, so the model gets what it was trained on
const fixPl = (ph) => ph.replace(/iʲ/g, "i");
async function plPhon(text) { await useVoice("pl"); const t = normalizeText(text); return t.trim() ? fixPl(espeakChunks(t)) : ""; }
async function enPhon(text) { await useVoice("en-us"); return espeakChunks(text).replace(/ʲ/g, ""); }   // same WASM quirk; en-us never has ʲ

const VOICELESS = ["p", "t", "k", "f", "s", "ʃ", "θ", "h", "tʃ", "ˈp", "ˈt", "ˈk", "ˈf", "ˈs", "ˈʃ", "ˈθ", "ˈh", "ˌp", "ˌt", "ˌk", "ˌf", "ˌs", "ˌh"];
function oneLetter(w, nextPh) {
  const vl = VOICELESS.some(p => nextPh.startsWith(p));
  return { w: vl ? "f" : "v", z: vl ? "s" : "z", i: "i", a: "a", o: "ɔ", u: "u" }[w];
}
const unstress = (ph) => { const i = ph.indexOf(" "); const head = i < 0 ? ph : ph.slice(0, i); return head.replace(/[ˈˌ]/g, "") + (i < 0 ? "" : ph.slice(i)); };

export async function textToIpa(text) {
  await initPhonemizer();
  text = text.replace(/\s+\?/g, "?");   // v2 was trained on VoxCPM2 texts with '?' glued to the word: "kuchni ?" -> "kuchni?" (a space makes wh-questions rise)
  if (!text.includes("{")) return plPhon(text);
  let out = "", pos = 0;
  for (const m of text.matchAll(/\{([^{}]+)\}/g)) {
    let pl = text.slice(pos, m.index), prep = "";
    const mm = pl.match(/(?:^|\s)([wzaiouWZAIOU])\s*$/);
    if (mm) { prep = mm[1].toLowerCase(); pl = pl.slice(0, mm.index + mm[0].indexOf(mm[1])); }   // = Python pl[:mm.start(1)]
    if (pl.trim()) {
      const glue = !/^\s/.test(pl) && out !== "";
      let ph = await plPhon(pl);
      if (glue) ph = unstress(ph);
      out += (glue ? "" : " ") + ph;
    }
    const en = await enPhon(m[1]);
    if (prep) out += " " + oneLetter(prep, en);
    const glue = m.index > 0 && !/\s/.test(text[m.index - 1]) && out !== "";
    out += (glue ? "" : " ") + en;
    pos = m.index + m[0].length;
  }
  const tail = text.slice(pos);
  if (tail.trim()) {
    const glue = !/^\s/.test(tail);
    let ph = await plPhon(tail);
    if (glue) ph = unstress(ph);
    out += (glue ? "" : " ") + ph;
  }
  await useVoice("pl");
  return out.replace(/\s+/g, " ").trim();
}

export function ipaToIds(ipa) {
  const ids = [];
  const unknown = new Set();
  for (const ch of ipa) {
    const id = SYMBOL_TO_ID[ch];
    if (id === undefined) unknown.add(ch); else ids.push(id);
  }
  const seq = new Array(ids.length * 2 + 1).fill(0);
  ids.forEach((v, i) => { seq[2 * i + 1] = v; });
  return { seq, unknown: [...unknown] };
}
