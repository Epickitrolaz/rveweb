# RVEWeb API contract (v1)

The backend is a FastAPI service. The frontend is served from the same origin, so all
requests use relative URLs (`/api/...`). All request/response bodies are JSON unless
noted. Errors use `{ "detail": "human readable message" }` with an appropriate status
code.

## Health & system

### `GET /health`
```json
{ "status": "ok", "version": "1.0.0", "uptimeSeconds": 123.4 }
```

### `GET /api/system`
```json
{
  "gpu": { "available": true, "name": "AMD Radeon Vega 11 Graphics (RADV RAVEN)", "backend": "vulkan" },
  "cpu": { "cores": 4, "load1": 0.42 },
  "memory": { "totalMb": 8192, "availableMb": 6120 },
  "storage": { "freeGb": 12.8 },
  "queue": { "active": 1, "queued": 2, "maxActive": 1, "maxQueue": 50 },
  "limits": { "maxUploadMb": 1024, "minFreeGb": 3, "retentionHours": 72, "maxOutputPixels": 8294400 },
  "models": {
    "upscalers": [
      { "id": "realesrgan-video", "label": "Real-ESRGAN v3 · Video", "scales": [2, 3, 4], "note": "Fast, video-tuned" },
      { "id": "realesrgan-x4plus", "label": "Real-ESRGAN x4plus · Detail", "scales": [2, 4], "note": "Slow, maximum detail" },
      { "id": "realesrgan-x4plus-anime", "label": "Real-ESRGAN x4plus Anime", "scales": [2, 4], "note": "Animation line art" }
    ],
    "interpolators": [
      { "id": "rife-4.27", "label": "RIFE 4.27", "factors": [2, 4, 8], "note": "Quality" },
      { "id": "rife-4.27-s", "label": "RIFE 4.27 Small", "factors": [2, 4, 8], "note": "Faster, lighter" }
    ]
  }
}
```
`gpu.available` may be false; the UI must still work and say GPU is unavailable.
`storage.freeGb` may be low; the UI should warn under 3 GB.
`limits.maxOutputPixels` is the projected width × height ceiling (4K); reject an upload with
`422` before queueing if the chosen upscale would exceed it.

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
    "width": 640,
    "height": 360,
    "fps": 24,
    "duration": 8.5,
    "sizeBytes": 1823412
  },
  "settings": {
    "upscale": { "enabled": true, "model": "realesrgan-video", "scale": 2 },
    "interpolate": { "enabled": true, "model": "rife-4.27", "factor": 2, "maxHeight": 1080 },
    "denoise": { "enabled": false, "strength": "medium" },
    "decompress": { "enabled": false, "strength": "light" },
    "encode": { "codec": "h264", "crf": 18, "preset": "veryfast", "container": "mp4" },
    "audio": { "mode": "copy" }
  },
  "output": null,
  "error": null,
  "createdAt": "2026-11-14T20:12:31Z",
  "startedAt": "2026-11-14T20:12:35Z",
  "completedAt": null
}
```
`status`: `queued` | `processing` | `completed` | `failed` | `cancelled` | `cancel_requested`.
`stage`: `queued` | `decode` | `denoise` | `upscale` | `interpolate` | `encode` | `finalize` | `done`.
`progress` is 0..1 for the whole job. `etaSeconds` may be null.
When completed, `output` is:
```json
{ "width": 1280, "height": 720, "fps": 48, "duration": 8.5, "sizeBytes": 9982211, "filename": "holiday-enhanced.mp4" }
```
When failed, `error` is a short plain-text message safe to display.

### `POST /api/jobs` (multipart/form-data)
Fields:
- `file` — the video file (required)
- `settings` — JSON string matching the settings object above (required)

Returns `201` with the job object. Possible errors:
- `413` upload too large
- `415` unsupported file type
- `422` invalid video or invalid settings
- `429` queue full (detail explains)
- `507` not enough disk space

### `GET /api/jobs?limit=20`
```json
{ "jobs": [ /* newest first */ ], "queue": { "active": 1, "queued": 2, "maxActive": 1, "maxQueue": 50 } }
```

### `GET /api/jobs/{id}`
Returns the job object, or `404`.

### `POST /api/jobs/{id}/cancel`
Returns `202` with the job object (status becomes `cancel_requested` or `cancelled`).
`409` if the job is already finished.

### `DELETE /api/jobs/{id}`
Deletes a finished/failed/cancelled job and its files. `204` on success. `409` while active.

### `GET /api/jobs/{id}/download`
Streams the completed output file with `Content-Disposition: attachment`. `409` if not completed.

### `GET /api/jobs/{id}/thumbnail`
Returns a JPEG thumbnail of the source frame (or `404`). Used in queue cards.

## Settings validation rules
- `upscale.enabled` boolean; `model` one of upscaler ids; `scale` one of the model's scales.
- `interpolate.enabled` boolean; `model` one of interpolator ids; `factor` 2, 4, or 8;
  `maxHeight` one of 480, 720, 1080, 2160, 0 (0 = native).
- `denoise.enabled` boolean; `strength` `light` | `medium` | `strong`.
- `decompress.enabled` boolean; `strength` `light` | `strong`.
- `encode.codec` `h264` | `h265`; `crf` integer 14..28; `preset` `veryfast` | `fast` | `medium`;
  `container` `mp4` | `mkv`.
- `audio.mode` `copy` | `none`.
Unknown keys must be rejected with `422`.

## Polling guidance for the UI
- Fetch `/api/jobs` on load and every 2 s while any job is queued/processing.
- Poll individual active jobs every 1.2 s only if you need smoother progress; otherwise the
  list endpoint is enough.
- Pause polling when `document.hidden` is true; resume on visibilitychange.
- Thumbnails may 404 until generated; hide broken images.
