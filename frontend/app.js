const SETTINGS_KEY = 'rveweb.settings.v1';
let MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
let MAX_OUTPUT_PIXELS = 3840 * 2160;
const ACCEPTED_EXTENSIONS = new Set(['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v']);
const ACTIVE_STATUSES = new Set(['queued', 'processing', 'cancel_requested']);
const POLL_ACTIVE_MS = 2000;
const SYSTEM_POLL_MS = 30000;
const BACKOFF_MS = [2000, 4000, 8000, 15000];
const MAX_JOBS = 20;

const FALLBACK_MODELS = {
  upscalers: [
    { id: 'realesrgan-video', label: 'Real-ESRGAN v3 · Video', scales: [2, 3, 4], note: 'Fast, video-tuned' },
    { id: 'realesrgan-x4plus', label: 'Real-ESRGAN x4plus · Detail', scales: [2, 4], note: 'Slow, maximum detail' },
    { id: 'realesrgan-x4plus-anime', label: 'Real-ESRGAN x4plus Anime', scales: [2, 4], note: 'Animation line art' },
  ],
  interpolators: [
    { id: 'rife-4.27', label: 'RIFE 4.27', factors: [2, 4, 8], note: 'Quality' },
    { id: 'rife-4.27-s', label: 'RIFE 4.27 Small', factors: [2, 4, 8], note: 'Faster, lighter' },
  ],
};

const DEFAULT_SETTINGS = {
  upscale: { enabled: true, model: 'realesrgan-video', scale: 2 },
  interpolate: { enabled: true, model: 'rife-4.27', factor: 2, maxHeight: 1080 },
  denoise: { enabled: false, strength: 'medium' },
  decompress: { enabled: false, strength: 'light' },
  encode: { codec: 'h264', crf: 18, preset: 'veryfast', container: 'mp4' },
  audio: { mode: 'copy' },
};

const STAGE_LABELS = {
  queued: 'Waiting',
  decode: 'Decoding',
  denoise: 'Denoising',
  upscale: 'Upscaling',
  interpolate: 'Interpolating',
  encode: 'Encoding',
  finalize: 'Finalizing',
  done: 'Done',
};

const STATUS_LABELS = {
  queued: 'Queued',
  processing: 'Processing',
  cancel_requested: 'Cancelling',
  completed: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STATUS_KINDS = {
  queued: 'queued',
  processing: 'processing',
  cancel_requested: 'processing',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

const els = {
  howToggle: document.getElementById('howToggle'),
  howPanel: document.getElementById('howPanel'),
  sysStrip: document.getElementById('sysStrip'),
  gpuDot: document.getElementById('gpuDot'),
  gpuValue: document.getElementById('gpuValue'),
  cpuDot: document.getElementById('cpuDot'),
  cpuValue: document.getElementById('cpuValue'),
  queueDot: document.getElementById('queueDot'),
  queueValue: document.getElementById('queueValue'),
  stationVersion: document.getElementById('stationVersion'),

  sourceBadge: document.getElementById('sourceBadge'),
  sourceFrame: document.getElementById('sourceFrame'),
  dropzone: document.getElementById('dropzone'),
  sourceError: document.getElementById('sourceError'),
  sourceFormats: document.getElementById('sourceFormats'),
  fileInput: document.getElementById('fileInput'),
  previewWrap: document.getElementById('previewWrap'),
  videoPreview: document.getElementById('videoPreview'),
  replaceBtn: document.getElementById('replaceBtn'),
  sourceMeta: document.getElementById('sourceMeta'),
  sourceName: document.getElementById('sourceName'),
  sourceDims: document.getElementById('sourceDims'),
  sourceFps: document.getElementById('sourceFps'),
  sourceDuration: document.getElementById('sourceDuration'),
  sourceSize: document.getElementById('sourceSize'),
  sourceNote: document.getElementById('sourceNote'),

  projFrom: document.getElementById('projFrom'),
  projTo: document.getElementById('projTo'),
  projSub: document.getElementById('projSub'),
  projNote: document.getElementById('projNote'),
  projRatio: document.getElementById('projRatio'),
  projectionSr: document.getElementById('projectionSr'),

  upscaleModel: document.getElementById('upscaleModel'),
  upscaleScale: document.getElementById('upscaleScale'),
  interpolateModel: document.getElementById('interpolateModel'),
  interpolateFactor: document.getElementById('interpolateFactor'),
  interpolateMaxHeight: document.getElementById('interpolateMaxHeight'),
  decompressStrength: document.getElementById('decompressStrength'),
  denoiseStrength: document.getElementById('denoiseStrength'),
  encodeCodec: document.getElementById('encodeCodec'),
  encodeContainer: document.getElementById('encodeContainer'),
  encodePreset: document.getElementById('encodePreset'),
  audioMode: document.getElementById('audioMode'),
  crfInput: document.getElementById('crfInput'),
  crfValue: document.getElementById('crfValue'),
  gpuNote: document.getElementById('gpuNote'),

  startButton: document.getElementById('startButton'),
  resetButton: document.getElementById('resetButton'),
  uploadTrack: document.getElementById('uploadTrack'),
  uploadFill: document.getElementById('uploadFill'),
  ctaNote: document.getElementById('ctaNote'),
  ctaError: document.getElementById('ctaError'),
  ctaStatus: document.getElementById('ctaStatus'),
  diskWarning: document.getElementById('diskWarning'),
  diskWarningText: document.getElementById('diskWarningText'),

  activityCount: document.getElementById('activityCount'),
  refreshButton: document.getElementById('refreshButton'),
  queueNotice: document.getElementById('queueNotice'),
  jobList: document.getElementById('jobList'),
  queueEmpty: document.getElementById('queueEmpty'),
  liveRegion: document.getElementById('liveRegion'),
  jobTemplate: document.getElementById('jobTemplate'),
};

const state = {
  settings: loadSettings(),
  models: clone(FALLBACK_MODELS),
  modelsSignature: JSON.stringify(FALLBACK_MODELS),

  system: null,
  systemOnline: null,
  systemInFlight: false,
  systemTimer: null,
  systemBackoff: 0,
  systemRetryDelay: 0,

  queue: null,
  jobs: [],
  jobsInitialized: false,
  jobsOnline: true,
  jobsInFlight: false,
  jobsTimer: null,
  jobsBackoff: 0,
  jobsRetryDelay: 0,

  jobNodes: new Map(),
  previousStatuses: new Map(),

  selected: null,
  mediaToken: 0,
  fpsProbeToken: 0,
  uploading: false,
  uploadXhr: null,
  uploadPercent: 0,
  confirmJobId: null,
  confirmTimer: null,
  queueNoticeUntil: 0,

  dragDepth: 0,
};

function $(id) {
  return document.getElementById(id);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function enumOr(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/* ---------- settings ---------- */

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return clone(DEFAULT_SETTINGS);
    return sanitizeSettings(JSON.parse(raw), FALLBACK_MODELS);
  } catch {
    return clone(DEFAULT_SETTINGS);
  }
}

function sanitizeSettings(input, models) {
  const source = input && typeof input === 'object' ? input : {};
  const defaults = clone(DEFAULT_SETTINGS);
  const upscalers = Array.isArray(models?.upscalers) && models.upscalers.length ? models.upscalers : FALLBACK_MODELS.upscalers;
  const interpolators = Array.isArray(models?.interpolators) && models.interpolators.length ? models.interpolators : FALLBACK_MODELS.interpolators;

  const rawUpscale = source.upscale && typeof source.upscale === 'object' ? source.upscale : {};
  const rawInterpolate = source.interpolate && typeof source.interpolate === 'object' ? source.interpolate : {};
  const rawDenoise = source.denoise && typeof source.denoise === 'object' ? source.denoise : {};
  const rawDecompress = source.decompress && typeof source.decompress === 'object' ? source.decompress : {};
  const rawEncode = source.encode && typeof source.encode === 'object' ? source.encode : {};
  const rawAudio = source.audio && typeof source.audio === 'object' ? source.audio : {};

  const upscaler = upscalers.find((item) => item.id === rawUpscale.model) || upscalers[0];
  const upscaleScales = Array.isArray(upscaler.scales) && upscaler.scales.length ? upscaler.scales : [2, 3, 4];
  const chosenScale = Number(rawUpscale.scale);
  const upscaleScale = upscaleScales.includes(chosenScale)
    ? chosenScale
    : (upscaleScales.includes(DEFAULT_SETTINGS.upscale.scale) ? DEFAULT_SETTINGS.upscale.scale : upscaleScales[0]);

  const interpolator = interpolators.find((item) => item.id === rawInterpolate.model) || interpolators[0];
  const factors = Array.isArray(interpolator.factors) && interpolator.factors.length ? interpolator.factors : [2, 4, 8];
  const chosenFactor = Number(rawInterpolate.factor);
  const factor = factors.includes(chosenFactor)
    ? chosenFactor
    : (factors.includes(DEFAULT_SETTINGS.interpolate.factor) ? DEFAULT_SETTINGS.interpolate.factor : factors[0]);

  const maxHeight = Number(rawInterpolate.maxHeight);
  const crf = Number(rawEncode.crf);

  return {
    upscale: {
      enabled: boolOr(rawUpscale.enabled, defaults.upscale.enabled),
      model: upscaler.id,
      scale: upscaleScale,
    },
    interpolate: {
      enabled: boolOr(rawInterpolate.enabled, defaults.interpolate.enabled),
      model: interpolator.id,
      factor,
      maxHeight: [0, 480, 720, 1080, 2160].includes(maxHeight) ? maxHeight : defaults.interpolate.maxHeight,
    },
    denoise: {
      enabled: boolOr(rawDenoise.enabled, defaults.denoise.enabled),
      strength: enumOr(rawDenoise.strength, ['light', 'medium', 'strong'], defaults.denoise.strength),
    },
    decompress: {
      enabled: boolOr(rawDecompress.enabled, defaults.decompress.enabled),
      strength: enumOr(rawDecompress.strength, ['light', 'strong'], defaults.decompress.strength),
    },
    encode: {
      codec: enumOr(rawEncode.codec, ['h264', 'h265'], defaults.encode.codec),
      crf: Number.isInteger(crf) ? clamp(crf, 14, 28) : defaults.encode.crf,
      preset: enumOr(rawEncode.preset, ['veryfast', 'fast', 'medium'], defaults.encode.preset),
      container: enumOr(rawEncode.container, ['mp4', 'mkv'], defaults.encode.container),
    },
    audio: {
      mode: enumOr(rawAudio.mode, ['copy', 'none'], defaults.audio.mode),
    },
  };
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {
    /* Storage can be unavailable in private windows. The console still works. */
  }
}

function normalizeModels(raw) {
  const cleanList = (items, kind) => {
    if (!Array.isArray(items)) return [];
    return items
      .filter((item) => item && typeof item === 'object' && typeof item.id === 'string' && item.id.trim())
      .map((item) => {
        const values = kind === 'upscaler' ? item.scales : item.factors;
        const numbers = Array.isArray(values)
          ? values.map(Number).filter((n) => Number.isFinite(n) && n > 0)
          : [];
        return {
          id: item.id,
          label: typeof item.label === 'string' && item.label.trim() ? item.label : item.id,
          scales: kind === 'upscaler' ? numbers : undefined,
          factors: kind === 'interpolator' ? numbers : undefined,
          note: typeof item.note === 'string' ? item.note : '',
        };
      })
      .filter((item) => (kind === 'upscaler' ? item.scales?.length : item.factors?.length));
  };

  const upscalers = cleanList(raw?.upscalers, 'upscaler');
  const interpolators = cleanList(raw?.interpolators, 'interpolator');
  return {
    upscalers: upscalers.length ? upscalers : clone(FALLBACK_MODELS.upscalers),
    interpolators: interpolators.length ? interpolators : clone(FALLBACK_MODELS.interpolators),
  };
}

function rebuildModelSelects() {
  const upscalers = state.models.upscalers;
  const interpolators = state.models.interpolators;

  fillSelect(els.upscaleModel, upscalers.map((model) => ({ value: model.id, label: model.label })));
  fillSelect(els.interpolateModel, interpolators.map((model) => ({ value: model.id, label: model.label })));

  if (!upscalers.some((model) => model.id === state.settings.upscale.model)) {
    state.settings.upscale.model = upscalers[0].id;
  }
  if (!interpolators.some((model) => model.id === state.settings.interpolate.model)) {
    state.settings.interpolate.model = interpolators[0].id;
  }

  els.upscaleModel.value = state.settings.upscale.model;
  els.interpolateModel.value = state.settings.interpolate.model;
  renderScaleOptions();
  renderFactorOptions();
}

function fillSelect(select, items) {
  select.replaceChildren();
  for (const item of items) {
    const option = document.createElement('option');
    option.value = String(item.value);
    option.textContent = item.label;
    select.appendChild(option);
  }
}

function currentUpscaler() {
  return state.models.upscalers.find((model) => model.id === state.settings.upscale.model) || state.models.upscalers[0];
}

function currentInterpolator() {
  return state.models.interpolators.find((model) => model.id === state.settings.interpolate.model) || state.models.interpolators[0];
}

function renderScaleOptions() {
  const model = currentUpscaler();
  const scales = model?.scales?.length ? model.scales : [2, 3, 4];
  if (!scales.includes(state.settings.upscale.scale)) {
    state.settings.upscale.scale = scales[0];
  }
  fillSelect(els.upscaleScale, scales.map((scale) => ({ value: String(scale), label: `${scale}×` })));
  els.upscaleScale.value = String(state.settings.upscale.scale);
}

function renderFactorOptions() {
  const model = currentInterpolator();
  const factors = model?.factors?.length ? model.factors : [2, 4, 8];
  if (!factors.includes(state.settings.interpolate.factor)) {
    state.settings.interpolate.factor = factors[0];
  }
  fillSelect(els.interpolateFactor, factors.map((factor) => ({ value: String(factor), label: `${factor}×` })));
  els.interpolateFactor.value = String(state.settings.interpolate.factor);
}

function applySettingsToControls() {
  const settings = state.settings;

  for (const stage of ['decompress', 'denoise', 'upscale', 'interpolate']) {
    const enabled = settings[stage].enabled;
    const row = document.querySelector(`.stage[data-stage="${stage}"]`);
    const toggle = document.querySelector(`[data-toggle="${stage}"]`);
    const wrap = toggle.closest('.switch-wrap');
    const stateLabel = wrap.querySelector('.switch-state');
    const options = document.querySelector(`[data-options="${stage}"]`);

    toggle.setAttribute('aria-checked', String(enabled));
    wrap.classList.toggle('is-on', enabled);
    stateLabel.textContent = enabled ? 'On' : 'Off';
    row.classList.toggle('is-on', enabled);
    row.classList.toggle('is-off', !enabled);
    options.hidden = !enabled;
  }

  els.decompressStrength.value = settings.decompress.strength;
  els.denoiseStrength.value = settings.denoise.strength;
  els.upscaleModel.value = settings.upscale.model;
  renderScaleOptions();
  els.interpolateModel.value = settings.interpolate.model;
  renderFactorOptions();
  els.interpolateMaxHeight.value = String(settings.interpolate.maxHeight);
  els.encodeCodec.value = settings.encode.codec;
  els.encodeContainer.value = settings.encode.container;
  els.encodePreset.value = settings.encode.preset;
  els.audioMode.value = settings.audio.mode;
  els.crfInput.value = String(settings.encode.crf);
  updateCrfReadout();
}

function updateCrfReadout() {
  const crf = state.settings.encode.crf;
  const quality = crf <= 18 ? 'better quality' : crf >= 24 ? 'smaller file' : 'balanced';
  els.crfValue.textContent = `CRF ${crf}`;
  els.crfInput.setAttribute('aria-valuetext', `CRF ${crf}, ${quality}`);
}

function applyPreset(name) {
  const settings = state.settings;
  const presets = {
    restore: {
      decompress: { enabled: true, strength: 'light' },
      denoise: { enabled: true, strength: 'medium' },
      upscale: { enabled: true, model: 'realesrgan-video', scale: 2 },
      interpolate: { enabled: false },
    },
    smooth: {
      decompress: { enabled: false },
      denoise: { enabled: false },
      upscale: { enabled: false },
      interpolate: { enabled: true, model: 'rife-4.27', factor: 2, maxHeight: 1080 },
    },
    max: {
      decompress: { enabled: false },
      denoise: { enabled: true, strength: 'light' },
      upscale: { enabled: true, model: 'realesrgan-video', scale: 4 },
      interpolate: { enabled: true, model: 'rife-4.27', factor: 4, maxHeight: 1080 },
    },
  };

  const preset = presets[name];
  if (!preset) return;

  for (const stage of ['decompress', 'denoise', 'upscale', 'interpolate']) {
    Object.assign(settings[stage], preset[stage]);
  }

  state.settings = sanitizeSettings(settings, state.models);
  saveSettings();
  rebuildModelSelects();
  applySettingsToControls();
  updateProjection();
  updateCta();
}

/* ---------- formatting ---------- */

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let scaled = value;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return index === 0 ? `${Math.round(scaled)} B` : `${scaled.toFixed(1)} ${units[index]}`;
}

function formatFps(fps) {
  const value = Number(fps);
  if (!Number.isFinite(value) || value <= 0) return '—';
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) < 0.01) return String(rounded);
  return String(Number(value.toFixed(3)));
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '—';
  return `${value.toFixed(1)} s`;
}

function formatTimecode(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '—';
  const totalMs = Math.round(value * 1000);
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function formatEta(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return 'estimating';
  const total = Math.round(value);
  if (total < 3600) {
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }
  return `${Math.floor(total / 3600)}h ${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`;
}

function stageLabel(stage) {
  if (!stage) return 'Preparing';
  return STAGE_LABELS[stage] || String(stage).charAt(0).toUpperCase() + String(stage).slice(1);
}

function fileExtension(name) {
  const value = String(name || '');
  const dot = value.lastIndexOf('.');
  return dot >= 0 ? value.slice(dot + 1).toLowerCase() : '';
}

/* ---------- system ---------- */

function normalizeSystem(raw) {
  const gpu = raw?.gpu && typeof raw.gpu === 'object' ? raw.gpu : {};
  const cpu = raw?.cpu && typeof raw.cpu === 'object' ? raw.cpu : {};
  const memory = raw?.memory && typeof raw.memory === 'object' ? raw.memory : {};
  const storage = raw?.storage && typeof raw.storage === 'object' ? raw.storage : {};
  return {
    gpu: {
      available: gpu.available === true,
      name: typeof gpu.name === 'string' ? gpu.name : '',
      backend: typeof gpu.backend === 'string' ? gpu.backend : '',
    },
    cpu: {
      cores: toNumber(cpu.cores),
      load1: toNumber(cpu.load1),
    },
    memory: {
      totalMb: toNumber(memory.totalMb),
      availableMb: toNumber(memory.availableMb),
    },
    storage: {
      freeGb: toNumber(storage.freeGb),
    },
    limits: {
      maxUploadMb: toNumber(raw?.limits?.maxUploadMb),
      minFreeGb: toNumber(raw?.limits?.minFreeGb),
      maxOutputPixels: toNumber(raw?.limits?.maxOutputPixels),
    },
    queue: raw?.queue && typeof raw.queue === 'object' ? raw.queue : null,
    models: raw?.models,
  };
}

function applyServerLimits(system) {
  const maxUploadMb = system?.limits?.maxUploadMb;
  if (Number.isFinite(maxUploadMb) && maxUploadMb > 0) {
    MAX_UPLOAD_BYTES = maxUploadMb * 1024 * 1024;
    if (els.sourceFormats) {
      els.sourceFormats.textContent = `Up to ${formatBytes(MAX_UPLOAD_BYTES)} per clip`;
    }
  }
  const maxOutputPixels = system?.limits?.maxOutputPixels;
  if (Number.isFinite(maxOutputPixels) && maxOutputPixels > 0) {
    MAX_OUTPUT_PIXELS = maxOutputPixels;
  }
}

async function fetchSystem() {
  if (state.systemInFlight) return;
  state.systemInFlight = true;
  try {
    const data = await fetchJson('/api/system');
    const wasOffline = state.systemOnline === false;
    state.system = normalizeSystem(data);
    applyServerLimits(state.system);
    state.systemOnline = true;
    state.systemBackoff = 0;
    state.systemRetryDelay = 0;

    if (state.system.queue) applyQueue(state.system.queue);

    const models = normalizeModels(data?.models);
    const signature = JSON.stringify(models);
    if (signature !== state.modelsSignature) {
      state.models = models;
      state.modelsSignature = signature;
      state.settings = sanitizeSettings(state.settings, state.models);
      saveSettings();
      rebuildModelSelects();
      applySettingsToControls();
    } else {
      state.models = models;
    }

    updateProjection();
    renderSystem();
    updateCta();

    if (wasOffline) {
      showCtaStatus('Station reconnected.');
      loadJobsNow();
    } else if (state.jobsInitialized && !state.jobsInFlight) {
      loadJobsNow();
    }
    scheduleSystemPoll();
  } catch {
    state.systemOnline = false;
    const delay = BACKOFF_MS[Math.min(state.systemBackoff, BACKOFF_MS.length - 1)];
    state.systemBackoff = Math.min(state.systemBackoff + 1, BACKOFF_MS.length - 1);
    state.systemRetryDelay = delay;
    renderSystem();
    updateCta();
    scheduleSystemPoll(delay);
  } finally {
    state.systemInFlight = false;
  }
}

function scheduleSystemPoll(delay = SYSTEM_POLL_MS) {
  clearTimeout(state.systemTimer);
  state.systemTimer = null;
  if (document.hidden) return;
  state.systemTimer = setTimeout(() => {
    state.systemTimer = null;
    fetchSystem();
  }, delay);
}

function setDot(dot, kind) {
  dot.classList.remove('dot-ok', 'dot-active', 'dot-bad');
  if (kind) dot.classList.add(`dot-${kind}`);
}

function renderSystem() {
  const online = state.systemOnline;

  if (online === false) {
    const retry = state.systemRetryDelay > 0 ? ` in ${Math.round(state.systemRetryDelay / 1000)} s` : '';
    const message = `Server unreachable — retrying${retry}`;
    els.gpuValue.textContent = message;
    els.gpuValue.title = 'The console could not reach /api/system. It will keep trying in the background.';
    els.cpuValue.textContent = '—';
    els.queueValue.textContent = '—';
    els.gpuNote.hidden = true;
    setDot(els.gpuDot, 'bad');
    setDot(els.cpuDot, null);
    setDot(els.queueDot, null);
    updateDiskWarning();
    renderActivityCounts();
    return;
  }

  if (online === null || !state.system) {
    els.gpuValue.textContent = 'Checking…';
    els.gpuValue.title = 'Checking the station';
    els.cpuValue.textContent = '—';
    els.queueValue.textContent = '—';
    els.gpuNote.hidden = true;
    setDot(els.gpuDot, null);
    setDot(els.cpuDot, null);
    setDot(els.queueDot, null);
    updateDiskWarning();
    renderActivityCounts();
    return;
  }

  const system = state.system;
  const processing = state.jobs.some((job) => job.status === 'processing' || job.status === 'cancel_requested');
  const queue = state.queue || { active: 0, queued: 0 };

  if (system.gpu.available) {
    els.gpuValue.textContent = system.gpu.name || 'GPU ready';
    els.gpuValue.title = [system.gpu.name, system.gpu.backend].filter(Boolean).join(' · ');
    setDot(els.gpuDot, processing ? 'active' : 'ok');
  } else {
    els.gpuValue.textContent = 'CPU only';
    els.gpuValue.title = 'No compatible GPU detected. Upscaling runs on the CPU and will be much slower.';
    setDot(els.gpuDot, 'bad');
  }

  if (system.cpu.cores != null) {
    const load = system.cpu.load1 != null ? system.cpu.load1.toFixed(2) : '—';
    els.cpuValue.textContent = `${system.cpu.cores} cores · load ${load}`;
    els.cpuValue.title = system.cpu.load1 != null ? `1-minute load average ${system.cpu.load1.toFixed(2)}` : '';
    const busy = system.cpu.load1 != null && system.cpu.load1 > Math.max(1, system.cpu.cores * 0.8);
    setDot(els.cpuDot, busy ? 'active' : 'ok');
  } else {
    els.cpuValue.textContent = '—';
    els.cpuValue.title = '';
    setDot(els.cpuDot, null);
  }

  els.queueValue.textContent = `${queue.active ?? 0} active · ${queue.queued ?? 0} queued`;
  els.queueValue.title = queue.maxQueue != null ? `Up to ${queue.maxQueue} clips can wait in the queue` : '';
  setDot(els.queueDot, processing || (queue.queued ?? 0) > 0 ? 'active' : 'ok');

  els.gpuNote.hidden = system.gpu.available;

  updateDiskWarning();
  renderActivityCounts();
}

function updateDiskWarning() {
  const free = state.system?.storage?.freeGb;
  const minimum = state.system?.limits?.minFreeGb ?? 3;
  const show = state.systemOnline === true && Number.isFinite(free) && free < minimum;
  if (show) {
    els.diskWarningText.textContent = `Low disk space: ${free.toFixed(1)} GB free. Finished jobs still hold their output files.`;
    els.diskWarning.hidden = false;
  } else {
    els.diskWarningText.textContent = '';
    els.diskWarning.hidden = true;
  }
}

function applyQueue(rawQueue) {
  if (!rawQueue || typeof rawQueue !== 'object') return;
  const previous = state.queue || { active: 0, queued: 0, maxActive: 1, maxQueue: 50 };
  const active = toNumber(rawQueue.active, previous.active);
  const queued = toNumber(rawQueue.queued, previous.queued);
  const maxActive = toNumber(rawQueue.maxActive, previous.maxActive);
  const maxQueue = toNumber(rawQueue.maxQueue, previous.maxQueue);
  state.queue = {
    active: active ?? 0,
    queued: queued ?? 0,
    maxActive: maxActive ?? 1,
    maxQueue: maxQueue ?? 50,
  };
  renderSystem();
  renderActivityCounts();
  updateCta();
}

function queueIsFull() {
  const queue = state.queue;
  return Boolean(queue && Number.isFinite(queue.maxQueue) && queue.maxQueue > 0 && queue.queued >= queue.maxQueue);
}

function renderActivityCounts() {
  const count = state.queue;
  if (!state.jobs.length) {
    els.activityCount.textContent = 'No jobs';
    els.activityCount.title = '';
    return;
  }
  const active = count ? count.active : state.jobs.filter((job) => job.status === 'processing' || job.status === 'cancel_requested').length;
  const queued = count ? count.queued : state.jobs.filter((job) => job.status === 'queued').length;
  els.activityCount.textContent = `${active} active · ${queued} queued`;
  els.activityCount.title = `${state.jobs.length} job${state.jobs.length === 1 ? '' : 's'} shown`;
}

/* ---------- jobs ---------- */

function isJobLike(job) {
  return Boolean(job && typeof job === 'object' && typeof job.id === 'string' && typeof job.status === 'string');
}

async function fetchJobsNow({ manual = false } = {}) {
  if (state.jobsInFlight || document.hidden) return;
  state.jobsInFlight = true;
  try {
    const data = await fetchJson(`/api/jobs?limit=${MAX_JOBS}`);
    const jobs = Array.isArray(data?.jobs) ? data.jobs.filter(isJobLike) : [];
    state.jobs = jobs;
    state.jobsOnline = true;
    state.jobsBackoff = 0;
    state.jobsRetryDelay = 0;
    if (data?.queue) applyQueue(data.queue);
    if (state.jobsInitialized) {
      announceJobChanges();
    } else {
      state.jobsInitialized = true;
      state.previousStatuses = new Map(jobs.map((job) => [job.id, job.status]));
    }
    renderJobs();
    hideQueueNoticeIfExpired();
    maybeConfirmSubmit();
    scheduleJobsPoll();
  } catch {
    state.jobsOnline = false;
    const delay = BACKOFF_MS[Math.min(state.jobsBackoff, BACKOFF_MS.length - 1)];
    state.jobsBackoff = Math.min(state.jobsBackoff + 1, BACKOFF_MS.length - 1);
    state.jobsRetryDelay = delay;
    showQueueNotice('Connection lost. Showing the last known queue.', { error: true, ttl: 0 });
    scheduleJobsPoll(delay);
  } finally {
    state.jobsInFlight = false;
    if (manual) setRefreshBusy(false);
  }
}

function loadJobsNow() {
  if (state.jobsInFlight) return;
  fetchJobsNow();
}

function hasActiveJobs() {
  return state.jobs.some((job) => ACTIVE_STATUSES.has(job.status));
}

function scheduleJobsPoll(delay = POLL_ACTIVE_MS) {
  clearTimeout(state.jobsTimer);
  state.jobsTimer = null;
  if (document.hidden) return;

  if (!state.jobsOnline) {
    state.jobsTimer = setTimeout(() => {
      state.jobsTimer = null;
      fetchJobsNow();
    }, delay);
    return;
  }

  if (hasActiveJobs()) {
    state.jobsTimer = setTimeout(() => {
      state.jobsTimer = null;
      fetchJobsNow();
    }, POLL_ACTIVE_MS);
  }
}

function announceJobChanges() {
  const messages = [];
  for (const job of state.jobs) {
    const previous = state.previousStatuses.get(job.id);
    if (!previous || previous === job.status) continue;
    const name = job.source?.name || 'Clip';
    if (job.status === 'processing') messages.push(`${name} started processing.`);
    else if (job.status === 'completed') messages.push(`${name} finished.`);
    else if (job.status === 'failed') messages.push(`${name} failed. ${job.error || ''}`.trim());
    else if (job.status === 'cancelled') messages.push(`${name} was cancelled.`);
    else if (job.status === 'cancel_requested') messages.push(`${name} is cancelling.`);
    else if (job.status === 'queued') messages.push(`${name} is queued.`);
  }
  state.previousStatuses = new Map(state.jobs.map((job) => [job.id, job.status]));
  if (messages.length) {
    els.liveRegion.textContent = messages.slice(-2).join(' ');
  }
}

function computeQueuePositions() {
  const queued = state.jobs
    .filter((job) => job.status === 'queued')
    .slice()
    .sort((a, b) => {
      const aTime = Date.parse(a.createdAt || '');
      const bTime = Date.parse(b.createdAt || '');
      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return aTime - bTime;
      return 0;
    });
  const total = Math.max(queued.length, state.queue?.queued ?? 0);
  return {
    positions: new Map(queued.map((job, index) => [job.id, index + 1])),
    total,
  };
}

function renderJobs() {
  const { positions, total } = computeQueuePositions();
  const seen = new Set();

  for (const job of state.jobs) {
    let node = state.jobNodes.get(job.id);
    if (!node) {
      node = createJobCard(job);
      state.jobNodes.set(job.id, node);
    }
    updateJobCard(node, job, positions.get(job.id) || 0, total);
    seen.add(job.id);
  }

  for (const [id, node] of state.jobNodes) {
    if (!seen.has(id)) {
      node.remove();
      state.jobNodes.delete(id);
      state.previousStatuses.delete(id);
    }
  }

  const desired = state.jobs.map((job) => state.jobNodes.get(job.id));
  const current = Array.from(els.jobList.children);
  const sameOrder = desired.length === current.length && desired.every((node, index) => node === current[index]);
  if (!sameOrder) {
    for (const node of desired) els.jobList.appendChild(node);
  }

  els.queueEmpty.hidden = state.jobs.length > 0;
  renderActivityCounts();
}

function createJobCard() {
  const fragment = els.jobTemplate.content.cloneNode(true);
  const node = fragment.querySelector('.job-card');
  node.tabIndex = -1;
  node._refs = {
    name: node.querySelector('.job-name'),
    status: node.querySelector('.job-status'),
    stage: node.querySelector('.job-stage'),
    track: node.querySelector('.progress-track'),
    fill: node.querySelector('.progress-fill'),
    readout: node.querySelector('.job-readout'),
    actions: node.querySelector('.job-actions'),
    error: node.querySelector('.job-error'),
    output: node.querySelector('.job-output'),
    img: node.querySelector('.thumb img'),
    placeholder: node.querySelector('.thumb-placeholder'),
    thumbSrc: '',
    actionsSignature: '',
    thumbFailed: '',
  };

  node._refs.img.addEventListener('load', () => {
    node._refs.img.hidden = false;
    node._refs.placeholder.hidden = true;
  });

  node._refs.img.addEventListener('error', () => {
    node._refs.thumbFailed = node._refs.thumbSrc;
    node._refs.img.hidden = true;
    node._refs.placeholder.hidden = false;
    node._refs.img.removeAttribute('src');
  });

  return node;
}

function updateJobCard(node, job, queuePosition, queueTotal) {
  const refs = node._refs;
  const name = job.source?.name || 'Untitled clip';
  const status = String(job.status || 'queued');
  const statusKind = STATUS_KINDS[status] || 'queued';

  node.dataset.status = status;
  node.dataset.jobId = job.id;

  refs.name.textContent = name;
  refs.name.title = name;
  refs.status.textContent = STATUS_LABELS[status] || status;
  refs.status.dataset.kind = statusKind;

  refs.stage.textContent = describeJobStage(job);

  let progress = clamp(toNumber(job.progress, 0) ?? 0, 0, 1);
  if (status === 'completed') progress = 1;
  const percent = status === 'completed' ? 100 : Math.floor(progress * 100);
  refs.fill.style.width = `${progress * 100}%`;
  refs.track.setAttribute('aria-valuenow', String(percent));
  refs.track.setAttribute('aria-valuetext', `${percent} percent`);
  refs.track.setAttribute('aria-label', `Progress for ${name}`);

  let readout = `${percent}%`;
  if (status === 'queued') {
    readout = queueTotal > 0
      ? (queuePosition === 1 ? 'next in line' : `${queuePosition} of ${queueTotal} waiting`)
      : 'waiting';
  } else if (status === 'processing') {
    readout = `${percent}% · ${job.etaSeconds != null ? formatEta(job.etaSeconds) : 'estimating'}`;
  } else if (status === 'cancel_requested') {
    readout = `${percent}% · stopping`;
  } else if (status === 'completed') {
    readout = '100% · done';
  } else if (status === 'failed') {
    readout = `${percent}% · stopped`;
  } else if (status === 'cancelled') {
    readout = `${percent}% · cancelled`;
  }
  refs.readout.textContent = readout;

  updateThumbnail(refs, job);
  updateJobActions(refs, job, status, name);

  if (status === 'failed' && job.error) {
    refs.error.textContent = String(job.error);
    refs.error.hidden = false;
  } else {
    refs.error.textContent = '';
    refs.error.hidden = true;
  }

  if (status === 'completed' && job.output) {
    const output = job.output;
    const parts = [];
    if (output.width && output.height) parts.push(`${output.width}×${output.height}`);
    if (output.fps) parts.push(`${formatFps(output.fps)} fps`);
    if (output.sizeBytes != null) parts.push(formatBytes(output.sizeBytes));
    refs.output.textContent = parts.join(' · ');
    refs.output.title = typeof output.filename === 'string' ? output.filename : '';
    refs.output.hidden = parts.length === 0;
  } else {
    refs.output.textContent = '';
    refs.output.title = '';
    refs.output.hidden = true;
  }
}

function describeJobStage(job) {
  const status = job.status;
  const label = stageLabel(job.stage);
  if (status === 'queued') return 'Waiting for a free slot.';
  if (status === 'processing' || status === 'cancel_requested') {
    if (job.stage === 'queued') return 'Starting.';
    return label;
  }
  if (status === 'completed') return 'Finished';
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'failed') {
    return job.stage && job.stage !== 'done' ? `Stopped during ${label.toLowerCase()}.` : 'Stopped before finishing.';
  }
  return label;
}

function updateThumbnail(refs, job) {
  if (job.status === 'queued') {
    refs.img.hidden = true;
    refs.placeholder.hidden = false;
    return;
  }

  const version = encodeURIComponent(job.completedAt || job.startedAt || job.status || '');
  const url = `/api/jobs/${encodeURIComponent(job.id)}/thumbnail?v=${version}`;
  if (url === refs.thumbSrc) return;
  if (url === refs.thumbFailed) return;

  refs.thumbSrc = url;
  refs.img.src = url;
  refs.img.hidden = false;
  refs.placeholder.hidden = true;
}

function updateJobActions(refs, job, status, name) {
  const signature = `${status}:${name}`;
  if (signature === refs.actionsSignature) return;
  refs.actionsSignature = signature;
  refs.actions.replaceChildren();

  const addButton = (label, action, danger = false) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `action-btn${danger ? ' is-danger' : ''}`;
    button.textContent = label;
    button.dataset.action = action;
    button.dataset.id = job.id;
    button.setAttribute('aria-label', `${label} job ${name}`);
    refs.actions.appendChild(button);
    return button;
  };

  if (status === 'queued' || status === 'processing') {
    addButton('Cancel', 'cancel');
  } else if (status === 'cancel_requested') {
    const button = addButton('Cancelling', 'none');
    button.disabled = true;
  } else if (status === 'completed') {
    const download = document.createElement('a');
    download.className = 'action-btn';
    download.href = `/api/jobs/${encodeURIComponent(job.id)}/download`;
    download.setAttribute('download', '');
    download.textContent = 'Download';
    download.setAttribute('aria-label', `Download output of ${name}`);
    refs.actions.appendChild(download);
    addButton('Remove', 'remove', true);
  } else if (status === 'failed') {
    addButton('Dismiss', 'remove', true);
  } else if (status === 'cancelled') {
    addButton('Remove', 'remove', true);
  }
}

function maybeConfirmSubmit() {
  if (!state.confirmJobId) return;
  const job = state.jobs.find((item) => item.id === state.confirmJobId);
  if (!job) return;

  if (state.confirmTimer) {
    clearTimeout(state.confirmTimer);
    state.confirmTimer = null;
  }

  if (job.status === 'processing') {
    showCtaStatus('Started processing.');
  } else if (job.status === 'queued') {
    const { positions, total } = computeQueuePositions();
    const position = positions.get(job.id);
    if (position) {
      showCtaStatus(`Added to queue · position ${position} of ${total}.`);
    } else {
      showCtaStatus('Added to queue.');
    }
  } else if (job.status === 'completed') {
    showCtaStatus('Enhancement complete.');
  } else {
    showCtaStatus('Job accepted.');
  }
  state.confirmJobId = null;
}

async function handleJobAction(action, id, button) {
  if (action === 'none') return;
  const job = state.jobs.find((item) => item.id === id);
  if (!job) return;
  const name = job.source?.name || 'clip';
  const card = state.jobNodes.get(id);

  if (action === 'cancel') {
    button.disabled = true;
    button.textContent = 'Cancelling…';
    try {
      const updated = await fetchJson(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
      if (updated && updated.id) {
        const index = state.jobs.findIndex((item) => item.id === updated.id);
        if (index >= 0) state.jobs[index] = updated;
        renderJobs();
      }
      showQueueNotice(`Cancelling ${name}.`, { error: false, ttl: 5000 });
      await fetchJobsNow();
      if (card && card.isConnected) card.focus({ preventScroll: true });
    } catch (error) {
      showQueueNotice(
        error.status === 409 ? 'That job has already finished.' : (error.detail || 'Could not cancel the job.'),
        { error: true, ttl: 7000 },
      );
      await fetchJobsNow();
      if (card && card.isConnected) card.focus({ preventScroll: true });
    }
    return;
  }

  if (action === 'remove') {
    button.disabled = true;
    try {
      await fetchJson(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
      state.jobs = state.jobs.filter((item) => item.id !== id);
      state.previousStatuses.delete(id);
      const removed = state.jobNodes.get(id);
      if (removed) removed.remove();
      state.jobNodes.delete(id);
      renderJobs();
      await fetchJobsNow();
      const first = els.jobList.querySelector('.job-card');
      if (first) first.focus({ preventScroll: true });
      else els.refreshButton.focus({ preventScroll: true });
    } catch (error) {
      showQueueNotice(
        error.status === 409 ? 'That job is still running and cannot be removed.' : (error.detail || 'Could not remove the job.'),
        { error: true, ttl: 7000 },
      );
      await fetchJobsNow();
      if (card && card.isConnected) card.focus({ preventScroll: true });
    }
  }
}

/* ---------- queue notices ---------- */

function showQueueNotice(message, { error = false, ttl = 0 } = {}) {
  els.queueNotice.textContent = message;
  els.queueNotice.hidden = false;
  els.queueNotice.setAttribute('role', error ? 'alert' : 'status');
  els.queueNotice.style.borderLeftColor = error ? 'var(--bad)' : 'var(--ok)';
  els.queueNotice.style.color = error ? '#f0a596' : 'var(--ok)';
  state.queueNoticeUntil = ttl > 0 ? Date.now() + ttl : 0;
  if (ttl > 0) {
    setTimeout(() => {
      if (state.queueNoticeUntil && Date.now() >= state.queueNoticeUntil) {
        state.queueNoticeUntil = 0;
        els.queueNotice.hidden = true;
        els.queueNotice.textContent = '';
      }
    }, ttl + 50);
  }
}

function hideQueueNoticeIfExpired() {
  if (state.queueNoticeUntil && Date.now() < state.queueNoticeUntil) return;
  if (!state.jobsOnline) {
    showQueueNotice('Connection lost. Showing the last known queue.', { error: true, ttl: 0 });
    return;
  }
  state.queueNoticeUntil = 0;
  els.queueNotice.hidden = true;
  els.queueNotice.textContent = '';
}

/* ---------- CTA ---------- */

function projectedOutputSize() {
  const source = state.selected;
  if (!source || !source.width || !source.height) return null;
  const settings = state.settings;
  const scale = settings.upscale.enabled ? settings.upscale.scale : 1;
  const width = settings.upscale.enabled
    ? Math.max(2, Math.round((source.width * scale) / 2) * 2)
    : source.width;
  const height = settings.upscale.enabled
    ? Math.max(2, Math.round((source.height * scale) / 2) * 2)
    : source.height;
  return { width, height, pixels: width * height };
}

function updateCta() {
  const full = queueIsFull();
  const offline = state.systemOnline === false;
  const checking = state.systemOnline === null;
  const projected = projectedOutputSize();
  const tooLarge = projected != null && projected.pixels > MAX_OUTPUT_PIXELS;
  let disabled = false;
  let reason = '';

  if (state.uploading) {
    const percent = Math.round(state.uploadPercent);
    els.startButton.textContent = `Uploading ${percent}%`;
    disabled = true;
    reason = 'Keep this tab open until the upload finishes.';
  } else {
    els.startButton.textContent = 'Start enhancement';
    if (offline) {
      disabled = true;
      reason = state.selected
        ? 'Server unreachable — retrying. Your clip stays selected.'
        : 'Server unreachable — retrying.';
    } else if (checking) {
      disabled = true;
      reason = 'Checking the station…';
    } else if (!state.selected) {
      disabled = true;
      reason = 'Choose a clip to begin.';
    } else if (tooLarge) {
      disabled = true;
      reason = `Projected ${projected.width}×${projected.height} is above the 4K output limit. Use a smaller scale.`;
    } else if (full) {
      disabled = true;
      reason = `Queue is full — ${state.queue.queued} of ${state.queue.maxQueue} clips waiting.`;
    }
  }

  els.startButton.disabled = disabled;
  els.startButton.setAttribute('aria-busy', String(state.uploading));
  els.resetButton.disabled = state.uploading;
  els.ctaNote.textContent = reason;
  els.ctaNote.hidden = !reason;
  updateDiskWarning();
}

function setUploadProgress(percent) {
  const rounded = clamp(Math.round(percent), 0, 100);
  state.uploadPercent = rounded;
  els.uploadFill.style.width = `${rounded}%`;
  els.uploadTrack.setAttribute('aria-valuenow', String(rounded));
}

function showCtaStatus(message) {
  if (state.confirmTimer) clearTimeout(state.confirmTimer);
  els.ctaStatus.textContent = message;
  els.ctaStatus.hidden = false;
  state.confirmTimer = setTimeout(() => {
    els.ctaStatus.hidden = true;
    els.ctaStatus.textContent = '';
    state.confirmTimer = null;
  }, 10000);
}

function clearCtaStatus() {
  if (state.confirmTimer) {
    clearTimeout(state.confirmTimer);
    state.confirmTimer = null;
  }
  els.ctaStatus.hidden = true;
  els.ctaStatus.textContent = '';
}

function showCtaError(message) {
  els.ctaError.textContent = message;
  els.ctaError.hidden = false;
  els.ctaError.focus({ preventScroll: false });
}

function clearCtaError() {
  els.ctaError.textContent = '';
  els.ctaError.hidden = true;
}

/* ---------- source ---------- */

function showSourceError(message, { focus = true } = {}) {
  els.sourceError.textContent = message;
  els.sourceError.hidden = false;
  if (focus) els.sourceError.focus({ preventScroll: false });
}

function clearSourceError() {
  els.sourceError.textContent = '';
  els.sourceError.hidden = true;
}

function setSourceNote(message) {
  if (message) {
    els.sourceNote.textContent = message;
    els.sourceNote.hidden = false;
  } else {
    els.sourceNote.textContent = '';
    els.sourceNote.hidden = true;
  }
}

function updateSourceMeta() {
  const selected = state.selected;
  if (!selected) return;
  els.sourceName.textContent = selected.name;
  els.sourceName.title = selected.name;
  els.sourceDims.textContent = selected.width && selected.height ? `${selected.width}×${selected.height}` : '— × —';
  els.sourceFps.textContent = selected.fps ? `${formatFps(selected.fps)} fps` : '— fps';
  els.sourceDuration.textContent = selected.duration != null ? formatTimecode(selected.duration) : '—';
  els.sourceSize.textContent = formatBytes(selected.size);
  els.sourceBadge.textContent = '1 clip';
}

function validateFile(file) {
  if (!file || !file.name) return 'No file was read. Try again or choose a file from disk.';
  const extension = fileExtension(file.name);
  if (!ACCEPTED_EXTENSIONS.has(extension)) {
    return 'That file type is not supported. Use MP4, MKV, MOV, WebM, AVI, or M4V.';
  }
  if (file.size === 0) {
    return 'That file is empty. Choose a clip with video in it.';
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `This clip is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_UPLOAD_BYTES)} per clip.`;
  }
  return null;
}

function handleFile(file) {
  const error = validateFile(file);
  if (error) {
    showSourceError(error);
    els.fileInput.value = '';
    return;
  }

  clearSourceError();
  clearCtaError();
  clearCtaStatus();

  if (state.selected?.url) URL.revokeObjectURL(state.selected.url);
  state.fpsProbeToken += 1;
  const token = ++state.mediaToken;
  const url = URL.createObjectURL(file);
  state.selected = {
    file,
    url,
    name: file.name,
    size: file.size,
    width: null,
    height: null,
    duration: null,
    fps: null,
    token,
  };

  els.dropzone.hidden = true;
  els.previewWrap.hidden = false;
  els.sourceMeta.hidden = false;
  els.videoPreview.dataset.mediaToken = String(token);
  els.videoPreview.src = url;
  els.videoPreview.load();

  els.sourceName.textContent = file.name;
  els.sourceName.title = file.name;
  els.sourceDims.textContent = '— × —';
  els.sourceFps.textContent = '— fps';
  els.sourceDuration.textContent = '—';
  els.sourceSize.textContent = formatBytes(file.size);
  els.sourceBadge.textContent = '1 clip';
  setSourceNote('Reading frame size and duration.');
  els.videoPreview.focus({ preventScroll: true });

  updateProjection();
  updateCta();
  els.fileInput.value = '';
}

function clearSelectedSource({ focusDropzone = false } = {}) {
  state.fpsProbeToken += 1;
  if (state.selected?.url) URL.revokeObjectURL(state.selected.url);
  state.selected = null;

  els.videoPreview.pause();
  els.videoPreview.removeAttribute('src');
  delete els.videoPreview.dataset.mediaToken;
  els.videoPreview.load();
  els.previewWrap.hidden = true;
  els.dropzone.hidden = false;
  els.sourceMeta.hidden = true;
  els.sourceName.textContent = '';
  els.sourceName.title = '';
  els.sourceBadge.textContent = 'No clip';
  setSourceNote('');
  updateProjection();
  updateCta();

  if (focusDropzone) {
    requestAnimationFrame(() => els.dropzone.focus({ preventScroll: true }));
  }
}

function probeFrameRate(video) {
  const token = ++state.fpsProbeToken;
  const selected = state.selected;
  if (!selected) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion || typeof video.requestVideoFrameCallback !== 'function') {
    setSourceNote('Frame rate will be read when the job starts.');
    return;
  }

  const samples = [];
  let done = false;
  let handle = null;
  let timer = null;
  let endedHandler = null;

  const estimateFrom = () => {
    if (samples.length < 6) return null;
    const deltas = [];
    for (let index = 1; index < samples.length; index += 1) {
      const delta = samples[index] - samples[index - 1];
      if (Number.isFinite(delta) && delta > 0.001) deltas.push(delta);
    }
    if (deltas.length < 4) return null;
    deltas.sort((a, b) => a - b);
    const median = deltas[Math.floor(deltas.length / 2)];
    if (!Number.isFinite(median) || median <= 0) return null;
    const raw = 1 / median;
    if (raw < 1 || raw > 240) return null;
    const common = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];
    const nearest = common.reduce((best, value) => (
      Math.abs(value - raw) < Math.abs(best - raw) ? value : best
    ), common[0]);
    return Math.abs(nearest - raw) < 1.2 ? nearest : Math.round(raw * 100) / 100;
  };

  const finish = (estimate) => {
    if (done) return;
    done = true;
    if (handle != null) {
      try { video.cancelVideoFrameCallback(handle); } catch { /* callback already spent */ }
    }
    if (timer != null) clearTimeout(timer);
    if (endedHandler) video.removeEventListener('ended', endedHandler);

    if (token !== state.fpsProbeToken || state.selected !== selected) return;

    video.pause();
    try { video.currentTime = 0; } catch { /* seeking can fail on odd files */ }

    if (estimate) {
      selected.fps = estimate;
      updateSourceMeta();
      updateProjection();
      setSourceNote('');
    } else {
      setSourceNote('Frame rate will be read when the job starts.');
    }
  };

  const onFrame = (now, metadata) => {
    if (done) return;
    samples.push(Number(metadata?.mediaTime ?? video.currentTime));
    if (samples.length >= 6 && samples[samples.length - 1] - samples[0] >= 0.8) {
      finish(estimateFrom());
      return;
    }
    handle = video.requestVideoFrameCallback(onFrame);
  };

  timer = setTimeout(() => finish(estimateFrom()), 1700);
  handle = video.requestVideoFrameCallback(onFrame);
  endedHandler = () => finish(estimateFrom());
  video.addEventListener('ended', endedHandler);

  video.muted = true;
  const playPromise = video.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(() => finish(null));
  }
  setSourceNote('Reading frame rate.');
}

function updateProjection() {
  const settings = state.settings;
  const source = state.selected;

  if (!source || !source.width || !source.height) {
    els.projFrom.textContent = '— × —';
    els.projTo.textContent = '— × —';
    els.projSub.textContent = '— fps · —';
    els.projRatio.textContent = '';
    els.projNote.textContent = source ? 'Waiting for the clip’s frame size.' : 'Load a clip to project the output.';
    els.projectionSr.textContent = source ? 'Source dimensions are not available yet.' : 'No source clip selected.';
    return;
  }

  const scaleFactor = settings.upscale.enabled ? settings.upscale.scale : 1;
  const outputWidth = settings.upscale.enabled
    ? Math.round((source.width * scaleFactor) / 2) * 2
    : source.width;
  const outputHeight = settings.upscale.enabled
    ? Math.round(source.height * scaleFactor)
    : source.height;

  const inputFps = source.fps;
  const outputFps = inputFps
    ? (settings.interpolate.enabled ? inputFps * settings.interpolate.factor : inputFps)
    : null;

  els.projFrom.textContent = `${source.width}×${source.height}`;
  els.projTo.textContent = `${outputWidth}×${outputHeight}`;
  els.projSub.textContent = `${inputFps ? formatFps(inputFps) : '—'} → ${outputFps ? formatFps(outputFps) : '—'} fps · ${source.duration != null ? formatDuration(source.duration) : '—'}`;

  if (settings.upscale.enabled && settings.interpolate.enabled) {
    els.projRatio.textContent = `${settings.upscale.scale}× upscale · ${settings.interpolate.factor}× frames`;
  } else if (settings.upscale.enabled) {
    els.projRatio.textContent = `${settings.upscale.scale}× upscale`;
  } else if (settings.interpolate.enabled) {
    els.projRatio.textContent = `${settings.interpolate.factor}× frames`;
  } else {
    els.projRatio.textContent = 'Re-encode only';
  }

  if (settings.interpolate.enabled) {
    if (settings.interpolate.maxHeight === 0) {
      els.projNote.textContent = 'RIFE runs at native height; the projected output is unchanged.';
    } else {
      els.projNote.textContent = `RIFE runs at up to ${settings.interpolate.maxHeight}p, then the frame is scaled to the projection.`;
    }
  } else if (!settings.upscale.enabled) {
    els.projNote.textContent = 'No scaling or frame generation. The clip is re-encoded only.';
  } else {
    els.projNote.textContent = `Upscale pass ×${settings.upscale.scale}. Output width is rounded to an even number.`;
  }

  els.projectionSr.textContent = `${source.width} by ${source.height} at ${inputFps ? formatFps(inputFps) : 'unknown'} frames per second becomes ${outputWidth} by ${outputHeight} at ${outputFps ? formatFps(outputFps) : 'unknown'} frames per second, ${source.duration != null ? formatDuration(source.duration) : 'unknown duration'}.`;
}

function setRefreshBusy(busy) {
  els.refreshButton.disabled = busy;
  els.refreshButton.classList.toggle('is-spinning', busy);
  if (busy) els.refreshButton.setAttribute('aria-busy', 'true');
  else els.refreshButton.removeAttribute('aria-busy');
}

async function manualRefresh() {
  if (els.refreshButton.disabled) return;
  setRefreshBusy(true);
  try {
    await Promise.allSettled([fetchSystem(), fetchJobsNow({ manual: true })]);
  } finally {
    setRefreshBusy(false);
  }
}

/* ---------- upload ---------- */

function statusFallback(status) {
  const messages = {
    400: 'The station could not read that request.',
    404: 'The station could not find that endpoint.',
    409: 'The job is no longer in a state that allows that action.',
    413: 'This clip is larger than the server accepts. Try a smaller file.',
    415: 'The server does not support that file type.',
    422: 'The server rejected the video or the settings.',
    429: 'The queue is full. Wait for a job to finish, then try again.',
    500: 'The station hit an internal error. Your clip is still selected.',
    502: 'The station is restarting. Your clip is still selected.',
    503: 'The station is busy or restarting. Your clip is still selected.',
    507: 'There is not enough disk space on the station.',
  };
  return messages[status] || 'The upload did not complete. Your clip is still selected.';
}

function extractDetail(data, status) {
  if (data && typeof data.detail === 'string' && data.detail.trim()) return data.detail.trim();
  if (data && Array.isArray(data.detail)) {
    const messages = data.detail
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item.msg === 'string') {
          const field = Array.isArray(item.loc) ? item.loc.filter((part) => part !== 'body').join('.') : '';
          return field ? `${field}: ${item.msg}` : item.msg;
        }
        return '';
      })
      .filter(Boolean);
    if (messages.length) return messages.slice(0, 2).join(' ');
  }
  return statusFallback(status);
}

function submitJob() {
  if (state.uploading || els.startButton.disabled || !state.selected) return;

  clearCtaError();
  clearCtaStatus();
  state.uploading = true;
  state.uploadPercent = 0;
  state.confirmJobId = null;
  els.uploadTrack.hidden = false;
  setUploadProgress(0);
  updateCta();

  const form = new FormData();
  form.append('file', state.selected.file, state.selected.name);
  form.append('settings', JSON.stringify(state.settings));

  const xhr = new XMLHttpRequest();
  state.uploadXhr = xhr;
  xhr.open('POST', '/api/jobs', true);
  xhr.setRequestHeader('Accept', 'application/json');

  xhr.upload.addEventListener('progress', (event) => {
    if (!event.lengthComputable) return;
    setUploadProgress((event.loaded / event.total) * 100);
    updateCta();
  });

  xhr.addEventListener('load', () => {
    let data = null;
    try {
      data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
    } catch {
      data = null;
    }

    if (xhr.status >= 200 && xhr.status < 300) {
      finishUploadSuccess(data);
    } else {
      finishUploadError(extractDetail(data, xhr.status));
    }
  });

  xhr.addEventListener('error', () => {
    finishUploadError('Connection lost before the upload finished. Your clip is still selected.');
  });

  xhr.addEventListener('abort', () => {
    finishUploadError('The upload was stopped. Your clip is still selected.');
  });

  xhr.addEventListener('timeout', () => {
    finishUploadError('The upload timed out. Your clip is still selected.');
  });

  xhr.send(form);
}

function finishUploadSuccess(job) {
  state.uploading = false;
  state.uploadXhr = null;
  state.uploadPercent = 0;
  els.uploadTrack.hidden = true;
  els.uploadFill.style.width = '0%';
  els.uploadTrack.setAttribute('aria-valuenow', '0');
  clearCtaError();

  if (job && job.id) {
    state.confirmJobId = job.id;
    state.jobs = [job, ...state.jobs.filter((item) => item.id !== job.id)];
    state.previousStatuses.set(job.id, job.status);
    renderJobs();
  }

  const submittedName = state.selected?.name || job?.source?.name || 'clip';
  clearSelectedSource({ focusDropzone: true });
  updateCta();
  showCtaStatus(`Uploaded ${submittedName}.`);
  loadJobsNow();
  fetchSystem();
}

function finishUploadError(message) {
  state.uploading = false;
  state.uploadXhr = null;
  state.uploadPercent = 0;
  els.uploadTrack.hidden = true;
  els.uploadFill.style.width = '0%';
  els.uploadTrack.setAttribute('aria-valuenow', '0');
  updateCta();
  showCtaError(message || 'The upload did not complete. Your clip is still selected.');
  loadJobsNow();
  fetchSystem();
}

/* ---------- network ---------- */

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'same-origin',
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    const detail = extractDetail(data, response.status);
    const error = new Error(detail);
    error.status = response.status;
    error.detail = detail;
    throw error;
  }

  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('The server returned an unreadable response.');
  }
}

async function loadHealth() {
  try {
    const response = await fetch('/health', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) return;
    const data = await response.json();
    if (data && typeof data.version === 'string' && data.version.trim()) {
      els.stationVersion.textContent = `RVEWeb ${data.version.trim()}`;
    }
  } catch {
    /* Health is decorative metadata; the system strip carries real status. */
  }
}

/* ---------- events ---------- */

function bindEvents() {
  els.howToggle.addEventListener('click', () => {
    const open = els.howToggle.getAttribute('aria-expanded') === 'true';
    els.howToggle.setAttribute('aria-expanded', String(!open));
    els.howPanel.hidden = open;
  });

  document.querySelectorAll('[data-toggle]').forEach((toggle) => {
    toggle.addEventListener('click', () => {
      const stage = toggle.dataset.toggle;
      if (stage === 'encode') return;
      state.settings[stage].enabled = !state.settings[stage].enabled;
      saveSettings();
      applySettingsToControls();
      updateProjection();
      updateCta();
      clearCtaError();
    });
  });

  els.decompressStrength.addEventListener('change', () => {
    state.settings.decompress.strength = els.decompressStrength.value;
    saveSettings();
    clearCtaError();
  });

  els.denoiseStrength.addEventListener('change', () => {
    state.settings.denoise.strength = els.denoiseStrength.value;
    saveSettings();
    clearCtaError();
  });

  els.upscaleModel.addEventListener('change', () => {
    state.settings.upscale.model = els.upscaleModel.value;
    renderScaleOptions();
    saveSettings();
    updateProjection();
    clearCtaError();
  });

  els.upscaleScale.addEventListener('change', () => {
    state.settings.upscale.scale = Number(els.upscaleScale.value);
    saveSettings();
    updateProjection();
    clearCtaError();
  });

  els.interpolateModel.addEventListener('change', () => {
    state.settings.interpolate.model = els.interpolateModel.value;
    renderFactorOptions();
    saveSettings();
    updateProjection();
    clearCtaError();
  });

  els.interpolateFactor.addEventListener('change', () => {
    state.settings.interpolate.factor = Number(els.interpolateFactor.value);
    saveSettings();
    updateProjection();
    clearCtaError();
  });

  els.interpolateMaxHeight.addEventListener('change', () => {
    state.settings.interpolate.maxHeight = Number(els.interpolateMaxHeight.value);
    saveSettings();
    updateProjection();
    clearCtaError();
  });

  els.encodeCodec.addEventListener('change', () => {
    state.settings.encode.codec = els.encodeCodec.value;
    saveSettings();
    clearCtaError();
  });

  els.encodeContainer.addEventListener('change', () => {
    state.settings.encode.container = els.encodeContainer.value;
    saveSettings();
    clearCtaError();
  });

  els.encodePreset.addEventListener('change', () => {
    state.settings.encode.preset = els.encodePreset.value;
    saveSettings();
    clearCtaError();
  });

  els.audioMode.addEventListener('change', () => {
    state.settings.audio.mode = els.audioMode.value;
    saveSettings();
    clearCtaError();
  });

  els.crfInput.addEventListener('input', () => {
    state.settings.encode.crf = Number(els.crfInput.value);
    updateCrfReadout();
    saveSettings();
    clearCtaError();
  });

  document.querySelectorAll('[data-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      applyPreset(button.dataset.preset);
      clearCtaError();
    });
  });

  els.startButton.addEventListener('click', submitJob);

  els.resetButton.addEventListener('click', () => {
    if (state.uploading) return;
    clearCtaError();
    clearCtaStatus();
    clearSourceError();
    clearSelectedSource({ focusDropzone: true });
    state.settings = sanitizeSettings(DEFAULT_SETTINGS, state.models);
    saveSettings();
    rebuildModelSelects();
    applySettingsToControls();
    updateProjection();
    updateCta();
  });

  els.refreshButton.addEventListener('click', manualRefresh);

  els.dropzone.addEventListener('click', () => {
    if (state.selected) return;
    els.fileInput.click();
  });

  els.dropzone.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (!state.selected) els.fileInput.click();
  });

  els.replaceBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files?.[0];
    if (file) handleFile(file);
  });

  els.sourceFrame.addEventListener('dragenter', (event) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    state.dragDepth += 1;
    els.dropzone.classList.add('is-dragging');
  });

  els.sourceFrame.addEventListener('dragover', (event) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    els.dropzone.classList.add('is-dragging');
  });

  els.sourceFrame.addEventListener('dragleave', (event) => {
    if (!dragHasFiles(event)) return;
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (state.dragDepth === 0) els.dropzone.classList.remove('is-dragging');
  });

  els.sourceFrame.addEventListener('drop', (event) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    state.dragDepth = 0;
    els.dropzone.classList.remove('is-dragging');
    const file = event.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });

  document.addEventListener('dragover', (event) => {
    if (dragHasFiles(event)) event.preventDefault();
  });

  document.addEventListener('drop', (event) => {
    if (dragHasFiles(event)) event.preventDefault();
  });

  els.videoPreview.addEventListener('loadedmetadata', () => {
    const selected = state.selected;
    if (!selected) return;
    if (els.videoPreview.dataset.mediaToken !== String(selected.token)) return;
    if (els.videoPreview.currentSrc && els.videoPreview.currentSrc !== selected.url) return;
    const width = els.videoPreview.videoWidth;
    const height = els.videoPreview.videoHeight;
    const duration = els.videoPreview.duration;
    selected.width = width > 0 ? width : null;
    selected.height = height > 0 ? height : null;
    selected.duration = Number.isFinite(duration) && duration > 0 ? duration : null;
    updateSourceMeta();
    updateProjection();
    if (selected.width && selected.height) {
      probeFrameRate(els.videoPreview);
    } else {
      setSourceNote('Frame size could not be read; the station will check it on upload.');
    }
  });

  els.videoPreview.addEventListener('error', () => {
    const selected = state.selected;
    if (!selected) return;
    if (els.videoPreview.dataset.mediaToken !== String(selected.token)) return;
    if (els.videoPreview.currentSrc && els.videoPreview.currentSrc !== selected.url) return;
    setSourceNote('The browser could not read this clip’s metadata. It may still upload; the station will check it.');
  });

  els.jobList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    handleJobAction(button.dataset.action, button.dataset.id, button);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(state.systemTimer);
      clearTimeout(state.jobsTimer);
      state.systemTimer = null;
      state.jobsTimer = null;
      return;
    }
    fetchSystem();
    fetchJobsNow();
  });
}

function dragHasFiles(event) {
  const types = event.dataTransfer?.types;
  return Boolean(types && Array.from(types).includes('Files'));
}

/* ---------- boot ---------- */

function boot() {
  rebuildModelSelects();
  applySettingsToControls();
  updateCrfReadout();
  updateProjection();
  updateCta();
  renderSystem();
  renderJobs();
  saveSettings();
  bindEvents();
  loadHealth();
  fetchSystem();
  fetchJobsNow();
}

boot();
