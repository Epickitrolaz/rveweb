# RVEWeb frontend brief

Build the single-page web console for **RVEWeb**, a local video restoration station that
upscales, interpolates, denoises, and decompresses video. It talks to the backend defined in
[`docs/API.md`](./API.md), served from the same origin.

## Non-negotiables
- **No framework, no build step.** Plain HTML + CSS + ES modules. Works when served statically.
- **No external network requests.** Fonts are in `frontend/fonts/` (see `fonts.css`). No CDN,
  no Google Fonts, no icon libraries.
- **Only write inside `frontend/`.** Do not touch backend, docs, Docker, or deployment files.
- Must work at 360 px wide and at 1440 px wide, keyboard-only, and with reduced motion.
- No emoji. Icons are small inline SVGs drawn with `stroke="currentColor"`.
- All user-facing copy in English, plain and specific. No marketing filler, no exclamation marks.

## Product context
This runs on a small home server with one AMD iGPU. Processing is genuinely slow, so the UI's
job is to make the wait legible: show what the machine is doing, how far along it is, and the
exact transformation that will happen. The app is a tool, not a landing page. The first screen
is the working console.

## Visual direction: the telecine bay
The reference world is a film-transfer suite: graphite equipment, warm tungsten indicators,
calm typography, precise readouts. Restrained and instrument-like, not cyberpunk and not a SaaS
dashboard.

Avoid these defaults: cream background with terracotta accent; near-black with acid green;
broadsheet hairlines everywhere; identical rounded cards with the same shadow; all-caps
eyebrow labels; gradient washes; "→" appended to buttons.

### Color tokens
```css
--bg:        #0b0d0e;  /* matte graphite, cool but not blue-black */
--panel:     #121619;
--panel-2:   #171d21;
--line:      #273036;
--line-soft: #1c2328;
--ink:       #eae6dc;  /* warm paper white */
--muted:     #98a3a8;
--faint:     #657077;
--accent:    #e9a23b;  /* tungsten amber; active states, CTA, focus rings */
--accent-ink:#1a1205;
--ok:        #8fbf9f;
--bad:       #e2725b;
--info:      #8fb4c9;
```
Use amber sparingly: the primary CTA, the active stage, focus rings, and progress. Never use it
for large backgrounds. Success is muted green, errors are clay red.

### Type
- Display/headings: **Bricolage Grotesque** (variable 400–800), tight tracking, optical sizes.
- Body/UI: **IBM Plex Sans** 400/500/600.
- Data, timecodes, resolutions, filenames: **IBM Plex Mono** 400/500.
- Body line length stays under ~75 characters. Base 15–16 px. Do not use all-caps labels;
  use sentence case.

### Layout
Desktop: a 1240 px max-width console on a graphite field, 32 px gutters. Header row with
wordmark, a live system status strip, and a small "How it works" text link that opens an inline
explainer (no modal). Then a two-column workspace: left `minmax(0, 1.55fr)` for source + signal
chain, right `minmax(320px, 1fr)` for the activity queue. Columns align at the top; the queue
column may scroll independently on tall screens but must not trap scroll on mobile.

At < 900 px: one column, queue after the settings. The header status strip wraps to a second
row. At < 560 px: reduce gutters to 16 px, source preview 16:9, stage rows stack their controls.

```
┌────────────────────────────────────────────────────────────────────┐
│ RVE/WEB      ● GPU Vega 11   ● 4 cores   1 active · 2 queued      │
├──────────────────────────────────┬─────────────────────────────────┤
│  SOURCE                          │  ACTIVITY                       │
│  ┌────────────────────────────┐  │  ┌───────────────────────────┐  │
│  │  drop video / preview      │  │  │ holiday.mp4   interpolate │  │
│  │                            │  │  │ ▓▓▓▓▓▓░░░░░░  43% · 1m34s │  │
│  └────────────────────────────┘  │  └───────────────────────────┘  │
│  holiday.mp4 · 640×360 · 24fps   │  ┌───────────────────────────┐  │
│  00:00:08.500 · 1.7 MB           │  │ clip2.mkv      queued     │  │
│                                  │  └───────────────────────────┘  │
│  OUTPUT PROJECTION               │                                 │
│  640×360 → 1280×720              │  empty state: "Nothing in the   │
│  24 → 48 fps · 8.5 s             │  queue. Drop a clip to start."  │
│                                  │                                 │
│  SIGNAL CHAIN                    │                                 │
│  ┌ decompress  [off]           ┐ │                                 │
│  ┌ denoise     [off]           ┐ │                                 │
│  ┌ upscale     [on]  v3 · 2×   ┐ │                                 │
│  ┌ interpolate [on]  RIFE 2×   ┐ │                                 │
│  ┌ encode      [on]  H.264 18  ┐ │                                 │
│                                  │                                 │
│  [ Start enhancement ]           │                                 │
└──────────────────────────────────┴─────────────────────────────────┘
```

The output projection is the page's one big typographic moment: resolution equation in
Bricolage at ~34–40 px with the arrow as a real glyph, and fps/timecode beneath in Plex Mono.
Update it live as settings change. It must be truthful for every combination.

## Required elements and behavior

### Header
- Wordmark `RVE/WEB` (the slash is amber). A small line beneath: "video restoration station".
- System strip: GPU name (truncated with title/tooltip), CPU core count + load average, queue
  counts. Status dots: amber when active, green when idle/available, clay when unavailable.
- Link "How it works" toggles a short inline panel (three sentences max) explaining the stages
  and that processing runs locally. Set `aria-expanded`.

### Source panel
- Large drop target with dashed 1px rule, no rounded-card look: use a 2 px corner cut or a
  sprocket-hole strip down one edge as the only decorative flourish. Keep it subtle.
- Accept drag/drop and click-to-browse. Accept video files listed by the backend; validate
  extension client-side and show a clear inline error for unsupported files.
- On selection: show a `<video>` preview (muted, controls, `preload="metadata"`), filename,
  dimensions, fps, duration, size. Read metadata from the file; then the server job result
  supersedes it.
- "Replace" button and a keyboard-accessible drop target (`role="button"`, Enter/Space).
- If no file: show a short instruction, accepted formats, and the upload size limit.
- Upload happens when the user starts a job. Show upload progress as part of the job card or
  the CTA (e.g. "Uploading 42%"); disable duplicate submits.

### Signal chain
Five stages, each a horizontal row separated by a 1 px rule (not five floating cards):
1. **Decompress** — removes block/ringing artifacts. Toggle; strength `Light`/`Strong`.
2. **Denoise** — temporal/spatial cleanup. Toggle; `Light`/`Medium`/`Strong`.
3. **Upscale** — AI or fast scaling. Toggle; model select + scale `2×`/`3×`/`4×`.
4. **Interpolate** — RIFE 4.27 frame generation. Toggle; model, factor `2×`/`4×`/`8×`.
5. **Encode** — always on; codec (H.264/H.265), quality slider/CRF 14–28 with "Better ← → Smaller"
   labels, container (MP4/MKV). Keep this compact; hide preset under "Advanced" if needed.
   Also an "AI working height" select (Auto/480/720/1080/2160/full) under Interpolate advanced,
   defaulting to 1080.

Each row: number-free (no `01/02/03` decoration), left-aligned stage name + one-line purpose in
muted text, controls right-aligned. Toggle is a custom switch with a visible focus ring and
proper `role="switch"`/`aria-checked`, or a real checkbox styled accessibly. Active stages get a
thin amber rule on the left and their options become visible. Disabled stages dim but remain
readable.

Three presets above the chain, as text buttons: **Restore** (decompress light + denoise medium +
upscale v3 2×), **Smooth** (RIFE 4.27 2×), **Max** (v3 4× + RIFE 4× + denoise light). Presets must
set all toggles and options correctly and visibly update the projection.

### CTA
- Primary button: `Start enhancement`, amber fill, dark text, 44 px min height, sits at the end of
  the settings column. Secondary `Reset` clears the file and settings to defaults.
- Disabled when no file or when the queue is full (max queue reached), with a reason beneath.
- After submit: reset the file input but keep settings; the new job appears at the top of the
  queue. Show a brief inline confirmation with the job's queue position (no toast library).

### Activity queue
- Header shows active/queued counts and a small "Refresh" icon button.
- Job card: file name, status label, current stage, progress bar, `percent · ETA` in Plex Mono,
  actions (Cancel while active; Download when done; Remove when finished). Thumbnail at 56×32
  if available, otherwise a frame-shaped placeholder with a play glyph.
- Status colors: queued = muted, processing = amber, completed = green, failed = clay,
  cancelled = faint. Use text + color, never color alone.
- Failed cards show the error in full (wrapping) and a "Dismiss" action.
- Empty state: one sentence and a hint that processing runs on this machine.
- Download uses the backend URL; set `download` attribute.
- On `429` / `503`, show the detail message next to the CTA and keep the selected file.

### Offline / degraded states
- If `/api/system` fails, show "Server unreachable — retrying" in the header; disable submit;
  retry with backoff (2s, 4s, 8s, capped 15s).
- If `gpu.available` is false, show "CPU only" and keep upscale selectable with a note that it
  will be slower.
- If `storage.freeGb < 3`, show a persistent warning line under the CTA.

## Motion and focus
- One orchestrated load reveal: header, then source/queue columns fade/translate up 8 px with
  60 ms stagger. That is the only entrance animation. No per-section reveals on scroll.
- Progress bar width transitions 200 ms linear; status changes cross-fade 120 ms.
- Respect `prefers-reduced-motion: reduce` (disable transforms/transitions).
- Visible `:focus-visible` ring in amber, 2 px offset, on every interactive element.

## Accessibility
- All form controls have visible labels or `aria-label`; stage toggles use `role="switch"`.
- The queue is a `<ul>` with `<li>` job cards; announce status changes via `aria-live="polite"`
  on a visually hidden live region, not on every card.
- Error messages use `role="alert"` where appropriate, with focus moved to the error summary.
- Contrast: body text ≥ 4.5:1 on panel backgrounds; muted text may be 3:1 only for decorative
  meta, not essential info.
- The video preview must not autoplay audio; default muted.

## Data handling details
- API base is same-origin; use `fetch('/api/...')`.
- Format timecodes as `HH:MM:SS.mmm` in the source meta, and `m:ss` for ETA under 1 h.
- Format bytes with one decimal (e.g. `1.7 MB`), durations with one decimal (`8.5 s`), fps as
  integer unless fractional.
- Projection math: width × upscale.scale (rounded to even), height × upscale.scale; fps ×
  interpolate.factor; duration unchanged. Account for `interpolate.maxHeight` only in a small
  note ("AI runs at 720p then upscales"), not in the output resolution.
- Persist nothing client-side except the last-used settings in `localStorage` under
  `rveweb.settings.v1` (validate before use).
- Never render server-provided filenames as HTML without escaping; build DOM nodes with
  `textContent`.

## Files
Create:
- `frontend/index.html`
- `frontend/styles.css`
- `frontend/app.js` (ES module)
- `frontend/assets/` for any inline SVG sprite or small static art you add

Fonts already exist in `frontend/fonts/`; import `./fonts/fonts.css` from `styles.css`.

## Definition of done
- Console renders correctly with a mock API and with no API (offline state).
- A file can be selected by drag/drop and picker; metadata and projection update.
- All five stages toggle, options work, presets work, settings persist.
- Submit posts multipart with the exact settings schema; progress/ETA and all job states render.
- Cancel, download, remove, and failed-job flows work.
- Keyboard-only pass works; focus visible; reduced motion respected; responsive at 360, 768,
  1024, 1440.
- No console errors during normal flows, no external network requests, no layout overflow.
- `frontend/README.md` documents how to preview with `python3 -m http.server` and what API
  responses to mock for manual testing.
