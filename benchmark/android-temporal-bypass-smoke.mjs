import assert from "node:assert/strict";

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    userAgent: "Mozilla/5.0 (Linux; Android 15; OnePlus) AppleWebKit/537.36 Chrome/150 Mobile Safari/537.36",
    platform: "Linux armv8l",
    maxTouchPoints: 5,
    hardwareConcurrency: 8
  }
});

const { DecodeWorkerPool } = await import("../shared/worker-pool.js");
await import("../shared/platform.js");

class FakeWorker {
  constructor(kind = "normal") {
    this.kind = kind;
    this.posts = [];
    this.onmessage = null;
    this.onerror = null;
  }
  postMessage(message) { this.posts.push(message); }
  terminate() {}
}

const createdKinds = [];
const pool = new DecodeWorkerPool((kind = "normal") => {
  createdKinds.push(kind ?? "normal");
  return new FakeWorker(kind ?? "normal");
}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {});
pool.resize(2);

const message = {
  id: 1,
  full: false,
  pixelFormat: "y8",
  sourceSequence: 1,
  w: 1440,
  h: 2560,
  yStride: 1440,
  yOffset: 0,
  videoFrame: new ArrayBuffer(16),
  tracks: [{
    slot: 0,
    dim: 177,
    quad: {
      topLeft: { x: 100, y: 100 },
      topRight: { x: 900, y: 100 },
      bottomRight: { x: 900, y: 900 },
      bottomLeft: { x: 100, y: 900 }
    }
  }]
};

assert.equal(pool.submit(message, []), true);
assert.equal(pool.workers[0].posts.length + pool.workers[1].posts.length, 1,
  "Android should post exactly the normal decode job");
assert.deepEqual(createdKinds, ["normal", "normal"],
  "Android low-count decode must not create temporal sampler/recovery workers");
assert.equal(pool.__airgapperTemporalSplit, undefined,
  "Android low-count decode must not create split temporal state");
assert.equal(pool.__airgapperTemporalCompanion, undefined,
  "Android low-count decode must bypass the legacy temporal companion too");

pool.resize(0);
console.log("android temporal bypass smoke: ok");
