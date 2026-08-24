import { DecodeWorkerPool } from "../shared/worker-pool.js";

const PACKED_TRACK_BYTES = 56;
const DENSE_REPAIR_MIN_TRACKS = 12;

function liveReceiveCamera() {
  const video = document.getElementById("video");
  const tracks = video?.srcObject?.getVideoTracks?.() ?? [];
  return document.body?.classList?.contains("receive-mode") === true &&
    tracks.some((track) => track?.readyState === "live");
}

function addTransfer(transfer, value) {
  const list = Array.isArray(transfer) ? transfer : [];
  if (value && !list.includes(value)) list.push(value);
  return list;
}

function keepTrackedCameraOnGuided(message, live) {
  if (live && message && !message.full && !message.strictHotPath &&
      message.videoFrame && Array.isArray(message.tracks) && message.tracks.length >= 2 &&
      (message.pixelFormat === "y8" || message.__airgapperWorkerLumaFromRgba)) {
    message.guidedDecode = true;
    message.__airgapperLiveTracked = true;
  }
}

function capDenseRepairMask(message, live) {
  const tracks = message?.tracks;
  if (!live || message?.full || !message?.guidedDecode ||
      !Array.isArray(tracks) || tracks.length < DENSE_REPAIR_MIN_TRACKS) return;
  const laneMask = tracks.length >= 32 ? 0xffffffff : (2 ** tracks.length - 1) >>> 0;
  const requested = message.guidedRepairMask === undefined
    ? laneMask
    : Number(message.guidedRepairMask) >>> 0;
  const allowed = requested & laneMask;
  if (!allowed || (allowed & (allowed - 1)) === 0) return;
  // RaptorQ already treats a missing QR as an erasure. On a dense wall, bound
  // expensive ambiguity repair to one best candidate and spend the rest of the
  // budget on the next fresh camera frame.
  message.guidedRepairMask = (allowed & -allowed) >>> 0;
}

function packTracks(message, transfer) {
  const tracks = message?.tracks;
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
  // DecodeWorkerPool records this after our wrapper runs. Preserve the count so
  // latency/cost samples and the adaptive track-budget controller do not see a
  // packed job as a zero-track job.
  message.trackCount = count;
  message.tracks = undefined;
  return addTransfer(transfer, packed);
}

const baseSubmitAtSlot = DecodeWorkerPool.prototype.submitAtSlot;
if (typeof baseSubmitAtSlot === "function" && !baseSubmitAtSlot.__airgapperRvfclumaGuard) {
  const submitAtSlot = function(slot, message, transfer) {
    const live = liveReceiveCamera();
    if (live && message && !message.full && !message.videoFrame && !message.strictHotPath &&
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
    keepTrackedCameraOnGuided(message, live);
    capDenseRepairMask(message, live);
    transfer = packTracks(message, transfer);
    return baseSubmitAtSlot.call(this, slot, message, transfer);
  };
  Object.defineProperty(submitAtSlot, "__airgapperRvfclumaGuard", { value: true });
  DecodeWorkerPool.prototype.submitAtSlot = submitAtSlot;
}

// Every AirGapper decode worker uses the live-camera wrapper. Preserve the
// build/scalar query string so it imports the exact same codec variant.
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

// Do not override DecodeWorkerPool.resize() here. runtime.js owns the adaptive
// worker controller and intentionally grows/shrinks based on source FPS,
// measured latency and sustained pressure. A former 8-core guard silently
// forced Auto to seven workers even while the controller believed its target
// was 2-5, which defeated feedback, multiplied WASM/cache memory and reduced
// per-worker temporal locality. Manual worker counts remain untouched.
