// [AGENT-EXP] 2026-10-24: kopia english.js ze Space machinekind/matcha-tts-pl-v2 (MIT), dane lokalnie.
// Browser port of voxcpm/english_detect.py: wrap English words of a Polish sentence in braces ("Po {meeting}u wyślę ci {feedback}.")
// for the mixed Polish/English phonemizer. Curated list only (the Python version also has a word-frequency fallback for
// unlisted words; a frequency table is too big for the browser). Inflected forms whose full form is a common Polish word
// (wina, legendy, deskę) are precomputed in english_data.json -> pl_inflected_block. Curated multi-word phrases are matched
// first, as whole phrases ("flash sale", "pull requesta" -> "{pull request}a"); english_data.json is written by
// `python3 voxcpm/english_detect.py --js-data english_data.json`.
let D = null;
const L = "A-Za-zÀ-ÿĄĆĘŁŃÓŚŹŻąćęłńóśźż";
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function load(j) {
  const alt = (j.phrases || []).map((ph) => ph.split(" ").map(esc).join("\\s+")).join("|") || "(?!)";
  const suf = j.suffixes.map(esc).join("|");
  return { cur: new Set(j.curated), rap: new Set(j.read_as_polish), suf: j.suffixes, loan: j.loan_stems, block: new Set(j.pl_inflected_block),
           phrase: new RegExp(`(?<![${L}'’-])(${alt})((?:'|’)?(?:${suf}))?(?![${L}'’-])`, "gi") };
}
export async function initEnglish(url = new URL("./english_data.json", import.meta.url)) {
  if (!D) {
    const j = await (await fetch(url)).json();
    D = load(j);
  }
  return D;
}
export function setEnglishData(j) { D = load(j); }
const known = (w) => { const l = w.toLowerCase(); return D.cur.has(l) && !D.rap.has(l); };
function splitWord(w) {
  if (known(w)) return [w, ""];
  const lw = w.toLowerCase();
  if (w.includes("'") || w.includes("’")) {
    const st = w.replace(/’/g, "'").split("'");
    const head = st.shift(), rest = st.join("'");
    if (known(head)) return [head, rest ? "'" + rest : ""];
  }
  if (D.block.has(lw)) return null;
  for (const k of D.suf) if (lw.endsWith(k) && w.length - k.length >= 3 && known(w.slice(0, -k.length))) return [w.slice(0, -k.length), w.slice(-k.length)];
  return null;
}
const WORD = /\{[^{}]*\}|[A-Za-zÀ-ÿĄĆĘŁŃÓŚŹŻąćęłńóśźż][A-Za-zÀ-ÿĄĆĘŁŃÓŚŹŻąćęłńóśźż'’-]*/g;
function markPhrases(text) {
  return text.split(/(\{[^{}]*\})/).map((p) => p.startsWith("{") ? p : p.replace(D.phrase, (m, ph, end) => `{${ph}}${end || ""}`)).join("");
}
export function markEnglish(text) {
  if (!D) throw new Error("initEnglish() first");
  const out = markPhrases(text).replace(WORD, (w) => { if (w.startsWith("{")) return w; const s = splitWord(w); return s ? `{${s[0]}}${s[1]}` : w; });
  return out.replace(/\}(\s+)\{/g, "$1");
}
