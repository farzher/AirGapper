let reader = null;
let sourceTrack = null;
let pendingFrame = null;
let wantsFrame = false;
let stopped = true;
let totalFrames = 0;
let discardedFrames = 0;
let expectedWidth = 0;
let expectedHeight = 0;
let expectedFrameRate = 0;
const frameMessage = { type: "frame", frame: null, totalFrames: 0, discardedFrames: 0 };

function publishLatest() {
  if (!wantsFrame || !pendingFrame) return;
  wantsFrame = false;
  const frame = pendingFrame;
  pendingFrame = null;
  // postMessage clones the envelope synchronously and transfers frame ownership,
  // so one reusable envelope removes a tiny object allocation per camera frame.
  frameMessage.frame = frame;
  frameMessage.totalFrames = totalFrames;
  frameMessage.discardedFrames = discardedFrames;
  try {
    postMessage(frameMessage, [frame]);
  } catch (error) {
    frame?.close?.();
    stopped = true;
    try {
      postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error)
      });
    } catch {}
  } finally {
    frameMessage.frame = null;
  }
}

async function stopSource() {
  stopped = true;
  wantsFrame = false;
  const activeReader = reader;
  reader = null;
  if (activeReader) {
    try { await activeReader.cancel(); } catch {}
    try { activeReader.releaseLock(); } catch {}
  }
  pendingFrame?.close?.();
  pendingFrame = null;
  sourceTrack?.stop?.();
  sourceTrack = null;
}

function frameWidth(frame) {
  return Number(frame?.displayWidth || frame?.visibleRect?.width || frame?.codedWidth || 0);
}

function frameHeight(frame) {
  return Number(frame?.displayHeight || frame?.visibleRect?.height || frame?.codedHeight || 0);
}

function frameMatchesExpected(frame) {
  if (!(expectedWidth > 0) || !(expectedHeight > 0)) return true;
  return frameWidth(frame) === expectedWidth && frameHeight(frame) === expectedHeight;
}

function trackAlreadyMatchesExpected(track) {
  if (!(expectedWidth > 0) || !(expectedHeight > 0)) return true;
  const settings = track?.getSettings?.() ?? {};
  const sameSize = Number(settings.width) === expectedWidth && Number(settings.height) === expectedHeight;
  if (!sameSize) return false;
  if (!(expectedFrameRate > 0) || !(Number(settings.frameRate) > 0)) return true;
  return Math.abs(Number(settings.frameRate) - expectedFrameRate) < 1;
}

async function startSource(track, maxBufferSize = 1, expected = {}) {
  await stopSource();
  stopped = false;
  sourceTrack = track;
  totalFrames = 0;
  discardedFrames = 0;
  expectedWidth = Math.max(0, Math.trunc(Number(expected.width) || 0));
  expectedHeight = Math.max(0, Math.trunc(Number(expected.height) || 0));
  expectedFrameRate = Math.max(0, Number(expected.frameRate) || 0);

  if (typeof MediaStreamTrackProcessor !== "function") {
    postMessage({ type: "unsupported" });
    sourceTrack?.stop?.();
    sourceTrack = null;
    return;
  }

  // A clone normally inherits the already-negotiated sensor mode. Do not issue
  // a redundant applyConstraints() write when it already matches: camera mode
  // writes can stall/restart delivery on mobile. Only repair a clone that
  // actually arrived in the worker with a different mode.
  if (!trackAlreadyMatchesExpected(sourceTrack) && expectedWidth && expectedHeight && sourceTrack?.applyConstraints) {
    try {
      await sourceTrack.applyConstraints({
        width: { exact: expectedWidth },
        height: { exact: expectedHeight },
        ...(expectedFrameRate ? { frameRate: { ideal: expectedFrameRate } } : {})
      });
    } catch {}
  }

  let processor;
  try {
    processor = new MediaStreamTrackProcessor({ track, maxBufferSize });
  } catch {
    try {
      processor = new MediaStreamTrackProcessor({ track });
    } catch (error) {
      postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
      sourceTrack?.stop?.();
      sourceTrack = null;
      return;
    }
  }

  const activeReader = processor.readable.getReader();
  reader = activeReader;
  try {
    while (!stopped && reader === activeReader) {
      const { value, done } = await activeReader.read();
      if (done) {
        if (!stopped && reader === activeReader) {
          postMessage({ type: "error", message: "Worker camera processor ended unexpectedly" });
        }
        break;
      }
      if (!value) continue;
      if (stopped || reader !== activeReader) {
        value.close?.();
        break;
      }

      // Never deliver a frame in a coordinate system different from the live
      // <video>. One mismatched Safari worker frame is enough to seed lattice
      // geometry that is wrong for every following rVFC frame and overlay.
      if (!frameMatchesExpected(value)) {
        const width = frameWidth(value);
        const height = frameHeight(value);
        value.close?.();
        postMessage({
          type: "error",
          message: `Worker camera frame ${width}×${height} does not match preview ${expectedWidth}×${expectedHeight}`
        });
        stopped = true;
        break;
      }

      const processorTotal = Number(processor.totalFrames);
      totalFrames = Number.isFinite(processorTotal) ? processorTotal : totalFrames + 1;
      const processorDrops = Number(processor.discardedFrames);
      if (Number.isFinite(processorDrops)) discardedFrames = Math.max(discardedFrames, processorDrops);

      // The consumer wants the freshest camera image, never a queue of stale
      // optical pages. Keep at most one frame while the main thread is busy.
      if (pendingFrame) {
        pendingFrame.close?.();
        discardedFrames++;
      }
      pendingFrame = value;
      publishLatest();
    }
  } catch (error) {
    if (!stopped && reader === activeReader) {
      postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    if (reader === activeReader) reader = null;
    try { activeReader.releaseLock(); } catch {}
    pendingFrame?.close?.();
    pendingFrame = null;
    sourceTrack?.stop?.();
    sourceTrack = null;
  }
}

self.onmessage = (event) => {
  const message = event.data;
  if (message === "pull") {
    wantsFrame = true;
    publishLatest();
    return;
  }
  const command = message ?? {};
  if (command.type === "start") {
    void startSource(
      command.track,
      Math.max(1, Math.trunc(Number(command.maxBufferSize) || 1)),
      {
        width: command.expectedWidth,
        height: command.expectedHeight,
        frameRate: command.expectedFrameRate
      }
    );
    return;
  }
  if (command.type === "stop") {
    void stopSource().finally(() => postMessage({ type: "stopped", totalFrames, discardedFrames }));
  }
};
