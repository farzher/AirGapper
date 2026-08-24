// Safari/WebKit exposes MediaStreamTrackProcessor in a DedicatedWorker even on
// releases where the constructor is absent from Window. AirGapper's receiver
// historically feature-tested only Window and therefore fell all the way back
// to <video> -> canvas -> RGBA readback on those browsers.
//
// Install a tiny Window-side compatibility proxy only when the native Window
// constructor is missing. It transfers a CLONE of the already-negotiated camera
// track to track-processor-worker.js, preserving the original track for preview,
// camera constraints and device bookkeeping. The worker keeps only its newest
// VideoFrame and transfers frames back on pull, matching the receiver's
// latest-frame/no-backlog policy.

if (typeof globalThis.MediaStreamTrackProcessor !== "function" &&
    typeof globalThis.Worker === "function") {
  const workerUrl = new URL("./track-processor-worker.js", import.meta.url);

  class WorkerTrackProcessor {
    constructor({ track, maxBufferSize = 1 } = {}) {
      if (!track || typeof track.clone !== "function") {
        throw new TypeError("MediaStreamTrackProcessor requires a video MediaStreamTrack");
      }

      this._worker = new Worker(workerUrl, { type: "module" });
      this._readerTaken = false;
      this._closed = false;
      this._terminalError = null;
      this._pendingResolve = null;
      this._pendingReject = null;
      this._totalFrames = 0;
      this._discardedFrames = 0;
      this._terminateTimer = 0;

      this._worker.onmessage = (event) => this._onMessage(event.data ?? {});
      this._worker.onerror = (event) => {
        this._fail(new Error(event.message || "Worker MediaStreamTrackProcessor failed"));
      };

      const settings = track.getSettings?.() ?? {};
      let workerTrack;
      try {
        // Transferring the original would detach ownership from the page. Keep
        // the live preview/controller track where it is and transfer its clone.
        workerTrack = track.clone();
        this._worker.postMessage({
          type: "start",
          track: workerTrack,
          maxBufferSize: Math.max(1, Math.trunc(Number(maxBufferSize) || 1)),
          expectedWidth: Number(settings.width) || 0,
          expectedHeight: Number(settings.height) || 0,
          expectedFrameRate: Number(settings.frameRate) || 0
        }, [workerTrack]);
      } catch (error) {
        workerTrack?.stop?.();
        this._fail(error instanceof Error ? error : new Error(String(error)));
      }

      this.readable = {
        getReader: () => this._getReader()
      };
    }

    get totalFrames() {
      return this._totalFrames;
    }

    get discardedFrames() {
      return this._discardedFrames;
    }

    _getReader() {
      if (this._readerTaken) throw new TypeError("ReadableStream is locked");
      this._readerTaken = true;
      let released = false;
      return {
        read: () => {
          if (released) return Promise.reject(new TypeError("Reader lock released"));
          if (this._terminalError) return Promise.reject(this._terminalError);
          if (this._closed) return Promise.resolve({ value: undefined, done: true });
          if (this._pendingResolve) return Promise.reject(new TypeError("Concurrent TrackProcessor reads are unsupported"));
          return new Promise((resolve, reject) => {
            this._pendingResolve = resolve;
            this._pendingReject = reject;
            try {
              // A string avoids allocating/cloning a one-property command object
              // for every camera frame.
              this._worker.postMessage("pull");
            } catch (error) {
              this._pendingResolve = null;
              this._pendingReject = null;
              reject(error);
            }
          });
        },
        cancel: (reason) => {
          released = true;
          this._readerTaken = false;
          return this._shutdown(reason);
        },
        releaseLock: () => {
          if (released) return;
          released = true;
          this._readerTaken = false;
          // Runtime releases a reader directly when a processor fails. Treat
          // that as disposal so the transferred clone/worker cannot survive a
          // switch to rVFC.
          void this._shutdown();
        }
      };
    }

    _updateCounters(message) {
      const total = Number(message.totalFrames);
      const discarded = Number(message.discardedFrames);
      if (Number.isFinite(total)) this._totalFrames = Math.max(this._totalFrames, total);
      if (Number.isFinite(discarded)) this._discardedFrames = Math.max(this._discardedFrames, discarded);
    }

    _onMessage(message) {
      this._updateCounters(message);
      if (message.type === "frame") {
        const frame = message.frame;
        const resolve = this._pendingResolve;
        if (this._closed || this._terminalError || !resolve) {
          frame?.close?.();
          return;
        }
        this._pendingResolve = null;
        this._pendingReject = null;
        resolve({ value: frame, done: false });
        return;
      }
      if (message.type === "unsupported") {
        this._fail(new Error("MediaStreamTrackProcessor is unavailable in this worker"));
        return;
      }
      if (message.type === "error") {
        this._fail(new Error(message.message || "Worker MediaStreamTrackProcessor failed"));
        return;
      }
      if (message.type === "stopped") {
        this._closed = true;
        const resolve = this._pendingResolve;
        this._pendingResolve = null;
        this._pendingReject = null;
        if (resolve) resolve({ value: undefined, done: true });
        this._terminateNow();
      }
    }

    _fail(error) {
      if (this._terminalError || this._closed) return;
      this._terminalError = error;
      const reject = this._pendingReject;
      this._pendingResolve = null;
      this._pendingReject = null;
      if (reject) reject(error);
      void this._shutdown(error);
    }

    _shutdown(reason) {
      if (this._closed) return Promise.resolve();
      this._closed = true;
      const resolve = this._pendingResolve;
      const reject = this._pendingReject;
      this._pendingResolve = null;
      this._pendingReject = null;
      if (reject || resolve) {
        if (reason instanceof Error) reject?.(reason);
        else resolve?.({ value: undefined, done: true });
      }
      try { this._worker.postMessage({ type: "stop" }); } catch {}
      // Give the worker a chance to stop its transferred track explicitly. A
      // one-shot teardown timer is acceptable; unlike the old implementation
      // there is no timer at camera/frame cadence.
      if (!this._terminateTimer) {
        this._terminateTimer = setTimeout(() => this._terminateNow(), 100);
      }
      return Promise.resolve();
    }

    _terminateNow() {
      if (this._terminateTimer) {
        clearTimeout(this._terminateTimer);
        this._terminateTimer = 0;
      }
      try { this._worker.terminate(); } catch {}
    }
  }

  Object.defineProperty(WorkerTrackProcessor, "__airgapperWorkerProxy", { value: true });
  try {
    globalThis.MediaStreamTrackProcessor = WorkerTrackProcessor;
  } catch {
    try {
      Object.defineProperty(globalThis, "MediaStreamTrackProcessor", {
        configurable: true,
        writable: true,
        value: WorkerTrackProcessor
      });
    } catch {}
  }
}
