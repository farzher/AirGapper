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
const STARTUP_CAPACITY_PRIOR_KEY = "airgapper:startup-capacity-prior:v1";
const STARTUP_CAPACITY_PRIOR_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const hardwareThreads = Math.max(1, navigator.hardwareConcurrency || 2);
const control = document.getElementById("decode-tracks-per-frame");
let warmupTimer = 0;
let restoreValue = "";
let consumedForLattice = false;

function readStartupCapacityPrior() {
  try {
    const saved = JSON.parse(localStorage.getItem(STARTUP_CAPACITY_PRIOR_KEY) || "null");
    if (saved?.fullWall !== true || Number(saved.threads) !== hardwareThreads) return false;
    const at = Number(saved.at);
    return Number.isFinite(at) && Date.now() - at <= STARTUP_CAPACITY_PRIOR_MAX_AGE_MS;
  } catch {
    return false;
  }
}

let provenFullWallPrior = readStartupCapacityPrior();

function rememberFullWallCapacity() {
  provenFullWallPrior = true;
  try {
    localStorage.setItem(STARTUP_CAPACITY_PRIOR_KEY, JSON.stringify({
      fullWall: true,
      threads: hardwareThreads,
      at: Date.now()
    }));
  } catch {}
}

function finishWarmup() {
  if (warmupTimer) clearTimeout(warmupTimer);
  warmupTimer = 0;
  const provedFullWall = Boolean(
    restoreValue && control?.value === "all" && decodeWallBroadlyHealthy()
  );
  if (control && restoreValue && control.value === "all") control.value = restoreValue;
  restoreValue = "";
  if (provedFullWall) rememberFullWallCapacity();
}

function startWarmup() {
  if (!(control instanceof HTMLSelectElement) || consumedForLattice || warmupTimer) return;
  consumedForLattice = true;
  if (control.value !== "auto" || !Array.from(control.options).some((option) => option.value === "all")) return;
  restoreValue = control.value;
  control.value = "all";
  const duration = provenFullWallPrior ? PROVEN_FULL_WALL_WARMUP_MS : COLD_FULL_WALL_WARMUP_MS;
  warmupTimer = setTimeout(finishWarmup, duration);
}

control?.addEventListener("change", () => {
  // A real user choice made during the lease immediately wins and is never
  // overwritten when the warm-up timer expires.
  if (warmupTimer) clearTimeout(warmupTimer);
  warmupTimer = 0;
  restoreValue = "";
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
