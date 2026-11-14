# RVEWeb API contract (v1.1)

The backend is a FastAPI service. The frontend is served from the same origin, so all
requests use relative URLs (`/api/...`). All request/response bodies are JSON unless noted.
Errors use `{ "detail": "human readable message" }` with an appropriate status code.

## Health & system

### `GET /health`
```json
{ "status": "ok", "version": "1.1.0", "uptimeSeconds": 123.4 }
```

### `GET /api/system`
```json
{
  "gpu": {
    "available": true,
    "name": "AMD Radeon Vega 11 Graphics (RADV RAVEN)",
    "backend": "vulkan",
    "driver": "radv",
    "cuda": false,
    "vulkan": true,
    "cudaOnnx": false,
    "vulkanIndex": 0
  },
  "cpu": { "cores": 4, "load1": 0.42 },
  "memory": { "totalMb": 7168, "availableMb": 6120 },
  "storage": { "freeGb": 12.8 },
  "queue": { "active": 1, "queued": 2, "maxActive": 1, "maxQueue": 25 },
  "limits": { "maxUploadMb": 1024, "minFreeGb": 3, "retentionHours": 72, "maxOutputPixels": 8294400 },
  "models": {
    "upscalers": [
      { "id": "realesrgan-video", "label": "Real-ESRGAN v3 · Video", "scales": [2, 3, 4], "note": "Fast, video-tuned", "engine": "ncnn" },
      { "id": "lanczos", "label": "Lanczos · CPU", "scales": [2, 3, 4], "note": "Fast CPU scaling, no AI", "engine": "cpu" }
    ],
    "interpolators": [
      { "id": "rife-4.27", "label": "RIFE 4.27", "factors": [2, 4, 8], "note": "Quality · CPU ONNX", "engine": "onnx", "backend": "cpu" },
      { "id": "rife-4.26", "label": "RIFE 4.26", "factors": [2, 4, 8], "note": "Vulkan · GPU", "engine": "ncnn", "backend": "gpu" }
    ]
  }
}
```
`gpu.backend` is always `"vulkan"`; `gpu.driver` is the Mesa driver name (e.g. `radv`).
`limits.maxOutputPixels` is the projected width × height ceiling (4K); reject an upload with
`422` before queueing if the chosen upscale would exceed it.

## Processing modes

A station-wide mode applies to every new job. It is stored in Settings, not chosen per job.

`gpu.backend` is `"cuda"` when `nvidia-smi` is present, otherwise `"vulkan"`. `gpu.cuda`
and `gpu.vulkan` report each runtime independently. `gpu.cudaOnnx` means ONNX Runtime was
built with the CUDA provider (used by RIFE 4.27 on a T4). `gpu.vulkanIndex` is the Vulkan
device index to use for ncnn.

| Mode | Upscale | Interpolation |
|---|---|---|
| `auto` | Vulkan Real-ESRGAN if available, Lanczos fallback | RIFE 4.27 CUDA ONNX if available, otherwise CPU; older RIFE on Vulkan when available |
| `gpu` | Required Vulkan Real-ESRGAN (Lanczos rejected) | RIFE 4.26 or older on Vulkan, or RIFE 4.27 with CUDA ONNX; unavailable without the matching backend |
| `cpu` | Lanczos only (AI models rejected) | CPU RIFE (4.27 ONNX or older ncnn) |

FFmpeg decode, denoise/deblock filters, and encode always use the CPU. `gpu` means
**GPU-only for the AI stages**.

## Jobs

Job object:
```json
{
  "id": "j_9f2c4a1b7d",
  "status": "processing",
  "stage": "interpolate",
  "progress": 0.43,
  "etaSeconds": 94,
  "source": {
    "name": "holiday.mp4",
    "width": 640, "height": 360, "fps": 24, "duration": 8.5,
    "sizeBytes": 1823412, "frameCount": 204
  },
  "settings": {
    "processing": { "mode": "gpu" },
    "upscale": { "enabled": true, "model": "realesrgan-video", "scale": 2 },
    "interpolate": { "enabled": true, "model": "rife-4.26", "factor": 2, "maxHeight": 1080 },
    "denoise": { "enabled": false, "strength": "medium" },
    "decompress": { "enabled": false, "strength": "light" },
    "encode": { "codec": "h264", "crf": 18, "preset": "veryfast", "container": "mp4" },
    "audio": { "mode": "copy" }
  },
  "library": { "itemId": "lib_…", "parentVersionId": "v_…" },
  "output": null,
  "error": null,
  "createdAt": "2026-11-14T20:12:31Z",
  "startedAt": "2026-11-14T20:12:35Z",
  "completedAt": null
}
```
`library` is `null` for direct-upload jobs. `status`: `queued` | `processing` | `completed` |
`failed` | `cancelled` | `cancel_requested`. `stage`: `queued` | `decode` | `denoise` |
`upscale` | `interpolate` | `encode` | `finalize` | `done`.

When completed, `output` includes `width`, `height`, `fps`, `duration`, `sizeBytes`, `filename`,
plus `engine: { mode, upscaler, interpolation }`. Library jobs also include
`libraryVersionId` and `libraryItemId`.

### `POST /api/jobs` (multipart/form-data)
Fields:
- `file` — video upload, **or**
- `libraryVersionId` — enhance an existing library version (no `file`)
- `settings` — JSON string matching the settings object above (required)

Returns `201` with the job object. Errors: `413` too large, `415` unsupported type, `422`
invalid video/settings/mode combination, `429` queue full, `507` disk full.

### `GET /api/jobs?limit=20`
```json
{ "jobs": [], "queue": { "active": 0, "queued": 0, "maxActive": 1, "maxQueue": 25 } }
```

### `GET /api/jobs/{id}`
### `POST /api/jobs/{id}/cancel` → `202`
### `DELETE /api/jobs/{id}` → `204` (finished jobs only)
### `GET /api/jobs/{id}/download`
### `GET /api/jobs/{id}/thumbnail`

## Settings

### `GET /api/settings`
```json
{
  "processingMode": "auto",
  "defaults": {
    "encode": { "codec": "h264", "crf": 18, "preset": "veryfast", "container": "mp4" },
    "audio": { "mode": "copy" }
  },
  "capabilities": { "gpu": { }, "interpolators": [ ] },
  "limits": { "maxUploadMb": 1024, "minFreeGb": 3, "retentionHours": 72, "maxOutputPixels": 8294400 }
}
```

### `PUT /api/settings`
Body:
```json
{
  "processingMode": "gpu",
  "defaults": {
    "encode": { "codec": "h264", "crf": 20, "preset": "veryfast", "container": "mp4" },
    "audio": { "mode": "copy" }
  }
}
```
Returns the same shape as `GET /api/settings`.

## Library

Items are persistent. Each item has a tree of versions; the next enhancement from a version
creates a child. Restoring a version only changes the active branch point; no version is
deleted. Library files live under `/data/library` and are not removed by job retention.

### `GET /api/library`
```json
{
  "count": 1,
  "items": [
    {
      "id": "lib_…", "name": "holiday.mp4",
      "activeVersionId": "v_…", "versionCount": 3,
      "activeVersion": {
        "id": "v_…", "label": "RIFE 4.26 2× · Real-ESRGAN v3 · Video 2×",
        "metadata": { "width": 1280, "height": 720, "fps": 48, "duration": 8.5, "sizeBytes": 9982211 },
        "createdAt": "2026-11-14T20:12:31Z"
      },
      "createdAt": "…", "updatedAt": "…"
    }
  ]
}
```

### `POST /api/library` (multipart `file`)
Uploads an original video and creates a library item with version label `Original`.
Returns `201` with the item detail. Uses the same size/type/disk limits as jobs.

### `GET /api/library/{item_id}`
Returns the item plus all versions:
```json
{
  "id": "lib_…", "name": "holiday.mp4",
  "activeVersionId": "v_…", "versionCount": 3,
  "versions": [
    {
      "id": "v_…", "parentVersionId": null, "jobId": null,
      "label": "Original", "metadata": { }, "settings": { },
      "createdAt": "…"
    }
  ],
  "activeVersion": { }
}
```

### `POST /api/library/{item_id}/activate`
```json
{ "versionId": "v_…" }
```
Restores a version as the active branch point. Returns the updated item.

### `DELETE /api/library/{item_id}` → `204`
Deletes the item and all files/versions. Returns `409` while any job references the item.

### `GET /api/library/{item_id}/versions/{version_id}/stream`
Inline video response; supports HTTP Range requests for seeking.

### `GET /api/library/{item_id}/versions/{version_id}/download`
Attachment download.

### `GET /api/library/{item_id}/versions/{version_id}/thumbnail`
JPEG thumbnail for the version.

## Polling guidance
- `/api/jobs` every 2 s while active jobs exist; pause when `document.hidden`.
- `/api/library` after a library job completes; refresh the open detail.
- Do not poll faster than 1 s.
