// JS-native wrapper around the espeak-ng wasm module (dist/wasm/espeak-ng.mjs),
// mirroring piper1-gpl's own espeak binding, src/piper/espeakbridge.c, name for
// name: initialize(distDir) / setVoice(voice) / getPhonemes(text). No wasm
// pointers, _malloc, or setValue/getValue appear in this module's exports —
// getPhonemes runs the espeak_TextToPhonemesWithTerminator clause loop
// internally, the same role the C loop plays inside py_get_phonemes.
//
// Language data is loaded on demand: scripts/bundle-data.mjs groups voices
// that share a dictionary (e.g. es_ES/es_MX/es_AR all use es_dict) into
// size-capped "bucket" files under dist/data/. setVoice() fetches/reads a
// voice's bucket the first time it's needed (subsequent calls for a voice in
// an already-loaded bucket are free) and writes its contents into the wasm
// module's virtual filesystem before calling espeak_SetVoiceByName. This is
// why setVoice() is async, unlike espeakbridge.c's synchronous set_voice.
//
// Usage:
//   import { initialize, setVoice, getPhonemes } from "espeak-phonemizer";
//   await initialize();               // Node: resolves this package's own dist/ automatically
//   await setVoice("en-us");          // fetches en-us's bucket on first use
//   getPhonemes("Hello world.");      // -> [{ phonemes, terminator, isSentenceEnd }]
//   // Outside Node (browser/bundler), pass an explicit base path/URL:
//   //   await initialize("https://your-cdn.example/espeak-phonemizer/dist");

import createEspeakModule from '../dist/wasm/espeak-ng.mjs';
import {
  espeakCHARS_AUTO,
  espeakPHONEMES_IPA,
  AUDIO_OUTPUT_SYNCHRONOUS,
  decodeTerminator,
} from './constants.mjs';

// The virtual filesystem path bucket files get written under (matches the
// path passed to espeak_Initialize below).
const ESPEAK_DATA_VIRTUAL_PATH = '/espeak-ng-data';

const isNode = typeof globalThis.process?.versions?.node === 'string' && globalThis.process?.type !== 'renderer';

let Module = null;
let manifest = null;
let dataDir = null; // base dir/URL for dist/data/ (bucket files + espeak_index.json)
let espeak_SetVoiceByName = null;
let espeak_TextToPhonemesWithTerminator = null;
const loadedBuckets = new Set();

// Fetches (browser) or reads (Node) one asset, returning its bytes.
async function readAsset(url) {
  if (isNode) {
    const { readFile } = await import('node:fs/promises');
    return new Uint8Array(await readFile(url));
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

function virtualDirname(virtualPath) {
  const idx = virtualPath.lastIndexOf('/');
  return idx <= 0 ? '/' : virtualPath.slice(0, idx);
}

// Fetches/reads one bucket blob and writes each of its contained files into
// MEMFS at their original relative path under ESPEAK_DATA_VIRTUAL_PATH.
async function loadBucket(bucket) {
  const bytes = await readAsset(`${dataDir}/${bucket.path}`);
  for (const [relPath, { offset, length }] of Object.entries(bucket.files)) {
    const virtualPath = `${ESPEAK_DATA_VIRTUAL_PATH}/${relPath}`;
    Module.FS.mkdirTree(virtualDirname(virtualPath));
    Module.FS.writeFile(virtualPath, bytes.subarray(offset, offset + length));
  }
}

// In Node, defaults to this package's own installed `dist/` directory, so
// `initialize()` works with no arguments after `npm install`. There's no
// sensible default outside Node (no "install location" to resolve relative
// to) — browser/bundler callers must always pass an explicit distDir.
async function defaultDistDir() {
  if (!isNode) {
    throw new Error(
      'initialize() requires an explicit distDir argument outside Node.js ' +
        "(e.g. a URL to wherever this package's dist/ directory is served from)."
    );
  }
  const { fileURLToPath } = await import('node:url');
  return fileURLToPath(new URL('../dist', import.meta.url));
}

async function fetchManifest(dir) {
  const bytes = await readAsset(`${dir}/espeak_index.json`);   // [AGENT-EXP] 2026-10-24: było manifest.json — drugi „manifest.json” w paczce blokował wczytanie na Androidzie
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Browser-only fallback used when the caller-supplied distDir's data/ isn't
// reachable — e.g. the host app's bundler copied dist/wasm (picked up via
// the static import above) but not dist/data (only ever fetched dynamically
// by relative path, so bundlers commonly miss it). Reads this package's own
// name/version from its package.json (resolved relative to this module, so
// it works whether this file itself was loaded from node_modules or a CDN)
// and points at that exact release's dist/data on the jsDelivr npm CDN, so
// the fetched language data always matches the wasm build already loaded.
async function npmDataDirFallback() {
  const pkgBytes = await readAsset(new URL('../package.json', import.meta.url));
  const { name, version } = JSON.parse(new TextDecoder().decode(pkgBytes));
  return `https://cdn.jsdelivr.net/npm/${name}@${version}/dist/data`;
}

/**
 * Loads the wasm module and the always-needed shared "core" language data
 * (phontab/phondata/phonindex/intonations), then calls espeak_Initialize.
 * Mirrors espeakbridge.c's py_initialize(data_dir), adapted for async wasm
 * loading and on-demand per-voice data (see setVoice).
 *
 * Safe to call more than once — subsequent calls are no-ops once loaded.
 *
 * @param {string} [distDir] base path/URL for this package's `dist/`
 *   directory (containing both `wasm/` and `data/`), e.g. "./dist" or an
 *   absolute URL. Defaults to this package's own installed location in
 *   Node.js; required when called outside Node. In a browser, if `data/`
 *   isn't reachable under this path (or the default), falls back to
 *   fetching this exact release's data bundle from the npm CDN.
 */
export async function initialize(distDir) {
  if (Module) return;

  const base = (distDir ?? (await defaultDistDir())).replace(/\/+$/, '');
  dataDir = `${base}/data`;

  try {
    manifest = await fetchManifest(dataDir);
  } catch (err) {
    if (isNode) throw err;
    // Browser fallback: the configured/default distDir doesn't serve
    // dist/data (a common gap — bundlers pick up dist/wasm automatically via
    // the static import above, but miss data/ since it's only ever fetched
    // dynamically by relative path) — pull this exact release's data bundle
    // from the npm CDN instead. The wasm binary itself still loads from
    // `base` below, unaffected.
    dataDir = await npmDataDirFallback();
    manifest = await fetchManifest(dataDir);
  }

  const loadedModule = await createEspeakModule({
    locateFile: (filename) => `${base}/wasm/${filename}`,
  });

  Module = loadedModule;
  await loadBucket(manifest.core);

  const init = Module.cwrap('espeak_Initialize', 'number', ['number', 'number', 'string', 'number']);
  const rc = init(AUDIO_OUTPUT_SYNCHRONOUS, 0, ESPEAK_DATA_VIRTUAL_PATH, 0);
  if (rc < 0) {
    throw new Error('Failed to initialize espeak-ng');
  }

  espeak_SetVoiceByName = Module.cwrap('espeak_SetVoiceByName', 'number', ['string']);
  espeak_TextToPhonemesWithTerminator = Module.cwrap(
    'espeak_TextToPhonemesWithTerminator',
    'string',
    ['number', 'number', 'number', 'number']
  );
}

function requireInitialized() {
  if (!Module) {
    throw new Error('espeak-ng is not initialized — call initialize(distDir) first.');
  }
}

/**
 * Mirrors espeakbridge.c's py_set_voice(voice), except async: sets the
 * active espeak-ng voice by name (e.g. "en-us", "es-419", "pt-br"), fetching
 * and mounting its bucket's language data on first use (a no-op on
 * subsequent calls for a voice in an already-loaded bucket). Throws/rejects
 * if the voice is unknown or wasn't bundled into this build.
 * @param {string} voice
 */
export async function setVoice(voice) {
  requireInitialized();

  const bucketName = manifest.voiceToBucket[voice];
  if (!bucketName) {
    throw new Error(`Unknown or unbundled voice: ${voice}`);
  }
  if (!loadedBuckets.has(bucketName)) {
    await loadBucket(manifest.buckets[bucketName]);
    loadedBuckets.add(bucketName);
  }

  if (espeak_SetVoiceByName(voice) !== 0 /* EE_OK */) {
    throw new Error(`Failed to set voice: ${voice}`);
  }
}

/**
 * Mirrors espeakbridge.c's py_get_phonemes(text): runs the
 * `while (text != NULL) { espeak_TextToPhonemesWithTerminator(...) }` loop
 * internally (using espeakCHARS_AUTO / espeakPHONEMES_IPA, matching both
 * piper-phonemize and espeakbridge.c) and returns one entry per clause. No
 * wasm pointers reach the caller — all heap allocation is freed before this
 * function returns. Synchronous — no I/O happens here.
 *
 * @param {string} text
 * @returns {Array<{ phonemes: string, terminator: string, isSentenceEnd: boolean }>}
 */
export function getPhonemes(text) {
  requireInitialized();

  const bytes = Module.lengthBytesUTF8(text) + 1;
  const textPtr = Module._malloc(bytes);
  Module.stringToUTF8(text, textPtr, bytes);

  const textPtrCell = Module._malloc(4); // holds the in/out `const void **textptr`
  Module.setValue(textPtrCell, textPtr, 'i32');
  const terminatorCell = Module._malloc(4); // holds the out `int *terminator`

  const results = [];
  try {
    while (Module.getValue(textPtrCell, 'i32') !== 0) {
      const phonemes = espeak_TextToPhonemesWithTerminator(
        textPtrCell,
        espeakCHARS_AUTO,
        espeakPHONEMES_IPA,
        terminatorCell
      );
      const terminator = Module.getValue(terminatorCell, 'i32');
      results.push({ phonemes: phonemes ?? '', ...decodeTerminator(terminator) });
    }
  } finally {
    Module._free(textPtr);
    Module._free(textPtrCell);
    Module._free(terminatorCell);
  }
  return results;
}
