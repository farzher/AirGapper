import { GridLattice } from "./grid-lattice.js";
import { DecodeWorkerPool } from "../shared/worker-pool.js";

const FRESH_PAYLOAD_HOLD_MS = 550;
const MAX_CONCURRENT_NATIVE_COPIES = 2;
const ACQUISITION_TIMEOUT_MS = 1500;
let freshPayloadUntil = 0;

function now() {
  return performance.now();
}

function noteFreshPayload(at) {
  const current = now();
  const packetAt = Number(at);
  const base = Number.isFinite(packetAt) && Math.abs(current - packetAt) < 5000
    ? Math.max(current, packetAt)
    : current;
  freshPayloadUntil = Math.max(freshPayloadUntil, base + FRESH_PAYLOAD_HOLD_MS);
}

function nativeFrame(value) {
  return typeof VideoFrame === "function" && value instanceof VideoFrame;
}

function closeMessageFrame(message) {
  if (!nativeFrame(message?.videoFrame)) return;
  try { message.videoFrame.close(); } catch {}
  message.videoFrame = void 0;
}

function activeNativeCopies(pool) {
  let count = 0;
  for (const meta of pool.activeMeta ?? []) {
    if (meta?.__airgapperNativeFrameCopy && !meta.__airgapperCopyComplete) count++;
  }
  return count;
}

function copyStageTimeout(meta) {
  const normal = Math.max(1, Number(meta?.timeoutMs) || 1);
  return Math.max(250, Math.min(600, normal * 0.20));
}

// CRC-valid payload is authoritative liveness. Geometry fitting may reject a
// noisy/stale quad, but that must not age a still-decoding wall into recovery.
const baseAccept = GridLattice.prototype.accept;
GridLattice.prototype.accept = function(detection, frameWidth, frameHeight) {
  const at = Number(detection?.at);
  if (this.candidate && Number.isFinite(at)) this.noteValidPacket(at);
  const snapshot = baseAccept.call(this, detection, frameWidth, frameHeight);
  if (snapshot && Number.isFinite(at)) {
    this.noteValidPacket(at);
    snapshot.state = this.state;
    snapshot.provisional = !this.active;
  }
  return snapshot;
};

const baseNoteValidPacket = GridLattice.prototype.noteValidPacket;
GridLattice.prototype.noteValidPacket = function(at = this.lastHitAt) {
  const accepted = baseNoteValidPacket.call(this, at);
  if (accepted && this.locked) noteFreshPayload(at);
  return accepted;
};

// Camera frames are scarce native buffers. One ordered admission path owns all
// rules for them: keep recovery out of the way while payload is flowing, keep
// only one full acquisition job active, bound copy-stage ownership, and close
// every frame that is rejected before postMessage transfers ownership.
const baseSubmitAtSlot = DecodeWorkerPool.prototype.submitAtSlot;
DecodeWorkerPool.prototype.submitAtSlot = function(slot, message, transfer) {
  const isNative = nativeFrame(message?.videoFrame);
  const fullAcquisition = Boolean(message?.full && message?.acquisitionMode);

  if (fullAcquisition && now() < freshPayloadUntil) {
    closeMessageFrame(message);
    return false;
  }
  if (fullAcquisition && this.activeFullCount >= 1) {
    closeMessageFrame(message);
    return false;
  }
  if (isNative && activeNativeCopies(this) >= MAX_CONCURRENT_NATIVE_COPIES) {
    closeMessageFrame(message);
    return false;
  }

  const worker = this.workers?.[slot];
  const accepted = baseSubmitAtSlot.call(this, slot, message, transfer);
  if (!accepted) {
    closeMessageFrame(message);
    return false;
  }

  const meta = this.activeMeta?.[slot];
  if (!meta || meta.id !== message.id) return true;

  if (fullAcquisition) {
    meta.timeoutMs = Math.min(Number(meta.timeoutMs) || ACQUISITION_TIMEOUT_MS, ACQUISITION_TIMEOUT_MS);
    meta.deadlineAt = meta.startedAt + meta.timeoutMs;
  }

  if (isNative) {
    meta.__airgapperNativeFrameCopy = true;
    meta.__airgapperCopyComplete = false;
    meta.__airgapperPreflight = false;
    if (worker?.__airgapperCameraCopyWarm) {
      meta.deadlineAt = Math.min(meta.deadlineAt, meta.startedAt + copyStageTimeout(meta));
    }
  }
  return true;
};

// The worker reports the exact point at which copyTo() completed and the native
// VideoFrame was closed. From then on a timeout belongs to decode/WASM, not the
// camera-buffer stage.
const baseConfigureWorker = DecodeWorkerPool.prototype.configureWorker;
DecodeWorkerPool.prototype.configureWorker = function(slot, worker) {
  baseConfigureWorker.call(this, slot, worker);
  worker.__airgapperCameraCopyWarm = false;
  const baseOnMessage = worker.onmessage;
  worker.onmessage = (event) => {
    const message = event?.data;
    if (message?.__airgapperCameraCopyComplete) {
      const meta = this.activeMeta?.[slot];
      if (meta && meta.id === message.id) {
        meta.__airgapperCopyComplete = true;
        meta.__airgapperPreflight = true;
        meta.deadlineAt = now() + Math.max(1, Number(meta.timeoutMs) || 1);
        worker.__airgapperCameraCopyWarm = true;
      }
      return;
    }
    return baseOnMessage?.call(worker, event);
  };
};

const baseTimeoutWorker = DecodeWorkerPool.prototype.timeoutWorker;
DecodeWorkerPool.prototype.timeoutWorker = function(slot, meta) {
  if (meta?.__airgapperNativeFrameCopy) {
    meta.__airgapperPreflight = Boolean(meta.__airgapperCopyComplete);
  }
  return baseTimeoutWorker.call(this, slot, meta);
};

// Route live decoder workers through the tiny copy-complete shim. The existing
// worker-capacity wrapper has already been installed before this module loads.
const PriorWorker = globalThis.Worker;
if (typeof PriorWorker === "function") {
  const rewriteWorkerUrl = (input) => {
    try {
      const url = input instanceof URL ? new URL(input.href) : new URL(String(input), location.href);
      if (url.pathname.endsWith("/receive/worker.js")) {
        url.pathname = url.pathname.slice(0, -"worker.js".length) + "worker-camera.js";
      }
      return url;
    } catch {
      return input;
    }
  };
  function StabilityWorker(url, options) {
    return new PriorWorker(rewriteWorkerUrl(url), options);
  }
  StabilityWorker.prototype = PriorWorker.prototype;
  try { Object.setPrototypeOf(StabilityWorker, PriorWorker); } catch {}
  try { globalThis.Worker = StabilityWorker; } catch {}
}
