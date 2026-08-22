import assert from "node:assert/strict";
import "../shared/platform.js";
import { DecodeWorkerPool } from "../shared/worker-pool.js";

class FakeWorker {
  constructor(kind = "normal") {
    this.kind = kind;
    this.messages = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
  }
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
}

const created = [];
const pool = new DecodeWorkerPool((kind = "normal") => {
  const worker = new FakeWorker(kind ?? "normal");
  created.push(worker);
  return worker;
}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {});
pool.resize(3);
assert.deepEqual(pool.workers.map((worker) => worker.kind), ["normal", "normal", "normal"]);

const quad = {
  topLeft: { x: 1, y: 1 },
  topRight: { x: 8, y: 1 },
  bottomRight: { x: 8, y: 8 },
  bottomLeft: { x: 1, y: 8 }
};
function low(id, sourceSequence = id) {
  return {
    id,
    videoFrame: new ArrayBuffer(100),
    w: 10,
    h: 10,
    yStride: 10,
    yOffset: 0,
    ox: 0,
    oy: 0,
    full: false,
    pixelFormat: "y8",
    sourceSequence,
    tracks: [{ slot: 0, dim: 21, quad }]
  };
}

assert.equal(pool.submit(low(1), []), true);
const temporal = created.find((worker) => worker.kind === "temporal-v2");
assert.ok(temporal, "first low-count job should create an out-of-pool v2 companion");
assert.equal(temporal.messages.length, 1);
assert.equal(temporal.messages[0].action, "sample");
assert.equal(pool.workers.every((worker) => worker.kind === "normal"), true,
  "normal decoder pool must never be replaced by temporal workers");

// Flood submissions while the companion sample is outstanding. Normal pool
// scheduling may accept/drop independently, but the companion must retain no
// additional camera frame and must not build a message queue.
for (let id = 2; id <= 40; id++) pool.submit(low(id), []);
assert.equal(temporal.messages.length, 1,
  "busy temporal companion must drop optional mirrors instead of queuing frames");

const sample = temporal.messages[0];
temporal.onmessage?.({ data: {
  temporalV2: true,
  phase: "sample",
  token: sample.token,
  generation: sample.generation,
  id: sample.id,
  sourceSequence: sample.sourceSequence,
  symbols: [],
  guidedMetrics: { temporalStitchSampled: 1 }
} });

// Normal decode for that sampled frame missed the expected slot. Recovery is
// requested only now, after the normal decoder outcome is known.
pool.onCompleted?.(1, { symbols: [], symbolCount: 0 });
assert.equal(temporal.messages.length, 2);
assert.equal(temporal.messages[1].action, "recover");
assert.deepEqual(temporal.messages[1].missingSlots, [0]);

for (let id = 41; id <= 80; id++) pool.submit(low(id), []);
assert.equal(temporal.messages.length, 2,
  "expensive recovery must also have hard backpressure with no queued frames");

const recover = temporal.messages[1];
temporal.onmessage?.({ data: {
  temporalV2: true,
  phase: "recover",
  token: recover.token,
  generation: recover.generation,
  id: recover.id,
  sourceSequence: recover.sourceSequence,
  symbols: [],
  guidedMetrics: { temporalStitchAttempts: 18, temporalStitchHits: 0 }
} });

// Free one normal slot so a subsequent tracked job can be scheduled. The next
// companion message may now be exactly one new sample, proving recovery releases
// the backpressure gate rather than accumulating prior frames.
pool.busy[0] = false;
pool.activeIds[0] = undefined;
clearTimeout(pool.jobTimers[0]);
pool.jobTimers[0] = undefined;
assert.equal(pool.submit(low(81), []), true);
assert.equal(temporal.messages.length, 3);
assert.equal(temporal.messages[2].action, "sample");
assert.equal(pool.workers.every((worker) => worker.kind === "normal"), true);

pool.resize(0);
console.log("temporal backpressure smoke: ok");
