import {
  sampleSoftModuleGrid,
  temporalEnabledForTracks
} from "./temporal-soft-grid.js";

const scope = self;
const scalarCodec = new URL(import.meta.url).searchParams.has("scalar");
const nativePostMessage = scope.postMessage.bind(scope);
const NativeWorker = scope.Worker;
const NativeCopyTo = globalThis.VideoFrame?.prototype?.copyTo;
const HISTORY_PER_SLOT = 3;
const MAX_FINAL_WAIT_MS = 12;
const TARGET_JOB_BUDGET_MS = 31;
const RECOVERY_SEARCH_MS = 70;

let activeJob = null;
let nextRecoveryToken = 1;
const history = new Map();
const recoveryResults = new Map();
const recoveryWaiters = new Map();
const recovery = {
  worker: null,
  busy: false,
  token: 0,
  sourceSequence: -1,
  pendingSequence: -1,
  sampledFrames: 0,
  sampledModules: 0,
  sampleMs: 0,
  jobs: 0,
  attempts: 0,
  hits: 0,
  merged: 0,
  dropped: 0,
  recoverMs: 0,
  waitMs: 0,
  errors: 0
};

function validSequence(value) {
  return Number.isInteger(Number(value)) ? Number(value) : null;
}

function lowCountMessage(message) {
  return Boolean(message && !message.full && message.pixelFormat === "y8" &&
    temporalEnabledForTracks(message.tracks) && validSequence(message.sourceSequence) !== null);
}

function copyQuad(quad) {
  if (!quad) return null;
  const copy = (point) => ({ x: Number(point.x), y: Number(point.y) });
  return {
    topLeft: copy(quad.topLeft),
    topRight: copy(quad.topRight),
    bottomRight: copy(quad.bottomRight),
    bottomLeft: copy(quad.bottomLeft)
  };
}

function cloneSample(sample) {
  return {
    slot: sample.slot,
    dim: sample.dim,
    luma: sample.luma.slice(),
    threshold: sample.threshold,
    low: sample.low,
    high: sample.high,
    separation: sample.separation,
    quad: copyQuad(sample.quad),
    sourceSequence: sample.sourceSequence
  };
}

function ensureRecoveryWorker() {
  if (recovery.worker || typeof NativeWorker !== "function") return recovery.worker;
  try {
    const file = scalarCodec
      ? "./worker-temporal-generalized.js?scalar=1"
      : "./worker-temporal-generalized.js";
    const worker = new NativeWorker(new URL(file, import.meta.url), { type: "module" });
    worker.onmessage = (event) => {
      const data = event.data;
      if (!data?.temporalGeneralized) return;
      if (data.token !== recovery.token) return;
      recovery.busy = false;
      recovery.attempts += Number(data.metrics?.attempts) || 0;
      recovery.hits += Number(data.metrics?.hits) || 0;
      recovery.recoverMs += Number(data.metrics?.recoverMs) || 0;
      recovery.errors += Number(Boolean(data.error));
      const sequence = validSequence(data.sourceSequence);
      if (sequence !== null) {
        recoveryResults.set(sequence, {
          symbols: Array.isArray(data.symbols) ? data.symbols : [],
          metrics: data.metrics ?? {},
          receivedAt: performance.now()
        });
        while (recoveryResults.size > 6) recoveryResults.delete(recoveryResults.keys().next().value);
        const waiters = recoveryWaiters.get(sequence);
        if (waiters) {
          recoveryWaiters.delete(sequence);
          for (const resolve of waiters) resolve(recoveryResults.get(sequence));
        }
      }
      const pending = recovery.pendingSequence;
      recovery.pendingSequence = -1;
      if (pending >= 0) serviceRecovery(pending);
    };
    worker.onerror = () => {
      recovery.errors++;
      recovery.busy = false;
      try { worker.terminate(); } catch {}
      if (recovery.worker === worker) recovery.worker = null;
      const pending = recovery.pendingSequence;
      recovery.pendingSequence = -1;
      if (pending >= 0) serviceRecovery(pending);
    };
    recovery.worker = worker;
    // Warm WASM before the first miss. This does not touch a camera frame.
    worker.postMessage({ action: "warm", token: 0, sourceSequence: -1 });
  } catch {
    recovery.errors++;
    recovery.worker = null;
  }
  return recovery.worker;
}

function pairForSlot(slot, sequence) {
  const items = history.get(slot) ?? [];
  const current = items.find((item) => item.sourceSequence === sequence);
  const previous = items.find((item) => item.sourceSequence === sequence - 1);
  if (!current || !previous || current.dim !== previous.dim) return null;
  return { slot, previous, current };
}

function pairsForSequence(sequence) {
  const pairs = [];
  for (const slot of history.keys()) {
    const pair = pairForSlot(slot, sequence);
    if (pair) pairs.push(pair);
  }
  return pairs.slice(0, 2);
}

function serviceRecovery(sequence) {
  const worker = ensureRecoveryWorker();
  if (!worker) return;
  if (recovery.busy) {
    // Latest wins. The retained state is only tiny module grids; no VideoFrame or
    // camera-plane buffer can ever queue here.
    if (sequence > recovery.pendingSequence) recovery.pendingSequence = sequence;
    recovery.dropped++;
    return;
  }
  const sourcePairs = pairsForSequence(sequence);
  if (!sourcePairs.length) return;

  const pairs = sourcePairs.map((pair) => ({
    slot: pair.slot,
    previous: cloneSample(pair.previous),
    current: cloneSample(pair.current)
  }));
  const transfer = [];
  for (const pair of pairs) {
    transfer.push(pair.previous.luma.buffer, pair.current.luma.buffer);
  }
  const token = ++nextRecoveryToken;
  recovery.token = token;
  recovery.sourceSequence = sequence;
  recovery.busy = true;
  recovery.jobs++;
  try {
    worker.postMessage({
      action: "recover",
      token,
      sourceSequence: sequence,
      pairs,
      maxMs: RECOVERY_SEARCH_MS
    }, transfer);
  } catch {
    recovery.busy = false;
    recovery.errors++;
  }
}

function noteSamples(samples, sampleMs) {
  if (!samples.length) return;
  recovery.sampledFrames++;
  recovery.sampledModules += samples.reduce((sum, sample) => sum + sample.dim * sample.dim, 0);
  recovery.sampleMs += sampleMs;
  const sequence = samples[0].sourceSequence;
  for (const sample of samples) {
    const prior = history.get(sample.slot) ?? [];
    const next = [sample, ...prior.filter((item) => item.sourceSequence < sample.sourceSequence)]
      .slice(0, HISTORY_PER_SLOT);
    history.set(sample.slot, next);
  }
  serviceRecovery(sequence);
}

function sampleActiveY(heap, yPtr, width, height, stride) {
  const job = activeJob;
  if (!job || job.sampled || !lowCountMessage(job.message)) return;
  const started = performance.now();
  const message = job.message;
  const sequence = Number(message.sourceSequence);
  const samples = [];
  for (const track of message.tracks) {
    const sample = sampleSoftModuleGrid(
      heap,
      yPtr,
      width,
      height,
      stride,
      Number(message.ox) || 0,
      Number(message.oy) || 0,
      track,
      sequence
    );
    if (sample) samples.push(sample);
  }
  job.sampled = true;
  noteSamples(samples, performance.now() - started);
}

if (NativeCopyTo && globalThis.VideoFrame?.prototype) {
  globalThis.VideoFrame.prototype.copyTo = async function(destination, options) {
    const planes = await NativeCopyTo.call(this, destination, options);
    try {
      const job = activeJob;
      const message = job?.message;
      const plane = planes?.[0];
      if (job && plane && lowCountMessage(message) && !job.sampled) {
        sampleActiveY(
          destination,
          Number(plane.offset) || 0,
          Math.max(1, Number(message.w) || 0),
          Math.max(1, Number(message.h) || 0),
          Number(plane.stride) || Number(message.w) || 0
        );
      }
    } catch {
      recovery.errors++;
    }
    return planes;
  };
}

function sampleBufferMessage(message) {
  if (!lowCountMessage(message)) return;
  try {
    if (message.videoFrame instanceof ArrayBuffer) {
      const width = Math.max(1, Number(message.w) || 0);
      const height = Math.max(1, Number(message.h) || 0);
      const stride = Number(message.yStride) || width;
      const offset = Number(message.yOffset) || 0;
      const bytes = new Uint8Array(message.videoFrame);
      const required = offset + Math.max(0, height - 1) * stride + width;
      if (stride >= width && required <= bytes.length)
        sampleActiveY(bytes, offset, width, height, stride);
      return;
    }
    if (!message.videoFrame && message.buf instanceof ArrayBuffer) {
      const width = Math.max(1, Number(message.w) || 0);
      const height = Math.max(1, Number(message.h) || 0);
      const stride = Number(message.yStride) || width;
      const offset = Number(message.yOffset) || 0;
      const bytes = new Uint8Array(message.buf);
      const required = offset + Math.max(0, height - 1) * stride + width;
      if (stride >= width && required <= bytes.length)
        sampleActiveY(bytes, offset, width, height, stride);
    }
  } catch {
    recovery.errors++;
  }
}

function decodedSlots(message) {
  const slots = new Set();
  for (const symbol of message?.symbols ?? []) {
    const slot = Number(symbol?.header?.slotIndex);
    if (Number.isInteger(slot)) slots.add(slot);
  }
  return slots;
}

function expectedSlots(message) {
  return (message?.tracks ?? []).map((track) => Number(track.slot ?? track.id))
    .filter((slot) => Number.isInteger(slot));
}

function mappedQuad(quad, outputMap) {
  const copy = copyQuad(quad);
  if (!copy || !outputMap || !Number.isFinite(outputMap.scaleX) || outputMap.scaleX <= 0 ||
      !Number.isFinite(outputMap.scaleY) || outputMap.scaleY <= 0) return copy;
  const map = (point) => ({
    x: (point.x - Number(outputMap.offsetX || 0)) / outputMap.scaleX,
    y: (point.y - Number(outputMap.offsetY || 0)) / outputMap.scaleY
  });
  return {
    topLeft: map(copy.topLeft),
    topRight: map(copy.topRight),
    bottomRight: map(copy.bottomRight),
    bottomLeft: map(copy.bottomLeft)
  };
}

function boundsOf(quad) {
  if (!quad) return null;
  const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  if (!points.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))) return null;
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function waitForRecovery(sequence, timeoutMs) {
  const ready = recoveryResults.get(sequence);
  if (ready || timeoutMs <= 0) return Promise.resolve(ready ?? null);
  return new Promise((resolve) => {
    const waiters = recoveryWaiters.get(sequence) ?? [];
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value ?? null);
    };
    waiters.push(done);
    recoveryWaiters.set(sequence, waiters);
    const timer = setTimeout(() => {
      const list = recoveryWaiters.get(sequence);
      if (list) {
        const index = list.indexOf(done);
        if (index >= 0) list.splice(index, 1);
        if (!list.length) recoveryWaiters.delete(sequence);
      }
      done(null);
    }, timeoutMs);
  });
}

function recoveryDiagnostics(waitMs = 0) {
  return {
    sampledFrames: recovery.sampledFrames,
    sampledModules: recovery.sampledModules,
    sampleMs: recovery.sampleMs,
    jobs: recovery.jobs,
    attempts: recovery.attempts,
    hits: recovery.hits,
    merged: recovery.merged,
    dropped: recovery.dropped,
    recoverMs: recovery.recoverMs,
    waitMs: recovery.waitMs + waitMs,
    errors: recovery.errors,
    busy: recovery.busy
  };
}

async function mergeTemporal(final, job) {
  if (!final || !lowCountMessage(job.message)) return final;
  const sequence = Number(job.message.sourceSequence);
  const expected = expectedSlots(job.message);
  const decoded = decodedSlots(final.message);
  const missing = expected.filter((slot) => !decoded.has(slot));
  if (!missing.length) {
    final.message.temporalMetrics = recoveryDiagnostics();
    return final;
  }

  let result = recoveryResults.get(sequence) ?? null;
  let waited = 0;
  if (!result) {
    const elapsed = performance.now() - job.startedAt;
    const budget = Math.max(0, Math.min(MAX_FINAL_WAIT_MS, TARGET_JOB_BUDGET_MS - elapsed));
    if (budget > 0) {
      const before = performance.now();
      result = await waitForRecovery(sequence, budget);
      waited = performance.now() - before;
      recovery.waitMs += waited;
    }
  }

  if (result?.symbols?.length) {
    const tracks = new Map(job.message.tracks.map((track) => [Number(track.slot ?? track.id), track]));
    const already = decodedSlots(final.message);
    for (const recovered of result.symbols) {
      const slot = Number(recovered.slot ?? recovered.header?.slotIndex);
      if (!missing.includes(slot) || already.has(slot)) continue;
      const track = tracks.get(slot);
      if (!track) continue;
      const quad = mappedQuad(track.quad, job.message.outputMap);
      if (!quad) continue;
      final.message.symbols.push({
        bytes: recovered.bytes,
        box: boundsOf(quad),
        quad,
        modules: recovered.modules || track.dim,
        tracked: true,
        geometryMeasured: false,
        decodePath: "temporal-generalized",
        crc32: true,
        verifiedPayload: true,
        header: recovered.header
      });
      already.add(slot);
      recovery.merged++;
      if (recovered.bytes?.buffer instanceof ArrayBuffer) final.transfer.push(recovered.bytes.buffer);
    }
  }

  final.message.trackedHit = (final.message.symbols?.length ?? 0) > 0;
  final.message.latencyMs = performance.now() - job.startedAt;
  final.message.temporalMetrics = {
    ...recoveryDiagnostics(waited),
    last: result?.metrics ?? null
  };
  if (recovery.merged && final.message.pixelPath && !String(final.message.pixelPath).includes("temporal"))
    final.message.pixelPath += "+temporal";
  return final;
}

function uniqueTransfer(list) {
  const seen = new Set();
  return list.filter((item) => item instanceof ArrayBuffer && !seen.has(item) && seen.add(item));
}

const baseModule = scalarCodec ? "./worker.js?scalar=1" : "./worker.js";
await import(baseModule);
const baseOnMessage = scope.onmessage;

scope.postMessage = function(message, transfer = []) {
  const job = activeJob;
  if (!job || message?.id === -1 || message?.preflight || message?.id !== job.message.id) {
    nativePostMessage(message, transfer);
    return;
  }
  // The base decoder posts exactly one terminal message per owned job. Hold the
  // terminal reply locally so a recovery result that is already in flight can
  // be merged under a strict sub-frame wait budget. Preflights remain immediate.
  job.final = { message, transfer: Array.from(transfer ?? []) };
};

scope.onmessage = async (event) => {
  const message = event.data ?? {};
  const job = {
    message,
    startedAt: performance.now(),
    sampled: false,
    final: null
  };
  activeJob = job;
  try {
    sampleBufferMessage(message);
    await baseOnMessage(event);
    if (!job.final) return;
    const final = await mergeTemporal(job.final, job);
    nativePostMessage(final.message, uniqueTransfer(final.transfer));
  } finally {
    if (activeJob === job) activeJob = null;
  }
};
