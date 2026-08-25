import { applyAdvancedConstraint } from "./camera-constraints.js";

const STORAGE_KEY = "airgapper:exposure-ev:v1";
const DEFAULT_QR_EV = -0.8;

const video = document.getElementById("video");
const autoToggle = document.getElementById("camera-exposure-auto");
const anchor = document.getElementById("camera-exposure-control");

let savedEv;
try {
  const value = Number(localStorage.getItem(STORAGE_KEY));
  if (Number.isFinite(value)) savedEv = value;
} catch {}

const control = document.createElement("div");
control.id = "camera-ev-control";
control.className = "axis-control";
control.hidden = true;
control.innerHTML = '<span class="axis-heading"><span>EV</span><output id="camera-ev-value"></output></span><input id="camera-ev" type="range" min="-2" max="2" step="0.1" value="0" aria-label="Exposure compensation" />';
anchor?.after(control);

const slider = control.querySelector("#camera-ev");
const output = control.querySelector("#camera-ev-value");
let boundTrack;
let applyGeneration = 0;

function activeTrack() {
  return video?.srcObject?.getVideoTracks?.()[0];
}

function rangeFor(track) {
  const range = track?.getCapabilities?.()?.exposureCompensation;
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.max < range.min) return;
  return {
    min: Number(range.min),
    max: Number(range.max),
    step: Number.isFinite(range.step) && range.step > 0 ? Number(range.step) : 0.1
  };
}

function quantize(value, range) {
  const clamped = Math.max(range.min, Math.min(range.max, Number(value)));
  const steps = Math.round((clamped - range.min) / range.step);
  return Math.max(range.min, Math.min(range.max, range.min + steps * range.step));
}

function manualExposureAvailable(track) {
  const caps = track?.getCapabilities?.() ?? {};
  const modes = Array.isArray(caps.exposureMode) ? caps.exposureMode : [];
  return modes.includes("manual") && Boolean(caps.exposureTime) && Boolean(caps.iso);
}

function formatEv(value) {
  const n = Number(value) || 0;
  return `${n > 0 ? "+" : ""}${Number(n.toFixed(2))} EV`;
}

function syncControl(track = activeTrack()) {
  const range = rangeFor(track);
  // EV is the fallback exposure control. If the browser exposes real shutter
  // time + ISO, those controls are clearer and more deterministic for QR work.
  if (!track || track.readyState !== "live" || !range || manualExposureAvailable(track)) {
    control.hidden = true;
    slider.disabled = true;
    boundTrack = void 0;
    return;
  }

  const changedTrack = boundTrack !== track;
  boundTrack = track;
  control.hidden = false;
  slider.disabled = false;
  slider.min = String(range.min);
  slider.max = String(range.max);
  slider.step = String(range.step);

  if (changedTrack) {
    const actual = Number(track.getSettings?.().exposureCompensation);
    const preferred = savedEv ?? (autoToggle?.checked ? DEFAULT_QR_EV : Number.isFinite(actual) ? actual : DEFAULT_QR_EV);
    slider.value = String(quantize(preferred, range));
  }

  control.title = "Exposure compensation";
  output.value = formatEv(slider.value);
  output.textContent = output.value;
}

async function applyCurrentEv(track = activeTrack()) {
  syncControl(track);
  const range = rangeFor(track);
  if (!track || track.readyState !== "live" || !range || slider.disabled) return false;
  const generation = ++applyGeneration;
  const value = quantize(slider.value, range);
  slider.value = String(value);
  output.value = formatEv(value);
  output.textContent = output.value;
  savedEv = value;
  try { localStorage.setItem(STORAGE_KEY, String(value)); } catch {}
  // Explicit user EV changes outrank Auto Optics' healthy-scan mutation lease.
  // Automatic controller writes still go through the protected default path.
  const accepted = await applyAdvancedConstraint(
    track,
    { exposureCompensation: value },
    { allowHealthyPerturbation: true }
  );
  return generation === applyGeneration && accepted;
}

function syncFreshCamera() {
  const track = activeTrack();
  syncControl(track);
  if (!track || track.readyState !== "live" || !rangeFor(track) || manualExposureAvailable(track)) return;

  // Devices without native shutter+ISO get a darker QR-specific AE bias.
  void applyCurrentEv(track);
}

slider?.addEventListener("input", () => {
  output.value = formatEv(slider.value);
  output.textContent = output.value;
});
slider?.addEventListener("change", () => void applyCurrentEv());

autoToggle?.addEventListener("change", () => {
  syncControl();
  // Manual -> Auto may deliberately reopen the camera. Do not mutate the old
  // track here; loadedmetadata/playing will apply EV to the replacement track.
  if (autoToggle.checked) setTimeout(syncFreshCamera, 350);
  else setTimeout(syncFreshCamera, 0);
});

video?.addEventListener("loadedmetadata", syncFreshCamera);
video?.addEventListener("playing", syncFreshCamera);
window.addEventListener("airgapper:resume-mode", () => setTimeout(syncFreshCamera, 250));

syncControl();
