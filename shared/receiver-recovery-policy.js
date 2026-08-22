import { FocusController } from "../receive/focus-controller.js";
import { GridLattice } from "../receive/grid-lattice.js";
import { DecodeWorkerPool } from "./worker-pool.js";
import {
  armWarmWorkerRestartSuppression,
  beginPoseRecovery,
  consumeWarmWorkerRestartSuppression,
  endPoseRecovery,
  noteSuppressedWorkerRestart,
  poseRecoveryReasonEligible,
  recoveryDiagnostics,
  rememberManualExposure,
  rememberedManualExposure,
  setExposureProtectionEnabled
} from "./receiver-recovery-state.js";

const SOFT_POSE_LOSS_MS = 450;
const LONG_AE_EXPOSURE = 50; // 5.0 ms hard QR shutter ceiling; units are 0.1 ms.
const MOTION_SAFE_MAX_EXPOSURE = 45; // 4.5 ms first deterministic clamp when no proven state exists.
const LONG_AE_HANDOFF_COOLDOWN_MS = 2500;
const QR_LIGHT_SCALE = Math.pow(2, -0.75);
let installed = false;
let diagnosticObserver;
const lastLongAeHandoffAt = new WeakMap();
const longAeHandoffCounts = new WeakMap();
const longAeHandoffRunning = new WeakSet();

function installLatticeRecoveryBridge() {
  const originalReset = GridLattice.prototype.reset;
  const originalReacquire = GridLattice.prototype.reacquire;
  const originalInvalidatePose = GridLattice.prototype.invalidatePose;
  const originalAccept = GridLattice.prototype.accept;
  const originalNoteValidPacket = GridLattice.prototype.noteValidPacket;
  const originalTick = GridLattice.prototype.tick;

  GridLattice.prototype.reset = function(...args) {
    endPoseRecovery();
    return originalReset.apply(this, args);
  };

  GridLattice.prototype.reacquire = function(at, reason = "whole lattice invalidated") {
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

  GridLattice.prototype.tick = function(now) {
    const staleMs = this.candidate ? now - this.lastHitAt : 0;
    const result = originalTick.call(this, now);
    if (this.candidate && staleMs > SOFT_POSE_LOSS_MS && this.state === "PARTIAL_LOSS") {
      beginPoseRecovery("whole lattice stale; bounded QR re-anchor window");
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

function installWarmWorkerRecovery() {
  const originalResize = DecodeWorkerPool.prototype.resize;
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
    return originalResize.call(this, count);
  };
}

function quantize(value, range) {
  const clamped = Math.max(range.min, Math.min(range.max, value));
  if (!range.step || range.step <= 0) return clamped;
  return Math.max(range.min, Math.min(range.max,
    range.min + Math.round((clamped - range.min) / range.step) * range.step
  ));
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
    // This handoff is only a candidate until another verified QR proves it.
    longAeHandoffCounts.set(track, (longAeHandoffCounts.get(track) ?? 0) + 1);
  } catch {
    lastLongAeHandoffAt.delete(track);
  } finally {
    longAeHandoffRunning.delete(track);
  }
}

function installVerifiedDecodeBridge() {
  const originalNoteValidDecode = FocusController.prototype.noteValidDecode;
  FocusController.prototype.noteValidDecode = function(...args) {
    const result = originalNoteValidDecode.apply(this, args);
    const track = this.track;
    if (track) {
      // Only a CRC-verified QR promotes the current manual sensor state to the
      // recovery prior. Speculative manual probes are never remembered as good.
      rememberManualExposure(track);
      // Let the rest of this synchronous decode path re-anchor GridLattice first.
      queueMicrotask(() => {
        if (!recoveryDiagnostics().active) void handOffLongAe(track);
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
    if (handoffs) {
      next = next.replace(/AutoOptics ([^\n]+)/, (line) => `${line} · long-AE handoffs ${handoffs}`);
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
  installVerifiedDecodeBridge();
  installAutomaticOpticsToggleBridge();
  installDiagnosticPolicy();
}

export { installReceiverRecoveryPolicy };
