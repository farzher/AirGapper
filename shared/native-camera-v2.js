const endpoint = globalThis.AirGapperNativeCameraV2;
let installed = false;
let nextRequestId = 1;
let activeTrack;
let frameHandler;
let resultHandler;
let previewHandler;
const pending = new Map();

const RESULT_MAGIC = 0x32444741; // AGD2
const RESULT_HEADER_BYTES = 104;
const RESULT_RECORD_BYTES = 52;
const PREVIEW_MAGIC = 0x32565041; // APV2
const PREVIEW_HEADER_BYTES = 28;
const GUIDED_METRICS_BYTES = 216;

function int64(view, offset) {
  return view.getUint32(offset, true) + view.getInt32(offset + 4, true) * 4294967296;
}

function scalarConstraint(value) {
  if (value && typeof value === "object") {
    if ("exact" in value) return value.exact;
    if ("ideal" in value) return value.ideal;
  }
  return value;
}

function flattenConstraints(constraints = {}) {
  const source = constraints.advanced?.[0] ?? constraints;
  const patch = {};
  for (const key of [
    "focusMode", "focusDistance", "pointsOfInterest",
    "exposureMode", "exposureTime", "iso", "exposureCompensation"
  ]) {
    if (source[key] !== undefined) patch[key] = scalarConstraint(source[key]);
  }
  return patch;
}

function makeNativeTrack(started) {
  let ended = false;
  const capabilities = started.capabilities ?? {};
  const settings = {
    deviceId: String(started.cameraId ?? ""),
    width: Number(started.width) || undefined,
    height: Number(started.height) || undefined,
    frameRate: Number(started.fps) || undefined,
    sensorFrameRate: Number(started.sensorFps) || undefined,
    measuredFps: started.settings?.measuredFps,
    measuredFrameDurationNs: started.settings?.measuredFrameDurationNs,
    pipeline: started.pipeline,
    highSpeed: Boolean(started.highSpeed),
    sensorOrientation: Number(started.sensorOrientation) || 0,
    sensorMode: `${started.fpsControl || "ae"}:${started.fixedFps ? "fixed" : "variable"}`,
    focusMode: started.settings?.focusMode,
    focusDistance: started.settings?.focusDistance,
    exposureMode: started.settings?.exposureMode,
    exposureTime: started.settings?.exposureTime,
    iso: started.settings?.iso,
    exposureCompensation: started.settings?.exposureCompensation,
    afState: started.settings?.afState,
    aeState: started.settings?.aeState,
    settingsEpoch: started.settings?.settingsEpoch
  };
  return {
    id: `camera2-ndk:${settings.deviceId}`,
    kind: "video",
    label: `Camera2 NDK ${settings.deviceId}`,
    get readyState() { return ended ? "ended" : "live"; },
    getCapabilities() { return capabilities; },
    getSettings() { return { ...settings }; },
    async applyConstraints(constraints = {}) {
      if (ended) throw new Error("Native Camera2 NDK track ended");
      const patch = flattenConstraints(constraints);
      if (!Object.keys(patch).length) return;
      const result = await request("apply", { patch }, 3500);
      if (result.settings) Object.assign(settings, result.settings);
    },
    stop() { ended = true; },
    _update(next) { if (!ended && next) Object.assign(settings, next); }
  };
}

function parseGuidedMetrics(view, offset, bytes) {
  if (bytes < GUIDED_METRICS_BYTES) return undefined;
  const u32 = (at) => view.getUint32(offset + at, true);
  const f64 = (at) => view.getFloat64(offset + at, true);
  const metrics = {
    totalMs: f64(0),
    binarizeMs: f64(8),
    finderMs: f64(16),
    sampleMs: f64(24),
    decodeMs: f64(32),
    tracks: u32(40),
    finderAttempts: u32(44),
    finderSuccesses: u32(48),
    finderTriplets: u32(52),
    sampleAttempts: u32(56),
    successful: u32(60),
    misses: u32(64),
    fastDecodeAttempts: u32(68),
    fastDecodeSuccesses: u32(72),
    genericDecodeAttempts: u32(76),
    fastDecodeMs: f64(80),
    genericDecodeMs: f64(88),
    genericFallbackTracks: u32(96),
    genericFallbackSuccesses: u32(100),
    genericFallbackSkipped: u32(104),
    sparseNoRsAttempts: u32(108),
    sparseNoRsSuccesses: u32(112),
    sparseRsFallbacks: u32(116),
    sparseSkipped: u32(120),
    turboAttempts: u32(124),
    fallbackAttemptMask: u32(128),
    fallbackSuccessMask: u32(132),
    sparseSuccessMask: u32(136),
    turboSuccesses: u32(140),
    stableRsAttempts: u32(144),
    stableRsSuccesses: u32(148),
    stableEligibleTracks: u32(152),
    sparseProfileAttempts: u32(156),
    sparseProfileSuccesses: u32(160),
    translationWarpTracks: u32(164),
    affineWarpTracks: u32(168),
    perspectiveWarpTracks: u32(172),
    perspectiveMeshWarpTracks: u32(176),
    erasureRsAttempts: u32(180),
    erasureRsSuccesses: u32(184),
    erasureRepairCodewords: u32(188),
    erasureRepairAttemptMask: u32(192),
    erasureRepairSuccessMask: u32(196),
    erasureRepairSuppressedMask: u32(200),
    finderLevelTracks: u32(204),
    finderLevelMatches: u32(208),
    finderLevelSeparation: u32(212)
  };
  if (metrics.finderLevelTracks) {
    const finderConfidence = Math.max(0, Math.min(1,
      metrics.finderLevelMatches / (metrics.finderLevelTracks * 147)));
    const separation = metrics.finderLevelSeparation / metrics.finderLevelTracks;
    const correctionBurden = Math.min(1, (
      metrics.sparseRsFallbacks + metrics.erasureRsAttempts + metrics.erasureRepairCodewords / 256
    ) / Math.max(1, metrics.tracks));
    metrics.optical = {
      confidence: finderConfidence,
      focusScore: Math.max(0, Math.min(1, (finderConfidence - 0.72) / 0.25)) *
        Math.max(0, Math.min(1, (separation - 20) / 70)) * (1 - correctionBurden * 0.45),
      exposureScore: Math.max(0, Math.min(1, (separation - 24) / 92)) * finderConfidence,
      transitionWidthModules: 1 - finderConfidence,
      blackLevel: 0,
      whiteLevel: separation,
      separation,
      noise: correctionBurden * Math.max(18, separation * 0.3),
      clipping: 0,
      banding: 0,
      temporalContamination: 0,
      tiles: metrics.finderLevelTracks,
      sampledModules: metrics.finderLevelTracks * 147,
      correctionBurden
    };
  }
  return metrics;
}

function parsePreview(buffer, view) {
  if (buffer.byteLength < PREVIEW_HEADER_BYTES) return null;
  const headerBytes = view.getUint16(4, true);
  const width = view.getInt32(8, true);
  const height = view.getInt32(12, true);
  if (headerBytes < PREVIEW_HEADER_BYTES || width <= 0 || height <= 0 || headerBytes + width * height > buffer.byteLength)
    return null;
  return {
    type: "preview",
    width,
    height,
    orientation: view.getInt32(16, true),
    sourceWidth: view.getInt32(20, true),
    sourceHeight: view.getInt32(24, true),
    y: new Uint8Array(buffer, headerBytes, width * height)
  };
}

function parseDecodeResult(buffer, view) {
  if (buffer.byteLength < RESULT_HEADER_BYTES) return null;
  const headerBytes = view.getUint16(4, true);
  const version = view.getUint16(6, true);
  const resultCount = view.getInt32(88, true);
  const metricsBytes = view.getInt32(92, true);
  const recordsBytes = view.getInt32(96, true);
  const payloadBytes = view.getInt32(100, true);
  if (version !== 1 || headerBytes < RESULT_HEADER_BYTES || resultCount < 0 || resultCount > 128 ||
      metricsBytes < 0 || recordsBytes !== resultCount * RESULT_RECORD_BYTES || payloadBytes < 0 ||
      headerBytes + metricsBytes + recordsBytes + payloadBytes > buffer.byteLength) return null;
  const recordsBase = headerBytes + metricsBytes;
  const payloadBase = recordsBase + recordsBytes;
  const records = [];
  for (let i = 0; i < resultCount; i++) {
    const at = recordsBase + i * RESULT_RECORD_BYTES;
    const bytesOffset = view.getInt32(at + 8, true);
    const bytesLength = view.getInt32(at + 12, true);
    const validPayload = bytesOffset >= 0 && bytesLength >= 0 && bytesOffset + bytesLength <= payloadBytes;
    records.push({
      id: view.getInt32(at, true),
      status: view.getInt32(at + 4, true),
      bytesOffset,
      bytesLength,
      dimension: view.getInt32(at + 16, true),
      quad: {
        topLeft: { x: view.getFloat32(at + 20, true), y: view.getFloat32(at + 24, true) },
        topRight: { x: view.getFloat32(at + 28, true), y: view.getFloat32(at + 32, true) },
        bottomRight: { x: view.getFloat32(at + 36, true), y: view.getFloat32(at + 40, true) },
        bottomLeft: { x: view.getFloat32(at + 44, true), y: view.getFloat32(at + 48, true) }
      },
      bytes: validPayload && bytesLength
        ? new Uint8Array(buffer, payloadBase + bytesOffset, bytesLength)
        : new Uint8Array(0)
    });
  }
  return {
    type: "decode",
    width: view.getInt32(8, true),
    height: view.getInt32(12, true),
    jobId: view.getInt32(16, true),
    sourceSequence: view.getInt32(20, true),
    frameNumber: int64(view, 24),
    timestampNs: int64(view, 32),
    exposureTimeNs: int64(view, 40),
    frameDurationNs: int64(view, 48),
    rollingShutterSkewNs: int64(view, 56),
    focusDistance: Number.isFinite(view.getFloat32(64, true)) ? view.getFloat32(64, true) : undefined,
    iso: view.getInt32(68, true),
    settingsEpoch: view.getInt32(72, true),
    orientation: view.getInt32(76, true),
    pipeline: view.getInt32(80, true),
    mode: view.getInt32(84, true),
    guidedMetrics: parseGuidedMetrics(view, headerBytes, metricsBytes),
    records
  };
}

function parseBinary(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 8) return null;
  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  if (magic === PREVIEW_MAGIC) return parsePreview(buffer, view);
  if (magic === RESULT_MAGIC) return parseDecodeResult(buffer, view);
  return null;
}

function install() {
  if (installed || !endpoint?.postMessage) return Boolean(endpoint?.postMessage);
  installed = true;
  endpoint.onmessage = (event) => {
    const data = event?.data;
    if (data instanceof ArrayBuffer) {
      const packet = parseBinary(data);
      if (!packet) return;
      if (packet.type === "preview") {
        try { previewHandler?.(packet); } catch (error) { console.error("Native camera v2 preview handler failed", error); }
      } else {
        activeTrack?._update({
          exposureTime: packet.exposureTimeNs > 0 ? packet.exposureTimeNs / 100000 : undefined,
          iso: packet.iso > 0 ? packet.iso : undefined,
          focusDistance: packet.focusDistance,
          settingsEpoch: packet.settingsEpoch
        });
        try { resultHandler?.(packet); } catch (error) { console.error("Native camera v2 result handler failed", error); }
      }
      return;
    }
    if (typeof data !== "string") return;
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message?.event === "settings") {
      activeTrack?._update(message.settings);
      return;
    }
    if (message?.event === "frame") {
      if (message.settings) activeTrack?._update(message.settings);
      try { frameHandler?.(message); } catch (error) { console.error("Native camera v2 frame handler failed", error); }
      return;
    }
    if (message?.event === "decodeError") {
      console.warn("Native camera v2 decoder", message.detail || "decode error");
      return;
    }
    const requestId = Number(message?.requestId);
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    clearTimeout(request.timer);
    if (message.ok) request.resolve(message);
    else request.reject(new Error(message.error || "Native camera v2 request failed"));
  };
  return true;
}

function request(op, payload = {}, timeoutMs = 8000) {
  if (!install()) return Promise.reject(new Error("Native Camera2 NDK bridge unavailable"));
  const requestId = nextRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Native camera v2 ${op} timed out`));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    try { endpoint.postMessage(JSON.stringify({ op, requestId, ...payload })); }
    catch (error) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(error);
    }
  });
}

function nativeCameraV2Available() { return install(); }
function nativeCameraV2Track() { return activeTrack; }
async function listNativeCamerasV2() { return request("list"); }
async function startNativeCameraV2({ cameraId, width, height, fps, sensorFps, pipeline, fpsControl, highSpeed }) {
  activeTrack?.stop();
  activeTrack = undefined;
  const started = await request("start", {
    cameraId, width, height, fps, sensorFps, pipeline, fpsControl, highSpeed: Boolean(highSpeed)
  }, 15000);
  activeTrack = makeNativeTrack(started);
  return started;
}
async function stopNativeCameraV2() {
  activeTrack?.stop();
  activeTrack = undefined;
  if (!install()) return;
  try { await request("stop", {}, 3000); } catch {}
}
function submitNativeCameraV2Plan(plan) {
  if (!install()) return false;
  try {
    endpoint.postMessage(JSON.stringify({ op: "plan", plan }));
    return true;
  } catch {
    return false;
  }
}
function setNativeCameraV2FrameHandler(handler) { frameHandler = typeof handler === "function" ? handler : undefined; }
function setNativeCameraV2ResultHandler(handler) { resultHandler = typeof handler === "function" ? handler : undefined; }
function setNativeCameraV2PreviewHandler(handler) { previewHandler = typeof handler === "function" ? handler : undefined; }

export {
  listNativeCamerasV2,
  nativeCameraV2Available,
  nativeCameraV2Track,
  setNativeCameraV2FrameHandler,
  setNativeCameraV2PreviewHandler,
  setNativeCameraV2ResultHandler,
  startNativeCameraV2,
  stopNativeCameraV2,
  submitNativeCameraV2Plan
};
