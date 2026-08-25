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

export function noteDecodeGeometry(snapshot, frameWidth, frameHeight) {
  const slots = snapshot?.slots;
  if (!Array.isArray(slots)) {
    geometrySlotCount = 0;
    return;
  }

  const width = Number(frameWidth);
  const height = Number(frameHeight);
  if (!(width > 1) || !(height > 1)) {
    geometrySlotCount = Math.min(SLOT_CAPACITY, slots.length);
    return;
  }

  // Lattice snapshots contain every declared layout slot, including QRs whose
  // predicted centers are outside the camera. Exposure health is about the wall
  // the camera can actually judge. Otherwise a partially framed 7x4 wall could
  // require six distinct successes when only four or five QRs are on-camera.
  let visible = 0;
  for (const slot of slots) {
    const box = slot?.box;
    const x = Number(box?.x);
    const y = Number(box?.y);
    const w = Number(box?.w);
    const h = Number(box?.h);
    if (![x, y, w, h].every(Number.isFinite) || !(w > 0) || !(h > 0)) continue;
    const centerX = x + w * 0.5;
    const centerY = y + h * 0.5;
    if (centerX >= 0 && centerY >= 0 && centerX < width && centerY < height) visible++;
  }
  geometrySlotCount = Math.min(SLOT_CAPACITY, visible);
}

export function noteDecodeLatticeState(state) {
  latticeState = String(state || "SEARCH");
  if (latticeState === "SEARCH" || latticeState === "REACQUIRE" || latticeState === "DORMANT") {
    geometrySlotCount = 0;
    clearRecentDecodeHealth();
  }
}

export function resetDecodeHealth() {
  latticeState = "SEARCH";
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
  // Geometry fit quality and payload health are deliberately separate. A local
  // fit can still be decoding broadly across the physical wall; those real CRC
  // successes are stronger exposure evidence than whether the current pose has
  // enough fresh anchors to be called distributed.
  if ((latticeState !== "TRACK" && latticeState !== "PARTIAL_LOSS") || !geometrySlotCount) return false;
  if (!lastSuccessAt || at - lastSuccessAt > HEALTH_FRESH_MS) return false;

  const cutoff = at - HEALTH_WINDOW_MS;
  const knownSlots = Math.max(1, geometrySlotCount);
  const requiredSlots = knownSlots <= 2
    ? knownSlots
    : Math.min(6, Math.max(2, Math.ceil(knownSlots * 0.35)));
  const requiredEvents = Math.max(12, requiredSlots * 4);

  return recentSlotCount(cutoff) >= requiredSlots && recentEventCount(cutoff) >= requiredEvents;
}
