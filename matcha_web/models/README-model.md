---
language: pl
license: cc-by-sa-4.0
library_name: onnx
pipeline_tag: text-to-speech
base_model: machinekind/Matcha-TTS-PL-v2
tags: [tts, text-to-speech, polish, matcha-tts, flow-matching, hifigan, onnx, onnxruntime, cpu, edge, raspberry-pi, jetson, int8, quantized, streaming, low-latency, voxcpm2, conversational, stochastic-duration]
datasets: [machinekind/polish-synthetic-speech-voxcpm2-v2]
---

# Matcha-TTS-PL-Edge-v2 — Polish TTS for CPUs: fp32 · int8 · streaming · stochastic durations

The voices of [Matcha-TTS-PL-v2](https://huggingface.co/machinekind/Matcha-TTS-PL-v2) for Raspberry Pi / Jetson-class CPUs, in one repo:
**fp32 and pre-quantised int8** ONNX graphs, a **15× smaller vocoder**, **streaming** (first audio in ~80 ms on one Pi-class
core) and **stochastic durations** (a flow-matching duration predictor for a natural, less regular rhythm; default, the
deterministic encoder is included). One inference file (`tts.py`, onnxruntime + numpy) does whole sentences and streaming.

Voices: `male_voxcpm_2`, `female_voxcpm_2` (synthetic, designed with VoxCPM2 from a text description — not recordings or
clones of real people), trained on conversational Polish
([polish-synthetic-speech-voxcpm2-v2](https://huggingface.co/datasets/machinekind/polish-synthetic-speech-voxcpm2-v2)), with English words
read in English ("Po meetingu wyślę ci feedback").

**Family:** [Matcha-TTS-PL-v2](https://huggingface.co/machinekind/Matcha-TTS-PL-v2) · [Matcha-TTS-PL-Edge-v2](https://huggingface.co/machinekind/Matcha-TTS-PL-Edge-v2) · [dataset v2](https://huggingface.co/datasets/machinekind/polish-synthetic-speech-voxcpm2-v2) · [demo Space](https://huggingface.co/spaces/machinekind/matcha-tts-pl-v2) · base: [Matcha-TTS-PL-Pretrain](https://huggingface.co/machinekind/Matcha-TTS-PL-Pretrain) · previous version: [Matcha-TTS-PL-Edge](https://huggingface.co/machinekind/Matcha-TTS-PL-Edge) / [Matcha-TTS-PL](https://huggingface.co/machinekind/Matcha-TTS-PL)

## Pick your files

| you want | precision · steps · mode | files of a voice (`<voice>/`) |
|---|---|---|
| a robot / Raspberry Pi 5 / Jetson: lowest latency | **int8 · 2 · streamed** (the default) | `encoder_sdp_int8.onnx`, `decoder_t2_int8.onnx`, `vocoder_fp16.onnx`, `voices.json` |
| a desktop / server CPU: best quality | fp32 · 4 · whole or streamed | `encoder_sdp.onnx`, `decoder_t4.onnx`, `vocoder.onnx`, `voices.json` |
| deterministic durations (as Matcha-TTS-PL-Edge) | any | `encoder_int8.onnx` / `encoder.onnx` instead of `encoder_sdp*` |
| fine-tuning, PyTorch | — | `pytorch/` (Matcha checkpoint, duration predictor, HiFi-GAN V2 generator) |

Plus, at the root: `tts.py`, `frontend/`, `requirements.txt`. Download only what you need:

```bash
hf download machinekind/Matcha-TTS-PL-Edge-v2 --include "tts.py" "requirements.txt" "frontend/*" \
    "male_voxcpm_2/voices.json" "male_voxcpm_2/*_int8.onnx" "male_voxcpm_2/vocoder_fp16.onnx" --local-dir Matcha-TTS-PL-Edge-v2
```

## Quick start

```bash
pip install -r requirements.txt        # onnxruntime, numpy, phonemizer, wordfreq (+ sounddevice for --play)
brew install espeak-ng                 # or: sudo apt install espeak-ng   (the phonemizer's backend)
python tts.py "Dzień dobry! W czym mogę dziś pomóc?" -o out.wav          # int8, 2 steps, streamed, stochastic durations
python tts.py "Dzień dobry! W czym mogę dziś pomóc?" --play              # hear it while it is generated
python tts.py "…" --precision fp32 --steps 4 --no-stream -o best.wav     # best quality
python tts.py "…" --durations deterministic                              # Matcha's own duration predictor (same rhythm every time)
```

```python
from tts import EdgeTTS
tts = EdgeTTS(voice="male_voxcpm_2", precision="int8", steps=2)    # durations="stochastic" (voices.json default) or "deterministic"
tts.warmup()                                   # once at start-up: loads the phonemizer and runs every graph
for audio in tts.stream("Dzień dobry! Mam dla ciebie kilka informacji na dziś."):
    play(audio)                                # float32 pieces, 22 050 Hz mono
wav = tts.synthesize("Dzień dobry!", stream=False, seed=1)   # a fixed seed repeats the rhythm and the decoder noise
```

## Stochastic durations

Matcha's duration predictor gives every phoneme its average length, so the rhythm is regular and the same on every call.
`encoder_sdp*.onnx` replaces it with a flow-matching duration model trained on the voice's real (monotonic-alignment)
durations: 10 Euler steps from a noise vector `z_dur` (one standard-normal value per phoneme, drawn by `tts.py`) give the
log durations, which are rounded to frames. The spread is `dur_temperature` (0.667; `--dur-temperature`), and a length
factor calibrated on the validation set (in `voices.json` under `"durations"`) keeps the mean tempo equal to the
deterministic encoder's. It costs 1–6 ms per sentence on top of the encoder (Mac CPU, int8) and changes nothing else in
the pipeline: the decoder, vocoder and streaming are the same.

## Streaming

Each sentence goes through the text encoder whole (so intonation is planned for the sentence); the flow-matching decoder then
runs on chunks of the mel, and the vocoder turns each piece into audio as soon as it is ready. Text is split into sentences and
the next one is prepared while the previous one plays. The defaults below (also in each `voices.json` under `"stream"`) are the
sweet spot of a sweep over 210 settings: smaller chunks starve playback on Pi-class CPUs, larger ones only add latency.

| parameter (`tts.py` flag) | default | suggested | what it does |
|---|---|---|---|
| `chunk` (`--chunk`) | 43 frames (0.5 s) | 43–86 | mel frames per chunk (11.6 ms each) |
| `ode_ctx` (`--ode-ctx`) | 16 | 8–32 | decoder context frames on each side of a chunk; below 8 the seams are audible |
| `voc_ctx` (`--voc-ctx`) | 12 | 8–12 | vocoder context frames; 12 = identical to whole-sentence vocoding, 8 = ~7 % less compute |
| `min_sentence_chars` | 40 | — | a shorter sentence is merged with the next (very short inputs synthesise less stably) |
| `first_chunk` (`--first-chunk`) | = chunk | — | a smaller first chunk starts ~45 ms earlier but stutters on slow CPUs |

Time to first audio, **short** / **long** input:

- short: *Dzień dobry, w czym mogę dziś pomóc?* — 7 words, 9 syllables, 1.8 s of speech
- long: *Robot nie zawsze ma dostęp do stabilnego połączenia z internetem. Musi też dzielić moc obliczeniową między wiele zadań.
  Dlatego potrzebuje modelu, który zapewnia dobrą jakość mowy bez nadmiernego obciążania urządzenia.* — 3 sentences, 30 words,
  72 syllables, 11.5 s of speech, given as one input (no sentence split: with the default split, first audio depends only on the
  first sentence, so it is lower)


| setting | Cortex-A725, 1 thread | Cortex-A725, 4 threads | Cortex-X925, 4 threads |
|---|---|---|---|
| int8 · 2 steps · streamed | 84 / 174 ms | 53 / 86 ms | 30 / 48 ms |
| int8 · 2 steps · whole sentence | 230 / 1518 ms | 96 / 554 ms | 58 / 314 ms |
| int8 · 4 steps · streamed | 104 / 196 ms | 66 / 99 ms | 38 / 56 ms |
| int8 · 4 steps · whole sentence | 273 / 1791 ms | 122 / 656 ms | 75 / 361 ms |
| fp32 · 2 steps · streamed | 151 / 418 ms | 54 / 132 ms | 27 / 58 ms |
| fp32 · 2 steps · whole sentence | 357 / 2352 ms | 115 / 694 ms | 54 / 278 ms |
| fp32 · 4 steps · streamed | 194 / 464 ms | 72 / 150 ms | 38 / 67 ms |
| fp32 · 4 steps · whole sentence | 460 / 3034 ms | 153 / 913 ms | 70 / 367 ms |

Compute per second of audio (real-time factor) of the long input, streamed / whole:

| setting | Cortex-A725, 1 thread | Cortex-A725, 4 threads | Cortex-X925, 4 threads |
|---|---|---|---|
| int8 · 2 steps | 0.20 / 0.13 | 0.09 / 0.05 | 0.06 / 0.03 |
| int8 · 4 steps | 0.25 / 0.16 | 0.12 / 0.06 | 0.08 / 0.03 |
| fp32 · 2 steps | 0.31 / 0.20 | 0.11 / 0.06 | 0.05 / 0.02 |
| fp32 · 4 steps | 0.42 / 0.26 | 0.15 / 0.08 | 0.07 / 0.03 |

Measured with the graphs of Matcha-TTS-PL-Edge (same architecture; the stochastic-duration encoder of v2 adds 1–6 ms per sentence on a Mac CPU). Wall clock of `tts.py` on an NVIDIA DGX Spark (GB10) CPU pinned to one core type, ONNX Runtime 1.30, `male_voxcpm_2` (the voices
share the architecture), after `warmup()`; text front end excluded (< 1 ms per sentence). The Cortex-A725 is the closest
available stand-in for a Raspberry Pi 5 (Cortex-A76) or a Jetson Orin CPU (Cortex-A78AE) — expect those to be roughly 1.5–3×
slower. Streaming computes the context frames twice, so its total is higher; what it buys is the first audio.

## Quality

UTMOS ↑ / Whisper WER ↓ / speaker similarity ↑ on 12 held-out sentences (temperature 0.8, tempo 0.8, neutral style, Mac CPU):

| setting | `male_voxcpm_2` | `female_voxcpm_2` |
|---|---|---|
| int8 · 2 steps · streamed (default) | 3.41 / 2.7 % / 0.852 | 3.56 / 4.0 % / 0.900 |
| int8 · 2 steps · whole sentence | 3.41 / 2.7 % / 0.853 | 3.57 / 3.4 % / 0.900 |
| fp32 · 2 steps · streamed | 3.47 / 2.7 % / 0.860 | 3.57 / 3.4 % / 0.905 |
| fp32 · 2 steps · whole sentence | 3.52 / 2.7 % / 0.862 | 3.59 / 3.4 % / 0.904 |
| fp32 · 4 steps · whole sentence | 3.53 / 2.7 % / 0.859 | 3.62 / 3.4 % / 0.906 |
| int8 · 2 steps · streamed, *deterministic durations* | 3.57 / 2.7 % / 0.859 | 3.57 / 2.7 % / 0.901 |
| *Matcha-TTS-PL-Edge (v1), int8 · 2 steps · streamed* | 3.46 / 3.4 % / 0.864 | 3.45 / 2.7 % / 0.910 |

UTMOS and similarity move by ±0.1 between runs (the model samples noise); streamed and whole-sentence synthesis are equal
within that. Stochastic vs deterministic durations on more text (the 92 held-out conversational texts × 3 seeds = 276 clips, UTMOS22, standard error ≈ 0.02): `male_voxcpm_2`: int8 · 2 steps · streamed 3.55 stochastic vs 3.56 deterministic, fp32 · 2 steps · streamed 3.60 stochastic vs 3.58 deterministic; `female_voxcpm_2`: int8 · 2 steps · streamed 3.60 stochastic vs 3.58 deterministic, fp32 · 2 steps · streamed 3.64 stochastic vs 3.62 deterministic. Equal in UTMOS; what changes is the rhythm.
On 92 held-out conversational texts (`male_voxcpm_2`) the v2 acoustic model with stochastic durations scored
best of v1, v2 deterministic and v2 stochastic (see the [Matcha-TTS-PL-v2 card](https://huggingface.co/machinekind/Matcha-TTS-PL-v2)).

## What is different from Matcha-TTS-PL-v2

1. **Small vocoder.** HiFi-GAN V2 (0.93 M parameters instead of 13.9 M; ~1.7 instead of ~26.5 GMAC per second of audio), the
   generator config of the official [jik876/hifi-gan](https://github.com/jik876/hifi-gan) V2, started from its VCTK checkpoint,
   fine-tuned per voice for Matcha-TTS-PL-Edge and then again on the v2 model's mels and the voice's v2 recordings.
2. **Graphs split for streaming**: text encoder + durations, decoder (any length: the whole mel or a chunk), vocoder. Run on the
   whole mel they give the same output as one graph, at the same speed.
3. **int8**: static QDQ quantisation (per-channel weights, activations calibrated on 40 sentences of the voice) of the encoders
   and decoders; the vocoder is fp16 in the int8 setting (a fully int8 vocoder was ~0.3 UTMOS worse).
4. **Faster graphs**: Mish computed with exponentials instead of ONNX Runtime's slow `Softplus` kernel; in the int8 decoders every
   ODE step reads the same per-channel int8 weights.

## Files

- `<voice>/encoder_sdp.onnx`, `encoder_sdp_int8.onnx` — `x` [1,T] int64, `x_lengths`, `scales` [temperature, length scale,
  dur_temperature], `spk_emb`, `z_dur` [1,1,T] (standard normal) → `mu` [1,80,F] (normalised mel prior), `mel_lengths`
- `<voice>/encoder.onnx`, `encoder_int8.onnx` — the same with the deterministic duration predictor: `x`, `x_lengths`,
  `scales` [temperature, length scale], `spk_emb` → `mu`, `mel_lengths`
- `<voice>/decoder_t2.onnx`, `decoder_t4.onnx` (+ `_int8`) — `mu`, `mask` [1,1,L], `z` (noise) [1,80,L], `spk_emb`, `temperature` →
  `mel` [1,80,L]; L a multiple of 4, padded frames masked; 2 or 4 ODE steps
- `<voice>/vocoder.onnx`, `vocoder_fp16.onnx` — `mel` [1,80,F] → 22.05 kHz waveform
- `<voice>/voices.json` — speaker vector, style vectors (8 = neutral), defaults, graph names, durations, streaming defaults; `voices_index.json`
- `<voice>/pytorch/` — Matcha checkpoint (mel statistics of the training data), `sdp_v2.pt` (duration predictor), HiFi-GAN V2 generator + config
- `<voice>/samples/eNN.wav` — the 12 evaluation sentences, default setting (`texts.txt`)
- `tts.py` — inference (whole / streamed, fp32 / int8, stochastic / deterministic durations, CLI and `EdgeTTS` class);
  `frontend/` — text → phoneme ids: Polish espeak-ng phonemisation with English words (curated list + rules,
  `english_detect.py`) read by espeak-ng en-us; you can also mark English words yourself: `"Wrzuć to na {Slack}a."`

## Licence and attribution

CC BY-SA 4.0 (`LICENSE`), like Matcha-TTS-PL-v2 and its training data. The vocoder starts from the HiFi-GAN V2 VCTK checkpoint by
Jungil Kong et al. (code and weights MIT), trained on the VCTK corpus (CC BY 4.0, University of Edinburgh, CSTR).
`frontend/text.py` contains the text cleaners and symbol table of Matcha-TTS (MIT, Shivam Mehta et al.) with our Polish additions.
espeak-ng (the runtime phonemiser, installed separately) is GPL-3.0. Full credits, including every source text of the training
data: `ATTRIBUTION.md`.
