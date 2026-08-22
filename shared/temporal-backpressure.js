import { DecodeWorkerPool } from "./worker-pool.js";
import { parseFrame } from "./protocol.js";

const MAX_TEMPORAL_JOBS = 4;
const SAMPLE_TIMEOUT_MS = 1500;
const RECOVER_TIMEOUT_MS = 3000;
const RESET_TIMEOUT_MS = 1000;
let installed = false;

const diagnostics = {
  sampled: 0,
  dropped: 0,
  recoveryAttempts: 0,
  recoveryHits: 0,
  companionRestarts: 0
};

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

function createCompanion(pool) {
  if (typeof globalThis.Worker !== "function" || typeof globalThis.location === "undefined") {
    return pool.create("temporal-v2");
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

function clearCommandTimer(state) {
  clearTimeout(state.commandTimer);
  state.commandTimer = void 0;
}

function stopCompanion(pool, state = pool.__airgapperTemporalV2) {
  if (!state) return;
  clearCommandTimer(state);
  try { state.worker?.terminate?.(); } catch {}
  state.jobs.clear();
  state.busy = false;
  state.busyToken = void 0;
  if (pool.__airgapperTemporalV2 === state) pool.__airgapperTemporalV2 = null;
}

function timeoutFor(action) {
  if (action === "recover") return RECOVER_TIMEOUT_MS;
  if (action === "reset") return RESET_TIMEOUT_MS;
  return SAMPLE_TIMEOUT_MS;
}

function postCommand(pool, state, payload, transfer) {
  if (state.busy || pool.__airgapperTemporalV2 !== state) return false;
  const token = ++state.commandToken;
  const command = { ...payload, token, generation: state.generation };
  state.busy = true;
  state.busyToken = token;
  try {
    state.worker.postMessage(command, transfer ?? []);
  } catch {
    state.busy = false;
    state.busyToken = void 0;
    clearCommandTimer(state);
    return false;
  }
  clearCommandTimer(state);
  state.commandTimer = setTimeout(() => {
    if (pool.__airgapperTemporalV2 !== state || state.busyToken !== token) return;
    diagnostics.companionRestarts++;
    stopCompanion(pool, state);
  }, timeoutFor(payload.action));
  return true;
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

function serviceCompanion(pool, state) {
  if (pool.__airgapperTemporalV2 !== state || state.busy) return;
  if (state.resetPending) {
    if (postCommand(pool, state, { action: "reset" })) return;
  }

  for (const [id, job] of state.jobs) {
    if (!job.sampleDone || !job.normalDone) continue;
    if (!job.missingSlots?.length) {
      state.jobs.delete(id);
      continue;
    }
    if (job.recoverRequested) continue;
    job.recoverRequested = true;
    if (postCommand(pool, state, {
      action: "recover",
      id,
      sourceSequence: job.sourceSequence,
      missingSlots: job.missingSlots
    })) return;
    job.recoverRequested = false;
  }
}

function installCompletionHook(pool) {
  if (pool.__airgapperTemporalCompletionHook) return;
  pool.__airgapperTemporalCompletionHook = true;
  const originalCompleted = pool.onCompleted;
  pool.onCompleted = (id, completion) => {
    const state = pool.__airgapperTemporalV2;
    const job = state?.jobs.get(id);
    if (job) {
      job.normalDone = true;
      const decoded = completedSlots(completion);
      job.missingSlots = job.expectedSlots.filter((slot) => !decoded.has(slot));
      serviceCompanion(pool, state);
    }
    return originalCompleted?.(id, completion);
  };
}

function ensureCompanion(pool) {
  const existing = pool.__airgapperTemporalV2;
  if (existing?.worker) return existing;
  const worker = createCompanion(pool);
  if (!worker) return null;
  const state = {
    worker,
    busy: false,
    busyToken: void 0,
    commandToken: 0,
    commandTimer: void 0,
    generation: 1,
    resetPending: false,
    lowCountActive: false,
    jobs: new Map()
  };
  pool.__airgapperTemporalV2 = state;
  installCompletionHook(pool);

  worker.onmessage = (event) => {
    if (pool.__airgapperTemporalV2 !== state) return;
    const message = event.data;
    if (!message?.temporalV2) return;

    if (state.busyToken === message.token) {
      clearCommandTimer(state);
      state.busy = false;
      state.busyToken = void 0;
    }

    if (message.generation !== state.generation) {
      serviceCompanion(pool, state);
      return;
    }

    const metrics = message.guidedMetrics ?? {};
    diagnostics.sampled += Number(metrics.temporalStitchSampled) || 0;
    diagnostics.recoveryAttempts += Number(metrics.temporalStitchAttempts) || 0;
    diagnostics.recoveryHits += Number(metrics.temporalStitchHits) || 0;

    if (message.phase === "reset") {
      state.resetPending = false;
      serviceCompanion(pool, state);
      return;
    }

    const job = state.jobs.get(message.id);
    if (!job) {
      serviceCompanion(pool, state);
      return;
    }

    if (message.phase === "sample") {
      job.sampleDone = true;
    } else if (message.phase === "recover") {
      injectRecovered(pool, message);
      state.jobs.delete(message.id);
    }
    serviceCompanion(pool, state);
  };

  worker.onerror = () => {
    diagnostics.companionRestarts++;
    stopCompanion(pool, state);
  };
  return state;
}

function cleanupJobs(state) {
  const now = performance.now();
  for (const [id, job] of state.jobs) {
    if (now - job.createdAt > 4000 && !job.recoverRequested) state.jobs.delete(id);
  }
}

function mirrorLowCountFrame(pool, message) {
  const state = ensureCompanion(pool);
  if (!state?.worker) return;
  state.lowCountActive = true;
  cleanupJobs(state);
  serviceCompanion(pool, state);

  // Hard backpressure: never clone/retain another camera frame while the
  // companion has any sample/recovery/reset command in flight. Temporal work is
  // optional; dropping its copy is always preferable to queuing camera frames.
  if (state.busy || state.resetPending || state.jobs.size >= MAX_TEMPORAL_JOBS) {
    diagnostics.dropped++;
    return;
  }

  const slots = expectedSlots(message);
  if (!slots.length) return;
  const frame = cloneTemporalFrame(message.videoFrame);
  if (!frame) return;

  const job = {
    id: message.id,
    sourceSequence: message.sourceSequence,
    expectedSlots: slots,
    missingSlots: [],
    sampleDone: false,
    normalDone: false,
    recoverRequested: false,
    createdAt: performance.now()
  };
  state.jobs.set(message.id, job);
  const copy = {
    ...message,
    action: "sample",
    videoFrame: frame
  };
  if (!postCommand(pool, state, copy, [frame])) {
    state.jobs.delete(message.id);
    try { frame.close?.(); } catch {}
  }
}

function resetCompanion(pool) {
  const state = pool.__airgapperTemporalV2;
  if (!state?.worker || (!state.lowCountActive && !state.jobs.size)) return;
  state.lowCountActive = false;
  state.generation++;
  state.jobs.clear();
  state.resetPending = true;
  serviceCompanion(pool, state);
}

function installDiagnostics() {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  const target = document.getElementById("focus-diagnostics");
  if (!target) return;
  let mutating = false;
  const sync = () => {
    if (mutating) return;
    const original = target.textContent || "";
    let next = original.replace(/ · temporal sample \d+ drop \d+ recover \d+\/\d+(?: restart \d+)?/g, "");
    if (diagnostics.sampled || diagnostics.dropped || diagnostics.recoveryAttempts || diagnostics.companionRestarts) {
      const suffix = ` · temporal sample ${diagnostics.sampled} drop ${diagnostics.dropped} recover ${diagnostics.recoveryHits}/${diagnostics.recoveryAttempts}${diagnostics.companionRestarts ? ` restart ${diagnostics.companionRestarts}` : ""}`;
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

  // receiver-recovery-policy installs first and wraps submit/submitTo to mirror
  // every low-count frame. Replace only those two methods with the base pool
  // scheduling semantics plus the bounded v2 companion. The policy's resize
  // wrapper (warm-worker recovery) remains intact.
  DecodeWorkerPool.prototype.submit = function(message, transfer) {
    if (lowCountTemporalMessage(message)) mirrorLowCountFrame(this, message);
    else resetCompanion(this);
    const slot = this.busy.indexOf(false);
    return slot !== -1 && this.submitAtSlot(slot, message, transfer);
  };

  DecodeWorkerPool.prototype.submitTo = function(slot, message, transfer) {
    if (lowCountTemporalMessage(message)) mirrorLowCountFrame(this, message);
    else resetCompanion(this);
    return Number.isInteger(slot) && this.submitAtSlot(slot, message, transfer);
  };

  const policyResize = DecodeWorkerPool.prototype.resize;
  DecodeWorkerPool.prototype.resize = function(count) {
    const result = policyResize.call(this, count);
    if (count === 0 && this.workers.length === 0) stopCompanion(this);
    return result;
  };

  installDiagnostics();
}

export { installTemporalBackpressure };
