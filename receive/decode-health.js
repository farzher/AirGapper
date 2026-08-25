const SLOT_CAPACITY = 128;
const EVENT_CAPACITY = 1024;
const HEALTH_WINDOW_MS = 800;
const HEALTH_FRESH_MS = 250;

const slotSuccessAt = new Float64Array(SLOT_CAPACITY);
const eventSuccessAt = new Float64Array(EVENT_CAPACITY);
let eventWrite = 0;
let eventCount = 0;
let lastSuccessAt = 0;
let latticeState = "SEARCH";
let geometrySlotCount = 0;
let distributedGeometry = false;

function clearRecentDecodeHealth() {
  slotSuccessAt.fill(0);
  eventSuccessAt.fill(0);
  eventWrite = 0;
  eventCount = 0;
  lastSuccessAt = 0;
}

export function noteDecodeSuccess(slot, at = performance.now()) {
  const index = Number(slot);
  if (Number.isInteger(index) && index >= 0 && index < SLOT_CAPACITY) slotSuccessAt[index] = at;
  eventSuccessAt[eventWrite] = at;
  eventWrite = (eventWrite + 1) % EVENT_CAPACITY;
  eventCount = Math.min(EVENT_CAPACITY, eventCount + 1);
  lastSuccessAt = at;
}

export function noteDecodeGeometry(snapshot, usable) {
  const slots = snapshot?.slots;
  geometrySlotCount = Array.isArray(slots) ? Math.min(SLOT_CAPACITY, slots.length) : 0;
  distributedGeometry = Boolean(usable && snapshot?.distributedFit);
}

export function noteDecodeLatticeState(state) {
  latticeState = String(state || "SEARCH");
  if (latticeState === "SEARCH" || latticeState === "REACQUIRE" || latticeState === "DORMANT") {
    distributedGeometry = false;
    geometrySlotCount = 0;
    clearRecentDecodeHealth();
  }
}

export function resetDecodeHealth() {
  latticeState = "SEARCH";
  distributedGeometry = false;
  geometrySlotCount = 0;
  clearRecentDecodeHealth();
}

function recentEventCount(cutoff) {
  let count = 0;
  for (let index = 0; index < eventCount; index++) {
    if (eventSuccessAt[index] >= cutoff) count++;
  }
  return count;
}

function recentSlotCount(cutoff) {
  let count = 0;
  for (let index = 0; index < SLOT_CAPACITY; index++) {
    const at = slotSuccessAt[index];
    if (at > 0 && at >= cutoff) count++;
  }
  return count;
}

export function decodeExposureHealthy(at = performance.now()) {
  if (latticeState !== "TRACK" || !distributedGeometry || !geometrySlotCount) return false;
  if (!lastSuccessAt || at - lastSuccessAt > HEALTH_FRESH_MS) return false;

  const cutoff = at - HEALTH_WINDOW_MS;
  const knownSlots = Math.max(1, geometrySlotCount);
  const requiredSlots = knownSlots <= 2
    ? knownSlots
    : Math.min(6, Math.max(2, Math.ceil(knownSlots * 0.35)));
  const requiredEvents = Math.max(12, requiredSlots * 4);

  return recentSlotCount(cutoff) >= requiredSlots && recentEventCount(cutoff) >= requiredEvents;
}
