#!/usr/bin/env bash
# End-to-end verification for a running RVEWeb deployment.
# Usage: BASE=http://127.0.0.1:8080 CONTAINER=rveweb bash scripts/verify.sh
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8080}"
CONTAINER="${CONTAINER:-rveweb}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

say() { printf '\n== %s ==\n' "$1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

say "health and system"
curl -fsS "$BASE/health" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["status"]=="ok",d;print("health ok",d["version"])'
curl -fsS "$BASE/api/system" | python3 -c '
import sys,json
d=json.load(sys.stdin)
print("gpu:", d["gpu"])
print("cpu:", d["cpu"], "memory:", d["memory"], "storage:", d["storage"])
assert d["models"]["interpolators"], "no interpolators advertised"
assert any(m["id"]=="rife-4.27" for m in d["models"]["interpolators"]), "RIFE 4.27 missing"
'
MODE="$(curl -fsS "$BASE/api/settings" | python3 -c 'import sys,json;print(json.load(sys.stdin)["processingMode"])')"
echo "station processing mode: $MODE"

say "create a 2 s test clip"
docker exec "$CONTAINER" ffmpeg -hide_banner -loglevel error \
  -f lavfi -i testsrc2=size=320x180:rate=24:duration=2 \
  -f lavfi -i sine=frequency=440:duration=2 \
  -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p \
  -c:a aac -shortest -y /tmp/verify-input.mp4
docker cp "$CONTAINER:/tmp/verify-input.mp4" "$WORK/input.mp4" >/dev/null
ls -l "$WORK/input.mp4"

SETTINGS="$(python3 - "$MODE" <<'PY'
import json, sys
mode = sys.argv[1]
if mode == "gpu":
    upscale = {"enabled": True, "model": "realesrgan-video", "scale": 2}
    interp = {"enabled": True, "model": "rife-4.26", "factor": 2, "maxHeight": 1080}
elif mode == "cpu":
    upscale = {"enabled": True, "model": "lanczos", "scale": 2}
    interp = {"enabled": True, "model": "rife-4.27", "factor": 2, "maxHeight": 1080}
else:
    upscale = {"enabled": True, "model": "realesrgan-video", "scale": 2}
    interp = {"enabled": True, "model": "rife-4.27", "factor": 2, "maxHeight": 1080}
print(json.dumps({
    "upscale": upscale,
    "interpolate": interp,
    "denoise": {"enabled": True, "strength": "medium"},
    "decompress": {"enabled": True, "strength": "strong"},
    "encode": {"codec": "h264", "crf": 20, "preset": "veryfast", "container": "mp4"},
    "audio": {"mode": "copy"},
}))
PY
)"

say "submit enhancement job"
RESP="$(curl -fsS -X POST "$BASE/api/jobs" -F "file=@$WORK/input.mp4" -F "settings=$SETTINGS")"
JOB_ID="$(echo "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')"
echo "job: $JOB_ID"
echo "$RESP" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("queued:",d["source"],d["settings"]["interpolate"])'

say "wait for completion"
for _ in $(seq 1 120); do
  STATUS="$(curl -fsS "$BASE/api/jobs/$JOB_ID" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["status"])')"
  DETAIL="$(curl -fsS "$BASE/api/jobs/$JOB_ID")"
  echo "$DETAIL" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["status"],d["stage"],round(d["progress"],3),d["etaSeconds"])'
  case "$STATUS" in
    completed) break ;;
    failed|cancelled) echo "$DETAIL" | python3 -c 'import sys,json;print(json.load(sys.stdin)["error"])'; fail "job ended as $STATUS" ;;
  esac
  sleep 5
done
[ "$STATUS" = "completed" ] || fail "job did not finish in time"

say "download and probe output"
curl -fsS -o "$WORK/output.mp4" "$BASE/api/jobs/$JOB_ID/download"
docker cp "$WORK/output.mp4" "$CONTAINER:/tmp/verify-output.mp4" >/dev/null
docker exec "$CONTAINER" ffprobe -v error -print_format json -show_streams -show_format /tmp/verify-output.mp4 \
  > "$WORK/probe.json"
python3 - "$WORK/probe.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
video = next(s for s in d["streams"] if s["codec_type"] == "video")
audio = next((s for s in d["streams"] if s["codec_type"] == "audio"), None)
print("video:", video["codec_name"], video["width"], "x", video["height"], video["avg_frame_rate"], video.get("nb_frames"))
print("audio:", audio and audio["codec_name"], "duration:", d["format"].get("duration"))
assert video["width"] == 640 and video["height"] == 360, "unexpected upscale size"
assert video["avg_frame_rate"] == "48/1", "RIFE 4.27 did not double the frame rate"
assert int(video.get("nb_frames", 0)) == 96, "expected 96 frames for 2 s at 48 fps"
assert audio is not None, "audio was not preserved"
assert abs(float(d["format"]["duration"]) - 2.0) < 0.1, "duration drifted"
PY

say "error handling"
echo "not a video" > "$WORK/bad.txt"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/jobs" -F "file=@$WORK/bad.txt" -F "settings=$SETTINGS")"
[ "$code" = "415" ] || fail "expected 415 for .txt, got $code"
cp "$WORK/bad.txt" "$WORK/bad.mp4"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/jobs" -F "file=@$WORK/bad.mp4" -F "settings=$SETTINGS")"
[ "$code" = "422" ] || fail "expected 422 for corrupt mp4, got $code"
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/jobs/j_does_not_exist")"
[ "$code" = "404" ] || fail "expected 404 for unknown job, got $code"

say "concurrent API reads"
seq 1 60 | xargs -P 15 -I{} curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/jobs" \
  | sort | uniq -c | tee "$WORK/codes.txt"
grep -q '^ *60 200$' "$WORK/codes.txt" || fail "concurrent reads were not all 200"

echo
echo "PASS — job $JOB_ID is available at $BASE/api/jobs/$JOB_ID/download"
