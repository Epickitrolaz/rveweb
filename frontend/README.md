# RVEWeb frontend

The console is plain HTML, CSS, and ES modules. There is no build step and no runtime
dependency on a CDN. Fonts live in `fonts/` and are imported by `styles.css`.

## Preview

```bash
# from the repository root
python3 -m http.server 5173 --directory frontend
```

Open <http://localhost:5173>. With no backend, the console shows its offline state; that is
intentional.

For the full experience, run the backend (see the root README) and open the app from the
same origin, usually <http://10.0.0.121:8080>. API calls are relative (`/api/...`).

## What it expects

- `GET /health`
- `GET /api/system` (models, GPU, queue, `limits.maxUploadMb`, `limits.maxOutputPixels`)
- `GET /api/settings` / `PUT /api/settings`
- `GET /api/jobs?limit=20`
- `POST /api/jobs` (multipart: `file` or `libraryVersionId`, plus `settings` JSON)
- `POST /api/jobs/{id}/cancel`
- `DELETE /api/jobs/{id}`
- `GET /api/jobs/{id}/thumbnail`
- `GET /api/jobs/{id}/download`
- `GET /api/library`, `POST /api/library`
- `GET /api/library/{id}`
- `POST /api/library/{id}/activate`
- `DELETE /api/library/{id}`
- `GET /api/library/{id}/versions/{versionId}/stream|download|thumbnail`

See [../docs/API.md](../docs/API.md) for the exact payloads.

## Tabs

- **Enhance** — source, projection, signal chain, activity queue.
- **Library** — persistent uploads, playback, download, branching and restore.
- **Settings** — Auto/GPU-only/CPU-only processing mode, new-job defaults, station info.

## Notes

- Settings persist in `localStorage` under `rveweb.settings.v1` and are validated against
  the model catalog returned by `/api/system`.
- Polling pauses while the tab is hidden and backs off on connection failures.
- Upload progress uses `XMLHttpRequest`; job progress uses the list endpoint.
- The queue column is an independent scroll region on desktop; on mobile it follows the
  settings in normal page flow.
- Reduced-motion, focus-visible, keyboard operation, and the offline/degraded states are
  all handled in `app.js` and `styles.css`.

## Manual mock

A quick mock is enough to exercise the UI without the pipeline:

```bash
python3 - <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
class H(BaseHTTPRequestHandler):
    def _json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path.startswith('/api/system'):
            self._json({"gpu":{"available":True,"name":"Mock Vulkan GPU","backend":"vulkan"},
                        "cpu":{"cores":4,"load1":0.4},"memory":{"totalMb":8192,"availableMb":5000},
                        "storage":{"freeGb":10.0},"queue":{"active":0,"queued":0,"maxActive":1,"maxQueue":25},
                        "limits":{"maxUploadMb":1024,"minFreeGb":3,"retentionHours":72,"maxOutputPixels":8294400},
                        "models":{"upscalers":[{"id":"realesrgan-video","label":"Real-ESRGAN v3 · Video","scales":[2,3,4],"note":"Fast"}],
                                  "interpolators":[{"id":"rife-4.27","label":"RIFE 4.27","factors":[2,4,8],"note":"Quality"}]}})
        elif self.path.startswith('/api/jobs'):
            self._json({"jobs":[],"queue":{"active":0,"queued":0,"maxActive":1,"maxQueue":25}})
        else:
            self.send_error(404)
    def log_message(self, *_): pass
HTTPServer(('127.0.0.1', 8000), H).serve_forever()
PY
```

Then open <http://localhost:5173> with the mock on port 8000 behind a simple proxy, or
temporarily point the fetch calls at `http://localhost:8000`. Do not commit mock servers or
sample media.
