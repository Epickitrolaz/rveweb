# RVEWeb

A self-hosted video restoration console: upscale, interpolate, denoise, and decompress
video on your own machine. The web UI and API run alongside a small GPU/CPU pipeline built
around FFmpeg, RIFE 4.27, and Real-ESRGAN.

This project is inspired by [TNTwise/REAL-Video-Enhancer](https://github.com/TNTwise/REAL-Video-Enhancer)
and adds a web service, a bounded job queue, and **RIFE 4.27** support.

## What it does

- **Upscale** — Real-ESRGAN v3 x2/x3/x4 (fast, video-tuned), x4plus, and x4plus-anime,
  running on Vulkan via ncnn with tiled inference.
- **Interpolate** — RIFE 4.27 and RIFE 4.27 Small, 2x/4x/8x, with scene-cut guard and an
  AI working-resolution cap. ONNX Runtime on CPU.
- **Denoise** — three strengths of `hqdn3d`.
- **Decompress** — weak/strong `deblock` for compression artifacts.
- **Encode** — H.264 or H.265, CRF 14–28, MP4 or MKV, source audio preserved.
- **Queue** — SQLite-backed, bounded, persistent across restarts; one job at a time by
  default so the machine stays responsive.
- **Crash isolation** — every enhancement runs in its own process group; the API survives
  worker crashes, cancellations, timeouts, and restarts.

## Target deployment

The reference deployment is an LXC with **4 CPU cores, 8 GB RAM, and an AMD Radeon Vega 11
iGPU** (RADV Vulkan). There is no NVIDIA/CUDA device. Concretely:

| Stage | Device | Notes |
|---|---|---|
| Real-ESRGAN upscale | **GPU (Vulkan / ncnn)** | ~0.2 s per 256 px tile with the v3 video model |
| RIFE 4.27 interpolation | **CPU (ONNX Runtime)** | ~0.2–0.8 s per frame at 180–360p |
| Denoise / deblock / decode / encode | **CPU (FFmpeg)** | 2 threads each, leaving headroom for RIFE |

Measured on the target (3 s, 320×180, 24 fps):

| Job | Time |
|---|---|
| RIFE 4.27 2x + denoise + deblock | ~19 s |
| Real-ESRGAN v3 2x only (72 frames) | ~17 s |
| Real-ESRGAN v3 2x + RIFE 4.27 2x + denoise + deblock | ~52 s |
| Real-ESRGAN x4plus at 2x | ~2.5 min per second of 320×180 |

This is a small iGPU, not a workstation. Short clips are the intended workload; the UI shows
ETA and keeps the queue honest.

## Quick start

```bash
# On the host with Docker and /dev/dri
docker compose up -d --build

# Console
http://10.0.0.121:8080

# API docs
http://10.0.0.121:8080/api/docs

# Health
curl http://10.0.0.121:8080/health
```

The image downloads and verifies pinned models during build (~70 MB). No model download
happens at runtime.

### Requirements

- Docker with Compose v2.
- `/dev/dri` passed through to the container and the render node group added in
  `docker-compose.yml`.
- On this LXC the render node is gid **993** and the video group is gid **44**:

```bash
stat -c '%g %n' /dev/dri/renderD128
```

Update `group_add` if your host differs. Without Vulkan the upscaler falls back to Lanczos,
but the UI will still report GPU availability based on `/dev/dri` and `vulkaninfo`.

## Configuration

Environment variables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `DATA_DIR` | `/data` | SQLite database, uploads, outputs, logs |
| `MAX_ACTIVE_JOBS` | `1` | Concurrent encoder/inference processes |
| `MAX_QUEUE` | `25` | Waiting jobs before `429` |
| `MAX_UPLOAD_MB` | `1024` | Per-file upload limit |
| `MAX_INFLIGHT_UPLOADS` | `3` | Simultaneous upload copies |
| `MIN_FREE_GB` | `3` | Refuse uploads/jobs below this free space |
| `RETENTION_HOURS` | `72` | Auto-delete finished jobs older than this |
| `RIFE_THREADS` | `4` | ONNX Runtime intra-op threads |
| `FFMPEG_THREADS` | `2` | Encoder/decoder threads |
| `GPU_DEVICE` | `0` | ncnn Vulkan device index |
| `JOB_TIMEOUT_MIN/MAX` | `900/10800` | Absolute job watchdog, seconds |

## Operations

```bash
docker compose logs -f --tail=100       # API and manager
docker exec rveweb tail -50 /data/jobs/<id>/worker.log   # one job
docker compose restart                   # jobs in flight become failed, queued jobs resume
docker compose down                      # stop (data volume persists)
```

Finished jobs are downloadable for `RETENTION_HOURS`, then removed by the manager. Use
`DELETE /api/jobs/<id>` to remove one sooner. The SQLite database lives in the
`rveweb-data` volume.

### Stability model

- Uploads are size-capped, extension-checked, and validated with `ffprobe`.
- The queue is bounded; excess submissions get `429` with a clear message.
- Jobs run in a separate process group. The manager reaps crashes, enforces a timeout,
  and kills cancelled jobs (SIGTERM, then SIGKILL).
- On startup, interrupted jobs are marked failed instead of staying stuck.
- The API is single-process and async; heavy work never runs in its address space.
- Disk space is checked before accepting an upload and before starting a job.

## Limits

- 8-bit SDR pipeline; HDR/10-bit sources are converted to 8-bit.
- Anamorphic sources are treated as square pixels (no SAR restoration).
- Inputs up to 4K and 4 hours; upload default 1 GB.
- Projected output is capped at 4K (3840×2160) to keep the single-GPU queue stable.
- Interpolation works on the whole frame; there is no mask/region selection.
- Model files are pinned and verified at image build time. Rebuild to update them.

## Development

```bash
# models (once, into backend/models)
bash backend/scripts/fetch_models.sh backend/models

# backend (needs ffmpeg/ffprobe, python packages)
cd backend
DATA_DIR=./data MODEL_DIR=./models FRONTEND_DIR=../frontend \
  uvicorn app.main:app --reload --port 8080

# frontend is static: open frontend/index.html or serve it
python3 -m http.server 5173 --directory frontend
```

Tests:

```bash
python3 -m unittest discover -s backend/tests -v
BASE=http://127.0.0.1:8080 bash scripts/verify.sh
```

## API

See [docs/API.md](docs/API.md). The console is served from `/`; API endpoints live under
`/api`. `POST /api/jobs` accepts multipart `file` + `settings` JSON.

## Credits and licenses

RVEWeb is MIT-licensed (see [LICENSE](LICENSE)). It would not exist without:

- **REAL-Video-Enhancer** by TNTwise (AGPL-3.0) — the desktop app this project takes its
  feature set and pipeline ideas from.
- **RIFE 4.27** models from [FluidFrames](https://github.com/Djdefrag/FluidFrames) (MIT),
  originally from the RIFE project (MIT).
- **Real-ESRGAN** by Xintao Wang (BSD-3-Clause) and its ncnn implementation.
- **ncnn** (BSD-3-Clause) and **FFmpeg** (LGPL/GPL, depending on the build).

See [NOTICE.md](NOTICE.md) for details.
