const workers = [];

class FakeWorker {
  constructor(url, options) {
    this.url = String(url);
    this.options = options;
    this.onmessage = null;
    this.onerror = null;
    this.messages = [];
    this.terminated = false;
    workers.push(this);
  }
  postMessage(message, transfer = []) {
    this.messages.push({ message, transfer });
  }
  terminate() {
    this.terminated = true;
  }
}

class FakeVideo {
  constructor() {
    this.nextCallbackId = 1;
    this.callbacks = new Map();
  }
  requestVideoFrameCallback(callback) {
    const id = this.nextCallbackId++;
    this.callbacks.set(id, callback);
    return id;
  }
  cancelVideoFrameCallback(id) {
    this.callbacks.delete(id);
  }
  fireNext(metadata = { mediaTime: 1.25 }) {
    const entry = this.callbacks.entries().next();
    if (entry.done) throw new Error("no pending video frame callback");
    const [id, callback] = entry.value;
    this.callbacks.delete(id);
    callback(1250, metadata);
  }
}

class FakeVideoFrame {
  constructor(source, init = {}) {
    this.source = source;
    this.timestamp = init.timestamp;
    this.closed = false;
  }
  close() {
    this.closed = true;
  }
}

const video = new FakeVideo();
globalThis.document = {
  getElementById(id) {
    return id === "video" ? video : null;
  }
};
globalThis.VideoFrame = FakeVideoFrame;

// Force the Safari compatibility branch: Window has Worker but no native
// MediaStreamTrackProcessor. The proxy should immediately prewarm exactly one
// module worker and reuse it for the first camera processor instance.
globalThis.Worker = FakeWorker;
delete globalThis.MediaStreamTrackProcessor;
await import(`../receive/track-processor-proxy.js?smoke=${Date.now()}`);

if (workers.length !== 1) throw new Error(`expected one prewarmed worker, got ${workers.length}`);
const prewarmed = workers[0];
if (prewarmed.options?.type !== "module") throw new Error("prewarmed processor worker is not a module worker");
if (typeof globalThis.MediaStreamTrackProcessor !== "function") throw new Error("proxy did not install MediaStreamTrackProcessor");

let stoppedClones = 0;
function track() {
  return {
    clone() {
      return { stop() { stoppedClones++; } };
    },
    getSettings() {
      return { width: 2560, height: 1440, frameRate: 30 };
    }
  };
}

// Case 1: the DedicatedWorker processor wins the startup race. The scheduled
// VideoFrame(video) snapshot must be cancelled and no later read should schedule
// another snapshot once the worker has proved healthy.
const processor = new globalThis.MediaStreamTrackProcessor({ track: track(), maxBufferSize: 1 });
if (workers.length !== 1) throw new Error("first processor did not reuse prewarmed worker");
const start = prewarmed.messages[0];
if (start?.message?.type !== "start") throw new Error("proxy did not send start command");
if (start.message.expectedWidth !== 2560 || start.message.expectedHeight !== 1440 || start.message.expectedFrameRate !== 30)
  throw new Error(`start command lost camera settings: ${JSON.stringify(start.message)}`);

const reader = processor.readable.getReader();
const firstReadPromise = reader.read();
if (prewarmed.messages.at(-1)?.message !== "pull") throw new Error("reader did not send allocation-light pull command");
if (video.callbacks.size !== 1) throw new Error("startup read did not arm VideoFrame(video) bridge");
const workerFrame1 = { closed: false, close() { this.closed = true; } };
prewarmed.onmessage?.({ data: { type: "frame", frame: workerFrame1, totalFrames: 1, discardedFrames: 0 } });
const firstRead = await firstReadPromise;
if (firstRead.done || firstRead.value !== workerFrame1) throw new Error("proxy did not deliver worker frame");
if (video.callbacks.size !== 0) throw new Error("worker success did not cancel startup snapshot");
if (processor.totalFrames !== 1) throw new Error("proxy totalFrames did not update");

const healthyReadPromise = reader.read();
if (video.callbacks.size !== 0) throw new Error("healthy worker path unnecessarily scheduled a snapshot");
const workerFrame2 = { closed: false, close() { this.closed = true; } };
prewarmed.onmessage?.({ data: { type: "frame", frame: workerFrame2, totalFrames: 2, discardedFrames: 0 } });
const healthyRead = await healthyReadPromise;
if (healthyRead.value !== workerFrame2) throw new Error("healthy worker read failed");

// Case 2: the HTMLVideoElement snapshot wins before worker startup. The read
// must resolve with a transferable VideoFrame constructed from the live video.
// A late worker frame is closed, marks the worker healthy, and subsequent reads
// stop scheduling snapshot callbacks.
const second = new globalThis.MediaStreamTrackProcessor({ track: track(), maxBufferSize: 1 });
if (workers.length !== 2) throw new Error(`second processor should create worker #2, got ${workers.length}`);
const secondWorker = workers[1];
const secondReader = second.readable.getReader();
const snapshotReadPromise = secondReader.read();
if (video.callbacks.size !== 1) throw new Error("second processor did not arm startup snapshot");
video.fireNext({ mediaTime: 2.5 });
const snapshotRead = await snapshotReadPromise;
if (!(snapshotRead.value instanceof FakeVideoFrame)) throw new Error("snapshot race did not return VideoFrame(video)");
if (snapshotRead.value.source !== video || snapshotRead.value.timestamp !== 2_500_000)
  throw new Error("snapshot VideoFrame did not preserve source/timestamp");

const lateWorkerFrame = { closed: false, close() { this.closed = true; } };
secondWorker.onmessage?.({ data: { type: "frame", frame: lateWorkerFrame, totalFrames: 1, discardedFrames: 0 } });
if (!lateWorkerFrame.closed) throw new Error("late worker frame was not closed after snapshot won race");
const postRaceReadPromise = secondReader.read();
if (video.callbacks.size !== 0) throw new Error("late healthy worker did not disable snapshot bridge");
const workerFrame3 = { close() {} };
secondWorker.onmessage?.({ data: { type: "frame", frame: workerFrame3, totalFrames: 2, discardedFrames: 0 } });
if ((await postRaceReadPromise).value !== workerFrame3) throw new Error("worker did not take over after startup race");

// Case 3: worker-side MediaStreamTrackProcessor is unsupported. The proxy must
// terminate that worker and remain a functional rVFC -> VideoFrame(video)
// processor for every following read instead of forcing runtime.js to canvas.
const third = new globalThis.MediaStreamTrackProcessor({ track: track(), maxBufferSize: 1 });
if (workers.length !== 3) throw new Error(`third processor should create worker #3, got ${workers.length}`);
const thirdWorker = workers[2];
const thirdReader = third.readable.getReader();
const unsupportedReadPromise = thirdReader.read();
thirdWorker.onmessage?.({ data: { type: "unsupported" } });
if (!thirdWorker.terminated) throw new Error("unsupported worker was not terminated");
if (video.callbacks.size !== 1) throw new Error("unsupported worker did not preserve snapshot fallback");
video.fireNext({ mediaTime: 3.75 });
const unsupportedRead = await unsupportedReadPromise;
if (!(unsupportedRead.value instanceof FakeVideoFrame) || unsupportedRead.value.timestamp !== 3_750_000)
  throw new Error("unsupported worker did not fall back to VideoFrame(video)");
const pullsBeforeSnapshotOnlyRead = thirdWorker.messages.filter(({ message }) => message === "pull").length;
const snapshotOnlyPromise = thirdReader.read();
if (video.callbacks.size !== 1) throw new Error("snapshot-only mode did not request next presented frame");
video.fireNext({ mediaTime: 4 });
if (!((await snapshotOnlyPromise).value instanceof FakeVideoFrame)) throw new Error("snapshot-only second read failed");
const pullsAfterSnapshotOnlyRead = thirdWorker.messages.filter(({ message }) => message === "pull").length;
if (pullsAfterSnapshotOnlyRead !== pullsBeforeSnapshotOnlyRead)
  throw new Error("snapshot-only mode continued sending pulls to terminated worker");

await reader.cancel();
await secondReader.cancel();
await thirdReader.cancel();

console.log("AIRGAPPER_TRACK_PROCESSOR_PROXY_PASS", JSON.stringify({
  prewarmedWorkers: 1,
  workerWinsRace: true,
  snapshotWinsRace: true,
  unsupportedFallsBackToSnapshots: true,
  workersCreated: workers.length,
  stoppedClones
}));
