import { DecodeWorkerPool } from "../shared/worker-pool.js";

class FakeWorker {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this.lastMessage = null;
    this.terminated = false;
  }
  postMessage(message) {
    this.lastMessage = message;
  }
  terminate() {
    this.terminated = true;
  }
}

const created = [];
const completions = [];
const preflights = [];
let firstCompletion;
let firstPreflight;

const pool = new DecodeWorkerPool(
  () => {
    const worker = new FakeWorker();
    created.push(worker);
    return worker;
  },
  () => void 0,
  () => void 0,
  () => void 0,
  (_id, completion) => {
    const sameIdentity = firstCompletion ? completion === firstCompletion : true;
    firstCompletion ??= completion;
    completions.push({
      sameIdentity,
      symbolCount: completion.symbolCount,
      guidedMetrics: completion.guidedMetrics,
      repeatSkipped: completion.repeatSkipped,
      error: completion.error
    });
  },
  () => void 0,
  (info) => {
    const sameIdentity = firstPreflight ? info === firstPreflight : true;
    firstPreflight ??= info;
    preflights.push({
      sameIdentity,
      id: info.id,
      sourceSequence: info.sourceSequence,
      signature: info.signature
    });
  }
);

pool.resize(1);
const worker = created[0];
if (!worker) throw new Error("pool did not create worker");

if (!pool.submit({ id: 1, full: false, w: 32, h: 32, tracks: [] }, []))
  throw new Error("first worker submit failed");
worker.onmessage({ data: {
  id: 1,
  preflight: true,
  sourceSequence: 17,
  frameSignature: { key: "a", bits: new Uint8Array([1, 2]), bitCount: 16 }
} });
worker.onmessage({ data: {
  id: 1,
  full: false,
  symbols: [],
  sightings: [],
  trackedAttempted: true,
  trackedHit: false,
  guidedMetrics: { totalMs: 7 },
  repeatSkipped: false,
  latencyMs: 9
} });

if (!pool.submit({ id: 2, full: false, w: 32, h: 32, tracks: [] }, []))
  throw new Error("second worker submit failed");
worker.onmessage({ data: {
  id: 2,
  preflight: true,
  sourceSequence: 18,
  frameSignature: { key: "b", bits: new Uint8Array([3, 4]), bitCount: 16 }
} });
worker.onmessage({ data: {
  id: 2,
  full: false,
  symbols: [],
  sightings: [],
  trackedAttempted: false,
  trackedHit: false,
  repeatSkipped: true,
  repeatDistance: 0,
  latencyMs: 1
} });

if (completions.length !== 2) throw new Error(`expected 2 completions, got ${completions.length}`);
if (!completions[1].sameIdentity) throw new Error("completion object was not reused for the worker slot");
if (completions[1].guidedMetrics !== undefined)
  throw new Error("stale guidedMetrics leaked into reused completion");
if (!completions[1].repeatSkipped) throw new Error("second completion did not receive fresh repeatSkipped state");
if (completions[1].error !== undefined) throw new Error("stale completion error leaked into success");

if (preflights.length !== 2) throw new Error(`expected 2 preflights, got ${preflights.length}`);
if (!preflights[1].sameIdentity) throw new Error("preflight envelope was not reused for the worker slot");
if (preflights[1].id !== 2 || preflights[1].sourceSequence !== 18 || preflights[1].signature?.key !== "b")
  throw new Error("reused preflight envelope did not receive fresh fields");

pool.resize(0);
console.log("AIRGAPPER_WORKER_POOL_REUSE_PASS", JSON.stringify({
  completionIdentityReused: completions[1].sameIdentity,
  preflightIdentityReused: preflights[1].sameIdentity,
  staleGuidedMetricsCleared: completions[1].guidedMetrics === undefined
}));
