// Low-allocation MediaStreamTrackProcessor stall guard.
//
// A reader can only have one outstanding read in AirGapper, so one coarse
// watchdog per reader is enough. The guard tracks that one native read with a
// generation token and returns its .then() chain directly; there is no extra
// manually-constructed Promise at camera cadence.

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
    let pending = false;
    let pendingSince = 0;
    let closed = false;
    let terminalError = null;

    const clearPending = (token) => {
      if (token !== generation) return;
      pending = false;
      pendingSince = 0;
    };

    const invalidatePending = (error) => {
      terminalError = error;
      ++generation;
      pending = false;
      pendingSince = 0;
    };

    // One reader-wide timer replaces one timeout per camera frame. 200 ms
    // granularity is immaterial against a 900 ms genuine-stall threshold.
    const watchdog = setInterval(() => {
      if (closed || !pending || !pendingSince ||
          performance.now() - pendingSince < TRACK_PROCESSOR_STALL_MS) return;
      closed = true;
      const error = stallError();
      invalidatePending(error);
      // Cancel settles the native read. Its derived promise below turns any
      // late frame into the same AbortError and closes that frame first.
      void nativeReader.cancel(error).catch(() => void 0).finally(() => {
        clearInterval(watchdog);
        try { nativeReader.releaseLock(); } catch {}
      });
    }, TRACK_PROCESSOR_WATCHDOG_MS);

    return {
      read() {
        if (closed) return Promise.reject(terminalError ?? cancelError());
        const token = ++generation;
        pending = true;
        pendingSince = performance.now();
        let nativeRead;
        try {
          nativeRead = nativeReader.read();
        } catch (error) {
          clearPending(token);
          return Promise.reject(error);
        }
        // Returning this chain directly removes the old outer new Promise().
        // The native read plus this one derived promise are the minimum needed
        // to close/reject a frame that resolves after watchdog cancellation.
        return nativeRead.then((value) => {
          if (token !== generation || closed) {
            value?.value?.close?.();
            throw terminalError ?? cancelError();
          }
          clearPending(token);
          return value;
        }, (error) => {
          if (token === generation) clearPending(token);
          if (token !== generation && terminalError) throw terminalError;
          throw error;
        });
      },
      cancel(reason) {
        if (!closed) {
          closed = true;
          invalidatePending(cancelError(reason));
        }
        clearInterval(watchdog);
        return nativeReader.cancel(reason);
      },
      releaseLock() {
        if (!closed) {
          closed = true;
          invalidatePending(cancelError());
        }
        clearInterval(watchdog);
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
