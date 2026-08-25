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
  const WORKER_PULL_STALL_MS = 220;
  const WORKER_STALLS_BEFORE_SNAPSHOT_ONLY = 3;
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

      this._worker = takeProcessorWorker();
      this._workerHealthy = false;
      this._workerStallTimer = 0;
      this._workerStallCount = 0;
      this._readerTaken = false;
      this._closed = false;
      this._terminalError = null;
      this._pendingResolve = null;
      this._pendingReject = null;
      this._readGeneration = 0;
      this._snapshotCallbackId = 0;
      this._totalFrames = 0;
      this._discardedFrames = 0;
      this._terminateTimer = 0;
      this._video = typeof document !== "undefined" ? document.getElementById("video") : null;
      this._snapshotEnabled = typeof globalThis.VideoFrame === "function" &&
        typeof this._video?.requestVideoFrameCallback === "function";

      this._worker.onmessage = (event) => this._onMessage(event.data ?? {});
      this._worker.onerror = (event) => {
        const error = new Error(event.message || "Worker MediaStreamTrackProcessor failed");
        if (this._snapshotEnabled) this._useSnapshotsOnly(error);
        else this._fail(error);
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
        if (this._snapshotEnabled) this._useSnapshotsOnly(error);
        else this._fail(error instanceof Error ? error : new Error(String(error)));
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
            const token = ++this._readGeneration;
            this._pendingResolve = resolve;
            this._pendingReject = reject;

            let workerRequested = false;
            if (this._worker) {
              try {
                this._worker.postMessage("pull");
                workerRequested = true;
              } catch (error) {
                if (this._snapshotEnabled) this._useSnapshotsOnly(error);
                else {
                  this._clearPending(token);
                  reject(error);
                  return;
                }
              }
            }

            if (this._snapshotEnabled && (!workerRequested || !this._workerHealthy)) {
              this._requestSnapshot(token);
            } else if (workerRequested && this._workerHealthy) {
              // A worker that succeeded once is not healthy forever. If it stops
              // answering while <video> keeps advancing, race in a fresh-video
              // snapshot instead of leaving this read pending indefinitely.
              this._armWorkerStallFallback(token);
            } else if (!workerRequested && !this._snapshotEnabled) {
              this._clearPending(token);
              reject(new Error("No usable video-frame source"));
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

    _clearWorkerStallFallback() {
      if (!this._workerStallTimer) return;
      clearTimeout(this._workerStallTimer);
      this._workerStallTimer = 0;
    }

    _armWorkerStallFallback(token) {
      this._clearWorkerStallFallback();
      this._workerStallTimer = setTimeout(() => {
        this._workerStallTimer = 0;
        if (this._closed || token !== this._readGeneration || !this._pendingResolve) return;
        this._workerHealthy = false;
        this._workerStallCount++;
        const error = new Error("Worker MediaStreamTrackProcessor stalled");
        if (this._snapshotEnabled) {
          if (this._workerStallCount >= WORKER_STALLS_BEFORE_SNAPSHOT_ONLY) this._useSnapshotsOnly(error);
          else this._requestSnapshot(token);
        } else {
          this._fail(error);
        }
      }, WORKER_PULL_STALL_MS);
    }

    _clearPending(token = this._readGeneration) {
      if (token !== this._readGeneration) return;
      this._clearWorkerStallFallback();
      this._pendingResolve = null;
      this._pendingReject = null;
    }

    _cancelSnapshot() {
      if (!this._snapshotCallbackId) return;
      try { this._video?.cancelVideoFrameCallback?.(this._snapshotCallbackId); } catch {}
      this._snapshotCallbackId = 0;
    }

    _requestSnapshot(token) {
      if (!this._snapshotEnabled || token !== this._readGeneration ||
          !this._pendingResolve || this._snapshotCallbackId) return;
      const video = this._video;
      try {
        this._snapshotCallbackId = video.requestVideoFrameCallback((callbackTime, metadata = {}) => {
          this._snapshotCallbackId = 0;
          if (this._closed || token !== this._readGeneration || !this._pendingResolve) return;
          let frame;
          try {
            const mediaTime = Number(metadata.mediaTime);
            const timestamp = Number.isFinite(mediaTime)
              ? Math.max(0, Math.round(mediaTime * 1e6))
              : Math.max(0, Math.round(Number(callbackTime || performance.now()) * 1e3));
            frame = new globalThis.VideoFrame(video, { timestamp });
          } catch (error) {
            this._snapshotEnabled = false;
            if (!this._worker) this._fail(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          const resolve = this._pendingResolve;
          this._clearPending(token);
          this._totalFrames++;
          resolve({ value: frame, done: false });
        });
      } catch (error) {
        this._snapshotCallbackId = 0;
        this._snapshotEnabled = false;
        if (!this._worker) this._fail(error instanceof Error ? error : new Error(String(error)));
      }
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
        const timely = Boolean(this._workerStallTimer);
        this._clearWorkerStallFallback();
        if (timely) this._workerStallCount = 0;
        this._workerHealthy = true;
        this._cancelSnapshot();
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
        const error = new Error("MediaStreamTrackProcessor is unavailable in this worker");
        if (this._snapshotEnabled) this._useSnapshotsOnly(error);
        else this._fail(error);
        return;
      }
      if (message.type === "error") {
        const error = new Error(message.message || "Worker MediaStreamTrackProcessor failed");
        if (this._snapshotEnabled) this._useSnapshotsOnly(error);
        else this._fail(error);
        return;
      }
      if (message.type === "stopped") {
        if (!this._worker && this._snapshotEnabled && !this._closed) return;
        this._closed = true;
        this._clearWorkerStallFallback();
        const resolve = this._pendingResolve;
        this._pendingResolve = null;
        this._pendingReject = null;
        if (resolve) resolve({ value: undefined, done: true });
        this._terminateNow();
      }
    }

    _useSnapshotsOnly(_reason) {
      this._clearWorkerStallFallback();
      const worker = this._worker;
      this._worker = null;
      this._workerHealthy = false;
      if (worker) {
        try { worker.postMessage({ type: "stop" }); } catch {}
        try { worker.terminate(); } catch {}
      }
      if (this._pendingResolve) this._requestSnapshot(this._readGeneration);
    }

    _fail(error) {
      if (this._terminalError || this._closed) return;
      this._terminalError = error;
      this._clearWorkerStallFallback();
      this._cancelSnapshot();
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
      this._clearWorkerStallFallback();
      this._cancelSnapshot();
      const resolve = this._pendingResolve;
      const reject = this._pendingReject;
      this._pendingResolve = null;
      this._pendingReject = null;
      if (reject || resolve) {
        if (reason instanceof Error) reject?.(reason);
        else resolve?.({ value: undefined, done: true });
      }
      const worker = this._worker;
      if (worker) {
        try { worker.postMessage({ type: "stop" }); } catch {}
        if (!this._terminateTimer) {
          this._terminateTimer = setTimeout(() => {
            if (this._worker === worker) this._worker = null;
            try { worker.terminate(); } catch {}
            this._terminateTimer = 0;
          }, 100);
        }
      }
      return Promise.resolve();
    }

    _terminateNow() {
      this._clearWorkerStallFallback();
      this._cancelSnapshot();
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
