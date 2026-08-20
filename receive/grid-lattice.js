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
const LOCAL_GEOMETRY_MAX_RESIDUAL = 0.03;
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
function declaredGridLayout(detection) {
  if (detection?.extendedGrid) {
    const cols = Number(detection.gridCols);
    const rows = Number(detection.gridRows);
    const count = cols * rows;
    if (!Number.isInteger(cols) || cols < 1 || cols > 32 ||
        !Number.isInteger(rows) || rows < 1 || rows > 32 ||
        !Number.isInteger(count) || count < 2 || count > 128)
      return null;
    return { id: `extended:${cols}x${rows}`, cols, rows, extendedGrid: true };
  }
  return gridLayoutById(detection?.layoutId) ?? null;
}
function activationReady(layout, observations) {
  // One CRC-verified AirGapper QR is enough to predict every declared slot and
  // begin tracked decoding immediately.
  return observations.length > 0;
}
function distributedFitReady(layout, observations) {
  const count = layout.cols * layout.rows;
  if (count <= 1) return observations.length > 0;
  const slots = [...new Set(observations.map((observation) => observation.slotIndex))];
  if (slots.length < 2) return false;
  if (layout.cols === 1 || layout.rows === 1) return true;
  const cols = new Set(slots.map((slot) => slot % layout.cols));
  const rows = new Set(slots.map((slot) => Math.floor(slot / layout.cols)));
  // A fresh fit may replace the longer-lived anchors only after observations
  // span both wall axes. Two diagonal slots are enough. Two slots from one row
  // or one column are still only a local/provisional geometric seed.
  return cols.size >= 2 && rows.size >= 2;
}
class GridLattice {
  constructor(onTransition) {
    this.onTransition = onTransition;
    this.state = "SEARCH";
    this.identity = "";
    this.observations = [];
    this.slotCorrections = /* @__PURE__ */ new Map();
    this.candidate = undefined;
    this.lastHitAt = 0;
    this.frameWidth = 1;
    this.frameHeight = 1;
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
    const declaredLayout = declaredGridLayout(detection);
    if (!declaredLayout || detection.slotIndex >= declaredLayout.cols * declaredLayout.rows) return null;
    if (this.identity && detection.identity !== this.identity) return null;
    if (!this.identity) this.identity = detection.identity;
    this.frameWidth = Math.max(1, frameWidth);
    this.frameHeight = Math.max(1, frameHeight);
    const packetIsCurrent = detection.at >= this.lastHitAt;
    this.lastHitAt = Math.max(this.lastHitAt, detection.at);
    if (this.candidate && this.candidate.layout.id !== declaredLayout.id) {
      this.observations = [];
      this.slotCorrections.clear();
      this.candidate = void 0;
    }
    // Worker completions are not camera ordered. A slow older job must never
    // replace a newer observation for the same slot. History is also pruned
    // relative to the newest packet seen by the lattice, not the arrival order.
    const previousSlot = this.observations.find((item) => item.slotIndex === detection.slotIndex);
    const slotGeometryIsFresh = !previousSlot ||
      detection.at > previousSlot.at ||
      detection.at === previousSlot.at && detection.scanId >= previousSlot.scanId;
    if (!slotGeometryIsFresh) return this.candidate ? this.snapshot() : null;
    this.observations = this.observations.filter((item) =>
      this.lastHitAt - item.at < OBSERVATION_HISTORY_MS &&
      item.modules === detection.modules &&
      item.slotIndex !== detection.slotIndex
    );
    this.observations.push(detection);
    if (this.locked && this.candidate) {
      const updated = this.makeCandidate(this.candidate.layout);
      if (updated) this.candidate = updated;
      if (packetIsCurrent) this.transition("TRACK", "valid packet refreshed locked lattice", detection.at);
    } else {
      this.candidate = (_a = this.makeCandidate(declaredLayout)) != null ? _a : void 0;
      if (!this.candidate) return null;
      // A single CRC-backed packet immediately activates the declared wall.
      // Subsequent packets continuously refine this initial projective seed.
      if (activationReady(declaredLayout, this.candidate.observations)) {
        this.transition("GRID_LOCK", "verified QR seeded declared grid", detection.at);
      }
    }
    if (packetIsCurrent) this.learnSlotCorrection(detection);
    return this.snapshot();
  }
  noteValidPacket(at = this.lastHitAt) {
    if (!this.candidate) return false;
    const packetIsCurrent = at >= this.lastHitAt;
    this.lastHitAt = Math.max(this.lastHitAt, at);
    if (packetIsCurrent && this.locked)
      this.transition("TRACK", "valid predicted packet kept lattice alive", at);
    return true;
  }
  nudgeMotion(motion, at = this.lastHitAt) {
    if (!this.locked || !this.candidate || !motion || at < this.lastHitAt) return null;
    const a = Number(motion.a ?? 1);
    const b = Number(motion.b ?? 0);
    const tx = Number(motion.tx ?? motion.dx);
    const ty = Number(motion.ty ?? motion.dy);
    if (![a, b, tx, ty].every(Number.isFinite)) return null;
    const scale = Math.hypot(a, b);
    const rotation = Math.atan2(b, a);
    const representativeShift = Number.isFinite(Number(motion.maxShift))
      ? Number(motion.maxShift)
      : Math.hypot(Number(motion.dx ?? tx), Number(motion.dy ?? ty));
    const linearChange = Math.max(Math.abs(a - 1), Math.abs(b));
    if (representativeShift < 0.08 && linearChange < 0.0004) return null;
    if (representativeShift > 5.25 || scale < 0.97 || scale > 1.03 || Math.abs(rotation) > 0.04) return null;
    const transformPoint = (point) => ({
      x: a * point.x - b * point.y + tx,
      y: b * point.x + a * point.y + ty
    });
    const transformQuad = (quad) => {
      const points = corners(quad).map(transformPoint);
      return { topLeft: points[0], topRight: points[1], bottomRight: points[2], bottomLeft: points[3] };
    };
    const transformObservation = (observation) => {
      const quad = transformQuad(observation.quad);
      return { ...observation, quad, box: bounds(quad) };
    };
    this.observations = this.observations.map(transformObservation);

    const h = this.candidate.transform;
    // Left-compose the image-space similarity A with the world->camera
    // homography H. H has an implicit final coefficient of 1.
    const next = [
      a * h[0] - b * h[3] + tx * h[6],
      a * h[1] - b * h[4] + tx * h[7],
      a * h[2] - b * h[5] + tx,
      b * h[0] + a * h[3] + ty * h[6],
      b * h[1] + a * h[4] + ty * h[7],
      b * h[2] + a * h[5] + ty,
      h[6],
      h[7]
    ];
    this.candidate = {
      ...this.candidate,
      transform: next,
      observations: this.candidate.observations.map(transformObservation)
    };
    // Slot corrections are image-space vectors, so rotate/scale the vectors
    // but never apply the affine translation to them.
    for (const [slot, residuals] of this.slotCorrections) {
      this.slotCorrections.set(slot, residuals.map((point) => ({
        x: a * point.x - b * point.y,
        y: b * point.x + a * point.y
      })));
    }
    return this.snapshot();
  }
  nudgeTranslation(dx, dy, at = this.lastHitAt) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) > 4.5) return null;
    return this.nudgeMotion({
      kind: "translation",
      a: 1, b: 0, tx: dx, ty: dy,
      dx, dy, maxShift: Math.hypot(dx, dy)
    }, at);
  }
  dropSlotCorrection(slot) {
    if (!Number.isInteger(slot) || !this.slotCorrections.has(slot)) return null;
    this.slotCorrections.delete(slot);
    return this.candidate ? this.snapshot() : null;
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
      // A CRC-backed measured quad may establish the local residual immediately;
      // the residual itself is tightly bounded above, and repeated unexplained
      // misses can now evict this correction independently of the wall.
      this.slotCorrections.set(detection.slotIndex, residual);
      return;
    }
    const disagreement = Math.max(...residual.map((point, index) =>
      Math.hypot(point.x - previous[index].x, point.y - previous[index].y)
    ));
    if (disagreement > edge * 0.018) {
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
      // Never erase a CRC-proven wall merely because the camera moved away from
      // its predicted quads. Keeping identity + homography lets bounded global
      // recovery accept any later same-stream QR and re-anchor the whole wall
      // from that QR's four measured corners. Session/camera changes still call
      // reset/reacquire explicitly when the identity really must be discarded.
      this.transition("PARTIAL_LOSS", "whole lattice stale; retaining proven wall for QR re-anchor", now);
    }
    // Stale geometry remains a recovery prior, not an acquisition blocker.
    return this.candidate ? this.snapshot() : null;
  }
  noteMissing(anyMissing, now = this.lastHitAt) {
    if (!this.locked) return;
    this.transition(anyMissing ? "PARTIAL_LOSS" : "TRACK", anyMissing ? "one or more predicted slots missing" : "all predicted slots healthy", now);
  }
  nudgeFromSightings(sightings, at = this.lastHitAt) {
    if (!this.locked || !this.candidate || at < this.lastHitAt || !Array.isArray(sightings) || !sightings.length) return null;
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
      const declared = declaredGridLayout(observation);
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
    const currentDistributed = distributedFitReady(layout, current);
    if (currentDistributed) observations = current;
    const pairsFor = (items) => items.flatMap((observation) => {
      const slot = observation.slotIndex;
      return slotWorld(layout, observation.modules, slot).map((world, index) => ({ world, image: corners(observation.quad)[index] }));
    });
    // When this camera-time window already spans both wall axes, seed the
    // outlier test from the distributed observations themselves. A homography
    // inferred from one QR is exact locally but is not a safe extrapolation
    // oracle across a large lens-distorted wall. If a filtering pass would
    // destroy the fresh cross-axis constraint, keep the CRC-backed fresh set.
    const seed = fitHomography(pairsFor(currentDistributed ? observations : [newest]));
    if (!seed) return null;
    const filtered = observations.filter((observation) => {
      const projected = slotWorld(layout, observation.modules, observation.slotIndex).map((point) => project(seed, point));
      const image = corners(observation.quad);
      const edge2 = Math.max(1, Math.sqrt(observation.box.w * observation.box.h));
      const residual = Math.sqrt(projected.reduce((sum, point, index) => sum + (point.x - image[index].x) ** 2 + (point.y - image[index].y) ** 2, 0) / 4) / edge2;
      return residual < 0.3;
    });
    if (!currentDistributed || distributedFitReady(layout, filtered)) observations = filtered;
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
    return { layout, transform, observations, score, error, distributedFit: distributedFitReady(layout, observations) };
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
      slots.push({ index, quad, box, decoded: observed.has(index), observed: Boolean(observation) });
    }
    const confidence = Math.max(0, Math.min(1, candidate.observations.length / Math.min(3, candidate.observations.length + 1) * (1 - candidate.error)));
    return {
      state: this.state, provisional: !this.active, confidence, layout: candidate.layout, modules, slots,
      observedSlots: observed.size, correctedSlots: this.slotCorrections.size,
      storedSlots: this.observations.length, fitSlots: candidate.observations.length,
      distributedFit: Boolean(candidate.distributedFit), fitError: candidate.error
    };
  }
}
export {
  GridLattice
};
