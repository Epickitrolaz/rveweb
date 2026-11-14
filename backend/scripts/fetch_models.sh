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

RIFE_NCNN_BASE="https://raw.githubusercontent.com/TNTwise/rife-ncnn-vulkan/master/models"
mkdir -p "$DEST/rife-ncnn"
while read -r model param_sha bin_sha; do
  mkdir -p "$DEST/rife-ncnn/$model"
  fetch_verified "$RIFE_NCNN_BASE/$model/flownet.param" \
    "$DEST/rife-ncnn/$model/flownet.param" "$param_sha"
  fetch_verified "$RIFE_NCNN_BASE/$model/flownet.bin" \
    "$DEST/rife-ncnn/$model/flownet.bin" "$bin_sha"
done <<'EOF'
rife-v4.6 724569596bcd1e7b9fa50455c604777ebed99746d2ef40aa86e31b5725f1053c f334ed2260149ce0188a6dcf049844e8b0cdd912e01cbcfb63553157d2508958
rife-v4.7 0136bc753bb4d358cdba0e14f9855061fdc0c21708a6b3fbc07ef225cec6084c 3c70442fbb1709221c968a4de1d3bde5e5c583e96af99d3a2b526ad1aa730f81
rife-v4.12 a1e0e143edb8695d8378c011cf8a9b8b848962ff359dc4b4a187929e7afa480f 8995f86fef81bdbd3baa600c09e611a924d90bfb96413e8b63257ed536e1b150
rife-v4.15 13b6407289b9888d65f2da2ad58b40c1db93a0e53cb3add26288f95f36241168 d01f3b9098a999c1aa46607f4851ae728d78866c060f782743b3b80d9fef279a
rife-v4.18 52fd5c75db42331d9195239c40c4fd88e681f61b6b6f5ff0590d8af6b0ebfa72 05858eb12ddef4441ec744e547ba80576c4acc7f014615cb4a68ebb0c18ee27c
rife-v4.22 e7dd2392d1317bc079cf579c650d52fae6a339abf45ded38125d2bc7836d19f7 48f40d52b9306a86c09a541990384f28ac08c6607c3595ed43727ee4ef63e91c
rife-v4.25 6ba231fb00e4ae82b120f938d9b2df91db32fbf322bd110f29450efaf61848d6 10de487a095e61cb2971c39e3b5e17005a70fba6201c77fb96e063f4423b583f
rife-v4.26 79f16c28903f93f8308f0c4c947f8c7e0c17d99a57b85473e5f298dd578d137b 94d58e30b75d7c7609cfa6f3bdad524deddd14f5f75e85c36d2f827ef5c64731
EOF

echo "models ready:"
du -sh "$DEST/rife" "$DEST/rife-ncnn" "$DEST/upscalers"
ls -1 "$DEST/rife-ncnn"
