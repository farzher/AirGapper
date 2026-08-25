// Native MediaStreamTrackProcessor stall recovery. The mobile worker-backed
// processor already owns its own worker/error/snapshot lifecycle, so never wrap
// that proxy a second time.
const TRACK_PROCESSOR_STALL_MS = 900;
const TRACK_PROCESSOR_WATCHDOG_MS = 200;

function abortError(message = "MediaStreamTrackProcessor stalled") {
  return typeof DOMException === "function"
    ? new DOMException(message, "AbortError")
    : new Error(message);
}

function installTrackProcessorWatchdog() {
  const NativeTrackProcessor = globalThis.MediaStreamTrackProcessor;
  if (typeof NativeTrackProcessor !== "function" || NativeTrackProcessor.__airgapperStallGuard) return;

  // track-processor-proxy installs a JS class with these private methods on
  // mobile/coarse-pointer devices. It already handles worker failure and rVFC
  // snapshot fallback, so wrapping it here only duplicates lifecycle state.
  const proxyPrototype = NativeTrackProcessor.prototype;
  if (typeof proxyPrototype?._onMessage === "function" && typeof proxyPrototype?._requestSnapshot === "function") return;

  class GuardedTrackProcessor {
    constructor(options) {
      this.options = options;
      this.processor = null;
      this.reader = null;
      this.readerTaken = false;
      this.closed = false;
      this.pending = false;
      this.pendingSince = 0;
      this.deliveredFrames = 0;
      this.totalBeforeRestart = 0;
      this.discardedBeforeRestart = 0;
      this.open();
      this.watchdog = setInterval(() => {
        if (!this.closed && this.pending && this.pendingSince &&
            performance.now() - this.pendingSince >= TRACK_PROCESSOR_STALL_MS) {
          void this.restart();
        }
      }, TRACK_PROCESSOR_WATCHDOG_MS);
      this.readable = { getReader: () => this.getReader() };
    }

    open() {
      this.processor = new NativeTrackProcessor(this.options);
      this.reader = this.processor.readable.getReader();
    }

    captureCounters() {
      const total = Number(this.processor?.totalFrames);
      const discarded = Number(this.processor?.discardedFrames);
      if (Number.isFinite(total) && total > 0) this.totalBeforeRestart += total;
      if (Number.isFinite(discarded) && discarded > 0) this.discardedBeforeRestart += discarded;
    }

    get totalFrames() {
      const current = Number(this.processor?.totalFrames);
      return Math.max(this.deliveredFrames,
        this.totalBeforeRestart + (Number.isFinite(current) && current > 0 ? current : 0));
    }

    get discardedFrames() {
      const current = Number(this.processor?.discardedFrames);
      return this.discardedBeforeRestart + (Number.isFinite(current) && current > 0 ? current : 0);
    }

    async restart() {
      if (this.closed || !this.reader) return;
      const old = this.reader;
      this.captureCounters();
      this.reader = null;
      this.processor = null;
      try { await old.cancel(abortError()); } catch {}
      try { old.releaseLock(); } catch {}
      if (this.closed) return;
      this.open();
      this.pending = false;
      this.pendingSince = 0;
    }

    getReader() {
      if (this.readerTaken) throw new TypeError("ReadableStream is locked");
      this.readerTaken = true;
      let released = false;
      return {
        read: async () => {
          if (released || this.closed) throw abortError("MediaStreamTrackProcessor cancelled");
          if (this.pending) throw new TypeError("Concurrent TrackProcessor reads are unsupported");
          this.pending = true;
          this.pendingSince = performance.now();
          try {
            while (!this.closed) {
              const reader = this.reader;
              if (!reader) {
                await new Promise((resolve) => setTimeout(resolve, 0));
                continue;
              }
              try {
                const value = await reader.read();
                this.pending = false;
                this.pendingSince = 0;
                if (!value?.done && value?.value) this.deliveredFrames++;
                return value;
              } catch (error) {
                if (reader !== this.reader) continue;
                this.pending = false;
                this.pendingSince = 0;
                throw error;
              }
            }
            throw abortError("MediaStreamTrackProcessor cancelled");
          } finally {
            if (this.closed) {
              this.pending = false;
              this.pendingSince = 0;
            }
          }
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

    async shutdown(reason) {
      if (this.closed) return;
      this.closed = true;
      this.pending = false;
      this.pendingSince = 0;
      clearInterval(this.watchdog);
      const reader = this.reader;
      this.reader = null;
      this.processor = null;
      try { await reader?.cancel(reason); } catch {}
      try { reader?.releaseLock(); } catch {}
    }
  }

  Object.defineProperty(GuardedTrackProcessor, "__airgapperStallGuard", { value: true });
  try { globalThis.MediaStreamTrackProcessor = GuardedTrackProcessor; }
  catch {
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
