const MODE_RESULTS_KEY = "airgapper:browser-camera-modes:v1";
const PERFORMANCE_KEY = "airgapper:camera-performance:v1";
const PERFORMANCE_FRESH_MS = 30 * 24 * 60 * 60 * 1000;

function loadJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function freshPerformance(record, now = Date.now()) {
  const updatedAt = Number(record?.updatedAt);
  return Number.isFinite(updatedAt) && updatedAt > 0 && now - updatedAt <= PERFORMANCE_FRESH_MS;
}

export function formatCameraSize(width, height) {
  return `${Math.max(width, height)}×${Math.min(width, height)}`;
}

export function formatCameraMode(width, height, fps) {
  return `${formatCameraSize(width, height)} · ${fps} fps`;
}

function capabilities(device) {
  try {
    return device?.getCapabilities?.() ?? {};
  } catch {
    return {};
  }
}

function facingHint(device, caps) {
  const modes = Array.isArray(caps?.facingMode) ? caps.facingMode : caps?.facingMode ? [caps.facingMode] : [];
  const label = String(device?.label ?? "").toLowerCase();
  if (modes.includes("environment") || /back|rear|environment/.test(label)) return "rear";
  if (modes.includes("user") || /front|user|selfie/.test(label)) return "front";
  return "unknown";
}

export class CameraUiStore {
  constructor() {
    this.modeResults = loadJson(MODE_RESULTS_KEY);
    this.performance = loadJson(PERFORMANCE_KEY);
    this.performanceSaveAt = 0;
    this.performancePersistPending = false;
    this.performancePersistHandle = 0;
    this.performancePersistUsesIdle = false;
    window.addEventListener("pagehide", () => this.flushPerformance(), { passive: true });
  }

  schedulePerformanceSave() {
    if (this.performancePersistPending) return;
    this.performancePersistPending = true;
    const persist = () => {
      this.performancePersistPending = false;
      this.performancePersistHandle = 0;
      this.performancePersistUsesIdle = false;
      saveJson(PERFORMANCE_KEY, this.performance);
    };
    if (typeof requestIdleCallback === "function") {
      this.performancePersistUsesIdle = true;
      this.performancePersistHandle = requestIdleCallback(persist, { timeout: 5000 });
    } else {
      this.performancePersistHandle = setTimeout(persist, 1000);
    }
  }

  flushPerformance() {
    if (!this.performancePersistPending) return;
    if (this.performancePersistHandle) {
      if (this.performancePersistUsesIdle && typeof cancelIdleCallback === "function")
        cancelIdleCallback(this.performancePersistHandle);
      else
        clearTimeout(this.performancePersistHandle);
    }
    this.performancePersistPending = false;
    this.performancePersistHandle = 0;
    this.performancePersistUsesIdle = false;
    saveJson(PERFORMANCE_KEY, this.performance);
  }

  standardModes(resolutions) {
    return resolutions.flatMap(([width, height]) => [30, 60].map((fps) => ({
      key: `${width}x${height}@${fps}`,
      width,
      height,
      fps,
      label: formatCameraMode(width, height, fps)
    }))).sort((a, b) => a.width - b.width || a.height - b.height || a.fps - b.fps);
  }

  modeSuffix(key) {
    return this.modeResults[key] === true ? "" : this.modeResults[key] === false ? " · Retry" : " · Try";
  }

  noteModeResult(key, supported) {
    this.modeResults[key] = supported;
    saveJson(MODE_RESULTS_KEY, this.modeResults);
  }

  learnedAutomaticCameraId() {
    let bestId = "";
    let best = -1;
    for (const [id, record] of Object.entries(this.performance)) {
      if (!freshPerformance(record)) continue;
      const goodput = Math.max(Number(record?.bestGoodputKbs) || 0, Number(record?.lastGoodputKbs) || 0);
      if (goodput > best) {
        best = goodput;
        bestId = id;
      }
    }
    return bestId;
  }

  score(device, index) {
    const caps = capabilities(device);
    const record = this.performance[device.deviceId] ?? {};
    const width = Number(caps?.width?.max) || Number(record.maxWidth) || 0;
    const height = Number(caps?.height?.max) || Number(record.maxHeight) || 0;
    const area = width * height;
    const fps = Number(caps?.frameRate?.max) || Number(record.maxFps) || 0;
    const goodput = freshPerformance(record)
      ? Math.max(Number(record.bestGoodputKbs) || 0, Number(record.lastGoodputKbs) || 0)
      : 0;
    const focusModes = Array.isArray(caps?.focusMode) ? caps.focusMode : [];
    const autofocus = focusModes.includes("continuous") ? 1 : 0;
    const main = /camera(?:2)?\s*0(?:\D|$)|\bmain\b|\bprimary\b/.test(String(device.label ?? "").toLowerCase()) ? 1 : 0;
    const cadence = fps >= 36 ? 1 : 0;
    return main * 1e12 + cadence * 1e9 + area + fps * 10000 + goodput * 1000 + autofocus * 50000 - index;
  }

  bestAutomaticDevice(devices) {
    if (!devices.length) return undefined;
    const tagged = devices.map((device, index) => ({ device, index, caps: capabilities(device) }));
    const rear = tagged.filter(({ device, caps }) => facingHint(device, caps) === "rear");
    const candidates = rear.length ? rear : tagged.filter(({ device, caps }) => facingHint(device, caps) !== "front");
    const pool = candidates.length ? candidates : tagged;
    return pool.reduce((best, candidate) =>
      !best || this.score(candidate.device, candidate.index) > this.score(best.device, best.index)
        ? candidate : best, undefined)?.device;
  }

  notePerformance(track, goodputKbs, uniqueRate, runSeconds) {
    if (runSeconds < 3 || goodputKbs <= 0 || performance.now() < this.performanceSaveAt) return;
    const settings = track?.getSettings?.();
    const id = String(settings?.deviceId ?? "");
    if (!id) return;
    this.performanceSaveAt = performance.now() + 2000;
    const previous = this.performance[id] ?? {};
    // Throughput is a starting prior, not permanent hardware truth. After the
    // record ages out, relearn speed from the current AirGapper/camera behavior
    // instead of reviving an ancient all-time best by merely refreshing updatedAt.
    const record = freshPerformance(previous) ? previous : {
      maxWidth: Number(previous.maxWidth) || 0,
      maxHeight: Number(previous.maxHeight) || 0,
      maxFps: Number(previous.maxFps) || 0
    };
    record.bestGoodputKbs = Math.max(Number(record.bestGoodputKbs) || 0, goodputKbs);
    record.lastGoodputKbs = goodputKbs;
    record.bestUniqueQrPerSecond = Math.max(Number(record.bestUniqueQrPerSecond) || 0, uniqueRate);
    record.maxWidth = Math.max(Number(record.maxWidth) || 0, Number(settings.width) || 0);
    record.maxHeight = Math.max(Number(record.maxHeight) || 0, Number(settings.height) || 0);
    record.maxFps = Math.max(Number(record.maxFps) || 0, Number(settings.frameRate) || 0);
    record.updatedAt = Date.now();
    this.performance[id] = record;
    this.schedulePerformanceSave();
  }
}
