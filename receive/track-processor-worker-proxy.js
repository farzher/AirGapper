// Prefer a DedicatedWorker camera drain on mobile/coarse-pointer devices.
// The worker continuously drains the camera and retains only the freshest
// pending VideoFrame, so main-thread scheduling jitter cannot starve the native
// processor or build a stale queue. Browsers without a Window-side processor use
// the same compatibility path regardless of device class.
const preferWorkerProcessor = navigator.userAgentData?.mobile === true ||
  globalThis.matchMedia?.("(pointer: coarse)")?.matches === true;
if ((preferWorkerProcessor || typeof globalThis.MediaStreamTrackProcessor !== "function") &&
    typeof globalThis.Worker === "function") {
  const workerUrl = new URL("./track-processor-worker.js", import.meta.url);
  // A single late worker reply must never permanently demote a healthy 30 fps
  // TrackProcessor camera to rVFC. Older Android devices can present <video> at
  // only 5-10 fps even while the camera track itself is still delivering 30 fps.
  // Treat a missed pull as a recoverable worker fault first. Only repeated
  // consecutive failures escape to runtime's compatibility fallback.
  const WORKER_PULL_STALL_MS = 500;
  const WORKER_RESTART_STALL_MS = 900;
  const WORKER_STALL_RESTART_LIMIT = 2;
  let prewarmedWorker = null;

  function createProcessorWorker() {
    return new Worker(workerUrl, { type: "module" });
  }

  // runtime.js gives a processor only 250 ms to produce its first frame before
  // falling back to rVFC/canvas. Remove module-worker startup from that race.
  try {
    const worker = createProcessorWorker();
    prewarmedWorker = worker;
    worker.onerror = () => {
      if (prewarmedWorker !== worker) return;
      prewarmedWorker = null;
      try { worker.terminate(); } catch {}
    };
  } catch {}

  function takeProcessorWorker() {
    const worker = prewarmedWorker;
    prewarmedWorker = null;
    if (worker) {
      worker.onerror = null;
      return worker;
    }
    return createProcessorWorker();
  }

  class WorkerTrackProcessor {
    constructor({ track, maxBufferSize = 1 } = {}) {
      if (!track || typeof track.clone !== "function") {
        throw new TypeError("MediaStreamTrackProcessor requires a video MediaStreamTrack");
      }

      this._sourceTrack = track;
      this._maxBufferSize = Math.max(1, Math.trunc(Number(maxBufferSize) || 1));
      const settings = track.getSettings?.() ?? {};
      this._expectedWidth = Number(settings.width) || 0;
      this._expectedHeight = Number(settings.height) || 0;
      this._expectedFrameRate = Number(settings.frameRate) || 0;
      this._worker = null;
      this._workerGeneration = 0;
      this._workerHealthy = false;
      this._consecutiveWorkerStalls = 0;
      this._workerStallTimer = 0;
      this._readerTaken = false;
      this._closed = false;
      this._terminalError = null;
      this._pendingResolve = null;
      this._pendingReject = null;
      this._readGeneration = 0;
      this._totalFrames = 0;
      this._discardedFrames = 0;
      this._terminateTimer = 0;

      try {
        this._startWorker(takeProcessorWorker());
      } catch (error) {
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

    _startWorker(worker) {
      if (!worker) throw new Error("Worker camera source unavailable");
      const generation = ++this._workerGeneration;
      this._worker = worker;
      worker.onmessage = (event) => {
        const message = event.data ?? {};
        if (this._closed || generation !== this._workerGeneration || worker !== this._worker) {
          message?.frame?.close?.();
          return;
        }
        this._onMessage(message);
      };
      worker.onerror = (event) => {
        if (this._closed || generation !== this._workerGeneration || worker !== this._worker) return;
        this._fail(new Error(event.message || "Worker MediaStreamTrackProcessor failed"));
      };

      let workerTrack;
      try {
        // Transferring the original would detach ownership from the page. Keep
        // the live preview/controller track where it is and transfer its clone.
        workerTrack = this._sourceTrack.clone();
        worker.postMessage({
          type: "start",
          track: workerTrack,
          maxBufferSize: this._maxBufferSize,
          expectedWidth: this._expectedWidth,
          expectedHeight: this._expectedHeight,
          expectedFrameRate: this._expectedFrameRate
        }, [workerTrack]);
      } catch (error) {
        workerTrack?.stop?.();
        if (this._worker === worker) this._worker = null;
        try { worker.terminate(); } catch {}
        throw error;
      }
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
            const token = ++this._readGeneration;
            this._pendingResolve = resolve;
            this._pendingReject = reject;
            const worker = this._worker;
            if (!worker) {
              const error = new Error("Worker camera source unavailable");
              this._clearPending(token);
              reject(error);
              return;
            }
            try {
              worker.postMessage("pull");
              // Initial startup already has runtime.js' first-frame watchdog.
              // Once this source has proved itself, fence a truly missing reply;
              // recovery stays inside this processor instead of demoting the
              // entire camera session after one scheduler hiccup.
              if (this._workerHealthy) this._armWorkerStallRecovery(token, WORKER_PULL_STALL_MS);
            } catch (error) {
              this._clearPending(token);
              reject(error instanceof Error ? error : new Error(String(error)));
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
          void this._shutdown();
        }
      };
    }

    _clearWorkerStallRecovery() {
      if (!this._workerStallTimer) return;
      clearTimeout(this._workerStallTimer);
      this._workerStallTimer = 0;
    }

    _armWorkerStallRecovery(token, delay) {
      this._clearWorkerStallRecovery();
      this._workerStallTimer = setTimeout(() => {
        this._workerStallTimer = 0;
        if (this._closed || token !== this._readGeneration || !this._pendingResolve) return;
        this._recoverWorkerStall(token);
      }, delay);
    }

    _recoverWorkerStall(token) {
      if (this._closed || token !== this._readGeneration || !this._pendingResolve) return;
      this._workerHealthy = false;
      this._consecutiveWorkerStalls++;
      const oldWorker = this._worker;
      this._worker = null;
      ++this._workerGeneration;
      try { oldWorker?.terminate(); } catch {}

      const sourceLive = !this._sourceTrack?.readyState || this._sourceTrack.readyState === "live";
      if (!sourceLive || this._consecutiveWorkerStalls > WORKER_STALL_RESTART_LIMIT) {
        this._fail(new Error("Worker MediaStreamTrackProcessor repeatedly stalled"));
        return;
      }

      try {
        this._startWorker(createProcessorWorker());
        // Keep the caller's original read() pending across the restart. The new
        // worker receives its pull immediately; startSource() queues the request
        // even if module/camera initialization has not produced a frame yet.
        this._worker.postMessage("pull");
        this._armWorkerStallRecovery(token, WORKER_RESTART_STALL_MS);
      } catch (error) {
        this._fail(error instanceof Error ? error : new Error(String(error)));
      }
    }

    _clearPending(token = this._readGeneration) {
      if (token !== this._readGeneration) return;
      this._clearWorkerStallRecovery();
      this._pendingResolve = null;
      this._pendingReject = null;
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
        this._clearWorkerStallRecovery();
        this._workerHealthy = true;
        this._consecutiveWorkerStalls = 0;
        const frame = message.frame;
        const resolve = this._pendingResolve;
        if (this._closed || this._terminalError || !resolve) {
          frame?.close?.();
          return;
        }
        const token = this._readGeneration;
        this._clearPending(token);
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
        if (this._closed) {
          this._terminateNow();
          return;
        }
        // A graceful done:true here would make runtime.js leave its pump loop
        // without starting rVFC. Treat an unsolicited stop as a source failure so
        // the outer frame pump keeps the live preview/scanner moving.
        this._fail(new Error("Worker MediaStreamTrackProcessor stopped unexpectedly"));
      }
    }

    _fail(error) {
      if (this._terminalError || this._closed) return;
      this._terminalError = error;
      this._clearWorkerStallRecovery();
      const reject = this._pendingReject;
      this._pendingResolve = null;
      this._pendingReject = null;
      if (reject) reject(error);
      void this._shutdown(error);
    }

    _shutdown(reason) {
      if (this._closed) return Promise.resolve();
      this._closed = true;
      ++this._readGeneration;
      ++this._workerGeneration;
      this._clearWorkerStallRecovery();
      const resolve = this._pendingResolve;
      const reject = this._pendingReject;
      this._pendingResolve = null;
      this._pendingReject = null;
      if (reject || resolve) {
        if (reason instanceof Error) reject?.(reason);
        else resolve?.({ value: undefined, done: true });
      }
      const worker = this._worker;
      this._worker = null;
      if (worker) {
        try { worker.postMessage({ type: "stop" }); } catch {}
        if (!this._terminateTimer) {
          this._terminateTimer = setTimeout(() => {
            try { worker.terminate(); } catch {}
            this._terminateTimer = 0;
          }, 100);
        }
      }
      return Promise.resolve();
    }

    _terminateNow() {
      this._clearWorkerStallRecovery();
      const worker = this._worker;
      this._worker = null;
      if (this._terminateTimer) {
        clearTimeout(this._terminateTimer);
        this._terminateTimer = 0;
      }
      try { worker?.terminate(); } catch {}
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
