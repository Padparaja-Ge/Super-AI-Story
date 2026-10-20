# Independent GPL phoneme utility

`phonemes.mjs` is GPL-3.0-or-later and exchanges JSON over stdin/stdout. It can
be run independently using Node.js and `espeak-ng@1.0.2` (`npm install espeak-ng@1.0.2`).
Input: `{"text":"Hello","language":"en-us"}`. Output: JSON phonemes.

The npm package is the unmodified distribution from ianmarmour/espeak-ng.js.
Its wrapper source, WASM and original build instructions are in the adjacent
`espeak-ng.js-source-1.0.2.zip`, commit eec88dbcc1482b1a03a76cf9d2025a0acde8982e.
`src/espeak-ng.wasm` was last updated in upstream commit
6ac1c0a549ff30528baf011b14ee76ca2cd24b61 (2023-11-24).

The WASM identifies eSpeak 1.52-dev. The adjacent native-source ZIP includes
the eSpeak upstream source tree at f9976e8f7846c20a4c19504d1125ba472e18aa7a,
the latest upstream native commit before that WASM build. The npm author does
not embed an exact native commit ID in the WASM. This provenance is recorded
explicitly rather than claiming a bit-identical rebuild.

For native/WASM build dependencies and Emscripten configure/link flags, follow
the original `Building` section of the wrapper README, including its documented
autogen.sh ChangeLog.md / CHANGELOG.md correction. Both source trees and licenses
are provided, not just links to a changing upstream branch.

Source URLs:
https://github.com/ianmarmour/espeak-ng.js
https://github.com/espeak-ng/espeak-ng

These GPL sources are an independent component; they do not place the original
SAS application source under this license. See COPYING and NOTICES.md.
