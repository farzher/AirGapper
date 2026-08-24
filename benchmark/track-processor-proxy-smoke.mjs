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

const processor = new globalThis.MediaStreamTrackProcessor({ track: track(), maxBufferSize: 1 });
if (workers.length !== 1) throw new Error("first processor did not reuse prewarmed worker");
const start = prewarmed.messages[0];
if (start?.message?.type !== "start") throw new Error("proxy did not send start command");
if (start.message.expectedWidth !== 2560 || start.message.expectedHeight !== 1440 || start.message.expectedFrameRate !== 30)
  throw new Error(`start command lost camera settings: ${JSON.stringify(start.message)}`);

const reader = processor.readable.getReader();
const readPromise = reader.read();
if (prewarmed.messages.at(-1)?.message !== "pull") throw new Error("reader did not send allocation-light pull command");
const frame = { close() {} };
prewarmed.onmessage?.({ data: { type: "frame", frame, totalFrames: 1, discardedFrames: 0 } });
const read = await readPromise;
if (read.done || read.value !== frame) throw new Error("proxy did not deliver worker frame");
if (processor.totalFrames !== 1) throw new Error("proxy totalFrames did not update");

// A second processor has consumed the one-shot warm worker and therefore must
// allocate a new one; this proves the first instance was not secretly creating
// another worker in addition to the prewarm.
const second = new globalThis.MediaStreamTrackProcessor({ track: track(), maxBufferSize: 1 });
if (workers.length !== 2) throw new Error(`second processor should create worker #2, got ${workers.length}`);

await reader.cancel();
const secondReader = second.readable.getReader();
await secondReader.cancel();

console.log("AIRGAPPER_TRACK_PROCESSOR_PROXY_PASS", JSON.stringify({
  prewarmedWorkers: 1,
  firstProcessorReusedWarmWorker: true,
  secondProcessorCreatedWorkers: workers.length,
  stoppedClones
}));
