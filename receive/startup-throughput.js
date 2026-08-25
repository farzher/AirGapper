import {
  decodeWallBroadlyHealthy,
  subscribeDecodeLatticeState
} from "./decode-health.js";

// Cold guided jobs are intentionally more expensive while worker-local WASM
// allocations, slot profiles and stable decode state are being learned. Letting
// that cold cost immediately drive the long-lived yield/cost budget teaches a
// fast phone that it is slow, then makes throughput ramp up over several seconds.
//
// For the first short window after a verified lattice lock, Auto mode therefore
// feeds the whole visible wall. Real worker saturation still provides natural
// backpressure, and after this lease expires the normal adaptive budget resumes
// with mostly warm measurements. This is internal only: no change event is fired
// and the user's saved tracks-per-frame preference is never rewritten.
const COLD_FULL_WALL_WARMUP_MS = 1600;
const PROVEN_FULL_WALL_WARMUP_MS = 2400;
const STARTUP_CAPACITY_PRIOR_KEY = "airgapper:startup-capacity-prior:v2";
const STARTUP_CAPACITY_PRIOR_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const STARTUP_CAPACITY_PRIOR_LIMIT = 8;
const hardwareThreads = Math.max(1, navigator.hardwareConcurrency || 2);
const control = document.getElementById("decode-tracks-per-frame");
const video = document.getElementById("video");
let warmupTimer = 0;
let restoreValue = "";
let activeProfileKey = "";
let consumedForLattice = false;

function currentCapacityProfileKey() {
  const track = video?.srcObject?.getVideoTracks?.()[0];
  const settings = track?.getSettings?.() ?? {};
  const id = String(settings.deviceId || track?.label || settings.facingMode || "default");
  const width = Math.max(0, Math.round(Number(settings.width) || 0));
  const height = Math.max(0, Math.round(Number(settings.height) || 0));
  const fps = Math.max(0, Math.round(Number(settings.frameRate) || 0));
  return `${id}|${width}x${height}@${fps}|t${hardwareThreads}`;
}

function readStartupCapacityPriors() {
  try {
    const saved = JSON.parse(localStorage.getItem(STARTUP_CAPACITY_PRIOR_KEY) || "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}

function hasProvenFullWallPrior(profileKey) {
  const saved = readStartupCapacityPriors()[profileKey];
  if (saved?.fullWall !== true) return false;
  const at = Number(saved.at);
  return Number.isFinite(at) && Date.now() - at <= STARTUP_CAPACITY_PRIOR_MAX_AGE_MS;
}

function rememberFullWallCapacity(profileKey) {
  if (!profileKey) return;
  try {
    const all = readStartupCapacityPriors();
    all[profileKey] = { fullWall: true, at: Date.now() };
    const entries = Object.entries(all)
      .filter(([, value]) => Date.now() - Number(value?.at || 0) <= STARTUP_CAPACITY_PRIOR_MAX_AGE_MS)
      .sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0))
      .slice(0, STARTUP_CAPACITY_PRIOR_LIMIT);
    localStorage.setItem(STARTUP_CAPACITY_PRIOR_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

function finishWarmup() {
  if (warmupTimer) clearTimeout(warmupTimer);
  warmupTimer = 0;
  const provedFullWall = Boolean(
    activeProfileKey && restoreValue && control?.value === "all" && decodeWallBroadlyHealthy()
  );
  const profileKey = activeProfileKey;
  activeProfileKey = "";
  if (control && restoreValue && control.value === "all") control.value = restoreValue;
  restoreValue = "";
  if (provedFullWall) rememberFullWallCapacity(profileKey);
}

function startWarmup() {
  if (!(control instanceof HTMLSelectElement) || consumedForLattice || warmupTimer) return;
  consumedForLattice = true;
  if (control.value !== "auto" || !Array.from(control.options).some((option) => option.value === "all")) return;
  activeProfileKey = currentCapacityProfileKey();
  restoreValue = control.value;
  control.value = "all";
  const duration = hasProvenFullWallPrior(activeProfileKey)
    ? PROVEN_FULL_WALL_WARMUP_MS
    : COLD_FULL_WALL_WARMUP_MS;
  warmupTimer = setTimeout(finishWarmup, duration);
}

control?.addEventListener("change", () => {
  // A real user choice made during the lease immediately wins and is never
  // overwritten when the warm-up timer expires.
  if (warmupTimer) clearTimeout(warmupTimer);
  warmupTimer = 0;
  restoreValue = "";
  activeProfileKey = "";
  consumedForLattice = true;
});

subscribeDecodeLatticeState((state) => {
  if (state === "SEARCH" || state === "REACQUIRE" || state === "DORMANT") {
    finishWarmup();
    consumedForLattice = false;
    return;
  }
  if (state === "GRID_LOCK" || state === "TRACK") startWarmup();
});
