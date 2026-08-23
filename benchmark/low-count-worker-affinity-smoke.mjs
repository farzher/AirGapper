import assert from "node:assert/strict";

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    userAgent: "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/150 Mobile Safari/537.36",
    platform: "Linux armv8l",
    maxTouchPoints: 5,
    hardwareConcurrency: 8
  }
});

const createdUrls = [];
class FakeWorker {
  constructor(url) {
    this.url = String(url);
    this.posts = [];
    this.onmessage = null;
    this.onerror = null;
    createdUrls.push(this.url);
  }
  postMessage(message) { this.posts.push(message); }
  terminate() {}
}
globalThis.Worker = FakeWorker;

const { DecodeWorkerPool } = await import("../shared/worker-pool.js");
await import("../shared/platform.js");

const direct = new Worker(new URL("../receive/worker.js", import.meta.url), { type: "module" });
assert.match(direct.url, /worker\.js$/, "direct workers outside DecodeWorkerPool must remain raw");
const raw = new Worker(new URL("../receive/worker.js?raw=1", import.meta.url), { type: "module" });
assert.match(raw.url, /worker\.js\?raw=1/, "raw proof worker must remain raw");
const recovery = new Worker(new URL("../receive/worker-temporal-generalized.js", import.meta.url), { type: "module" });
assert.match(recovery.url, /worker-temporal-generalized\.js/, "recovery worker must remain untouched");

const pool = new DecodeWorkerPool(
  () => new Worker(new URL("../receive/worker.js", import.meta.url), { type: "module" }),
  () => {}, () => {}, () => {}, () => {}, () => {}, () => {}
);
pool.resize(3);
assert.equal(pool.workers.length, 3);
for (const worker of pool.workers)
  assert.match(worker.url, /worker-reconstruct-bootstrap\.js/, "decode-pool workers must use reconstruction bootstrap");

const tracks = [{ slot: 0, dim: 177, quad: {
  topLeft: { x: 0, y: 0 }, topRight: { x: 177, y: 0 },
  bottomRight: { x: 177, y: 177 }, bottomLeft: { x: 0, y: 177 }
} }];
const message = (id) => ({ id, full: false, pixelFormat: "y8", tracks, w: 177, h: 177, sourceSequence: id });

assert.equal(pool.submit(message(1), []), true);
assert.equal(pool.activeIds[0], 1, "first low-count job should prefer worker 0");
assert.equal(pool.submit(message(2), []), true);
assert.equal(pool.activeIds[1], 2, "busy affinity worker must fall back to another free worker rather than drop");
assert.equal(pool.activeIds[2], undefined);

console.log("low-count worker affinity smoke: ok", { created: createdUrls.length });
