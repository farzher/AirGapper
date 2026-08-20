const endpoint = globalThis.AirGapperNativeCamera;
let installed = false;
let nextRequestId = 1;
let frameHandler;
const pending = new Map();

function install() {
  if (installed || !endpoint?.postMessage) return Boolean(endpoint?.postMessage);
  installed = true;
  endpoint.onmessage = (event) => {
    const data = event?.data;
    if (data instanceof ArrayBuffer) {
      if (frameHandler) {
        try {
          frameHandler(data);
        } catch (error) {
          console.error("Native camera frame handler failed", error);
          ackNativeCameraFrame();
        }
      } else {
        ackNativeCameraFrame();
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

async function startNativeCamera({ cameraId, width, height, fps, pipeline }) {
  return request("start", { cameraId, width, height, fps, pipeline }, 15000);
}

async function stopNativeCamera() {
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
  setNativeCameraFrameHandler,
  startNativeCamera,
  stopNativeCamera
};
