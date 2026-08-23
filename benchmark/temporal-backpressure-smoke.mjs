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
function sampleFor(sequence) {
  return {
    slot: 0,
    dim: 21,
    modules: new Uint8Array(21 * 21).fill(sequence & 1 ? 255 : 0),
    quad,
    sourceSequence: sequence,
    separation: 180
  };
}
function releaseNormalSlot(slot) {
  pool.busy[slot] = false;
  pool.activeIds[slot] = undefined;
  clearTimeout(pool.jobTimers[slot]);
  pool.jobTimers[slot] = undefined;
}

assert.equal(pool.submit(low(1), []), true);
const split = pool.__airgapperTemporalSplit;
const sampler = split?.sampler?.worker;
const recovery = split?.recovery?.worker;
assert.equal(sampler?.kind, "temporal-sampler", "first low-count job should create a fast sampler");
assert.equal(recovery?.kind, "temporal-recover", "first low-count job should create an independent recovery decoder");
assert.equal(pool.workers.every((worker) => worker.kind === "normal"), true,
  "normal decoder pool must never be replaced by temporal workers");
assert.equal(sampler.messages.length, 1);
assert.equal(sampler.messages[0].action, "sample");
assert.equal(recovery.messages.length, 1);
assert.equal(recovery.messages[0].action, "warm");

// The sampler has hard one-frame backpressure: never build a camera-frame queue.
for (let id = 10; id <= 30; id++) pool.submit(low(id), []);
assert.equal(sampler.messages.length, 1,
  "busy sampler must drop optional mirrors instead of queuing camera frames");

// Warm the recovery decoder independently.
const warm = recovery.messages[0];
recovery.onmessage?.({ data: {
  temporalV2: true,
  phase: "warm",
  token: warm.token,
  generation: warm.generation,
  id: warm.id,
  sourceSequence: warm.sourceSequence,
  symbols: [],
  guidedMetrics: { temporalWarmMs: 5 }
} });

// Finish sample N and its normal miss. There is no prior sample yet, so no
// recovery job should be emitted.
const firstSample = sampler.messages[0];
sampler.onmessage?.({ data: {
  temporalV2: true,
  phase: "sample",
  token: firstSample.token,
  generation: firstSample.generation,
  id: 1,
  sourceSequence: 1,
  samples: [sampleFor(1)],
  symbols: [],
  guidedMetrics: { temporalStitchSampled: 1, temporalSampleMs: 2, temporalCopyMs: 0.5 }
} });
pool.onCompleted?.(1, { symbols: [], symbolCount: 0 });
assert.equal(recovery.messages.length, 1, "first physical sample cannot reconstruct without N-1");

// Capture adjacent frame N+1.
releaseNormalSlot(0);
assert.equal(pool.submit(low(2), []), true);
assert.equal(sampler.messages.length, 2);
const secondSample = sampler.messages[1];
sampler.onmessage?.({ data: {
  temporalV2: true,
  phase: "sample",
  token: secondSample.token,
  generation: secondSample.generation,
  id: 2,
  sourceSequence: 2,
  samples: [sampleFor(2)],
  symbols: [],
  guidedMetrics: { temporalStitchSampled: 1, temporalSampleMs: 2, temporalCopyMs: 0.5 }
} });
pool.onCompleted?.(2, { symbols: [], symbolCount: 0 });
assert.equal(recovery.messages.length, 2, "N/N-1 should schedule one recovery job after normal decode misses");
assert.equal(recovery.messages[1].action, "recover-pairs");
assert.equal(recovery.messages[1].pairs.length, 1);
assert.equal(recovery.messages[1].pairs[0].current.sourceSequence, 2);
assert.equal(recovery.messages[1].pairs[0].previousSamples[0].sourceSequence, 1);

// Critical invariant: expensive seam decoding MUST NOT block collection of N+2.
// The recovery worker stays busy while the independent sampler accepts the next
// physical camera frame.
releaseNormalSlot(0);
assert.equal(pool.submit(low(3), []), true);
assert.equal(sampler.messages.length, 3,
  "sampler must keep collecting adjacent frames while recovery decoder is busy");
assert.equal(sampler.messages[2].action, "sample");
assert.equal(recovery.messages.length, 2, "busy recovery decoder must not build an unbounded queue");
assert.equal(pool.workers.every((worker) => worker.kind === "normal"), true);

// A fourth frame while sample N+2 is still in flight is intentionally dropped
// from temporal mirroring rather than queued.
releaseNormalSlot(0);
assert.equal(pool.submit(low(4), []), true);
assert.equal(sampler.messages.length, 3,
  "sampler must retain at most one camera frame at a time");

assert.equal(created.filter((worker) => worker.kind === "temporal-sampler").length, 1);
assert.equal(created.filter((worker) => worker.kind === "temporal-recover").length, 1);

pool.resize(0);
console.log("temporal split backpressure smoke: ok");
