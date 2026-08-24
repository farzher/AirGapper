import { DecodeWorkerPool } from "../shared/worker-pool.js";

const threads = Math.max(1, Number(navigator.hardwareConcurrency) || 2);
const autoWorkerFloor = threads >= 8 ? Math.min(7, threads - 1) : 0;
const PACKED_TRACK_BYTES = 56;
const DENSE_REPAIR_MIN_TRACKS = 12;

function liveReceiveCamera() {
  const video = document.getElementById("video");
  const tracks = video?.srcObject?.getVideoTracks?.() ?? [];
  return document.body?.classList?.contains("receive-mode") === true &&
    tracks.some((track) => track?.readyState === "live");
}

function addTransfer(transfer, value) {
  if (!value) return Array.isArray(transfer) ? transfer : [];
  const list = Array.isArray(transfer) ? transfer : [];
  return list.includes(value) ? list : [...list, value];
}

function keepTrackedCameraOnGuided(message) {
  // The old rollout scheduler still injects a dense robust scout every ~30
  // tracked jobs. Guided is no longer experimental: it has cached Turbo,
  // Sparse, generic per-track fallback and dedicated whole-lattice recovery.
  // A full-crop robust scout can cost hundreds of milliseconds and duplicates
  // work without improving healthy throughput. Keep ordinary multi-QR camera
  // frames on Guided; explicit full/recovery jobs remain untouched.
  if (liveReceiveCamera() && message && !message.full && !message.strictHotPath &&
      message.videoFrame && Array.isArray(message.tracks) && message.tracks.length >= 2 &&
      (message.pixelFormat === "y8" || message.__airgapperWorkerLumaFromRgba)) {
    message.guidedDecode = true;
  }
}

function capDenseRepairMask(message) {
  const tracks = message?.tracks;
  if (!liveReceiveCamera() || message?.full || !message?.guidedDecode ||
      !Array.isArray(tracks) || tracks.length < DENSE_REPAIR_MIN_TRACKS) return;
  const laneMask = tracks.length >= 32 ? 0xffffffff : (2 ** tracks.length - 1) >>> 0;
  const requested = message.guidedRepairMask === undefined
    ? laneMask
    : Number(message.guidedRepairMask) >>> 0;
  const allowed = requested & laneMask;
  if (!allowed || (allowed & (allowed - 1)) === 0) return;

  // Dense-wall transport prefers a fresh camera frame over heroic salvage of a
  // badly damaged QR. RaptorQ already treats missing symbols as erasures. Keep
  // one explicit repair lane so a borderline QR can still self-heal, but never
  // let a single frame spend two long ambiguity-repair passes while newer
  // camera frames are waiting. Runtime orders the tracked batch by usefulness,
  // so the lowest surviving lane is the best repair candidate it supplied.
  message.guidedRepairMask = (allowed & -allowed) >>> 0;
}

function packTracks(message, transfer) {
  const tracks = message?.tracks;
  // Only live camera tracked batches use the pooled worker descriptors. Replay,
  // full acquisition and one-off developer paths keep their ordinary objects.
  if (message?.full || !message?.videoFrame || !Array.isArray(tracks) || tracks.length < 2) return transfer;
  const count = tracks.length;
  const packed = new ArrayBuffer(count * PACKED_TRACK_BYTES);
  const view = new DataView(packed);
  for (let index = 0; index < count; index++) {
    const track = tracks[index];
    const q = track?.quad;
    if (!q?.topLeft || !q?.topRight || !q?.bottomRight || !q?.bottomLeft) return transfer;
    const base = index * PACKED_TRACK_BYTES;
    view.setInt32(base, Math.trunc(Number(track.id) || 0), true);
    view.setInt32(base + 4, Number.isInteger(track.slot) ? track.slot : -1, true);
    view.setInt32(base + 8, Math.trunc(Number(track.misses) || 0), true);
    view.setInt32(base + 12, Math.trunc(Number(track.dim) || 0), true);
    view.setUint32(base + 16, Number(Boolean(track.crc32)) | (Number(Boolean(track.temporalProbe)) << 1), true);
    view.setFloat32(base + 20, Number(track.temporalRisk) || 0, true);
    view.setFloat32(base + 24, Number(q.topLeft.x), true);
    view.setFloat32(base + 28, Number(q.topLeft.y), true);
    view.setFloat32(base + 32, Number(q.topRight.x), true);
    view.setFloat32(base + 36, Number(q.topRight.y), true);
    view.setFloat32(base + 40, Number(q.bottomRight.x), true);
    view.setFloat32(base + 44, Number(q.bottomRight.y), true);
    view.setFloat32(base + 48, Number(q.bottomLeft.x), true);
    view.setFloat32(base + 52, Number(q.bottomLeft.y), true);
  }
  message.__airgapperPackedTracks = packed;
  message.__airgapperPackedTrackCount = count;
  message.tracks = undefined;
  return addTransfer(transfer, packed);
}

// rVFC/canvas capture arrives as a transferable RGBA ArrayBuffer. Do not pack
// all 3.7M 1440p pixels to Y8 on the browser main thread: transfer ownership to
// the worker immediately. worker-rvfc.js compacts green->Y8 in place there.
const baseSubmitAtSlot = DecodeWorkerPool.prototype.submitAtSlot;
if (typeof baseSubmitAtSlot === "function" && !baseSubmitAtSlot.__airgapperRvfclumaGuard) {
  const submitAtSlot = function(slot, message, transfer) {
    if (liveReceiveCamera() && message && !message.full && !message.videoFrame && !message.strictHotPath &&
        Array.isArray(message.tracks) && message.tracks.length >= 2 &&
        (!message.pixelFormat || message.pixelFormat === "rgba") && message.buf instanceof ArrayBuffer) {
      const rgba = message.buf;
      const width = Math.trunc(Number(message.w) || 0);
      const height = Math.trunc(Number(message.h) || 0);
      if (width > 0 && height > 0 && rgba.byteLength >= width * height * 4) {
        message.buf = undefined;
        message.videoFrame = rgba;
        message.__airgapperWorkerLumaFromRgba = true;
        message.guidedDecode = true;
        transfer = addTransfer(transfer, rgba);
      }
    }
    keepTrackedCameraOnGuided(message);
    capDenseRepairMask(message);
    transfer = packTracks(message, transfer);
    return baseSubmitAtSlot.call(this, slot, message, transfer);
  };
  Object.defineProperty(submitAtSlot, "__airgapperRvfclumaGuard", { value: true });
  DecodeWorkerPool.prototype.submitAtSlot = submitAtSlot;
}

// Every AirGapper decode worker uses the wrapper. Preserve the build/scalar
// query string so it imports the exact same codec variant.
const NativeWorker = globalThis.Worker;
if (typeof NativeWorker === "function" && !NativeWorker.__airgapperRvfclumaWorkerGuard) {
  const rewriteWorkerUrl = (input) => {
    try {
      const url = input instanceof URL ? new URL(input.href) : new URL(String(input), location.href);
      if (url.pathname.endsWith("/receive/worker.js")) {
        url.pathname = url.pathname.slice(0, -"worker.js".length) + "worker-rvfc.js";
      }
      return url;
    } catch {
      return input;
    }
  };
  function AirGapperWorker(url, options) {
    return new NativeWorker(rewriteWorkerUrl(url), options);
  }
  AirGapperWorker.prototype = NativeWorker.prototype;
  try { Object.setPrototypeOf(AirGapperWorker, NativeWorker); } catch {}
  Object.defineProperty(AirGapperWorker, "__airgapperRvfclumaWorkerGuard", { value: true });
  try { globalThis.Worker = AirGapperWorker; } catch {}
}

if (autoWorkerFloor > 0) {
  const baseResize = DecodeWorkerPool.prototype.resize;
  if (typeof baseResize === "function" && !baseResize.__airgapperCapacityGuard) {
    const resize = function(count) {
      const requested = Math.max(0, Math.trunc(Number(count) || 0));
      const selector = document.getElementById("decode-workers");
      const effective = requested > 0 && selector?.value === "auto"
        ? Math.max(requested, autoWorkerFloor)
        : requested;
      return baseResize.call(this, effective);
    };
    Object.defineProperty(resize, "__airgapperCapacityGuard", { value: true });
    DecodeWorkerPool.prototype.resize = resize;
  }

  const syncLabel = () => {
    const selector = document.getElementById("decode-workers");
    const option = selector?.querySelector('option[value="auto"]');
    if (option && selector.value === "auto") {
      const label = `Auto (${autoWorkerFloor})`;
      if (option.textContent !== label) option.textContent = label;
    }
  };
  queueMicrotask(syncLabel);
  const selector = document.getElementById("decode-workers");
  const option = selector?.querySelector('option[value="auto"]');
  if (selector && option && typeof MutationObserver === "function") {
    new MutationObserver(syncLabel).observe(option, { childList: true, characterData: true, subtree: true });
    selector.addEventListener("change", syncLabel);
  }
}
