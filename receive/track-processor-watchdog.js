// Low-allocation MediaStreamTrackProcessor stall guard.
//
// A transient camera/driver stall must not permanently demote Receive to the
// much slower rVFC -> canvas -> RGBA path. Keep one coarse watchdog per reader;
// when a native read stalls, cancel only that processor instance, recreate it on
// the same live track, and retry the outstanding read without surfacing an error
// to runtime.js. Normal non-stall processor errors still escape to runtime's
// compatibility fallback.

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

  class GuardedTrackProcessor {
    constructor(options) {
      this.options = options;
      this.processor = null;
      this.nativeReader = null;
      this.readerTaken = false;
      this.closed = false;
      this.generation = 0;
      this.pending = false;
      this.pendingSince = 0;
      this.restartRequested = false;
      this.restartPromise = null;
      this.cumulativeTotal = 0;
      this.cumulativeDiscarded = 0;
      this.deliveredFrames = 0;
      this.openNative();

      this.watchdog = setInterval(() => {
        if (this.closed || !this.pending || !this.pendingSince || this.restartRequested ||
            performance.now() - this.pendingSince < TRACK_PROCESSOR_STALL_MS) return;
        this.requestRestart(stallError());
      }, TRACK_PROCESSOR_WATCHDOG_MS);

      this.readable = {
        getReader: () => this.getReader()
      };
    }

    openNative() {
      const processor = new NativeTrackProcessor(this.options);
      const reader = processor.readable.getReader();
      this.processor = processor;
      this.nativeReader = reader;
    }

    snapshotCounters(processor = this.processor) {
      if (!processor) return;
      const total = Number(processor.totalFrames);
      const discarded = Number(processor.discardedFrames);
      if (Number.isFinite(total) && total > 0) this.cumulativeTotal += total;
      if (Number.isFinite(discarded) && discarded > 0) this.cumulativeDiscarded += discarded;
    }

    get totalFrames() {
      const current = Number(this.processor?.totalFrames);
      const nativeTotal = this.cumulativeTotal + (Number.isFinite(current) && current > 0 ? current : 0);
      return Math.max(this.deliveredFrames, nativeTotal);
    }

    get discardedFrames() {
      const current = Number(this.processor?.discardedFrames);
      return this.cumulativeDiscarded + (Number.isFinite(current) && current > 0 ? current : 0);
    }

    requestRestart(reason) {
      if (this.closed || this.restartRequested) return;
      this.restartRequested = true;
      const processor = this.processor;
      const reader = this.nativeReader;
      this.snapshotCounters(processor);
      this.processor = null;
      this.nativeReader = null;

      let cancel;
      try {
        cancel = reader?.cancel(reason);
      } catch {
        cancel = null;
      }
      this.restartPromise = Promise.resolve(cancel).catch(() => void 0).then(() => {
        try { reader?.releaseLock(); } catch {}
      });
    }

    finishRestart() {
      const pending = this.restartPromise ?? Promise.resolve();
      return pending.then(() => {
        if (this.closed) throw cancelError();
        if (!this.nativeReader) this.openNative();
        this.restartRequested = false;
        this.restartPromise = null;
        this.pendingSince = performance.now();
      });
    }

    readNative(token) {
      if (this.closed || token !== this.generation) return Promise.reject(cancelError());
      const reader = this.nativeReader;
      if (!reader) {
        return this.finishRestart().then(() => this.readNative(token));
      }

      let nativeRead;
      try {
        nativeRead = reader.read();
      } catch (error) {
        this.pending = false;
        this.pendingSince = 0;
        return Promise.reject(error);
      }

      return nativeRead.then((value) => {
        if (this.closed || token !== this.generation) {
          value?.value?.close?.();
          throw cancelError();
        }
        if (this.restartRequested) {
          value?.value?.close?.();
          return this.finishRestart().then(() => this.readNative(token));
        }
        this.pending = false;
        this.pendingSince = 0;
        if (!value?.done && value?.value) this.deliveredFrames++;
        return value;
      }, (error) => {
        if (this.closed || token !== this.generation) throw cancelError(error);
        if (this.restartRequested) {
          return this.finishRestart().then(() => this.readNative(token));
        }
        this.pending = false;
        this.pendingSince = 0;
        throw error;
      });
    }

    getReader() {
      if (this.readerTaken) throw new TypeError("ReadableStream is locked");
      this.readerTaken = true;
      let released = false;
      return {
        read: () => {
          if (released || this.closed) return Promise.reject(cancelError());
          if (this.pending) return Promise.reject(new TypeError("Concurrent TrackProcessor reads are unsupported"));
          const token = ++this.generation;
          this.pending = true;
          this.pendingSince = performance.now();
          return this.readNative(token);
        },
        cancel: (reason) => {
          if (released) return Promise.resolve();
          released = true;
          this.readerTaken = false;
          return this.shutdown(reason);
        },
        releaseLock: () => {
          if (released) return;
          released = true;
          this.readerTaken = false;
          void this.shutdown();
        }
      };
    }

    shutdown(reason) {
      if (this.closed) return Promise.resolve();
      this.closed = true;
      ++this.generation;
      this.pending = false;
      this.pendingSince = 0;
      clearInterval(this.watchdog);
      const reader = this.nativeReader;
      this.nativeReader = null;
      this.processor = null;
      let cancelled;
      try {
        cancelled = reader?.cancel(reason);
      } catch {
        cancelled = null;
      }
      return Promise.resolve(cancelled).catch(() => void 0).finally(() => {
        try { reader?.releaseLock(); } catch {}
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
