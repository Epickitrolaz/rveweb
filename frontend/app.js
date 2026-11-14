const SETTINGS_KEY = 'rveweb.settings.v1';
const HAS_STORED_SETTINGS = (() => {
  try { return Boolean(localStorage.getItem(SETTINGS_KEY)); } catch { return false; }
})();
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
    { id: 'realesrgan-video', label: 'Real-ESRGAN v3 · Video', scales: [2, 3, 4], note: 'Fast, video-tuned', engine: 'ncnn' },
    { id: 'realesrgan-x4plus', label: 'Real-ESRGAN x4plus · Detail', scales: [2, 4], note: 'Slow, maximum detail', engine: 'ncnn' },
    { id: 'realesrgan-x4plus-anime', label: 'Real-ESRGAN x4plus Anime', scales: [2, 4], note: 'Animation line art', engine: 'ncnn' },
    { id: 'lanczos', label: 'Lanczos · CPU', scales: [2, 3, 4], note: 'Fast CPU scaling, no AI', engine: 'cpu' },
  ],
  interpolators: [
    { id: 'rife-4.27', label: 'RIFE 4.27', factors: [2, 4, 8], note: 'Quality · CPU ONNX', engine: 'onnx', backend: 'cpu' },
    { id: 'rife-4.27-s', label: 'RIFE 4.27 Small', factors: [2, 4, 8], note: 'Lighter · CPU ONNX', engine: 'onnx', backend: 'cpu' },
    { id: 'rife-4.26', label: 'RIFE 4.26', factors: [2, 4, 8], note: 'Vulkan · GPU', engine: 'ncnn', backend: 'gpu' },
    { id: 'rife-4.25', label: 'RIFE 4.25', factors: [2, 4, 8], note: 'Vulkan · GPU', engine: 'ncnn', backend: 'gpu' },
    { id: 'rife-4.22', label: 'RIFE 4.22', factors: [2, 4, 8], note: 'Vulkan · GPU', engine: 'ncnn', backend: 'gpu' },
    { id: 'rife-4.18', label: 'RIFE 4.18', factors: [2, 4, 8], note: 'Vulkan · GPU', engine: 'ncnn', backend: 'gpu' },
    { id: 'rife-4.15', label: 'RIFE 4.15', factors: [2, 4, 8], note: 'Vulkan · GPU', engine: 'ncnn', backend: 'gpu' },
    { id: 'rife-4.12', label: 'RIFE 4.12', factors: [2, 4, 8], note: 'Vulkan · GPU', engine: 'ncnn', backend: 'gpu' },
    { id: 'rife-4.7', label: 'RIFE 4.7', factors: [2, 4, 8], note: 'Vulkan · GPU', engine: 'ncnn', backend: 'gpu' },
    { id: 'rife-4.6', label: 'RIFE 4.6', factors: [2, 4, 8], note: 'Vulkan · GPU', engine: 'ncnn', backend: 'gpu' },
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
  sourceOrigin: document.getElementById('sourceOrigin'),

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

  modeChip: document.getElementById('modeChip'),
  tabEnhance: document.getElementById('tab-enhance'),
  tabLibrary: document.getElementById('tab-library'),
  tabSettings: document.getElementById('tab-settings'),
  viewEnhance: document.getElementById('view-enhance'),
  viewLibrary: document.getElementById('view-library'),
  viewSettings: document.getElementById('view-settings'),

  libraryUploadBtn: document.getElementById('libraryUploadBtn'),
  libraryFileInput: document.getElementById('libraryFileInput'),
  libraryUploadTrack: document.getElementById('libraryUploadTrack'),
  libraryUploadFill: document.getElementById('libraryUploadFill'),
  libraryNotice: document.getElementById('libraryNotice'),
  libraryList: document.getElementById('libraryList'),
  libraryEmpty: document.getElementById('libraryEmpty'),
  libraryDetail: document.getElementById('libraryDetail'),
  libraryBack: document.getElementById('libraryBack'),
  libraryDelete: document.getElementById('libraryDelete'),
  libraryDetailName: document.getElementById('libraryDetailName'),
  libraryDetailVersions: document.getElementById('libraryDetailVersions'),
  libraryPlayer: document.getElementById('libraryPlayer'),
  libraryDetailMeta: document.getElementById('libraryDetailMeta'),
  libraryDetailLabel: document.getElementById('libraryDetailLabel'),
  libraryEnhance: document.getElementById('libraryEnhance'),
  libraryDownload: document.getElementById('libraryDownload'),
  libraryTree: document.getElementById('libraryTree'),

  settingsSave: document.getElementById('settingsSave'),
  settingsCodec: document.getElementById('settingsCodec'),
  settingsContainer: document.getElementById('settingsContainer'),
  settingsPreset: document.getElementById('settingsPreset'),
  settingsAudio: document.getElementById('settingsAudio'),
  settingsCrf: document.getElementById('settingsCrf'),
  settingsCrfValue: document.getElementById('settingsCrfValue'),
  stationInfo: document.getElementById('stationInfo'),
  settingsStatus: document.getElementById('settingsStatus'),
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

  tab: 'enhance',
  station: { processingMode: 'auto', defaults: null },
  stationOnline: null,
  stationApplied: false,
  library: {
    items: [],
    loading: false,
    selectedId: null,
    detail: null,
    selectedVersionId: null,
    uploadXhr: null,
    uploading: false,
    noticeTimer: null,
    refreshTimer: null,
  },

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
          engine: typeof item.engine === 'string' ? item.engine : '',
          backend: typeof item.backend === 'string' ? item.backend : '',
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

function processingMode() {
  return state.station?.processingMode || 'auto';
}

function allowedUpscalers() {
  const mode = processingMode();
  const all = state.models.upscalers;
  if (mode === 'gpu') {
    const list = all.filter((model) => model.engine !== 'cpu');
    return list.length ? list : all;
  }
  if (mode === 'cpu') {
    const list = all.filter((model) => model.engine === 'cpu');
    return list.length ? list : all;
  }
  return all;
}

function allowedInterpolators() {
  const mode = processingMode();
  const all = state.models.interpolators;
  if (mode === 'gpu') {
    const list = all.filter((model) => model.backend === 'gpu');
    return list.length ? list : all;
  }
  return all;
}

function applyModeCompatibility() {
  const mode = processingMode();
  if (mode === 'gpu') {
    if (state.settings.upscale.model === 'lanczos') {
      state.settings.upscale.model = 'realesrgan-video';
    }
    const gpuModels = state.models.interpolators.filter((model) => model.backend === 'gpu');
    if (!gpuModels.some((model) => model.id === state.settings.interpolate.model) && gpuModels.length) {
      state.settings.interpolate.model = gpuModels[0].id;
    }
  } else if (mode === 'cpu') {
    if (state.settings.upscale.model !== 'lanczos') {
      state.settings.upscale.model = 'lanczos';
    }
  }
  state.settings = sanitizeSettings(state.settings, state.models);
  saveSettings();
  rebuildModelSelects();
  applySettingsToControls();
  updateProjection();
  updateCta();
  updateModeChip();
}

function updateModeChip() {
  const mode = processingMode();
  const labels = { auto: 'Auto', gpu: 'GPU only', cpu: 'CPU only' };
  if (els.modeChip) {
    els.modeChip.textContent = labels[mode] || 'Auto';
    els.modeChip.dataset.mode = mode;
  }
}

function updateModeChipFromForm() {
  const selected = document.querySelector('input[name="processingMode"]:checked');
  if (!selected || !els.modeChip) return;
  const labels = { auto: 'Auto', gpu: 'GPU only', cpu: 'CPU only' };
  els.modeChip.textContent = labels[selected.value] || 'Auto';
  els.modeChip.dataset.mode = selected.value;
}

function rebuildModelSelects() {
  const upscalers = allowedUpscalers();
  const interpolators = allowedInterpolators();

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

  applyModeCompatibility();
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
      driver: typeof gpu.driver === 'string' ? gpu.driver : '',
      cuda: gpu.cuda === true,
      vulkan: gpu.vulkan === true,
      cudaOnnx: gpu.cudaOnnx === true,
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

  updateModeChip();
  if (state.tab === 'settings') renderStationInfo();
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
    if (job.status === 'completed' && job.library?.itemId) {
      queueLibraryRefresh(job.library.itemId);
    }
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
    : Math.max(2, Math.ceil(source.width / 2) * 2);
  const height = settings.upscale.enabled
    ? Math.max(2, Math.round((source.height * scale) / 2) * 2)
    : Math.max(2, Math.ceil(source.height / 2) * 2);
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
    } else if (processingMode() === 'gpu' && !state.system?.gpu?.available) {
      disabled = true;
      reason = 'GPU-only mode is selected, but the station has no Vulkan device. Open Settings to switch modes.';
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
  els.sourceBadge.textContent = selected.library ? 'Library' : '1 clip';
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
    library: null,
    token,
  };
  els.sourceOrigin.hidden = true;
  els.sourceOrigin.textContent = '';

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
  if (state.selected?.url && !state.selected?.remote) URL.revokeObjectURL(state.selected.url);
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
  els.sourceOrigin.hidden = true;
  els.sourceOrigin.textContent = '';
  setSourceNote('');
  updateProjection();
  updateCta();

  if (focusDropzone) {
    requestAnimationFrame(() => els.dropzone.focus({ preventScroll: true }));
  }
}

function selectLibrarySource(item, version) {
  if (!item || !version) return;
  clearSelectedSource();
  const metadata = version.metadata || {};
  const url = libraryStreamUrl(item.id, version.id);
  const selected = {
    file: null,
    remote: true,
    url,
    name: item.name,
    size: metadata.sizeBytes || 0,
    width: metadata.width || null,
    height: metadata.height || null,
    duration: metadata.duration || null,
    fps: metadata.fps || null,
    library: { itemId: item.id, versionId: version.id, label: version.label },
    token: ++state.mediaToken,
  };
  state.selected = selected;
  els.dropzone.hidden = true;
  els.previewWrap.hidden = false;
  els.sourceMeta.hidden = false;
  els.videoPreview.dataset.mediaToken = String(selected.token);
  els.videoPreview.src = url;
  els.videoPreview.load();
  els.sourceOrigin.textContent = `From Library · ${version.label}`;
  els.sourceOrigin.hidden = false;
  updateSourceMeta();
  setSourceNote('Enhancement will create a child version in the Library tree.');
  updateProjection();
  updateCta();
  els.videoPreview.focus({ preventScroll: true });
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
    ? Math.max(2, Math.round((source.width * scaleFactor) / 2) * 2)
    : Math.max(2, Math.ceil(source.width / 2) * 2);
  const outputHeight = settings.upscale.enabled
    ? Math.max(2, Math.round((source.height * scaleFactor) / 2) * 2)
    : Math.max(2, Math.ceil(source.height / 2) * 2);

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
    const padded = source.width % 2 !== 0 || source.height % 2 !== 0;
    els.projNote.textContent = padded
      ? 'No scaling or frame generation. Odd source dimensions are padded by 1 px so H.264 output stays even.'
      : 'No scaling or frame generation. The clip is re-encoded only.';
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

  const selected = state.selected;
  const form = new FormData();
  if (selected.library) {
    form.append('libraryVersionId', selected.library.versionId);
    setUploadProgress(100);
  } else if (selected.file) {
    form.append('file', selected.file, selected.name);
  } else {
    finishUploadError('The selected clip is missing. Choose it again.');
    return;
  }
  form.append('settings', JSON.stringify({ ...state.settings, processing: { mode: processingMode() } }));

  const xhr = new XMLHttpRequest();
  state.uploadXhr = xhr;
  xhr.open('POST', '/api/jobs', true);
  xhr.setRequestHeader('Accept', 'application/json');

  if (!selected.library) {
    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      setUploadProgress((event.loaded / event.total) * 100);
      updateCta();
    });
  }

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
  const wasLibrary = Boolean(state.selected?.library);
  clearSelectedSource({ focusDropzone: true });
  updateCta();
  showCtaStatus(wasLibrary ? `Queued ${submittedName}.` : `Uploaded ${submittedName}.`);
  loadJobsNow();
  fetchSystem();
  if (job?.library?.itemId) {
    queueLibraryRefresh(job.library.itemId);
  }
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
    applyModeCompatibility();
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

  [els.tabEnhance, els.tabLibrary, els.tabSettings].forEach((button) => {
    button.addEventListener('click', () => showTab(button.dataset.tab));
    button.addEventListener('keydown', bindTabKeys);
  });
  els.modeChip.addEventListener('click', () => showTab('settings', { focus: true }));

  els.libraryUploadBtn.addEventListener('click', () => els.libraryFileInput.click());
  els.libraryFileInput.addEventListener('change', () => {
    const file = els.libraryFileInput.files?.[0];
    if (file) uploadLibraryFile(file);
  });
  els.libraryBack.addEventListener('click', closeLibraryDetail);
  els.libraryDelete.addEventListener('click', deleteLibraryItem);
  els.libraryEnhance.addEventListener('click', () => {
    const detail = state.library.detail;
    const version = selectedLibraryVersion();
    if (!detail || !version) return;
    selectLibrarySource(detail, version);
    showTab('enhance');
    showCtaStatus(`Loaded ${detail.name} · ${version.label}.`);
  });
  els.libraryTree.addEventListener('click', (event) => {
    const button = event.target.closest('[data-version-action]');
    if (!button) return;
    handleVersionAction(button.dataset.versionAction, button.dataset.versionId);
  });

  els.settingsSave.addEventListener('click', saveStationSettings);
  els.settingsCrf.addEventListener('input', updateSettingsCrfReadout);

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

/* ---------- tabs, settings, library ---------- */

function showTab(name, { focus = false } = {}) {
  if (!['enhance', 'library', 'settings'].includes(name)) name = 'enhance';
  state.tab = name;
  const tabs = [
    { id: 'enhance', button: els.tabEnhance, view: els.viewEnhance },
    { id: 'library', button: els.tabLibrary, view: els.viewLibrary },
    { id: 'settings', button: els.tabSettings, view: els.viewSettings },
  ];
  for (const item of tabs) {
    const active = item.id === name;
    item.button.classList.toggle('is-active', active);
    item.button.setAttribute('aria-selected', String(active));
    item.button.tabIndex = active ? 0 : -1;
    item.view.hidden = !active;
  }
  if (name === 'library') {
    fetchLibrary({ openId: state.library.selectedId });
  } else if (name === 'settings') {
    populateSettingsForm();
    renderStationInfo();
    fetchStationSettings();
  }
  try {
    history.replaceState(null, '', `#${name}`);
  } catch {
    /* file:// previews can reject history updates */
  }
  if (focus) tabs.find((item) => item.id === name)?.button.focus();
}

function bindTabKeys(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const order = ['enhance', 'library', 'settings'];
  let index = order.indexOf(state.tab);
  if (event.key === 'ArrowRight') index = (index + 1) % order.length;
  else if (event.key === 'ArrowLeft') index = (index - 1 + order.length) % order.length;
  else index = event.key === 'Home' ? 0 : order.length - 1;
  event.preventDefault();
  showTab(order[index], { focus: true });
}

async function fetchStationSettings() {
  try {
    const data = await fetchJson('/api/settings');
    state.station.processingMode = ['auto', 'gpu', 'cpu'].includes(data.processingMode) ? data.processingMode : 'auto';
    state.station.defaults = data.defaults || null;
    state.stationOnline = true;
    if (!state.stationApplied) {
      state.stationApplied = true;
      if (!HAS_STORED_SETTINGS && data.defaults) {
        if (data.defaults.encode) state.settings.encode = { ...state.settings.encode, ...data.defaults.encode };
        if (data.defaults.audio) state.settings.audio = { ...state.settings.audio, ...data.defaults.audio };
      }
    }
    applyModeCompatibility();
    populateSettingsForm();
    renderStationInfo();
  } catch {
    state.stationOnline = false;
    updateModeChip();
  }
}

function populateSettingsForm() {
  if (!els.settingsCodec) return;
  const mode = processingMode();
  document.querySelectorAll('input[name="processingMode"]').forEach((input) => {
    input.checked = input.value === mode;
  });
  const defaults = state.station.defaults || {
    encode: state.settings.encode,
    audio: state.settings.audio,
  };
  const encode = defaults.encode || state.settings.encode;
  const audio = defaults.audio || state.settings.audio;
  els.settingsCodec.value = encode.codec || 'h264';
  els.settingsContainer.value = encode.container || 'mp4';
  els.settingsPreset.value = encode.preset || 'veryfast';
  els.settingsAudio.value = audio.mode || 'copy';
  els.settingsCrf.value = String(Number.isInteger(encode.crf) ? encode.crf : 18);
  updateSettingsCrfReadout();
}

function updateSettingsCrfReadout() {
  const crf = Number(els.settingsCrf.value) || 18;
  els.settingsCrfValue.textContent = `CRF ${crf}`;
  els.settingsCrf.setAttribute('aria-valuetext', `Default CRF ${crf}`);
}

async function saveStationSettings() {
  const selected = document.querySelector('input[name="processingMode"]:checked');
  const payload = {
    processingMode: selected?.value || 'auto',
    defaults: {
      encode: {
        codec: els.settingsCodec.value,
        container: els.settingsContainer.value,
        preset: els.settingsPreset.value,
        crf: Number(els.settingsCrf.value) || 18,
      },
      audio: { mode: els.settingsAudio.value },
    },
  };
  els.settingsSave.disabled = true;
  els.settingsSave.textContent = 'Saving…';
  try {
    const data = await fetchJson('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    state.station.processingMode = data.processingMode || payload.processingMode;
    state.station.defaults = data.defaults || payload.defaults;
    state.settings.encode = { ...state.settings.encode, ...state.station.defaults.encode };
    state.settings.audio = { ...state.settings.audio, ...state.station.defaults.audio };
    applyModeCompatibility();
    populateSettingsForm();
    renderStationInfo();
    els.settingsStatus.textContent = 'Saved. New jobs use this mode and these defaults.';
    els.settingsStatus.hidden = false;
    setTimeout(() => { els.settingsStatus.hidden = true; }, 6000);
  } catch (error) {
    els.settingsStatus.textContent = error.detail || 'Could not save settings.';
    els.settingsStatus.hidden = false;
  } finally {
    els.settingsSave.disabled = false;
    els.settingsSave.textContent = 'Save settings';
  }
}

function renderStationInfo() {
  if (!els.stationInfo) return;
  const system = state.system;
  const rows = [];
  if (system) {
    const gpu = system.gpu || {};
    rows.push(['GPU', gpu.available ? gpu.name : 'No GPU']);
    if (gpu.available) {
      let backend = 'Unavailable';
      if (gpu.cuda && gpu.vulkan) backend = 'CUDA + Vulkan';
      else if (gpu.cuda) backend = 'CUDA';
      else if (gpu.vulkan) backend = gpu.driver ? `Vulkan · ${gpu.driver}` : 'Vulkan';
      rows.push(['AI backend', backend]);
    }
    rows.push(['CPU', `${system.cpu?.cores ?? '—'} cores · load ${system.cpu?.load1 != null ? system.cpu.load1.toFixed(2) : '—'}`]);
    rows.push(['Memory', system.memory ? `${system.memory.availableMb} MB free of ${system.memory.totalMb} MB` : '—']);
    rows.push(['Storage', system.storage ? `${system.storage.freeGb} GB free` : '—']);
    rows.push(['Queue', system.queue ? `${system.queue.active} active · ${system.queue.queued} waiting · ${system.queue.maxQueue} max` : '—']);
  }
  rows.push(['Processing mode', processingMode() === 'gpu' ? 'GPU only' : processingMode() === 'cpu' ? 'CPU only' : 'Auto']);
  rows.push(['Limits', `${MAX_UPLOAD_BYTES / (1024 ** 3)} GB upload · 4K output · ${state.system?.limits?.retentionHours ?? 72} h retention`]);
  els.stationInfo.replaceChildren();
  for (const [key, value] of rows) {
    const row = document.createElement('div');
    row.className = 'station-row';
    const label = document.createElement('span');
    label.className = 'station-key';
    label.textContent = key;
    const val = document.createElement('span');
    val.className = 'station-value';
    val.textContent = value;
    row.append(label, val);
    els.stationInfo.appendChild(row);
  }
}

/* ---------- library ---------- */

function libraryStreamUrl(itemId, versionId) {
  return `/api/library/${encodeURIComponent(itemId)}/versions/${encodeURIComponent(versionId)}/stream`;
}

function libraryThumbUrl(itemId, versionId) {
  return `/api/library/${encodeURIComponent(itemId)}/versions/${encodeURIComponent(versionId)}/thumbnail`;
}

function showLibraryNotice(message, { error = false, ttl = 7000 } = {}) {
  if (!els.libraryNotice) return;
  clearTimeout(state.library.noticeTimer);
  els.libraryNotice.textContent = message;
  els.libraryNotice.classList.toggle('is-error', error);
  els.libraryNotice.hidden = false;
  if (ttl > 0) {
    state.library.noticeTimer = setTimeout(() => {
      els.libraryNotice.hidden = true;
    }, ttl);
  }
}

async function fetchLibrary({ openId = null, silent = false } = {}) {
  if (state.library.loading) {
    clearTimeout(state.library.refreshTimer);
    state.library.refreshTimer = setTimeout(() => fetchLibrary({ openId, silent }), 800);
    return;
  }
  state.library.loading = true;
  try {
    const data = await fetchJson('/api/library');
    state.library.items = Array.isArray(data.items) ? data.items : [];
    renderLibraryList();
    const target = openId || state.library.selectedId;
    if (target && state.library.items.some((item) => item.id === target)) {
      await openLibraryItem(target, { preserveVersion: !openId });
    } else if (state.library.selectedId) {
      closeLibraryDetail();
    }
  } catch (error) {
    if (!silent) showLibraryNotice(error.detail || 'Could not load the library.', { error: true });
  } finally {
    state.library.loading = false;
  }
}

function renderLibraryList() {
  if (!els.libraryList) return;
  els.libraryList.replaceChildren();
  els.libraryEmpty.hidden = state.library.items.length > 0;
  for (const item of state.library.items) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'library-card';
    card.dataset.libraryId = item.id;
    card.setAttribute('aria-label', `Open ${item.name}`);

    const thumb = document.createElement('div');
    thumb.className = 'library-thumb';
    if (item.activeVersionId) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = libraryThumbUrl(item.id, item.activeVersionId);
      img.addEventListener('error', () => { img.hidden = true; });
      thumb.appendChild(img);
    }
    const play = document.createElement('span');
    play.className = 'library-thumb-play';
    play.setAttribute('aria-hidden', 'true');
    play.textContent = '▶';
    thumb.appendChild(play);

    const body = document.createElement('div');
    body.className = 'library-card-body';
    const title = document.createElement('span');
    title.className = 'library-card-name';
    title.textContent = item.name;
    const meta = document.createElement('span');
    meta.className = 'library-card-meta mono';
    const active = item.activeVersion?.metadata;
    meta.textContent = active
      ? `${active.width}×${active.height} · ${formatFps(active.fps)} fps · ${item.versionCount} version${item.versionCount === 1 ? '' : 's'}`
      : `${item.versionCount} version${item.versionCount === 1 ? '' : 's'}`;
    const label = document.createElement('span');
    label.className = 'library-card-label';
    label.textContent = item.activeVersion?.label || 'Original';
    body.append(title, meta, label);
    card.append(thumb, body);
    card.addEventListener('click', () => openLibraryItem(item.id));
    els.libraryList.appendChild(card);
  }
}

async function openLibraryItem(itemId, { preserveVersion = false } = {}) {
  try {
    const detail = await fetchJson(`/api/library/${encodeURIComponent(itemId)}`);
    state.library.selectedId = itemId;
    state.library.detail = detail;
    if (!preserveVersion || !detail.versions.some((version) => version.id === state.library.selectedVersionId)) {
      state.library.selectedVersionId = detail.activeVersionId || detail.versions[0]?.id || null;
    }
    els.libraryDetail.hidden = false;
    els.libraryEmpty.hidden = true;
    els.viewLibrary.classList.add('detail-open');
    renderLibraryDetail();
  } catch (error) {
    showLibraryNotice(error.detail || 'Could not open this library item.', { error: true });
  }
}

function closeLibraryDetail() {
  state.library.selectedId = null;
  state.library.detail = null;
  state.library.selectedVersionId = null;
  els.libraryDetail.hidden = true;
  els.viewLibrary.classList.remove('detail-open');
  els.libraryPlayer.pause();
  els.libraryPlayer.removeAttribute('src');
  els.libraryEmpty.hidden = state.library.items.length > 0;
}

function selectedLibraryVersion() {
  const detail = state.library.detail;
  if (!detail) return null;
  return detail.versions.find((version) => version.id === state.library.selectedVersionId)
    || detail.versions.find((version) => version.id === detail.activeVersionId)
    || detail.versions[0]
    || null;
}

function renderLibraryDetail() {
  const detail = state.library.detail;
  const version = selectedLibraryVersion();
  if (!detail || !version) return;
  const meta = version.metadata || {};
  els.libraryDetailName.textContent = detail.name;
  els.libraryDetailName.title = detail.name;
  els.libraryDetailVersions.textContent = `${detail.versions.length} version${detail.versions.length === 1 ? '' : 's'}`;
  els.libraryDetailMeta.textContent = `${meta.width}×${meta.height} · ${formatFps(meta.fps)} fps · ${formatDuration(meta.duration)} · ${formatBytes(meta.sizeBytes || 0)}`;
  const active = version.id === detail.activeVersionId;
  els.libraryDetailLabel.textContent = `${version.label}${active ? ' · active' : ' · restore to branch from here'}`;
  if (els.libraryPlayer.dataset.versionId !== version.id) {
    els.libraryPlayer.dataset.versionId = version.id;
    els.libraryPlayer.src = libraryStreamUrl(detail.id, version.id);
    els.libraryPlayer.poster = libraryThumbUrl(detail.id, version.id);
    els.libraryPlayer.load();
  }
  els.libraryDownload.href = `/api/library/${encodeURIComponent(detail.id)}/versions/${encodeURIComponent(version.id)}/download`;
  els.libraryDownload.setAttribute('download', '');
  renderVersionTree(detail, version);
}

function renderVersionTree(detail, selected) {
  els.libraryTree.replaceChildren();
  const children = new Map();
  for (const version of detail.versions) {
    const parent = version.parentVersionId || 'root';
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(version);
  }
  for (const list of children.values()) list.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  const walk = (parentId, depth) => {
    for (const version of children.get(parentId) || []) {
      const node = document.createElement('div');
      node.className = 'version-node';
      node.style.setProperty('--depth', String(depth));
      node.setAttribute('role', 'treeitem');
      node.setAttribute('aria-level', String(depth + 1));
      if (version.id === detail.activeVersionId) node.classList.add('is-active');
      if (version.id === selected.id) node.classList.add('is-selected');

      const line = document.createElement('div');
      line.className = 'version-line';
      const title = document.createElement('span');
      title.className = 'version-label';
      title.textContent = version.label;
      const meta = version.metadata || {};
      const metaEl = document.createElement('span');
      metaEl.className = 'version-meta mono';
      metaEl.textContent = `${meta.width}×${meta.height} · ${formatFps(meta.fps)} fps`;
      line.append(title, metaEl);
      if (version.id === detail.activeVersionId) {
        const badge = document.createElement('span');
        badge.className = 'version-badge';
        badge.textContent = 'Active';
        line.appendChild(badge);
      }

      const actions = document.createElement('div');
      actions.className = 'version-actions';
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'mini-btn';
      play.dataset.versionAction = 'play';
      play.dataset.versionId = version.id;
      play.textContent = 'Play';
      const download = document.createElement('a');
      download.className = 'mini-btn';
      download.href = `/api/library/${encodeURIComponent(detail.id)}/versions/${encodeURIComponent(version.id)}/download`;
      download.setAttribute('download', '');
      download.textContent = 'Download';
      const enhance = document.createElement('button');
      enhance.type = 'button';
      enhance.className = 'mini-btn';
      enhance.dataset.versionAction = 'enhance';
      enhance.dataset.versionId = version.id;
      enhance.textContent = 'Enhance';
      actions.append(play, download, enhance);
      if (version.id !== detail.activeVersionId) {
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.className = 'mini-btn';
        restore.dataset.versionAction = 'activate';
        restore.dataset.versionId = version.id;
        restore.textContent = 'Restore';
        actions.appendChild(restore);
      }
      node.append(line, actions);
      els.libraryTree.appendChild(node);
      walk(version.id, depth + 1);
    }
  };
  walk('root', 0);
}

async function handleVersionAction(action, versionId) {
  const detail = state.library.detail;
  if (!detail) return;
  const version = detail.versions.find((item) => item.id === versionId);
  if (!version) return;
  if (action === 'play') {
    state.library.selectedVersionId = versionId;
    renderLibraryDetail();
    els.libraryPlayer.play().catch(() => {});
  } else if (action === 'enhance') {
    selectLibrarySource(detail, version);
    showTab('enhance');
    showCtaStatus(`Loaded ${detail.name} · ${version.label}.`);
  } else if (action === 'activate') {
    try {
      const updated = await fetchJson(`/api/library/${encodeURIComponent(detail.id)}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId }),
      });
      state.library.detail = updated;
      state.library.selectedVersionId = updated.activeVersionId;
      renderLibraryDetail();
      renderLibraryList();
      showLibraryNotice(`Restored ${version.label}. Future enhancements branch from it.`);
    } catch (error) {
      showLibraryNotice(error.detail || 'Could not restore this version.', { error: true });
    }
  }
}

async function deleteLibraryItem() {
  const detail = state.library.detail;
  if (!detail) return;
  if (!window.confirm(`Delete “${detail.name}” and all of its versions? This cannot be undone.`)) return;
  try {
    await fetchJson(`/api/library/${encodeURIComponent(detail.id)}`, { method: 'DELETE' });
    closeLibraryDetail();
    await fetchLibrary({ silent: true });
    showLibraryNotice(`Deleted ${detail.name}.`);
  } catch (error) {
    showLibraryNotice(error.detail || 'Could not delete this item.', { error: true });
  }
}

function uploadLibraryFile(file) {
  const error = validateFile(file);
  if (error) {
    showLibraryNotice(error, { error: true });
    return;
  }
  const xhr = new XMLHttpRequest();
  state.library.uploadXhr = xhr;
  state.library.uploading = true;
  els.libraryUploadBtn.disabled = true;
  els.libraryUploadBtn.textContent = 'Uploading…';
  els.libraryUploadTrack.hidden = false;
  els.libraryUploadFill.style.width = '0%';
  els.libraryUploadTrack.setAttribute('aria-valuenow', '0');
  const form = new FormData();
  form.append('file', file, file.name);
  xhr.open('POST', '/api/library', true);
  xhr.setRequestHeader('Accept', 'application/json');
  xhr.upload.addEventListener('progress', (event) => {
    if (!event.lengthComputable) return;
    const percent = Math.round((event.loaded / event.total) * 100);
    els.libraryUploadFill.style.width = `${percent}%`;
    els.libraryUploadTrack.setAttribute('aria-valuenow', String(percent));
  });
  xhr.addEventListener('load', () => {
    let data = null;
    try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { data = null; }
    state.library.uploading = false;
    state.library.uploadXhr = null;
    els.libraryUploadBtn.disabled = false;
    els.libraryUploadBtn.textContent = 'Upload video';
    els.libraryUploadTrack.hidden = true;
    els.libraryFileInput.value = '';
    if (xhr.status >= 200 && xhr.status < 300 && data?.id) {
      showLibraryNotice(`Added ${data.name} to the library.`);
      fetchLibrary({ openId: data.id });
    } else {
      showLibraryNotice(extractDetail(data, xhr.status), { error: true });
    }
  });
  xhr.addEventListener('error', () => {
    state.library.uploading = false;
    els.libraryUploadBtn.disabled = false;
    els.libraryUploadBtn.textContent = 'Upload video';
    els.libraryUploadTrack.hidden = true;
    showLibraryNotice('Connection lost during the library upload.', { error: true });
  });
  xhr.send(form);
}

function queueLibraryRefresh(itemId = null) {
  clearTimeout(state.library.refreshTimer);
  state.library.refreshTimer = setTimeout(() => {
    if (state.tab === 'library' || state.library.selectedId) {
      fetchLibrary({ openId: state.library.selectedId, silent: true });
    }
  }, 600);
}


function boot() {
  const hash = (location.hash || '').replace('#', '');
  const initialTab = ['enhance', 'library', 'settings'].includes(hash) ? hash : 'enhance';
  rebuildModelSelects();
  applySettingsToControls();
  updateCrfReadout();
  updateModeChip();
  updateProjection();
  updateCta();
  renderSystem();
  renderJobs();
  renderLibraryList();
  saveSettings();
  bindEvents();
  showTab(initialTab);
  loadHealth();
  fetchSystem();
  fetchJobsNow();
  fetchStationSettings();
}

boot();
