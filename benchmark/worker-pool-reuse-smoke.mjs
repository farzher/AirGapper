import { DecodeWorkerPool } from "../shared/worker-pool.js";

// The receiver imports worker-capacity-guard.js before constructing its pool.
// Mock the tiny browser surface it needs so this smoke exercises the same
// patched submitAtSlot() prototype instead of only the unwrapped base class.
globalThis.document = {
  getElementById: () => null,
  body: { classList: { contains: () => false } }
};
globalThis.window = globalThis;
await import("../receive/worker-capacity-guard.js");
if (!DecodeWorkerPool.prototype.submitAtSlot.__airgapperWorkerPolicy)
  throw new Error("worker-capacity guard did not patch submitAtSlot");

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
const decodedInfos = [];
let firstCompletion;
let firstPreflight;
let pool;
let allowReentrantSubmit = false;
let autoSubmittedSecond = false;
let secondMeta;

pool = new DecodeWorkerPool(
  () => {
    const worker = new FakeWorker();
    created.push(worker);
    return worker;
  },
  (_bytes, _box, info) => {
    decodedInfos.push({
      scanId: info.scanId,
      sourceSequence: info.sourceSequence,
      opticsEpoch: info.opticsEpoch
    });
  },
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
  () => {
    // Worker-ready also uses onAvailable so queued live work can resume after a
    // timeout replacement warms. Only exercise completion reentrancy after the
    // first real job has been submitted.
    if (!allowReentrantSubmit || autoSubmittedSecond) return;
    autoSubmittedSecond = true;
    if (!pool.submit({
      id: 2,
      full: false,
      w: 32,
      h: 32,
      tracks: [],
      sourceSequence: 202,
      opticsEpoch: 22
    }, [])) throw new Error("reentrant second worker submit failed");
    secondMeta = pool.activeMeta[0];
  },
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

// A worker is intentionally not schedulable until worker.js has initialized
// its WASM decoder and emitted the existing id:-1 ready signal.
if (pool.submit({ id: 99, full: false, w: 8, h: 8, tracks: [] }, []))
  throw new Error("cold worker accepted a decode job before ready");
worker.onmessage({ data: { id: -1, bytes: null } });

if (!pool.submit({
  id: 1,
  full: false,
  w: 32,
  h: 32,
  tracks: [],
  sourceSequence: 101,
  opticsEpoch: 11
}, [])) throw new Error("first worker submit failed");
const firstMeta = pool.activeMeta[0];
allowReentrantSubmit = true;

worker.onmessage({ data: {
  id: 1,
  preflight: true,
  sourceSequence: 17,
  frameSignature: { key: "a", bits: new Uint8Array([1, 2]), bitCount: 16 }
} });
worker.onmessage({ data: {
  id: 1,
  full: false,
  symbols: [{
    bytes: new Uint8Array([1]),
    header: { slotIndex: 0 },
    tracked: true,
    geometryMeasured: false
  }],
  sightings: [],
  trackedAttempted: true,
  trackedHit: true,
  guidedMetrics: { totalMs: 7 },
  repeatSkipped: false,
  latencyMs: 9
} });

if (!secondMeta) throw new Error("onAvailable did not reentrantly schedule second job");
if (secondMeta === firstMeta) throw new Error("reentrant submit reused metadata record before prior completion consumed it");
if (decodedInfos.length !== 1 || decodedInfos[0].sourceSequence !== 101 || decodedInfos[0].opticsEpoch !== 11)
  throw new Error(`prior job metadata was corrupted by reentrant submit: ${JSON.stringify(decodedInfos)}`);

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

// The third job should wrap back to the first metadata record: two records are
// sufficient because a worker message cannot finish the newly posted job before
// the current message callback returns.
if (!pool.submit({
  id: 3,
  full: false,
  w: 32,
  h: 32,
  tracks: [],
  sourceSequence: 303,
  opticsEpoch: 33
}, [])) throw new Error("third worker submit failed");
const thirdMeta = pool.activeMeta[0];
if (thirdMeta !== firstMeta) throw new Error("metadata ping-pong did not reuse the first record on third submit");
worker.onmessage({ data: {
  id: 3,
  full: false,
  symbols: [],
  sightings: [],
  trackedAttempted: false,
  trackedHit: false,
  repeatSkipped: false,
  latencyMs: 2
} });

if (completions.length !== 3) throw new Error(`expected 3 completions, got ${completions.length}`);
if (!completions[1].sameIdentity || !completions[2].sameIdentity)
  throw new Error("completion object was not reused for the worker slot");
if (completions[1].guidedMetrics !== undefined)
  throw new Error("stale guidedMetrics leaked into reused completion");
if (!completions[1].repeatSkipped) throw new Error("second completion did not receive fresh repeatSkipped state");
if (completions[1].error !== undefined) throw new Error("stale completion error leaked into success");
if (completions[2].repeatSkipped) throw new Error("third completion retained stale repeatSkipped state");

if (preflights.length !== 2) throw new Error(`expected 2 preflights, got ${preflights.length}`);
if (!preflights[1].sameIdentity) throw new Error("preflight envelope was not reused for the worker slot");
if (preflights[1].id !== 2 || preflights[1].sourceSequence !== 18 || preflights[1].signature?.key !== "b")
  throw new Error("reused preflight envelope did not receive fresh fields");

pool.resize(0);

// Acquisition timeout ownership belongs to DecodeWorkerPool. The receiver guard
// may bound concurrency and normalize cheap-vs-robust modes, but it must not
// silently replace the pool's recovery deadline with another short timeout.
const timeoutWorkers = [];
const timeoutPool = new DecodeWorkerPool(
  () => {
    const next = new FakeWorker();
    timeoutWorkers.push(next);
    return next;
  },
  () => void 0,
  () => void 0,
  () => void 0,
  () => void 0
);
timeoutPool.resize(1);
const timeoutWorker = timeoutWorkers[0];
timeoutWorker.onmessage({ data: { id: -1, bytes: null } });
if (!timeoutPool.submit({ id: 40, full: true, acquisitionMode: "seed", w: 64, h: 64 }, []))
  throw new Error("warm acquisition worker rejected job");
const acquisitionMeta = timeoutPool.activeMeta[0];
if (!acquisitionMeta || acquisitionMeta.timeoutMs < 6000)
  throw new Error(`acquisition timeout was unexpectedly shortened: ${acquisitionMeta?.timeoutMs}`);
timeoutPool.resize(0);

console.log("AIRGAPPER_WORKER_POOL_REUSE_PASS", JSON.stringify({
  guardedSubmitPath: true,
  coldWorkerRejected: true,
  completionIdentityReused: completions[1].sameIdentity && completions[2].sameIdentity,
  preflightIdentityReused: preflights[1].sameIdentity,
  staleGuidedMetricsCleared: completions[1].guidedMetrics === undefined,
  reentrantMetadataPreserved: decodedInfos[0]?.sourceSequence === 101 && decodedInfos[0]?.opticsEpoch === 11,
  metadataRecordReused: thirdMeta === firstMeta,
  acquisitionTimeoutMs: acquisitionMeta.timeoutMs
}));