let tts = null;
// ===== WŁASNY GŁOS (?voice=custom) =====
// Popup zapisuje pliki modelu w IndexedDB ('lektorVoices'/'files'); tutaj je
// czytamy i wgrywamy do wirtualnego FS zamiast pobierać z paczki rozszerzenia.
const CUSTOM_VOICE = (() => {
  try { return new URL(self.location.href).searchParams.get("voice") === "custom"; }
  catch (e) { return false; }
})();

// Wiele głosów w pamięci: klucze '<id>/model.onnx' itd. Brak id lub id='default'
// = stare klucze bez prefiksu (kompatybilność z pierwszą wersją zapisu).
const CUSTOM_VOICE_ID = (() => {
  try { return new URL(self.location.href).searchParams.get("id") || ""; }
  catch (e) { return ""; }
})();
const VOICE_PREFIX = CUSTOM_VOICE_ID && CUSTOM_VOICE_ID !== "default" ? CUSTOM_VOICE_ID + "/" : "";

// Typ głosu: 'piper' (domyślny) = fonetyzacja espeak-ng-data z paczki;
// 'mms' (Meta MMS-TTS) i 'coqui'/'cantonese' = własny tokens.txt w IDB, BEZ
// espeak-ng-data (szybszy start i mniej pamięci — espeak nie jest potrzebny).
const CUSTOM_TYPE = (() => {
  try { return (new URL(self.location.href).searchParams.get("type") || "piper").toLowerCase(); }
  catch (e) { return "piper"; }
})();
const USE_ESPEAK = !CUSTOM_VOICE || CUSTOM_TYPE === "piper";

function idbVoiceGet(key) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open("lektorVoices", 1); }
    catch (e) { reject(e); return; }
    req.onerror = () => reject(req.error || new Error("IndexedDB niedostępna"));
    req.onsuccess = () => {
      const db = req.result;
      try {
        const get = db.transaction("files", "readonly").objectStore("files").get(key);
        get.onsuccess = () => resolve(get.result || null);
        get.onerror = () => reject(get.error || new Error("Odczyt IndexedDB nieudany"));
      } catch (e) { reject(e); }
    };
  });
}

async function toBytes(v) {
  if (v instanceof Blob) return new Uint8Array(await v.arrayBuffer());
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (v && v.buffer) return new Uint8Array(v.buffer.slice(0));
  return new Uint8Array(v);
}

self.Module = {
  // https://emscripten.org/docs/api_reference/module.html#Module.locateFile
  locateFile: function (path, scriptDirectory = "") {
    return scriptDirectory + path;
  },
  // https://emscripten.org/docs/api_reference/module.html#Module.locateFile
  setStatus: function (status) {
    self.postMessage({ type: "sherpa-onnx-tts-progress", status });
  },
  onRuntimeInitialized: function () {
    console.log("Model files downloaded!");
    console.log("Initializing tts ......");
    (async () => {
      try {
      if (typeof self.Module.FS_createPath !== "function" ||
          typeof self.Module.FS_createDataFile !== "function") {
        throw new Error("Runtime Sherpa nie udostępnia filesystemu WASM");
      }
      const modelDir = "vits-piper-pl_PL-meski_wg_glos-medium";
      const baseUrl = new URL("./", self.location.href);
      const readAsset = async (name) => {
        const response = await fetch(new URL(name, baseUrl));
        if (!response.ok) throw new Error(`Nie można pobrać ${name}: HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      };

      // 1) Model + tokeny + konfiguracja VITS
      // Dwie ścieżki: wbudowany głos (fetch z paczki) albo WŁASNY głos
      // (?voice=custom) — pliki zapisane wcześniej przez popup w IndexedDB.
      const putFile = (name, data) => self.Module.FS_createDataFile("/", name, data, true, true);
      if (CUSTOM_VOICE) {
        const onnx = await idbVoiceGet(VOICE_PREFIX + 'model.onnx');
        if (!onnx) throw new Error("Własny głos: brak model.onnx w pamięci rozszerzenia (wczytaj pliki w popupie)");
        const tokens = await idbVoiceGet(VOICE_PREFIX + 'tokens.txt');
        if (!tokens) throw new Error("Własny głos: brak tokens.txt w pamięci rozszerzenia");
        const meta = await idbVoiceGet(VOICE_PREFIX + 'model.onnx.json'); // opcjonalny
        // Opcjonalne pliki leksykonu/reguł (modele znakowe, np. Coqui/kantoński).
        var CUSTOM_LEXICON = await idbVoiceGet(VOICE_PREFIX + 'lexicon.txt');
        var CUSTOM_RULE_FSTS = await idbVoiceGet(VOICE_PREFIX + 'rule.fst');
        putFile('model.onnx', await toBytes(onnx));
        putFile('tokens.txt', await toBytes(tokens));
        if (meta) putFile('model.onnx.json', await toBytes(meta));
        if (CUSTOM_LEXICON) putFile('lexicon.txt', await toBytes(CUSTOM_LEXICON));
        if (CUSTOM_RULE_FSTS) putFile('rule.fst', await toBytes(CUSTOM_RULE_FSTS));
        self.postMessage({ type: "sherpa-onnx-tts-progress", status: "własny model załadowany" });
      } else {
        putFile('model.onnx', await readAsset(`${modelDir}/pl_PL-meski_wg_glos-medium.onnx`));
        putFile('tokens.txt', await readAsset(`${modelDir}/tokens.txt`));
        putFile('model.onnx.json', await readAsset(`${modelDir}/pl_PL-meski_wg_glos-medium.onnx.json`));
      }

      // 2) espeak-ng-data — wymagane do fonetyzacji Piper. Bez tych plików
      //    sherpa-onnx kończy się błędem "Errors in config" (brak
      //    /espeak-ng-data/phontab) i TTS nigdy się nie inicjalizuje.
      //    Głosy MMS mają własny tokens.txt w IDB — espeak pomijamy.
      if (USE_ESPEAK) await loadEspeakNgData(self.Module, readAsset);

      tts = createOfflineTts(self.Module, {
        offlineTtsModelConfig: {
          offlineTtsVitsModelConfig: {
            model: '/model.onnx',
            lexicon: (CUSTOM_VOICE && typeof CUSTOM_LEXICON !== 'undefined' && CUSTOM_LEXICON) ? '/lexicon.txt' : '',
            tokens: '/tokens.txt',
            dataDir: USE_ESPEAK ? '/espeak-ng-data' : '',
            noiseScale: 0.667,
            noiseScaleW: 0.8,
            lengthScale: 1.0
          },
          numThreads: 1,
          provider: 'cpu'
        },
        ruleFsts: (CUSTOM_VOICE && typeof CUSTOM_RULE_FSTS !== 'undefined' && CUSTOM_RULE_FSTS) ? '/rule.fst' : '',
        maxNumSentences: 1
      });
      self.postMessage({
        type: "sherpa-onnx-tts-ready",
        numSpeakers: tts.numSpeakers,
        custom: CUSTOM_VOICE,
      });
      } catch (e) {
      self.postMessage({
        type: "error",
        message: "TTS Initialization failed: " + getErrorMessage(e),
      });
      }
    })();
  },
};

// Lista plików espeak-ng-data (zmienne SHERPA_ESPEAK_ROOT / SHERPA_ESPEAK_FILES)
// jest w pliku sherpa-espeak-data-files.js — wgrywana przez importScripts poniżej.
importScripts("sherpa-espeak-data-files.js");
importScripts("sherpa-onnx-wasm-main-tts.js");
importScripts("sherpa-onnx-tts.js");

// Wgrywa katalog espeak-ng-data do wirtualnego systemu plików WASM pod /espeak-ng-data.
// katalogi są tworzone raz, pliki pobierane są porcjami (16 równolegle).
async function loadEspeakNgData(m, readAsset) {
  const root = SHERPA_ESPEAK_ROOT;
  m.FS_createPath("/", "espeak-ng-data", true, true);

  const dirs = new Set();
  for (const p of SHERPA_ESPEAK_FILES) {
    const i = p.lastIndexOf("/");
    if (i > 0) dirs.add(p.substring(0, i));
  }
  for (const d of dirs) m.FS_createPath("/espeak-ng-data", d, true, true);

  for (let i = 0; i < SHERPA_ESPEAK_FILES.length; i += 16) {
    await Promise.all(
      SHERPA_ESPEAK_FILES.slice(i, i + 16).map(async (p) => {
        const idx = p.lastIndexOf("/");
        const parent = idx > 0 ? "/espeak-ng-data/" + p.substring(0, idx) : "/espeak-ng-data";
        const name = idx > 0 ? p.substring(idx + 1) : p;
        m.FS_createDataFile(
          parent,
          name,
          await readAsset(`${root}/${p}`),
          true,
          true
        );
      })
    );
  }
}

function getErrorMessage(err) {
  if (err instanceof Error) {
    if (err.stack) {
      return `${err.message}\n${err.stack}`;
    }
    return err.message;
  }

  return `${err}`;
}

self.onmessage = async (e) => {
  const { type, text, sid, speed, genConfig } = e.data;
  if (type == "generate") {
    if (!tts) {
      return;
    }
    try {
      const audio = tts.generate({
        text: text,
        sid: sid || 0,
        speed: speed || 1.0,
      });
      const samples = audio.samples;
      const sampleRate = tts.sampleRate;
      self.postMessage(
        {
          type: "sherpa-onnx-tts-result",
          samples: samples,
          sampleRate: sampleRate,
        },
        [samples.buffer],
      );
    } catch (err) {
      self.postMessage({
        type: "error",
        message: "Generation failed: " + getErrorMessage(err),
      });
    }
  } else if (type == "generateWithConfig") {
    if (!tts) {
      return;
    }
    try {
      const config = Object.assign({}, genConfig || {});
      config.callback = (samples, n, progress) => {
        self.postMessage({
          type: "sherpa-onnx-tts-generation-progress",
          progress: progress,
        });
        return 1;
      };

      const audio = tts.generateWithConfig(text, config);
      const samples = audio.samples;
      const sampleRate = audio.sampleRate;
      self.postMessage(
          {
            type: "sherpa-onnx-tts-result",
            samples: samples,
            sampleRate: sampleRate,
          },
          [samples.buffer],
      );
    } catch (err) {
      self.postMessage({
        type: "error",
        message: "Generation failed: " + getErrorMessage(err),
      });
    }
  }
};