const endpoint = globalThis.AirGapperNativeCamera;
let installed = false;
let nextRequestId = 1;
let frameHandler;
let activeTrack;
const pending = new Map();
const NATIVE_Y_MAGIC = 0x32594741;
const NATIVE_Y_HEADER_BYTES = 88;

function parseNativeFrame(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < NATIVE_Y_HEADER_BYTES) return null;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== NATIVE_Y_MAGIC) return null;
  const headerBytes = view.getUint16(4, true);
  const width = view.getUint32(8, true);
  const height = view.getUint32(12, true);
  const stride = view.getUint32(16, true);
  if (headerBytes < NATIVE_Y_HEADER_BYTES || stride < width || headerBytes + stride * height > buffer.byteLength) return null;
  const finiteOrUndefined = (value) => Number.isFinite(value) ? value : undefined;
  const int64 = (offset) => view.getUint32(offset, true) + view.getInt32(offset + 4, true) * 4294967296;
  return {
    buffer,
    yOffset: headerBytes,
    width,
    height,
    stride,
    orientation: view.getInt32(20, true),
    sequence: int64(24),
    timestampNs: int64(32),
    exposureTimeNs: int64(40),
    frameDurationNs: int64(48),
    rollingShutterSkewNs: int64(56),
    focusDistance: finiteOrUndefined(view.getFloat32(64, true)),
    iso: view.getInt32(68, true),
    afState: view.getInt32(72, true),
    aeState: view.getInt32(76, true),
    settingsEpoch: view.getInt32(80, true),
    pipeline: view.getInt32(84, true)
  };
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
    pipeline: started.pipeline,
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
  const track = {
    id: `camera2:${settings.deviceId}`,
    kind: "video",
    label: `Camera2 ${settings.deviceId}`,
    get readyState() { return ended ? "ended" : "live"; },
    getCapabilities() { return capabilities; },
    getSettings() { return { ...settings }; },
    async applyConstraints(constraints = {}) {
      if (ended) throw new Error("Native Camera2 track ended");
      const patch = flattenConstraints(constraints);
      if (!Object.keys(patch).length) return;
      const result = await request("apply", { patch }, 3500);
      if (result.settings) Object.assign(settings, result.settings);
    },
    stop() { ended = true; },
    _update(next) { if (!ended && next) Object.assign(settings, next); }
  };
  return track;
}

function nativeCameraTrack() {
  return activeTrack;
}

function install() {
  if (installed || !endpoint?.postMessage) return Boolean(endpoint?.postMessage);
  installed = true;
  endpoint.onmessage = (event) => {
    const data = event?.data;
    if (data instanceof ArrayBuffer) {
      // WebView owns a copy now, so release Camera2 before decode. Metadata and
      // Y8 remain one transferable object and cannot drift apart.
      ackNativeCameraFrame();
      const frame = parseNativeFrame(data);
      if (frame) activeTrack?._update({
        exposureTime: frame.exposureTimeNs > 0 ? frame.exposureTimeNs / 100000 : undefined,
        iso: frame.iso > 0 ? frame.iso : undefined,
        focusDistance: frame.focusDistance,
        afState: frame.afState,
        aeState: frame.aeState,
        settingsEpoch: frame.settingsEpoch
      });
      if (frameHandler && frame) {
        try {
          frameHandler(frame);
        } catch (error) {
          console.error("Native camera frame handler failed", error);
        }
      }
      return;
    }
    if (typeof data !== "string") return;
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (message?.event === "settings") {
      activeTrack?._update(message.settings);
      return;
    }
    const requestId = Number(message?.requestId);
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    clearTimeout(request.timer);
    if (message.ok) request.resolve(message);
    else request.reject(new Error(message.error || "Native camera request failed"));
  };
  return true;
}

function nativeCameraAvailable() {
  return install();
}

function request(op, payload = {}, timeoutMs = 8000) {
  if (!install()) return Promise.reject(new Error("Native Camera2 bridge unavailable"));
  const requestId = nextRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Native camera ${op} timed out`));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    try {
      endpoint.postMessage(JSON.stringify({ op, requestId, ...payload }));
    } catch (error) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(error);
    }
  });
}

async function listNativeCameras() {
  return request("list");
}

async function startNativeCamera({ cameraId, width, height, fps, pipeline, fpsControl }) {
  activeTrack?.stop();
  activeTrack = undefined;
  const started = await request("start", { cameraId, width, height, fps, pipeline, fpsControl }, 15000);
  activeTrack = makeNativeTrack(started);
  return started;
}

async function stopNativeCamera() {
  activeTrack?.stop();
  activeTrack = undefined;
  if (!install()) return;
  try {
    await request("stop", {}, 3000);
  } catch {
    // Activity lifecycle also closes Camera2. Stop is best-effort during teardown.
  }
}

function ackNativeCameraFrame() {
  if (!install()) return;
  try {
    endpoint.postMessage(JSON.stringify({ op: "ack" }));
  } catch {
  }
}

function setNativeCameraFrameHandler(handler) {
  frameHandler = typeof handler === "function" ? handler : undefined;
}

export {
  ackNativeCameraFrame,
  listNativeCameras,
  nativeCameraAvailable,
  nativeCameraTrack,
  setNativeCameraFrameHandler,
  startNativeCamera,
  stopNativeCamera
};
