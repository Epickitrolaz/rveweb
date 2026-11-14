#!/usr/bin/env bash
# Fetch and verify the pinned models baked into the RVEWeb image.
set -euo pipefail

DEST="${1:-/app/models}"
RIFE_COMMIT="f2be94f3c40ebaa8df5e96a6e69b2d9d0653ef40"
ESRGAN_ZIP="https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip"
ESRGAN_SHA="e5aa6eb131234b87c0c51f82b89390f5e3e642b7b70f2b9bbe95b6a285a40c96"

mkdir -p "$DEST/rife" "$DEST/upscalers"

fetch_verified() {
  local url="$1" output="$2" sha="$3"
  if [[ -f "$output" ]] && echo "$sha  $output" | sha256sum -c --status -; then
    echo "model already present: $(basename "$output")"
    return
  fi
  echo "downloading $(basename "$output")"
  curl -fL --retry 4 --retry-delay 2 --connect-timeout 20 "$url" -o "$output"
  echo "$sha  $output" | sha256sum -c -
}

fetch_verified \
  "https://raw.githubusercontent.com/Djdefrag/FluidFrames/${RIFE_COMMIT}/AI-onnx/RIFE_fp32.onnx" \
  "$DEST/rife/RIFE_fp32.onnx" \
  "5ee29acda81a6747d55624be41ac28723b7a121d743a58f6a12c96ccb9deed0c"

fetch_verified \
  "https://raw.githubusercontent.com/Djdefrag/FluidFrames/${RIFE_COMMIT}/AI-onnx/RIFE_s_fp32.onnx" \
  "$DEST/rife/RIFE_s_fp32.onnx" \
  "ff7bca3cbbaf1d86f7387b186d029e8fb76ec86d2a5b47401353a95f9c633f2f"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
echo "downloading Real-ESRGAN ncnn models"
curl -fL --retry 4 --retry-delay 2 --connect-timeout 20 "$ESRGAN_ZIP" -o "$TMP_DIR/models.zip"
echo "$ESRGAN_SHA  $TMP_DIR/models.zip" | sha256sum -c -
unzip -q "$TMP_DIR/models.zip" 'models/*' -d "$TMP_DIR/unpacked"

for name in \
  realesr-animevideov3-x2 \
  realesr-animevideov3-x3 \
  realesr-animevideov3-x4 \
  realesrgan-x4plus \
  realesrgan-x4plus-anime
do
  cp "$TMP_DIR/unpacked/models/$name.param" "$DEST/upscalers/$name.param"
  cp "$TMP_DIR/unpacked/models/$name.bin" "$DEST/upscalers/$name.bin"
done

echo "models ready:"
du -sh "$DEST/rife" "$DEST/upscalers"
ls -1 "$DEST/rife" "$DEST/upscalers"
