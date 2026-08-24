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

function publishLatest() {
  if (!wantsFrame || !pendingFrame) return;
  wantsFrame = false;
  const frame = pendingFrame;
  pendingFrame = null;
  postMessage({ type: "frame", frame, totalFrames, discardedFrames }, [frame]);
}

async function stopSource() {
  stopped = true;
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

function frameSize(frame) {
  return {
    width: Number(frame?.displayWidth || frame?.visibleRect?.width || frame?.codedWidth || 0),
    height: Number(frame?.displayHeight || frame?.visibleRect?.height || frame?.codedHeight || 0)
  };
}

function frameMatchesExpected(frame) {
  if (!(expectedWidth > 0) || !(expectedHeight > 0)) return true;
  const size = frameSize(frame);
  return size.width === expectedWidth && size.height === expectedHeight;
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

  // WebKit can reset a cloned camera track to a different sensor mode when it
  // crosses into a worker. Ask the clone to retain the already-negotiated main
  // track mode before creating the processor. Failure is harmless because the
  // first VideoFrame is validated below and the page falls back to rVFC.
  if (expectedWidth && expectedHeight && sourceTrack?.applyConstraints) {
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
      if (done) break;
      if (!value) continue;
      if (stopped || reader !== activeReader) {
        value.close?.();
        break;
      }

      // Never deliver a frame in a coordinate system different from the live
      // <video>. One mismatched Safari worker frame is enough to seed lattice
      // geometry that is wrong for every following rVFC frame and overlay.
      if (!frameMatchesExpected(value)) {
        const size = frameSize(value);
        value.close?.();
        postMessage({
          type: "error",
          message: `Worker camera frame ${size.width}×${size.height} does not match preview ${expectedWidth}×${expectedHeight}`
        });
        stopped = true;
        break;
      }

      totalFrames = Number.isFinite(Number(processor.totalFrames))
        ? Number(processor.totalFrames)
        : totalFrames + 1;
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
  const message = event.data ?? {};
  if (message.type === "start") {
    void startSource(
      message.track,
      Math.max(1, Math.trunc(Number(message.maxBufferSize) || 1)),
      {
        width: message.expectedWidth,
        height: message.expectedHeight,
        frameRate: message.expectedFrameRate
      }
    );
    return;
  }
  if (message.type === "pull") {
    wantsFrame = true;
    publishLatest();
    return;
  }
  if (message.type === "stop") void stopSource();
};
