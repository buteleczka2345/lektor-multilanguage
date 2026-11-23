List of several Polish voice models for piper
===

All models were trained on the RTX4090 graphics card. Datasets for the indicated models can be found in another repository. 1600-2000 samples were used to generate the models. Generated sample texts read by the included models are also included.


How to use models?
---

`pip install piper-tts`

`echo 'Witamy w świecie syntezy mowy!' | piper --model ./pl_PL-jarvis_wg_glos-medium.onnx --config ./pl_PL-jarvis_wg_glos-medium.onnx.json --output_file witaj.wav`


How to use models in MacOS:
---

```
pip install piper-phonemize-cross
pip install piper-tts --no-deps
pip install onnxruntime
```

`echo 'Witamy w świecie syntezy mowy!' | piper --model ./pl_PL-meski_wg_glos-medium.onnx --config ./pl_PL-meski_wg_glos-medium.onnx.json --output_file witaj.wav`

Info
---

All models was tuning from file `epoch=2164-step=1355540.ckpt` (https://huggingface.co/datasets/rhasspy/piper-checkpoints/resolve/main/en/en_US/lessac/medium/epoch%3D2164-step%3D1355540.ckpt) and tuning ware taken around 10h per voice.

pl_PL-jarvis_wg_glos-medium: `epoch=2499-step=1395740.ckpt`

pl_PL-justyna_wg_glos-medium: `epoch=2499-step=1387030.ckpt`

pl_PL-meski_wg_glos-medium: `epoch=4449-step=1593180.ckpt`

pl_PL-zenski_wg_glos-medium: `epoch=4949-step=1645180.ckpt`


---
license: mit
---

