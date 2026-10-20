# Speech components

SAS uses ONNX Runtime (Microsoft, MIT) for inference. Its license is included as
`LICENSE-onnxruntime.txt`. Node wrapper: `onnxruntime-node` 1.30.0.

The independent `server/tts/phonemes.mjs` utility is GPL-3.0-or-later. It exchanges
JSON over stdin/stdout with the inference process and uses `espeak-ng` 1.0.2 by
Ian Armour. The unmodified npm distribution and its license are preserved.
`LICENSE-espeak-ng.txt` contains GPLv3; `espeak-ng.js-source-1.0.2.zip` contains the
upstream JavaScript/WASM distribution, original source tree and build instructions
at commit `eec88dbcc1482b1a03a76cf9d2025a0acde8982e`.
The upstream C project and build prerequisites referenced by those instructions:
https://github.com/espeak-ng/espeak-ng . SAS does not modify the eSpeak engine.

Bundled weights:

* Kokoro RU: https://huggingface.co/zaakirio/kokoro-ru — OpenRAIL, as identified
  in the bundled model card. Revision: `d649c57b239b18c4c384378127cbf01dba039bc1`.
* Kokoro-82M ONNX: https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX —
  Apache-2.0. Revision: `1939ad2a8e416c0acfeecc08a694d14ef25f2231`.
  Apache license included in `LICENSE-kokoro-apache.txt`.
* Silero TTS `v3_1_ru` and `v3_en`: https://github.com/snakers4/silero-models —
  CC BY-NC-SA 4.0, included in `LICENSE-Silero-models.txt`. Catalog metadata is
  pinned to `e382298387332f2bf461fe6eadfde99104611b0c`. The optional `v4_ru` package
  has the same upstream license. Original model URLs and checksum-pinned mirrors
  are recorded in `server/tts/silero-catalog.json`. SAS runs these packages locally;
  it does not embed or depend on the NeuroSenko Gradio Space.

The bundled Silero Windows CPU runtime contains CPython 3.12.3 (PSF),
PyTorch 2.5.1+cpu (BSD-3-Clause), NumPy 1.26.4 (BSD-3-Clause), and their Python
dependencies. Original package license/notices and Python's `LICENSE.txt` are
preserved inside `speech/runtime/silero-cpu`. Unused development headers, static
import libraries and bytecode are omitted; runtime libraries are not modified.
Sources: https://www.python.org/downloads/release/python-3123/ ,
https://github.com/pytorch/pytorch/tree/v2.5.1 ,
https://github.com/numpy/numpy/tree/v1.26.4 . A fresh standalone installation
uses the compatible pinned versions specified in `server/tts/silero-engine.mjs`.

Optional weights are installed only on an explicit request:

* XTTS v2: https://huggingface.co/coqui/XTTS-v2 — Coqui Public Model License.
  The package includes its upstream license and model card. Python implementation:
  `coqui-tts` 0.27.2 (MPL-2.0).
* Fish Speech 1.5: https://huggingface.co/fishaudio/fish-speech-1.5 — CC BY-NC-SA 4.0.
  Implementation source at `58046eaa1a4cefb0c8cc3a3a667b34186ea02dde` (v1.5.1)
  includes its upstream license. PyTorch and other runtime dependencies preserve
  their package notices in the private Python environments.

The SAS copyright notice does not supersede any of these component licenses.
Model-specific conditions, including commercial-use restrictions, remain those
of the upstream licensors. Imported user models retain their own licenses.

Russian phoneme normalization follows the Apache-2.0 frontend described at
https://huggingface.co/zaakirio/kokoro-ru/blob/d649c57b239b18c4c384378127cbf01dba039bc1/ru_g2p.py .
SAS implements the phoneme/orthoepy transformations in JavaScript; it does not
bundle RUAccent or claim its lexical-stress accuracy.

Optional voice presets are synthetic Piper examples from HiFi-Captain:
https://github.com/rhasspy/piper-samples/tree/da672d1157136d07365790f51da3357a17cf9650/samples/en/en_US .
The hfc_female/hfc_male model cards identify CC BY-NC-SA 4.0 and the HiFi-Captain
source: https://ast-astrec.nict.go.jp/en/release/hi-fi-captain/ .
SAS preserves source, transcript, license and SHA-256 in each downloaded profile.
These noncommercial demonstration samples do not change the license of SAS code.

Optional audio conversion uses imageio-ffmpeg 0.6.0 (BSD-2-Clause wrapper), which
downloads its FFmpeg distribution in the private Python environment. Its package
notices remain installed there. FFmpeg licensing/source: https://ffmpeg.org/legal.html
and https://github.com/imageio/imageio-ffmpeg . The main application does not
bundle or modify that binary. A user-provided FFmpeg path can be configured.
