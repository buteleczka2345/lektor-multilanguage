# espeak-phonemizer

A lightweight WebAssembly build of [eSpeak NG](https://github.com/espeak-ng/espeak-ng) trimmed to the 53 languages and built to be used with web implementations of [piper1-gpl](https://github.com/OHF-Voice/piper1-gpl). Language data is optimized to be fetched on demand, only for the voices you actually use. Japanese, Hebrew, and Mandarin are excluded, since piper phonemizes those with OpenJTalk / a Hebrew phonemizer / pinyin instead of raw espeak IPA.

```sh
npm install espeak-phonemizer
```

## Usage

```js
import { initialize, setVoice, getPhonemes } from "espeak-phonemizer";

await initialize();      // Node: resolves this package's own data automatically
await setVoice("en-us"); // fetches en-us's dictionary on first use

const result = getPhonemes("Hello world. How are you?");
[
   { phonemes: "həlˈoʊ wˈɜːld", terminator: ".", isSentenceEnd: true },
   { phonemes: "hˈaʊ ɑːɹ juː", terminator: "?", isSentenceEnd: true },
]
```

`initialize`, `setVoice`, and `getPhonemes` mirror piper1-gpl's own Python
espeak binding, [`espeakbridge.c`](https://github.com/OHF-Voice/piper1-gpl/blob/main/src/piper/espeakbridge.c).

**Outside Node** (browser, bundler), pass an explicit base path/URL to
`initialize()` pointing at wherever this package's `dist/` directory is
served from — there's no "install location" to resolve automatically there.
If that path's `data/` folder isn't reachable (a common gap: bundlers pick up
`dist/wasm` automatically via the static import, but `dist/data` is only ever
fetched dynamically by relative path, so it's easy to forget to serve/copy
it), `initialize()` falls back to fetching this exact release's data bundle
from the npm CDN ([jsDelivr](https://www.jsdelivr.com/)) instead.

## License

GPL-3.0-only (inherited from eSpeak NG). See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
