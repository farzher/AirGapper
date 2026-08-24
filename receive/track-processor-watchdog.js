// Low-allocation MediaStreamTrackProcessor stall guard.
//
// The previous guard created a fresh setTimeout for every reader.read(). At
// camera cadence that meant 30-60 native timer allocations/clears per second on
// top of the unavoidable read Promise. A reader can only have one outstanding
// read in AirGapper, so one coarse watchdog per reader is enough.

const TRACK_PROCESSOR_STALL_MS = 900;
const TRACK_PROCESSOR_WATCHDOG_MS = 200;

function stallError() {
  return typeof DOMException === "function"
    ? new DOMException("MediaStreamTrackProcessor stalled", "AbortError")
    : new Error("MediaStreamTrackProcessor stalled");
}

function cancelError(reason) {
  if (reason instanceof Error) return reason;
  return typeof DOMException === "function"
    ? new DOMException("MediaStreamTrackProcessor cancelled", "AbortError")
    : new Error("MediaStreamTrackProcessor cancelled");
}

function installTrackProcessorWatchdog() {
  const NativeTrackProcessor = globalThis.MediaStreamTrackProcessor;
  if (typeof NativeTrackProcessor !== "function" || NativeTrackProcessor.__airgapperStallGuard) return;

  const guardedReader = (nativeReader) => {
    let generation = 0;
    let pendingReject = null;
    let pendingSince = 0;
    let closed = false;

    const clearPending = () => {
      pendingReject = null;
      pendingSince = 0;
    };

    const rejectPending = (error) => {
      const reject = pendingReject;
      if (!reject) return false;
      ++generation;
      clearPending();
      reject(error);
      return true;
    };

    // One reader-wide timer replaces one timeout per camera frame. 200 ms
    // granularity is immaterial against a 900 ms genuine-stall threshold.
    const watchdog = setInterval(() => {
      if (closed || !pendingReject || !pendingSince ||
          performance.now() - pendingSince < TRACK_PROCESSOR_STALL_MS) return;
      closed = true;
      const error = stallError();
      rejectPending(error);
      // Cancel the native pending read too. If it resolves late, the generation
      // check below closes the returned VideoFrame instead of leaking it.
      void nativeReader.cancel(error).catch(() => void 0).finally(() => {
        clearInterval(watchdog);
        try { nativeReader.releaseLock(); } catch {}
      });
    }, TRACK_PROCESSOR_WATCHDOG_MS);

    return {
      read() {
        if (closed) return Promise.reject(cancelError());
        const token = ++generation;
        pendingSince = performance.now();
        return new Promise((resolve, reject) => {
          pendingReject = reject;
          let nativeRead;
          try {
            nativeRead = nativeReader.read();
          } catch (error) {
            if (token === generation) clearPending();
            reject(error);
            return;
          }
          nativeRead.then((value) => {
            if (token !== generation || pendingReject !== reject) {
              value?.value?.close?.();
              return;
            }
            clearPending();
            resolve(value);
          }, (error) => {
            if (token !== generation || pendingReject !== reject) return;
            clearPending();
            reject(error);
          });
        });
      },
      cancel(reason) {
        closed = true;
        clearInterval(watchdog);
        rejectPending(cancelError(reason));
        return nativeReader.cancel(reason);
      },
      releaseLock() {
        closed = true;
        clearInterval(watchdog);
        rejectPending(cancelError());
        try { nativeReader.releaseLock(); } catch {}
      }
    };
  };

  class GuardedTrackProcessor {
    constructor(options) {
      const processor = new NativeTrackProcessor(options);
      this.readable = {
        getReader() {
          return guardedReader(processor.readable.getReader());
        }
      };
      Object.defineProperties(this, {
        totalFrames: { get: () => processor.totalFrames },
        discardedFrames: { get: () => processor.discardedFrames }
      });
    }
  }

  Object.defineProperty(GuardedTrackProcessor, "__airgapperStallGuard", { value: true });
  try {
    globalThis.MediaStreamTrackProcessor = GuardedTrackProcessor;
  } catch {
    try {
      Object.defineProperty(globalThis, "MediaStreamTrackProcessor", {
        configurable: true,
        writable: true,
        value: GuardedTrackProcessor
      });
    } catch {}
  }
}

installTrackProcessorWatchdog();
