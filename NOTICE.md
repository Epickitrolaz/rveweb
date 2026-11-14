# Third-party notices

RVEWeb's own source is MIT-licensed. It downloads, bundles, or links the following
third-party components and models.

## REAL-Video-Enhancer

- Upstream: https://github.com/TNTwise/REAL-Video-Enhancer
- License: AGPL-3.0
- Use here: conceptual source for the enhancement feature set (upscale, interpolate,
  denoise, decompress) and pipeline design. No upstream source files are copied into this
  repository; the implementation here is independent. If you redistribute a derivative of
  RVE itself, comply with AGPL-3.0.

## RIFE / FluidFrames RIFE 4.27 models

- Model files: `RIFE_fp32.onnx`, `RIFE_s_fp32.onnx`
- Upstream: https://github.com/Djdefrag/FluidFrames (MIT), derived from RIFE
  (https://github.com/hzwer/ECCV2022-RIFE, MIT)
- Bundled at image build time from a pinned commit and verified by SHA-256.
- License: MIT (model export), RIFE code MIT.

## Real-ESRGAN

- Upstream: https://github.com/xinntao/Real-ESRGAN
- ncnn models: `realesr-animevideov3-x2/x3/x4`, `realesrgan-x4plus`,
  `realesrgan-x4plus-anime`
- License: BSD-3-Clause. Model files are redistributed under the same terms; see the
  upstream LICENSE.

## ncnn

- Upstream: https://github.com/Tencent/ncnn
- License: BSD-3-Clause
- Used through the Python bindings, with the Vulkan backend.

## FFmpeg

- Upstream: https://ffmpeg.org
- License: LGPL-2.1-or-later by default; Debian's build may include GPL components
  (libx264/libx265). The Docker image installs Debian's `ffmpeg` package; review its
  licensing for redistribution.

## ONNX Runtime

- Upstream: https://github.com/microsoft/onnxruntime
- License: MIT
- CPU execution provider only in this deployment.

## Fonts

- Bricolage Grotesque (SIL Open Font License 1.1)
- IBM Plex Sans / IBM Plex Mono (SIL Open Font License 1.1)

Font files are bundled in `frontend/fonts/` for offline use.
