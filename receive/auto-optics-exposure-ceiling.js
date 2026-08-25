// Auto Optics may briefly use hardware AE as a light meter, but an animated
// QR wall must never remain on a long photographic shutter. The proven
// production policy (v0.5.369/v0.5.370) capped QR exposure at <=5 ms and
// compensated with ISO. Newer AE-rescue code can otherwise leave some Android
// cameras at 60 ms indefinitely when EV compensation is ignored.
const MAX_QR_EXPOSURE = 50; // 5 ms; MediaTrack exposureTime uses 0.1 ms units.
const AE_DWELL_MS = 700;
const RETRY_MS = 220;
const pending = new WeakMap();

function autoOpticsEnabled() {
  const input = document.getElementById("camera-exposure-auto");
  return !input || input.checked;
}

function activeTrackIs(track) {
  return document.getElementById("video")?.srcObject?.getVideoTracks?.()[0] === track;
}

function quantize(value, range) {
  if (!range || !Number.isFinite(value)) return value;
  const min = Number(range.min);
  const max = Number(range.max);
  const step = Number(range.step) || 0;
  let next = Math.max(min, Math.min(max, value));
  if (step > 0) next = min + Math.round((next - min) / step) * step;
  return Math.max(min, Math.min(max, next));
}

async function enforceQrCeiling(track) {
  if (!autoOpticsEnabled() || !activeTrackIs(track) || track.readyState !== "live") return;
  const settings = track.getSettings?.() ?? {};
  const exposure = Number(settings.exposureTime);
  const iso = Number(settings.iso);
  if (!(exposure > MAX_QR_EXPOSURE) || !(iso > 0)) return;

  const caps = track.getCapabilities?.() ?? {};
  if (!Array.isArray(caps.exposureMode) || !caps.exposureMode.includes("manual") || !caps.exposureTime || !caps.iso) return;

  const targetExposure = quantize(Math.min(MAX_QR_EXPOSURE, exposure), caps.exposureTime);
  // Preserve the AE light product as closely as the sensor permits, but spend
  // it on gain rather than motion blur.
  const targetIso = quantize(iso * exposure / Math.max(targetExposure, 1e-6), caps.iso);
  try {
    await track.applyConstraints({ advanced: [{
      exposureMode: "manual",
      exposureTime: targetExposure,
      iso: targetIso
    }] });
  } catch {
    return;
  }

  // A few Android camera stacks acknowledge a sensor write before it appears
  // in getSettings(). Retry once, bounded, and never touch focus.
  await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  if (!autoOpticsEnabled() || !activeTrackIs(track) || track.readyState !== "live") return;
  const after = track.getSettings?.() ?? {};
  if (Number(after.exposureTime) <= MAX_QR_EXPOSURE) return;
  try {
    await track.applyConstraints({ advanced: [{
      exposureMode: "manual",
      exposureTime: targetExposure,
      iso: targetIso
    }] });
  } catch {}
}

function scheduleCeiling(track) {
  clearTimeout(pending.get(track));
  const timer = setTimeout(() => {
    pending.delete(track);
    void enforceQrCeiling(track);
  }, AE_DWELL_MS);
  pending.set(track, timer);
}

const proto = globalThis.MediaStreamTrack?.prototype;
const priorApply = proto?.applyConstraints;
if (typeof priorApply === "function" && !priorApply.__airgapperQrExposureCeiling) {
  const guardedApply = function(constraints) {
    const requestedContinuous = constraints?.exposureMode === "continuous" ||
      constraints?.advanced?.some?.((entry) => entry?.exposureMode === "continuous");
    const result = priorApply.call(this, constraints);
    if (requestedContinuous) Promise.resolve(result).finally(() => scheduleCeiling(this));
    return result;
  };
  Object.defineProperty(guardedApply, "__airgapperQrExposureCeiling", { value: true });
  try { proto.applyConstraints = guardedApply; } catch {}
}
