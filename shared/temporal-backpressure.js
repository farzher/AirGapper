import { DecodeWorkerPool } from "./worker-pool.js";
import { parseFrame } from "./protocol.js";

const SAMPLE_TIMEOUT_MS = 750;
const RECOVERY_TIMEOUT_MS = 3000;
const WARM_TIMEOUT_MS = 30000;
const LOW_COUNT_REACQUIRE_GRACE_MS = 2000;
const JOB_TTL_MS = 2000;
const HISTORY_PER_SLOT = 4;
let installed = false;
let nextGeneration = 1;

const diagnostics = {
  active: false,
  sampledFrames: 0,
  sampledModules: 0,
  sampleDrops: 0,
  sampleRestarts: 0,
  sampleMs: 0,
  copyMs: 0,
  delta1Pairs: 0,
  delta2Pairs: 0,
  noPair: 0,
  recoveryJobs: 0,
  recoveryReplaced: 0,
  recoveryAttempts: 0,
  recoveryHits: 0,
  recoveryRestarts: 0,
  recoveryMs: 0,
  warmMs: 0,
  lastSeam: void 0,
  lastOrientation: void 0,
  lastDelta: void 0
};

if (typeof globalThis !== "undefined") globalThis.__airgapperTemporalDiagnostics = diagnostics;

function lowCountTemporalMessage(message) {
  return Boolean(message && !message.full && message.pixelFormat === "y8" &&
    Array.isArray(message.tracks) && message.tracks.length >= 1 && message.tracks.length <= 2);
}

function supportsWasmSimd() {
  try {
    return WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123,
      3, 2, 1, 0, 10, 8, 1, 6, 0, 65, 0, 253, 15, 11
    ]));
  } catch {
    return false;
  }
}

function temporalUsesScalarCodec() {
  try {
    if (globalThis.window?.AirGapperAndroid?.is64BitProcess?.() === false) return true;
  } catch {}
  return !supportsWasmSimd();
}

function createRoleWorker(pool, role) {
  if (typeof globalThis.Worker !== "function" || typeof globalThis.location === "undefined") {
    return pool.create(role);
  }
  const file = temporalUsesScalarCodec()
    ? "../receive/worker-temporal-v2.js?scalar=1"
    : "../receive/worker-temporal-v2.js";
  return new Worker(new URL(file, import.meta.url), { type: "module" });
}

function cloneTemporalFrame(frame) {
  if (frame instanceof ArrayBuffer) {
    try { return frame.slice(0); } catch { return null; }
  }
  if (frame && typeof frame.clone === "function") {
    try { return frame.clone(); } catch { return null; }
  }
  return null;
}

function slotOfSymbol(symbol) {
  const direct = Number(symbol?.header?.slotIndex);
  if (Number.isInteger(direct)) return direct;
  if (!symbol?.bytes?.length) return void 0;
  try {
    const parsed = parseFrame(symbol.bytes);
    const slot = Number(parsed?.header?.slotIndex);
    return Number.isInteger(slot) ? slot : void 0;
  } catch {
    return void 0;
  }
}

function expectedSlots(message) {
  return [...new Set((message?.tracks ?? []).flatMap((track) => {
    const slot = Number(track?.slot ?? track?.id);
    return Number.isInteger(slot) ? [slot] : [];
  }))];
}

function completedSlots(completion) {
  const slots = new Set();
  for (const symbol of completion?.symbols ?? []) {
    const slot = slotOfSymbol(symbol);
    if (Number.isInteger(slot)) slots.add(slot);
  }
  return slots;
}

function clearTimer(channel) {
  clearTimeout(channel?.timer);
  if (channel) channel.timer = void 0;
}

function stopState(pool, state = pool.__airgapperTemporalSplit) {
  if (!state) return;
  clearTimer(state.sampler);
  clearTimer(state.recovery);
  try { state.sampler?.worker?.terminate?.(); } catch {}
  try { state.recovery?.worker?.terminate?.(); } catch {}
  state.jobs.clear();
  state.history.clear();
  state.pendingRecovery = null;
  if (pool.__airgapperTemporalSplit === state) pool.__airgapperTemporalSplit = null;
  diagnostics.active = false;
}

function injectRecovered(pool, message) {
  for (const symbol of message?.symbols ?? []) {
    try {
      pool.onDecoded?.(symbol.bytes, symbol.box, {
        scanId: message.id,
        sourceSequence: message.sourceSequence,
        quad: symbol.quad,
        modules: symbol.modules,
        tracked: true,
        geometryMeasured: false,
        decodePath: "temporal-stitch",
        crc32: true,
        verifiedPayload: true,
        header: symbol.header
      });
    } catch {}
  }
}

function rememberSample(state, sample) {
  const slot = Number(sample?.slot);
  const sequence = Number(sample?.sourceSequence);
  if (!Number.isInteger(slot) || !Number.isInteger(sequence) || !sample?.modules) return;
  const previous = state.history.get(slot) ?? [];
  state.history.set(slot, [sample, ...previous.filter((item) => Number(item.sourceSequence) < sequence)]
    .slice(0, HISTORY_PER_SLOT));
}

function cloneSnapshot(sample) {
  return {
    slot: Number(sample.slot),
    dim: Number(sample.dim),
    modules: sample.modules.slice(),
    quad: sample.quad,
    sourceSequence: Number(sample.sourceSequence),
    separation: Number(sample.separation) || 0
  };
}

function recoveryTransfer(payload) {
  const buffers = [];
  for (const pair of payload.pairs ?? []) {
    if (pair.current?.modules?.buffer) buffers.push(pair.current.modules.buffer);
    for (const previous of pair.previousSamples ?? []) {
      if (previous?.modules?.buffer) buffers.push(previous.modules.buffer);
    }
  }
  return buffers;
}

function postSampler(pool, state, payload, transfer) {
  const channel = state.sampler;
  if (!channel?.worker || channel.busy || pool.__airgapperTemporalSplit !== state) return false;
  const token = ++channel.token;
  channel.busy = true;
  channel.busyToken = token;
  channel.jobId = payload.id;
  try {
    channel.worker.postMessage({ ...payload, token, generation: state.generation }, transfer ?? []);
  } catch {
    channel.busy = false;
    channel.busyToken = void 0;
    channel.jobId = void 0;
    return false;
  }
  clearTimer(channel);
  channel.timer = setTimeout(() => {
    if (pool.__airgapperTemporalSplit !== state || channel.busyToken !== token) return;
    diagnostics.sampleRestarts++;
    const failedJob = channel.jobId;
    try { channel.worker?.terminate?.(); } catch {}
    if (Number.isInteger(failedJob)) state.jobs.delete(failedJob);
    state.sampler = makeSampler(pool, state);
  }, SAMPLE_TIMEOUT_MS);
  return true;
}

function postRecovery(pool, state, payload, transfer, timeoutMs = RECOVERY_TIMEOUT_MS) {
  const channel = state.recovery;
  if (!channel?.worker || channel.busy || pool.__airgapperTemporalSplit !== state) return false;
  const token = ++channel.token;
  channel.busy = true;
  channel.busyToken = token;
  channel.current = payload.action === "recover-pairs" ? payload : null;
  try {
    channel.worker.postMessage({ ...payload, token, generation: state.generation }, transfer ?? []);
  } catch {
    channel.busy = false;
    channel.busyToken = void 0;
    channel.current = null;
    return false;
  }
  clearTimer(channel);
  channel.timer = setTimeout(() => {
    if (pool.__airgapperTemporalSplit !== state || channel.busyToken !== token) return;
    diagnostics.recoveryRestarts++;
    if (channel.current) state.pendingRecovery = channel.current;
    try { channel.worker?.terminate?.(); } catch {}
    state.recovery = makeRecovery(pool, state);
    warmRecovery(pool, state);
  }, timeoutMs);
  return true;
}

function makeSampler(pool, state) {
  const worker = createRoleWorker(pool, "temporal-sampler");
  const channel = { worker, busy: false, busyToken: void 0, token: 0, timer: void 0, jobId: void 0 };
  if (!worker) return channel;
  worker.onmessage = (event) => {
    if (pool.__airgapperTemporalSplit !== state || state.sampler !== channel) return;
    const message = event.data;
    if (!message?.temporalV2 || message.phase !== "sample") return;
    if (channel.busyToken === message.token) {
      clearTimer(channel);
      channel.busy = false;
      channel.busyToken = void 0;
      channel.jobId = void 0;
    }
    if (message.generation !== state.generation) return;

    const metrics = message.guidedMetrics ?? {};
    const samples = Array.isArray(message.samples) ? message.samples : [];
    diagnostics.sampledFrames += samples.length ? 1 : 0;
    diagnostics.sampledModules += samples.length;
    diagnostics.sampleMs = Number(metrics.temporalSampleMs) || diagnostics.sampleMs;
    diagnostics.copyMs = Number(metrics.temporalCopyMs) || diagnostics.copyMs;
    for (const sample of samples) rememberSample(state, sample);

    const job = state.jobs.get(message.id);
    if (!job) return;
    job.sampleDone = true;
    job.samples = samples;
    serviceJob(pool, state, job);
  };
  worker.onerror = () => {
    if (pool.__airgapperTemporalSplit !== state || state.sampler !== channel) return;
    diagnostics.sampleRestarts++;
    clearTimer(channel);
    if (Number.isInteger(channel.jobId)) state.jobs.delete(channel.jobId);
    state.sampler = makeSampler(pool, state);
  };
  return channel;
}

function serviceRecovery(pool, state) {
  const channel = state.recovery;
  if (!channel?.ready || channel.busy || !state.pendingRecovery) return;
  const payload = state.pendingRecovery;
  state.pendingRecovery = null;
  diagnostics.recoveryJobs++;
  if (!postRecovery(pool, state, payload, recoveryTransfer(payload))) {
    state.pendingRecovery = payload;
  }
}

function makeRecovery(pool, state) {
  const worker = createRoleWorker(pool, "temporal-recover");
  const channel = {
    worker,
    ready: false,
    busy: false,
    busyToken: void 0,
    token: 0,
    timer: void 0,
    current: null
  };
  if (!worker) return channel;
  worker.onmessage = (event) => {
    if (pool.__airgapperTemporalSplit !== state || state.recovery !== channel) return;
    const message = event.data;
    if (!message?.temporalV2) return;
    if (channel.busyToken === message.token) {
      clearTimer(channel);
      channel.busy = false;
      channel.busyToken = void 0;
      channel.current = null;
    }
    if (message.generation !== state.generation) return;
    const metrics = message.guidedMetrics ?? {};

    if (message.phase === "warm") {
      channel.ready = true;
      diagnostics.warmMs = Number(metrics.temporalWarmMs) || diagnostics.warmMs;
      serviceRecovery(pool, state);
      return;
    }
    if (message.phase !== "recover-pairs") return;

    diagnostics.recoveryAttempts += Number(metrics.temporalStitchAttempts) || 0;
    diagnostics.recoveryHits += Number(metrics.temporalStitchHits) || 0;
    diagnostics.recoveryMs = Number(metrics.temporalRecoverMs) || diagnostics.recoveryMs;
    if ((message.symbols?.length ?? 0) > 0) {
      for (const symbol of message.symbols) {
        const slot = slotOfSymbol(symbol);
        if (!Number.isInteger(slot)) continue;
        state.hints.set(slot, {
          seam: Number(symbol.temporalSeam),
          orientation: symbol.temporalOrientation,
          delta: Number(symbol.temporalSourceDelta)
        });
        diagnostics.lastSeam = Number(symbol.temporalSeam);
        diagnostics.lastOrientation = symbol.temporalOrientation;
        diagnostics.lastDelta = Number(symbol.temporalSourceDelta);
      }
      injectRecovered(pool, message);
    }
    serviceRecovery(pool, state);
  };
  worker.onerror = () => {
    if (pool.__airgapperTemporalSplit !== state || state.recovery !== channel) return;
    diagnostics.recoveryRestarts++;
    clearTimer(channel);
    if (channel.current) state.pendingRecovery = channel.current;
    state.recovery = makeRecovery(pool, state);
    warmRecovery(pool, state);
  };
  return channel;
}

function warmRecovery(pool, state) {
  const channel = state.recovery;
  if (!channel?.worker || channel.ready || channel.busy) return;
  postRecovery(pool, state, { action: "warm", id: -2, sourceSequence: -1 }, [], WARM_TIMEOUT_MS);
}

function ensureState(pool) {
  const existing = pool.__airgapperTemporalSplit;
  if (existing) return existing;
  const state = {
    generation: nextGeneration++,
    sampler: null,
    recovery: null,
    lowCountActive: true,
    lastLowCountAt: performance.now(),
    jobs: new Map(),
    history: new Map(),
    hints: new Map(),
    pendingRecovery: null
  };
  pool.__airgapperTemporalSplit = state;
  state.sampler = makeSampler(pool, state);
  state.recovery = makeRecovery(pool, state);
  diagnostics.active = true;
  installCompletionHook(pool);
  warmRecovery(pool, state);
  return state;
}

function cleanupJobs(state) {
  const now = performance.now();
  for (const [id, job] of state.jobs) {
    if (now - job.createdAt > JOB_TTL_MS) state.jobs.delete(id);
  }
}

function buildRecoveryPayload(state, job) {
  const pairs = [];
  for (const slot of job.missingSlots ?? []) {
    const current = (job.samples ?? []).find((sample) => Number(sample.slot) === slot);
    if (!current) {
      diagnostics.noPair++;
      continue;
    }
    const history = state.history.get(slot) ?? [];
    const previous = history.filter((sample) => {
      const delta = Number(current.sourceSequence) - Number(sample.sourceSequence);
      return delta >= 1 && delta <= 2 && Number(sample.dim) === Number(current.dim);
    }).slice(0, 2);
    if (!previous.length) {
      diagnostics.noPair++;
      continue;
    }
    if (previous.some((sample) => Number(current.sourceSequence) - Number(sample.sourceSequence) === 1)) diagnostics.delta1Pairs++;
    if (previous.some((sample) => Number(current.sourceSequence) - Number(sample.sourceSequence) === 2)) diagnostics.delta2Pairs++;
    pairs.push({
      slot,
      current: cloneSnapshot(current),
      previousSamples: previous.map(cloneSnapshot),
      hint: state.hints.get(slot)
    });
  }
  if (!pairs.length) return null;
  return {
    action: "recover-pairs",
    id: job.id,
    sourceSequence: job.sourceSequence,
    pairs
  };
}

function queueRecovery(pool, state, payload) {
  if (!payload) return;
  if (state.pendingRecovery) diagnostics.recoveryReplaced++;
  state.pendingRecovery = payload;
  serviceRecovery(pool, state);
}

function serviceJob(pool, state, job) {
  if (!job.sampleDone || !job.normalDone) return;
  state.jobs.delete(job.id);
  if (!job.missingSlots?.length) return;
  queueRecovery(pool, state, buildRecoveryPayload(state, job));
}

function installCompletionHook(pool) {
  if (pool.__airgapperTemporalSplitCompletionHook) return;
  pool.__airgapperTemporalSplitCompletionHook = true;
  const originalCompleted = pool.onCompleted;
  pool.onCompleted = (id, completion) => {
    const state = pool.__airgapperTemporalSplit;
    const job = state?.jobs.get(id);
    if (job) {
      job.normalDone = true;
      const decoded = completedSlots(completion);
      job.missingSlots = job.expectedSlots.filter((slot) => !decoded.has(slot));
      serviceJob(pool, state, job);
    }
    return originalCompleted?.(id, completion);
  };
}

function mirrorLowCountFrame(pool, message) {
  const state = ensureState(pool);
  state.lowCountActive = true;
  state.lastLowCountAt = performance.now();
  cleanupJobs(state);

  const channel = state.sampler;
  // The camera path is never queued. If the 2 ms sampler somehow misses its
  // frame budget, drop this optional mirror and let normal decode continue.
  if (!channel?.worker || channel.busy) {
    diagnostics.sampleDrops++;
    return;
  }

  const slots = expectedSlots(message);
  if (!slots.length) return;
  const frame = cloneTemporalFrame(message.videoFrame);
  if (!frame) return;
  const job = {
    id: message.id,
    sourceSequence: Number(message.sourceSequence),
    expectedSlots: slots,
    missingSlots: [],
    samples: [],
    sampleDone: false,
    normalDone: false,
    createdAt: performance.now()
  };
  state.jobs.set(message.id, job);
  const copy = {
    ...message,
    action: "sample",
    sampleOnly: true,
    videoFrame: frame
  };
  if (!postSampler(pool, state, copy, [frame])) {
    state.jobs.delete(message.id);
    try { frame.close?.(); } catch {}
    diagnostics.sampleDrops++;
  }
}

function manageTemporalForMessage(pool, message) {
  if (lowCountTemporalMessage(message)) {
    mirrorLowCountFrame(pool, message);
    return;
  }
  const state = pool.__airgapperTemporalSplit;
  if (!state) return;
  // A low-count wall can briefly submit full reacquisition jobs. Keep the tiny
  // module history and already-warm workers alive across that outage; 3+ tracked
  // QR immediately tears temporal work down so dense mode pays zero overhead.
  if (message?.full && performance.now() - state.lastLowCountAt <= LOW_COUNT_REACQUIRE_GRACE_MS) return;
  stopState(pool, state);
}

function installDiagnostics() {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  const target = document.getElementById("focus-diagnostics");
  if (!target) return;
  let mutating = false;
  const sync = () => {
    if (mutating) return;
    const original = target.textContent || "";
    let next = original.replace(/ · temporal frames [^\n]*/g, "");
    if (diagnostics.active || diagnostics.sampledFrames || diagnostics.recoveryAttempts || diagnostics.sampleRestarts || diagnostics.recoveryRestarts) {
      const timing = `${diagnostics.sampleMs.toFixed(1)}ms sample/${diagnostics.recoveryMs.toFixed(1)}ms recover`;
      const seam = Number.isFinite(diagnostics.lastSeam)
        ? ` · seam ${diagnostics.lastSeam} d${diagnostics.lastDelta || "?"}`
        : "";
      const suffix = ` · temporal frames ${diagnostics.sampledFrames} drop ${diagnostics.sampleDrops} · Δ1 ${diagnostics.delta1Pairs} Δ2 ${diagnostics.delta2Pairs} no-pair ${diagnostics.noPair} · stitch ${diagnostics.recoveryHits}/${diagnostics.recoveryAttempts} jobs ${diagnostics.recoveryJobs} repl ${diagnostics.recoveryReplaced} · ${timing}${seam}${diagnostics.sampleRestarts || diagnostics.recoveryRestarts ? ` · restart ${diagnostics.sampleRestarts}/${diagnostics.recoveryRestarts}` : ""}`;
      next = next.replace(/Recovery ([^\n]+)/, (line) => `${line}${suffix}`);
    }
    if (next !== original) {
      mutating = true;
      target.textContent = next;
      mutating = false;
    }
  };
  const observer = new MutationObserver(sync);
  observer.observe(target, { childList: true, characterData: true, subtree: true });
  sync();
}

function installTemporalBackpressure() {
  if (installed) return;
  installed = true;

  DecodeWorkerPool.prototype.submit = function(message, transfer) {
    const slot = this.busy.indexOf(false);
    if (slot === -1) return false;
    manageTemporalForMessage(this, message);
    return this.submitAtSlot(slot, message, transfer);
  };

  DecodeWorkerPool.prototype.submitTo = function(slot, message, transfer) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.workers.length || this.busy[slot]) return false;
    manageTemporalForMessage(this, message);
    return this.submitAtSlot(slot, message, transfer);
  };

  const policyResize = DecodeWorkerPool.prototype.resize;
  DecodeWorkerPool.prototype.resize = function(count) {
    const result = policyResize.call(this, count);
    if (count === 0 && this.workers.length === 0) stopState(this);
    return result;
  };

  installDiagnostics();
}

export { installTemporalBackpressure };
