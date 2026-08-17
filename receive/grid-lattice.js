var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import { gridLayoutById } from "../shared/grid-layout.js";
// Preserve a proven wall through short optical/display-phase miss bursts.
const WHOLE_GRID_LOSS_MS = 3200;
// Geometry has two different lifetimes. Identity/lock evidence may survive a
// brief miss, but quads used to aim the hot decoder must represent the camera
// pose *now*. Keeping those concepts separate prevents repeatedly decoded easy
// slots from pushing rarer slot geometry out of the lattice, while also
// preventing an old exact quad from fighting a newer whole-wall fit.
const OBSERVATION_HISTORY_MS = 2500;
const CURRENT_FIT_MS = 420;
const EXACT_GEOMETRY_MS = 420;
// CRC-backed QR corner estimates still carry ~subpixel/pixel frame noise. The
// wall itself is rigid, so publish coherent global motion and retain only the
// slowly learned local residual that represents lens distortion.
const LOCAL_GEOMETRY_LEARN_MAX_ERROR = 0.08;
const LOCAL_GEOMETRY_MAX_RESIDUAL = 0.08;
const LOCAL_GEOMETRY_ALPHA = 0.08;
function corners(quad) {
  return quad ? [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft] : [];
}
function validPoints(points) {
  return points.length === 4 && points.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
}
function validGeometry(detection) {
  if (!detection || detection.modules < 21 || detection.modules > 177 || detection.modules % 4 !== 1) return false;
  const points = corners(detection.quad);
  if (!validPoints(points)) return false;
  const edges = points.map((p, i) => Math.hypot(p.x - points[(i + 1) % 4].x, p.y - points[(i + 1) % 4].y));
  const shortest = Math.min(...edges);
  const longest = Math.max(...edges);
  const area = Math.abs(points.reduce((sum, p, i) => sum + p.x * points[(i + 1) % 4].y - p.y * points[(i + 1) % 4].x, 0) / 2);
  return shortest >= 20 && longest / shortest < 2.25 && area > shortest * shortest * 0.35;
}
function solve(rows, values) {
  const n = values.length;
  const a = rows.map((row, i) => [...row, values[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col];
    if (Math.abs(divisor) < 1e-8) return null;
    const pivotRow = a[col];
    for (let j = col; j <= n; j++) pivotRow[j] = pivotRow[j] / divisor;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const targetRow = a[row];
      const factor = targetRow[col];
      for (let j = col; j <= n; j++) targetRow[j] = targetRow[j] - factor * pivotRow[j];
    }
  }
  return a.map((row) => row[n]);
}
function fitHomography(pairs) {
  const normal = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const rhs = new Array(8).fill(0);
  for (const { world: p, image: q } of pairs) {
    const equations = [
      { row: [p.x, p.y, 1, 0, 0, 0, -q.x * p.x, -q.x * p.y], value: q.x },
      { row: [0, 0, 0, p.x, p.y, 1, -q.y * p.x, -q.y * p.y], value: q.y }
    ];
    for (const equation of equations) {
      for (let i = 0; i < 8; i++) {
        rhs[i] = rhs[i] + equation.row[i] * equation.value;
        const normalRow = normal[i];
        for (let j = 0; j < 8; j++) normalRow[j] = normalRow[j] + equation.row[i] * equation.row[j];
      }
    }
  }
  const result = solve(normal, rhs);
  return result ? result : null;
}
function project(h, point) {
  const d = h[6] * point.x + h[7] * point.y + 1;
  return { x: (h[0] * point.x + h[1] * point.y + h[2]) / d, y: (h[3] * point.x + h[4] * point.y + h[5]) / d };
}
function slotWorld(layout, modules, slot) {
  const stride = modules + 1;
  const x = slot % layout.cols * stride;
  const y = Math.floor(slot / layout.cols) * stride;
  return [{ x, y }, { x: x + modules, y }, { x: x + modules, y: y + modules }, { x, y: y + modules }];
}
function bounds(quad) {
  const points = corners(quad);
  if (!validPoints(points)) return null;
  const left = Math.min(...points.map((p) => p.x));
  const top = Math.min(...points.map((p) => p.y));
  const right = Math.max(...points.map((p) => p.x));
  const bottom = Math.max(...points.map((p) => p.y));
  return { x: left, y: top, w: right - left, h: bottom - top };
}
function lockReady(layout, observations) {
  const count = layout.cols * layout.rows;
  if (count <= 1) return true;
  const slots = [...new Set(observations.map((observation) => observation.slotIndex))];
  if (slots.length < 2) return false;
  // A one-dimensional grid needs observations from both positions before the
  // lattice may replace measured geometry with a predicted neighbor.
  if (layout.cols === 1 || layout.rows === 1) return true;
  // For a two-dimensional wall, require evidence along both axes. Two
  // diagonally separated QRs are sufficient; two QRs from one row/column are
  // still only a provisional seed and acquisition must continue.
  const cols = new Set(slots.map((slot) => slot % layout.cols));
  const rows = new Set(slots.map((slot) => Math.floor(slot / layout.cols)));
  return cols.size >= 2 && rows.size >= 2;
}
class GridLattice {
  constructor(onTransition) {
    this.onTransition = onTransition;
    __publicField(this, "state", "SEARCH");
    __publicField(this, "identity", "");
    __publicField(this, "observations", []);
    __publicField(this, "slotCorrections", /* @__PURE__ */ new Map());
    __publicField(this, "candidate");
    __publicField(this, "lastHitAt", 0);
    __publicField(this, "frameWidth", 1);
    __publicField(this, "frameHeight", 1);
  }
  transition(next, reason, at) {
    var _a;
    if (next === this.state) return;
    const prior = this.state;
    this.state = next;
    (_a = this.onTransition) == null ? void 0 : _a.call(this, prior, next, reason, at);
  }
  get active() {
    return this.state !== "SEARCH" && this.state !== "REACQUIRE";
  }
  get locked() {
    return this.state === "GRID_LOCK" || this.state === "TRACK" || this.state === "PARTIAL_LOSS";
  }
  reset() {
    this.transition("SEARCH", "reset", this.lastHitAt);
    this.identity = "";
    this.observations = [];
    this.slotCorrections.clear();
    this.candidate = void 0;
    this.lastHitAt = 0;
  }
  reacquire(at, reason = "whole lattice invalidated") {
    this.transition("REACQUIRE", reason, at);
    this.observations = [];
    this.slotCorrections.clear();
    this.candidate = void 0;
    this.lastHitAt = at;
  }
  accept(detection, frameWidth, frameHeight) {
    var _a;
    if (!validGeometry(detection)) return null;
    const declaredLayout = gridLayoutById(detection.layoutId);
    if (!declaredLayout || detection.slotIndex >= declaredLayout.cols * declaredLayout.rows) return null;
    if (this.identity && detection.identity !== this.identity) return null;
    if (!this.identity) this.identity = detection.identity;
    this.frameWidth = Math.max(1, frameWidth);
    this.frameHeight = Math.max(1, frameHeight);
    this.lastHitAt = detection.at;
    if (this.candidate && this.candidate.layout.id !== declaredLayout.id) {
      this.observations = [];
      this.slotCorrections.clear();
      this.candidate = void 0;
    }
    // makeCandidate only uses the newest observation for each slot. Storing a
    // raw last-N stream was therefore both wasted memory and actively harmful:
    // a few easy QRs decoded every frame could evict the last good geometry for
    // the other cells. Keep exactly one CRC-backed observation per slot.
    this.observations = this.observations.filter((item) =>
      detection.at - item.at < OBSERVATION_HISTORY_MS &&
      item.modules === detection.modules &&
      item.slotIndex !== detection.slotIndex
    );
    this.observations.push(detection);
    if (this.locked && this.candidate) {
      const updated = this.makeCandidate(this.candidate.layout);
      if (updated) this.candidate = updated;
      this.transition("TRACK", "valid packet refreshed locked lattice", detection.at);
    } else {
      this.candidate = (_a = this.makeCandidate(declaredLayout)) != null ? _a : void 0;
      if (!this.candidate) return null;
      // One QR is enough to create a provisional homography but not enough to
      // trust a multi-QR wall. Stay in SEARCH/REACQUIRE so full acquisition
      // continues until distinct observed slots constrain the declared grid.
      if (lockReady(declaredLayout, this.candidate.observations)) {
        this.transition("GRID_LOCK", "multi-slot geometry confirmed", detection.at);
      }
    }
    this.learnSlotCorrection(detection);
    return this.snapshot();
  }
  noteValidPacket(at = this.lastHitAt) {
    if (!this.candidate) return null;
    this.lastHitAt = at;
    if (this.locked) this.transition("TRACK", "valid predicted packet kept lattice alive", at);
    return this.snapshot();
  }
  learnSlotCorrection(detection) {
    const candidate = this.candidate;
    if (!this.locked || !candidate || candidate.error > LOCAL_GEOMETRY_LEARN_MAX_ERROR) return;
    const measured = corners(detection.quad);
    if (!validPoints(measured) || !detection.box) return;
    const predicted = slotWorld(candidate.layout, detection.modules, detection.slotIndex)
      .map((point) => project(candidate.transform, point));
    const edge = Math.max(1, Math.sqrt(detection.box.w * detection.box.h));
    const residual = measured.map((point, index) => ({
      x: point.x - predicted[index].x,
      y: point.y - predicted[index].y
    }));
    if (residual.some((point) => Math.hypot(point.x, point.y) > edge * LOCAL_GEOMETRY_MAX_RESIDUAL)) return;
    const previous = this.slotCorrections.get(detection.slotIndex);
    if (!previous || previous.length !== 4) {
      // First CRC-backed sample establishes the local lens residual immediately;
      // later samples only nudge it slowly so decoder corner noise cannot move
      // one QR independently from the rest of the wall.
      this.slotCorrections.set(detection.slotIndex, residual);
      return;
    }
    const next = residual.map((point, index) => ({
      x: previous[index].x + (point.x - previous[index].x) * LOCAL_GEOMETRY_ALPHA,
      y: previous[index].y + (point.y - previous[index].y) * LOCAL_GEOMETRY_ALPHA
    }));
    this.slotCorrections.set(detection.slotIndex, next);
  }
  tick(now) {
    if (this.candidate && now - this.lastHitAt > WHOLE_GRID_LOSS_MS) {
      this.transition("REACQUIRE", "whole lattice expired without a valid packet", now);
      this.candidate = void 0;
      this.observations = [];
      this.slotCorrections.clear();
      return null;
    }
    // Provisional geometry remains publishable for overlays, visibility,
    // cropping and exact observed-slot tracking. Only `active` means the whole
    // predicted wall is trusted enough to replace acquisition.
    return this.candidate ? this.snapshot() : null;
  }
  noteMissing(anyMissing, now = this.lastHitAt) {
    if (!this.locked) return;
    this.transition(anyMissing ? "PARTIAL_LOSS" : "TRACK", anyMissing ? "one or more predicted slots missing" : "all predicted slots healthy", now);
  }
  nudgeFromSightings(sightings, at = this.lastHitAt) {
    if (!this.locked || !this.candidate || !Array.isArray(sightings) || !sightings.length) return null;
    const snapshot = this.snapshot();
    if (!snapshot) return null;
    const validBox = (box) => box && [box.x, box.y, box.w, box.h].every(Number.isFinite) &&
      box.w >= 20 && box.h >= 20 && Math.max(box.w / box.h, box.h / box.w) < 2.4;
    const candidates = snapshot.slots.filter((slot) => validBox(slot.box));
    if (!candidates.length) return null;
    const unused = new Set(candidates.map((slot) => slot.index));
    const matches = [];
    // Greedy nearest-neighbor matching is intentionally conservative. Finder
    // sightings contain no identity/CRC, so require similar size, proximity to
    // an already-proven slot, and later a coherent multi-sighting translation.
    for (const sighting of sightings.filter(validBox)) {
      const sx = sighting.x + sighting.w / 2;
      const sy = sighting.y + sighting.h / 2;
      let best = null;
      for (const slot of candidates) {
        if (!unused.has(slot.index)) continue;
        const box = slot.box;
        const px = box.x + box.w / 2;
        const py = box.y + box.h / 2;
        const edge = Math.max(24, Math.sqrt(box.w * box.h));
        const ratio = Math.sqrt(sighting.w * sighting.h / Math.max(1, box.w * box.h));
        if (ratio < 0.5 || ratio > 1.9) continue;
        const distance = Math.hypot(sx - px, sy - py);
        if (distance > edge * 0.9) continue;
        const score = distance / edge + Math.abs(Math.log(ratio)) * 0.55;
        if (!best || score < best.score) {
          best = { slot, dx: sx - px, dy: sy - py, ratio, edge, score };
        }
      }
      if (best) {
        unused.delete(best.slot.index);
        matches.push(best);
      }
    }
    const wallCount = snapshot.layout.cols * snapshot.layout.rows;
    const minimumMatches = wallCount <= 1 ? 1 : 2;
    if (matches.length < minimumMatches) return null;
    const median = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    let dx = median(matches.map((match) => match.dx));
    let dy = median(matches.map((match) => match.dy));
    const edge = median(matches.map((match) => match.edge));
    let inliers = matches.filter((match) => Math.hypot(match.dx - dx, match.dy - dy) <= edge * 0.3);
    if (inliers.length < minimumMatches) return null;
    dx = median(inliers.map((match) => match.dx));
    dy = median(inliers.map((match) => match.dy));
    const shift = Math.hypot(dx, dy);
    // Ignore sub-pixel/no-op results and large jumps that are more likely to be
    // a different object/grid. This is a rescue nudge, never reacquisition.
    if (shift < 1 || shift > edge * 0.72) return null;
    const bySlot = new Map(inliers.map((match) => [match.slot.index, match]));
    const movePoint = (point, mx, my, scale, cx, cy) => ({
      x: cx + (point.x - cx) * scale + mx,
      y: cy + (point.y - cy) * scale + my
    });
    this.observations = this.observations.map((observation) => {
      const match = bySlot.get(observation.slotIndex);
      const mx = match ? match.dx : dx;
      const my = match ? match.dy : dy;
      // A sighting's bounding box can estimate a small zoom change, but clamp
      // it tightly because failed finder geometry is noisier than CRC geometry.
      const scale = match ? Math.max(0.92, Math.min(1.08, match.ratio)) : 1;
      const box = observation.box;
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      const points = corners(observation.quad).map((point) => movePoint(point, mx, my, scale, cx, cy));
      const quad = { topLeft: points[0], topRight: points[1], bottomRight: points[2], bottomLeft: points[3] };
      return { ...observation, quad, box: bounds(quad) };
    });
    const updated = this.makeCandidate(this.candidate.layout);
    if (!updated) return null;
    this.candidate = updated;
    // Deliberately do not advance lastHitAt: finder-only evidence may reposition
    // a proven wall, but only a valid AirGapper packet may keep it alive.
    this.transition("PARTIAL_LOSS", "finder sightings recentered locked lattice", at);
    return this.snapshot();
  }
  makeCandidate(layout) {
    const count = layout.cols * layout.rows;
    const latest = /* @__PURE__ */ new Map();
    for (const observation of this.observations) {
      const declared = gridLayoutById(observation.layoutId);
      if (!declared || declared.cols !== layout.cols || declared.rows !== layout.rows) continue;
      latest.set(observation.slotIndex, observation);
    }
    let observations = [...latest.values()];
    if (!observations.length) return null;
    const newest = observations.reduce((a, b) => a.at > b.at ? a : b);
    // A moving phone makes a 1-2 second old quad a different camera pose. When
    // the current window already spans both lattice axes, fit only that fresh
    // evidence. Fall back to the longer-lived anchors only when the visible
    // fragment cannot constrain a 2D wall by itself.
    const current = observations.filter((observation) => newest.at - observation.at <= CURRENT_FIT_MS);
    if (lockReady(layout, current)) observations = current;
    const pairsFor = (items) => items.flatMap((observation) => {
      const slot = observation.slotIndex;
      return slotWorld(layout, observation.modules, slot).map((world, index) => ({ world, image: corners(observation.quad)[index] }));
    });
    const seed = fitHomography(pairsFor([newest]));
    if (!seed) return null;
    observations = observations.filter((observation) => {
      const projected = slotWorld(layout, observation.modules, observation.slotIndex).map((point) => project(seed, point));
      const image = corners(observation.quad);
      const edge2 = Math.max(1, Math.sqrt(observation.box.w * observation.box.h));
      const residual = Math.sqrt(projected.reduce((sum, point, index) => sum + (point.x - image[index].x) ** 2 + (point.y - image[index].y) ** 2, 0) / 4) / edge2;
      return residual < 0.3;
    });
    const pairs = pairsFor(observations);
    const transform = fitHomography(pairs);
    if (!transform) return null;
    let squaredError = 0;
    for (const pair of pairs) {
      const p = project(transform, pair.world);
      squaredError += (p.x - pair.image.x) ** 2 + (p.y - pair.image.y) ** 2;
    }
    const edge = Math.max(1, Math.sqrt(observations[0].box.w * observations[0].box.h));
    const error = Math.sqrt(squaredError / pairs.length) / edge;
    if (error > 0.22) return null;
    let inside = 0;
    for (let slot = 0; slot < count; slot++) {
      const center = project(transform, slotWorld(layout, observations[0].modules, slot).reduce((p, q) => ({ x: p.x + q.x / 4, y: p.y + q.y / 4 }), { x: 0, y: 0 }));
      if (center.x > -edge * 0.5 && center.y > -edge * 0.5 && center.x < this.frameWidth + edge * 0.5 && center.y < this.frameHeight + edge * 0.5) inside++;
    }
    const observedFraction = Math.sqrt(observations[0].box.w * observations[0].box.h / (this.frameWidth * this.frameHeight));
    const expectedFraction = 0.68 / Math.sqrt(count);
    const sizePrior = -Math.abs(Math.log(Math.max(0.01, observedFraction) / expectedFraction)) * 8;
    const score = observations.length * 100 - error * 80 + sizePrior + inside / count * 12;
    return { layout, transform, observations, score, error };
  }
  snapshot() {
    const candidate = this.candidate;
    const count = candidate.layout.cols * candidate.layout.rows;
    const modules = candidate.observations[0].modules;
    // The whole-grid homography owns frame-to-frame pose. CRC-backed local
    // observations remain useful for freshness/identity and for learning the
    // persistent per-slot lens residual, but raw one-frame quads are never
    // published directly into the tracking hot path.
    const newestAt = candidate.observations.reduce((latest, observation) => Math.max(latest, observation.at), 0);
    // Freshness still records which slots have recently decoded; geometry is
    // global pose plus the slowly learned local correction below.
    const observed = new Map(candidate.observations
      .filter((observation) => newestAt - observation.at <= EXACT_GEOMETRY_MS)
      .map((observation) => [observation.slotIndex, observation]));
    const decoded = new Set(observed.keys());
    const slots = [];
    for (let index = 0; index < count; index++) {
      const observation = observed.get(index);
      // Never publish a raw per-frame QR quad. The whole wall moves through one
      // homography; each slot carries only its persistent local lens residual.
      // This removes independent overlay/track jitter while preserving the
      // non-projective distortion Guided calibrated for the hot sampler.
      let points = slotWorld(candidate.layout, modules, index).map((point) => project(candidate.transform, point));
      const correction = this.slotCorrections.get(index);
      if (correction && correction.length === 4) {
        points = points.map((point, cornerIndex) => ({
          x: point.x + correction[cornerIndex].x,
          y: point.y + correction[cornerIndex].y
        }));
      }
      const quad = { topLeft: points[0], topRight: points[1], bottomRight: points[2], bottomLeft: points[3] };
      const box = bounds(quad);
      if (!box) return null;
      slots.push({ index, quad, box, decoded: decoded.has(index), observed: Boolean(observation) });
    }
    const confidence = Math.max(0, Math.min(1, candidate.observations.length / Math.min(3, candidate.observations.length + 1) * (1 - candidate.error)));
    return {
      state: this.state, provisional: !this.active, confidence, layout: candidate.layout, modules, slots,
      observedSlots: observed.size, correctedSlots: this.slotCorrections.size,
      storedSlots: this.observations.length, fitSlots: candidate.observations.length,
      fitError: candidate.error
    };
  }
}
export {
  GridLattice
};
