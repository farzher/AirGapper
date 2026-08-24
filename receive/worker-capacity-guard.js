import { DecodeWorkerPool } from "../shared/worker-pool.js";

const threads = Math.max(1, Number(navigator.hardwareConcurrency) || 2);
const autoWorkerFloor = threads >= 8 ? Math.min(7, threads - 1) : 0;

function liveReceiveCamera() {
  const video = document.getElementById("video");
  const tracks = video?.srcObject?.getVideoTracks?.() ?? [];
  return document.body?.classList?.contains("receive-mode") === true &&
    tracks.some((track) => track?.readyState === "live");
}

// rVFC/canvas capture arrives as a transferable RGBA ArrayBuffer. The pool's
// historical fallback converted all 3.7M 1440p pixels to Y8 synchronously on
// the browser main thread before postMessage(), which can starve the very next
// requestVideoFrameCallback while decode workers sit idle. Mark that buffer as
// worker-owned before the pool sees it; prepareTrackedBrowserY8() then skips its
// main-thread pack because videoFrame is already present. worker-rvfc.js does
// the same green-channel Y8 pack inside the decode worker and hands the packed
// plane to the existing Guided decoder.
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
        if (!Array.isArray(transfer)) transfer = [];
        if (!transfer.includes(rgba)) transfer = [...transfer, rgba];
      }
    }
    return baseSubmitAtSlot.call(this, slot, message, transfer);
  };
  Object.defineProperty(submitAtSlot, "__airgapperRvfclumaGuard", { value: true });
  DecodeWorkerPool.prototype.submitAtSlot = submitAtSlot;
}

// Only AirGapper decode workers need the wrapper. Preserve the build/scalar
// query string so the wrapped worker imports the exact same codec variant.
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
