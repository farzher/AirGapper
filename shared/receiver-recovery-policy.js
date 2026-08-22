import { FocusController } from "../receive/focus-controller.js";
import { GridLattice } from "../receive/grid-lattice.js";
import { DecodeWorkerPool } from "./worker-pool.js";
import {
  VERIFIED_QR_MAX_EXPOSURE,
  armWarmWorkerRestartSuppression,
  beginPoseRecovery,
  consumeWarmWorkerRestartSuppression,
  endPoseRecovery,
  latchVerifiedExposure,
  noteExposureMotion,
  noteSuppressedWorkerRestart,
  poseRecoveryReasonEligible,
  recoveryDiagnostics,
  rememberManualExposure,
  rememberedManualExposure,
  setExposureProtectionEnabled
} from "./receiver-recovery-state.js";

const SOFT_POSE_LOSS_MS = 450;
const STOCK_HARD_POSE_LOSS_MS = 900;
const LOW_COUNT_ONE_QR_HARD_LOSS_MS = 3500;
const LOW_COUNT_TWO_QR_HARD_LOSS_MS = 2500;
const LONG_AE_EXPOSURE = VERIFIED_QR_MAX_EXPOSURE;
const MOTION_SAFE_MAX_EXPOSURE = 45;
const LONG_AE_HANDOFF_COOLDOWN_MS = 2500;
const QR_LIGHT_SCALE = Math.pow(2, -0.75);
let installed = false;
let diagnosticObserver;
const lastLongAeHandoffAt = new WeakMap();
const longAeHandoffCounts = new WeakMap();
const longAeHandoffRunning = new WeakSet();
const verifiedFreezeRunning = new WeakSet();
const lowCountFinderEvidenceAt = new WeakMap();
let temporalStitchAttempts = 0;
let temporalStitchHits = 0;
let temporalStitchSampled = 0;
let temporalStitchSkipped = 0;
let temporalStitchLastSeam;
let temporalStitchLastOrientation = "";
let temporalStitchLastSourceDelta;

function resetTemporalDiagnostics() {
  temporalStitchAttempts = 0;
  temporalStitchHits = 0;
  temporalStitchSampled = 0;
  temporalStitchSkipped = 0;
  temporalStitchLastSeam = void 0;
  temporalStitchLastOrientation = "";
  temporalStitchLastSourceDelta = void 0;
}

function latticeSlotCount(lattice) {
  const layout = lattice?.candidate?.layout;
  const count = Number(layout?.cols) * Number(layout?.rows);
  return Number.isInteger(count) && count > 0 ? count : 0;
}

function lowCountHardLossMs(count) {
  if (count === 1) return LOW_COUNT_ONE_QR_HARD_LOSS_MS;
  if (count === 2) return LOW_COUNT_TWO_QR_HARD_LOSS_MS;
  return STOCK_HARD_POSE_LOSS_MS;
}

function installLatticeRecoveryBridge() {
  const originalReset = GridLattice.prototype.reset;
  const originalReacquire = GridLattice.prototype.reacquire;
  const originalInvalidatePose = GridLattice.prototype.invalidatePose;
  const originalAccept = GridLattice.prototype.accept;
  const originalNoteValidPacket = GridLattice.prototype.noteValidPacket;
  const originalTick = GridLattice.prototype.tick;
  const originalNudgeFromSightings = GridLattice.prototype.nudgeFromSightings;

  GridLattice.prototype.reset = function(...args) {
    endPoseRecovery();
    lowCountFinderEvidenceAt.delete(this);
    return originalReset.apply(this, args);
  };

  GridLattice.prototype.reacquire = function(at, reason = "whole lattice invalidated") {
    lowCountFinderEvidenceAt.delete(this);
    if (poseRecoveryReasonEligible(reason)) {
      beginPoseRecovery(reason);
      armWarmWorkerRestartSuppression();
    } else endPoseRecovery();
    return originalReacquire.call(this, at, reason);
  };

  GridLattice.prototype.invalidatePose = function(reason = "camera pose invalidated") {
    if (poseRecoveryReasonEligible(reason)) beginPoseRecovery(reason);
    return originalInvalidatePose.call(this, reason);
  };

  GridLattice.prototype.nudgeFromSightings = function(sightings, at = this.lastHitAt) {
    const result = originalNudgeFromSightings.call(this, sightings, at);
    const count = latticeSlotCount(this);
    if (result && count >= 1 && count <= 2) lowCountFinderEvidenceAt.set(this, at);
    return result;
  };

  GridLattice.prototype.tick = function(now) {
    const staleMs = this.candidate ? now - this.lastHitAt : 0;
    const count = latticeSlotCount(this);
    const lowCount = count >= 1 && count <= 2;
    const finderAt = lowCountFinderEvidenceAt.get(this) ?? -Infinity;
    const hardEvidenceAge = lowCount ? now - Math.max(this.lastHitAt, finderAt) : staleMs;
    const hardLimit = lowCountHardLossMs(count);
    let result;

    if (lowCount && this.candidate && !this.pendingInvalidationReason &&
        staleMs > STOCK_HARD_POSE_LOSS_MS && hardEvidenceAge <= hardLimit) {
      const actualLastHitAt = this.lastHitAt;
      this.lastHitAt = now - (STOCK_HARD_POSE_LOSS_MS - 1);
      try {
        result = originalTick.call(this, now);
      } finally {
        if (this.candidate) this.lastHitAt = actualLastHitAt;
      }
    } else {
      result = originalTick.call(this, now);
    }

    if (this.candidate && staleMs > SOFT_POSE_LOSS_MS && this.state === "PARTIAL_LOSS") {
      beginPoseRecovery(lowCount
        ? "whole lattice stale; low-count temporal salvage window"
        : "whole lattice stale; bounded QR re-anchor window");
    }
    return result;
  };

  GridLattice.prototype.accept = function(...args) {
    const result = originalAccept.apply(this, args);
    if (result && this.locked && recoveryDiagnostics().active) endPoseRecovery();
    return result;
  };

  GridLattice.prototype.noteValidPacket = function(...args) {
    const accepted = originalNoteValidPacket.apply(this, args);
    if (accepted && recoveryDiagnostics().active) endPoseRecovery();
    return accepted;
  };
}

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

function makeTemporalCompanion(pool) {
  if (typeof globalThis.Worker !== "function" || typeof globalThis.location === "undefined") {
    const worker = pool.create("temporal");
    if (worker) worker.__airgapperTemporalCompanion = true;
    return worker;
  }
  const file = temporalUsesScalarCodec()
    ? "../receive/worker-temporal.js?scalar=1"
    : "../receive/worker-temporal.js";
  const worker = new Worker(new URL(file, import.meta.url), { type: "module" });
  worker.__airgapperTemporalCompanion = true;
  return worker;
}

function noteTemporalMetrics(metrics) {
  if (!metrics) return;
  const attempts = Number(metrics.temporalStitchAttempts) || 0;
  const hits = Number(metrics.temporalStitchHits) || 0;
  const sampled = Number(metrics.temporalStitchSampled) || 0;
  const skipped = Number(metrics.temporalStitchSkipped) || 0;
  temporalStitchAttempts += attempts;
  temporalStitchHits += hits;
  temporalStitchSampled += sampled;
  temporalStitchSkipped += skipped;
  if (Number.isFinite(Number(metrics.temporalStitchSeam))) temporalStitchLastSeam = Number(metrics.temporalStitchSeam);
  if (metrics.temporalStitchOrientation) temporalStitchLastOrientation = String(metrics.temporalStitchOrientation);
  if (Number.isFinite(Number(metrics.temporalStitchSourceDelta))) temporalStitchLastSourceDelta = Number(metrics.temporalStitchSourceDelta);
}

function ensureTemporalCompanion(pool) {
  if (pool.__airgapperTemporalCompanion?.worker) return pool.__airgapperTemporalCompanion;
  const worker = makeTemporalCompanion(pool);
  if (!worker) return null;
  const state = { worker };
  pool.__airgapperTemporalCompanion = state;
  worker.onmessage = (event) => {
    if (pool.__airgapperTemporalCompanion !== state) return;
    const message = event.data;
    if (!message?.temporal) return;
    noteTemporalMetrics(message.guidedMetrics);
    for (const symbol of message.symbols ?? []) {
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
  };
  worker.onerror = () => {
    if (pool.__airgapperTemporalCompanion === state) pool.__airgapperTemporalCompanion = null;
    worker.terminate?.();
  };
  return state;
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

function mirrorLowCountFrame(pool, message) {
  const state = ensureTemporalCompanion(pool);
  if (!state?.worker) return;
  const frame = cloneTemporalFrame(message.videoFrame);
  if (!frame) return;
  const copy = { ...message, videoFrame: frame };
  try {
    state.worker.postMessage(copy, [frame]);
    pool.__airgapperTemporalLowCountActive = true;
  } catch {
    frame.close?.();
  }
}

function resetTemporalCompanion(pool) {
  if (!pool.__airgapperTemporalLowCountActive) return;
  pool.__airgapperTemporalLowCountActive = false;
  try { pool.__airgapperTemporalCompanion?.worker?.postMessage({ reset: true }); } catch {}
}

function stopTemporalCompanion(pool) {
  const state = pool.__airgapperTemporalCompanion;
  if (state?.worker) state.worker.terminate?.();
  pool.__airgapperTemporalCompanion = null;
  pool.__airgapperTemporalLowCountActive = false;
}

function installWarmWorkerRecovery() {
  const originalResize = DecodeWorkerPool.prototype.resize;
  const originalSubmit = DecodeWorkerPool.prototype.submit;
  const originalSubmitTo = DecodeWorkerPool.prototype.submitTo;

  DecodeWorkerPool.prototype.submit = function(message, transfer) {
    if (lowCountTemporalMessage(message)) mirrorLowCountFrame(this, message);
    else resetTemporalCompanion(this);
    return originalSubmit.call(this, message, transfer);
  };

  DecodeWorkerPool.prototype.submitTo = function(slot, message, transfer) {
    if (lowCountTemporalMessage(message)) mirrorLowCountFrame(this, message);
    else resetTemporalCompanion(this);
    return originalSubmitTo.call(this, slot, message, transfer);
  };

  DecodeWorkerPool.prototype.resize = function(count) {
    if (count === 0 && this.workers.length && consumeWarmWorkerRestartSuppression()) {
      this.__airgapperWarmRecovery = true;
      noteSuppressedWorkerRestart();
      return;
    }
    if (count > 0 && this.__airgapperWarmRecovery) {
      this.__airgapperWarmRecovery = false;
      if (this.workers.length === count) return;
    }
    const result = originalResize.call(this, count);
    if (count === 0) stopTemporalCompanion(this);
    return result;
  };
}

function quantize(value, range) {
  const clamped = Math.max(range.min, Math.min(range.max, value));
  if (!range.step || range.step <= 0) return clamped;
  return Math.max(range.min, Math.min(range.max,
    range.min + Math.round((clamped - range.min) / range.step) * range.step
  ));
}

async function freezeVerifiedShortExposure(controller, track) {
  if (!recoveryDiagnostics().exposureProtectionEnabled) return false;
  if (!track || track.readyState !== "live" || verifiedFreezeRunning.has(track)) return false;
  const settings = track.getSettings?.() ?? {};
  const exposure = Number(settings.exposureTime);
  const iso = Number(settings.iso);
  if (!(exposure > 0) || exposure > VERIFIED_QR_MAX_EXPOSURE || !(iso > 0)) return false;
  const caps = track.getCapabilities?.() ?? {};
  if (!Array.isArray(caps.exposureMode) || !caps.exposureMode.includes("manual") || !caps.exposureTime || !caps.iso) return false;

  verifiedFreezeRunning.add(track);
  try {
    let actual = settings;
    if (settings.exposureMode !== "manual") {
      const frozenExposure = quantize(exposure, caps.exposureTime);
      const frozenIso = quantize(iso, caps.iso);
      await track.applyConstraints({ advanced: [{
        exposureMode: "manual",
        exposureTime: frozenExposure,
        iso: frozenIso
      }] });
      actual = track.getSettings?.() ?? {
        ...settings,
        exposureMode: "manual",
        exposureTime: frozenExposure,
        iso: frozenIso
      };
    }
    const finalExposure = Number(actual.exposureTime);
    const finalIso = Number(actual.iso);
    if (!(finalExposure > 0) || finalExposure > VERIFIED_QR_MAX_EXPOSURE || !(finalIso > 0)) return false;

    const proven = {
      ...actual,
      exposureMode: "manual",
      exposureTime: finalExposure,
      iso: finalIso
    };
    rememberManualExposure(track, proven);
    latchVerifiedExposure(track, proven);
    controller?.commitSettings?.(proven);
    if (controller) {
      controller.optimizeLearnedExposure = finalExposure;
      controller.optimizeLearnedIso = finalIso;
    }
    return true;
  } catch {
    return false;
  } finally {
    verifiedFreezeRunning.delete(track);
  }
}

async function handOffLongAe(track) {
  if (!recoveryDiagnostics().exposureProtectionEnabled) return;
  if (!track || track.readyState !== "live" || longAeHandoffRunning.has(track)) return;
  const now = performance.now();
  if (now - (lastLongAeHandoffAt.get(track) ?? -Infinity) < LONG_AE_HANDOFF_COOLDOWN_MS) return;
  const settings = track.getSettings?.() ?? {};
  const exposure = Number(settings.exposureTime);
  const iso = Number(settings.iso);
  if (!(exposure > LONG_AE_EXPOSURE) || !(iso > 0)) return;
  const caps = track.getCapabilities?.() ?? {};
  const exposureRange = caps.exposureTime;
  const isoRange = caps.iso;
  if (!Array.isArray(caps.exposureMode) || !caps.exposureMode.includes("manual") || !exposureRange || !isoRange) return;

  longAeHandoffRunning.add(track);
  lastLongAeHandoffAt.set(track, now);
  try {
    const prior = rememberedManualExposure(track);
    const fps = Math.max(12, Math.min(120, Number(settings.frameRate) || 30));
    const targetProduct = prior
      ? prior.exposure * prior.iso
      : exposure * iso * QR_LIGHT_SCALE;
    const exposureCeiling = prior
      ? Math.min(LONG_AE_EXPOSURE, prior.exposure)
      : MOTION_SAFE_MAX_EXPOSURE;
    const shortExposure = quantize(
      Math.min(exposureRange.max, exposureCeiling, 1e4 / fps * (prior ? 0.18 : 0.10)),
      exposureRange
    );
    const shortIso = quantize(
      Math.max(isoRange.min, Math.min(isoRange.max, targetProduct / Math.max(exposureRange.min, shortExposure))),
      isoRange
    );
    await track.applyConstraints({ advanced: [{
      exposureMode: "manual",
      exposureTime: shortExposure,
      iso: shortIso
    }] });
    longAeHandoffCounts.set(track, (longAeHandoffCounts.get(track) ?? 0) + 1);
  } catch {
    lastLongAeHandoffAt.delete(track);
  } finally {
    longAeHandoffRunning.delete(track);
  }
}

function geometryMoved(a, b) {
  if (!a || !b) return false;
  const center = Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y));
  const scaleA = Number(a.scale);
  const scaleB = Number(b.scale);
  const scale = scaleA > 0 && scaleB > 0 ? Math.abs(Math.log2(scaleA / scaleB)) : 0;
  const perspective = Math.max(
    Math.abs(Number(a.perspectiveX ?? 0) - Number(b.perspectiveX ?? 0)),
    Math.abs(Number(a.perspectiveY ?? 0) - Number(b.perspectiveY ?? 0))
  );
  return center > 0.015 || scale > 0.04 || perspective > 0.04;
}

function installGeometryMotionBridge() {
  const originalObserve = FocusController.prototype.observe;
  FocusController.prototype.observe = function(id, geometry, ...args) {
    const previous = this.latest?.geometry;
    if (this.track && geometryMoved(geometry, previous)) noteExposureMotion(this.track);
    return originalObserve.call(this, id, geometry, ...args);
  };
}

function installVerifiedDecodeBridge() {
  const originalAttach = FocusController.prototype.attach;
  const originalNoteValidDecode = FocusController.prototype.noteValidDecode;
  FocusController.prototype.attach = function(...args) {
    resetTemporalDiagnostics();
    return originalAttach.apply(this, args);
  };
  FocusController.prototype.noteValidDecode = function(...args) {
    const result = originalNoteValidDecode.apply(this, args);
    const track = this.track;
    if (track) {
      rememberManualExposure(track);
      const controller = this;
      queueMicrotask(async () => {
        if (await freezeVerifiedShortExposure(controller, track)) return;
        if (!recoveryDiagnostics().active) await handOffLongAe(track);
      });
    }
    return result;
  };
}

function currentBrowserTrack() {
  if (typeof document === "undefined") return void 0;
  const source = document.getElementById("video")?.srcObject;
  return source?.getVideoTracks?.().find((item) => item.readyState === "live");
}

function installAutomaticOpticsToggleBridge() {
  if (typeof document === "undefined") return;
  const toggle = document.getElementById("camera-exposure-auto");
  if (!toggle) return;
  const sync = () => setExposureProtectionEnabled(Boolean(toggle.checked));
  toggle.addEventListener("change", sync);
  sync();
}

function installDiagnosticPolicy() {
  if (typeof document === "undefined") return;
  const focus = document.getElementById("focus-diagnostics");
  if (!focus) return;
  let mutating = false;
  const sync = () => {
    if (mutating) return;
    const original = focus.textContent || "";
    const state = recoveryDiagnostics();
    const track = currentBrowserTrack();
    const handoffs = track ? longAeHandoffCounts.get(track) ?? 0 : 0;
    let next = original;
    next = next.replace(/exposure writes (\d+)/, (_, raw) =>
      `exposure requests ${raw}${state.suppressedExposureWrites ? ` · sensor holds ${state.suppressedExposureWrites}` : ""}`
    );
    next = next.replace(/worker restarts (\d+)/, (_, raw) =>
      `worker restart requests ${raw}${state.suppressedWorkerRestarts ? ` · warm keeps ${state.suppressedWorkerRestarts}` : ""}`
    );
    next = next.replace(/ · long-AE handoffs \d+/g, "");
    next = next.replace(/ · QR latch [^·\n]+/g, "");
    next = next.replace(/ · exposure rescues \d+/g, "");
    next = next.replace(/ · stitch \d+\/\d+(?: sampled \d+)?(?: · seam [^\n]+)?/g, "");
    const annotations = [];
    if (handoffs) annotations.push(`long-AE handoffs ${handoffs}`);
    if (state.verifiedExposure) {
      annotations.push(`QR latch ${(state.verifiedExposure.exposure / 10).toFixed(2)} ms/ISO ${Math.round(state.verifiedExposure.iso)}`);
    }
    if (state.exposureRescueCount) annotations.push(`exposure rescues ${state.exposureRescueCount}`);
    if (annotations.length) {
      next = next.replace(/AutoOptics ([^\n]+)/, (line) => `${line} · ${annotations.join(" · ")}`);
    }
    if (temporalStitchAttempts || temporalStitchSampled) {
      const seam = temporalStitchLastSeam === void 0 ? "" :
        ` · seam ${temporalStitchLastSeam}${temporalStitchLastOrientation ? ` ${temporalStitchLastOrientation}` : ""}${temporalStitchLastSourceDelta ? ` Δ${temporalStitchLastSourceDelta}` : ""}`;
      next = next.replace(/Recovery ([^\n]+)/, (line) =>
        `${line} · stitch ${temporalStitchHits}/${temporalStitchAttempts} sampled ${temporalStitchSampled}${temporalStitchSkipped ? ` skip ${temporalStitchSkipped}` : ""}${seam}`
      );
    }
    if (next !== original) {
      mutating = true;
      focus.textContent = next;
      mutating = false;
    }
  };
  diagnosticObserver = new MutationObserver(sync);
  diagnosticObserver.observe(focus, { childList: true, characterData: true, subtree: true });
  sync();
}

function installReceiverRecoveryPolicy() {
  if (installed) return;
  installed = true;
  installLatticeRecoveryBridge();
  installWarmWorkerRecovery();
  installGeometryMotionBridge();
  installVerifiedDecodeBridge();
  installAutomaticOpticsToggleBridge();
  installDiagnosticPolicy();
}

export { installReceiverRecoveryPolicy };