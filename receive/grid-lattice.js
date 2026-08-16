var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import { gridLayoutById } from "../shared/grid-layout.js";
const WHOLE_GRID_LOSS_MS = 2200;
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
class GridLattice {
  constructor(onTransition) {
    this.onTransition = onTransition;
    __publicField(this, "state", "SEARCH");
    __publicField(this, "identity", "");
    __publicField(this, "observations", []);
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
    this.candidate = void 0;
    this.lastHitAt = 0;
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
    this.observations.push(detection);
    this.observations = this.observations.filter((item) => detection.at - item.at < 2500 && item.modules === detection.modules).slice(-32);
    if (this.locked && this.candidate) {
      const updated = this.makeCandidate(this.candidate.layout);
      if (updated) this.candidate = updated;
      this.transition("TRACK", "valid packet refreshed locked lattice", detection.at);
    } else {
      this.candidate = (_a = this.makeCandidate(declaredLayout)) != null ? _a : void 0;
      if (!this.candidate) return null;
      this.transition("GRID_LOCK", "packet declared layoutId and slotIndex", detection.at);
    }
    return this.snapshot();
  }
  tick(now) {
    if (this.active && now - this.lastHitAt > WHOLE_GRID_LOSS_MS) {
      this.transition("REACQUIRE", "whole lattice expired without a valid packet", now);
      this.candidate = void 0;
      this.observations = [];
      return null;
    }
    return this.candidate ? this.snapshot() : null;
  }
  noteMissing(anyMissing, now = this.lastHitAt) {
    if (!this.locked) return;
    this.transition(anyMissing ? "PARTIAL_LOSS" : "TRACK", anyMissing ? "one or more predicted slots missing" : "all predicted slots healthy", now);
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
    const decoded = new Set(candidate.observations.map((observation) => observation.slotIndex));
    const slots = [];
    for (let index = 0; index < count; index++) {
      const points = slotWorld(candidate.layout, modules, index).map((point) => project(candidate.transform, point));
      const quad = { topLeft: points[0], topRight: points[1], bottomRight: points[2], bottomLeft: points[3] };
      const box = bounds(quad);
      if (!box) return null;
      slots.push({ index, quad, box, decoded: decoded.has(index) });
    }
    const confidence = Math.max(0, Math.min(1, candidate.observations.length / Math.min(3, candidate.observations.length + 1) * (1 - candidate.error)));
    return { state: this.state, confidence, layout: candidate.layout, modules, slots };
  }
}
export {
  GridLattice
};
