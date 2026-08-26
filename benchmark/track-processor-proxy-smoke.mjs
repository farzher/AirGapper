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

globalThis.document = { getElementById() { return null; } };
globalThis.Worker = FakeWorker;
delete globalThis.MediaStreamTrackProcessor;

// No Window-side TrackProcessor: current production uses the dedicated
// worker directly. If that worker proves unsupported, it rejects the
// read so runtime.js can choose its outer rVFC/canvas compatibility path.
await import(`../receive/track-processor-proxy.js?smoke=${Date.now()}`);

if (workers.length !== 1) throw new Error(`expected one prewarmed worker, got ${workers.length}`);
const prewarmed = workers[0];
if (prewarmed.options?.type !== "module") throw new Error("prewarmed processor worker is not a module worker");
if (typeof globalThis.MediaStreamTrackProcessor !== "function") throw new Error("proxy did not install MediaStreamTrackProcessor");
if (globalThis.MediaStreamTrackProcessor.__airgapperWorkerProxy !== true)
  throw new Error("installed processor lost worker-proxy identity through overlay wrapper");

let stoppedClones = 0;
function track() {
  return {
    readyState: "live",
    clone() {
      return { stop() { stoppedClones++; } };
    },
    getSettings() {
      return { width: 2560, height: 1440, frameRate: 30 };
    }
  };
}

// Case 1: first processor reuses the prewarmed module worker and keeps
// read() allocation-light: one string pull, then the worker frame itself.
const processor = new globalThis.MediaStreamTrackProcessor({ track: track(), maxBufferSize: 1 });
if (workers.length !== 1) throw new Error("first processor did not reuse prewarmed worker");
const start = prewarmed.messages[0];
if (start?.message?.type !== "start") throw new Error("proxy did not send start command");
if (start.message.expectedWidth !== 2560 || start.message.expectedHeight !== 1440 || start.message.expectedFrameRate !== 30)
  throw new Error(`start command lost camera settings: ${JSON.stringify(start.message)}`);

const reader = processor.readable.getReader();
const firstReadPromise = reader.read();
if (prewarmed.messages.at(-1)?.message !== "pull") throw new Error("reader did not send allocation-light pull command");
const workerFrame1 = { closed: false, close() { this.closed = true; } };
prewarmed.onmessage?.({ data: { type: "frame", frame: workerFrame1, totalFrames: 1, discardedFrames: 0 } });
const firstRead = await firstReadPromise;
if (firstRead.done || firstRead.value !== workerFrame1) throw new Error("proxy did not deliver worker frame");
if (processor.totalFrames !== 1 || processor.discardedFrames !== 0) throw new Error("worker counters did not update");

const secondReadPromise = reader.read();
const workerFrame2 = { closed: false, close() { this.closed = true; } };
prewarmed.onmessage?.({ data: { type: "frame", frame: workerFrame2, totalFrames: 3, discardedFrames: 1 } });
const secondRead = await secondReadPromise;
if (secondRead.value !== workerFrame2) throw new Error("second worker read failed");
if (processor.totalFrames !== 3 || processor.discardedFrames !== 1)
  throw new Error(`worker counters lost monotonic totals: ${processor.totalFrames}/${processor.discardedFrames}`);

// A frame with no pending consumer must be closed, never queued stale.
const unsolicited = { closed: false, close() { this.closed = true; } };
prewarmed.onmessage?.({ data: { type: "frame", frame: unsolicited, totalFrames: 4, discardedFrames: 1 } });
if (!unsolicited.closed) throw new Error("unsolicited worker frame was not closed");

// Case 2: with no native Window TrackProcessor, an unsupported worker is
// a clean terminal handoff to runtime's outer compatibility pump. The old
// per-read VideoFrame(video) snapshot race was deliberately removed.
const unsupported = new globalThis.MediaStreamTrackProcessor({ track: track(), maxBufferSize: 1 });
if (workers.length !== 2) throw new Error(`second processor should create worker #2, got ${workers.length}`);
const unsupportedWorker = workers[1];
const unsupportedReader = unsupported.readable.getReader();
const unsupportedReadPromise = unsupportedReader.read();
unsupportedWorker.onmessage?.({ data: { type: "unsupported" } });
let unsupportedError;
try {
  await unsupportedReadPromise;
} catch (error) {
  unsupportedError = error;
}
if (!unsupportedError || !/unavailable in this worker/i.test(String(unsupportedError.message)))
  throw new Error(`unsupported worker did not reject for outer fallback: ${unsupportedError}`);
if (!unsupportedWorker.terminated) throw new Error("unsupported worker was not terminated");

let repeatedError;
try {
  await unsupportedReader.read();
} catch (error) {
  repeatedError = error;
}
if (!repeatedError || repeatedError !== unsupportedError)
  throw new Error("terminal worker failure was not stable for subsequent reads");

await reader.cancel();
await unsupportedReader.cancel();

console.log("AIRGAPPER_TRACK_PROCESSOR_PROXY_PASS", JSON.stringify({
  prewarmedWorkers: 1,
  workerFramesDelivered: 2,
  unsupportedHandsOffToRuntime: true,
  workersCreated: workers.length,
  stoppedClones
}));
