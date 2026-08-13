import type { SymbolBox, SymbolQuad } from "../shared/worker-pool";
import { GRID_LAYOUTS, GRID_MARGIN_MODULES, gridLayoutById, type GridLayout } from "../shared/grid-layout";

export type GridState = "SEARCH" | "GRID_HYPOTHESIS" | "GRID_LOCK" | "TRACK" | "PARTIAL_LOSS" | "REACQUIRE";

export interface GridDetection {
  identity: string;
  seq: number;
  gridEsi?: number;
  layoutId?: number;
  slotIndex?: number;
  at: number;
  scanId: number;
  box: SymbolBox;
  quad: SymbolQuad;
  modules: number;
}

export interface GridSlot {
  index: number;
  quad: SymbolQuad;
  box: SymbolBox;
  decoded: boolean;
}

export interface GridSnapshot {
  state: GridState;
  confidence: number;
  layout: { cols: number; rows: number };
  modules: number;
  slots: GridSlot[];
}

type Point = { x: number; y: number };
type Layout = Pick<GridLayout, "cols" | "rows">;
type Homography = [number, number, number, number, number, number, number, number];
type Candidate = { layout: Layout; transform: Homography; observations: GridDetection[]; score: number; error: number };

const HYPOTHESIS_DWELL_MS = 650;
const WHOLE_GRID_LOSS_MS = 2200;

function corners(quad: SymbolQuad): Point[] {
  return [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
}

function validGeometry(detection: GridDetection, frameWidth: number, frameHeight: number): boolean {
  if (detection.modules < 21 || detection.modules > 177 || detection.modules % 4 !== 1) return false;
  const points = corners(detection.quad);
  if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
  const edges = points.map((p, i) => Math.hypot(p.x - points[(i + 1) % 4]!.x, p.y - points[(i + 1) % 4]!.y));
  const shortest = Math.min(...edges);
  const longest = Math.max(...edges);
  const area = Math.abs(points.reduce((sum, p, i) => sum + p.x * points[(i + 1) % 4]!.y - p.y * points[(i + 1) % 4]!.x, 0) / 2);
  if (shortest < 20 || longest / shortest >= 2.25 || area <= shortest * shortest * 0.35) return false;

  // A corrupt/freed native position can still be finite and roughly square.
  // Reject it before one decoded packet projects an entire blue lattice from
  // bad coordinates. The independently returned box must agree with the quad,
  // and a real camera symbol cannot live far outside the captured frame.
  const quadBounds = bounds(detection.quad);
  const boxCenterX = detection.box.x + detection.box.w / 2;
  const boxCenterY = detection.box.y + detection.box.h / 2;
  const quadCenterX = quadBounds.x + quadBounds.w / 2;
  const quadCenterY = quadBounds.y + quadBounds.h / 2;
  const size = Math.max(quadBounds.w, quadBounds.h, detection.box.w, detection.box.h);
  return detection.box.w > 0 && detection.box.h > 0 &&
    Math.abs(boxCenterX - quadCenterX) <= size * 0.2 &&
    Math.abs(boxCenterY - quadCenterY) <= size * 0.2 &&
    quadBounds.x >= -frameWidth * 0.25 && quadBounds.y >= -frameHeight * 0.25 &&
    quadBounds.x + quadBounds.w <= frameWidth * 1.25 &&
    quadBounds.y + quadBounds.h <= frameHeight * 1.25;
}

function solve(rows: number[][], values: number[]): number[] | null {
  const n = values.length;
  const a = rows.map((row, i) => [...row, values[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    const divisor = a[col]![col]!;
    if (Math.abs(divisor) < 1e-8) return null;
    const pivotRow = a[col]!;
    for (let j = col; j <= n; j++) pivotRow[j] = pivotRow[j]! / divisor;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const targetRow = a[row]!;
      const factor = targetRow[col]!;
      for (let j = col; j <= n; j++) targetRow[j] = targetRow[j]! - factor * pivotRow[j]!;
    }
  }
  return a.map((row) => row[n]!);
}

function fitHomography(pairs: { world: Point; image: Point }[]): Homography | null {
  const normal = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const rhs = new Array<number>(8).fill(0);
  for (const { world: p, image: q } of pairs) {
    const equations = [
      { row: [p.x, p.y, 1, 0, 0, 0, -q.x * p.x, -q.x * p.y], value: q.x },
      { row: [0, 0, 0, p.x, p.y, 1, -q.y * p.x, -q.y * p.y], value: q.y },
    ];
    for (const equation of equations) {
      for (let i = 0; i < 8; i++) {
        rhs[i] = rhs[i]! + equation.row[i]! * equation.value;
        const normalRow = normal[i]!;
        for (let j = 0; j < 8; j++) normalRow[j] = normalRow[j]! + equation.row[i]! * equation.row[j]!;
      }
    }
  }
  const result = solve(normal, rhs);
  return result ? result as Homography : null;
}

function project(h: Homography, point: Point): Point {
  const d = h[6] * point.x + h[7] * point.y + 1;
  return { x: (h[0] * point.x + h[1] * point.y + h[2]) / d, y: (h[3] * point.x + h[4] * point.y + h[5]) / d };
}

function slotWorld(layout: Layout, modules: number, slot: number): Point[] {
  const stride = modules + GRID_MARGIN_MODULES;
  const x = (slot % layout.cols) * stride;
  const y = Math.floor(slot / layout.cols) * stride;
  return [{ x, y }, { x: x + modules, y }, { x: x + modules, y: y + modules }, { x, y: y + modules }];
}

function bounds(quad: SymbolQuad): SymbolBox {
  const points = corners(quad);
  const left = Math.min(...points.map((p) => p.x));
  const top = Math.min(...points.map((p) => p.y));
  const right = Math.max(...points.map((p) => p.x));
  const bottom = Math.max(...points.map((p) => p.y));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export class GridLattice {
  state: GridState = "SEARCH";
  private identity = "";
  private observations: GridDetection[] = [];
  private candidate?: Candidate;
  private ranked: Candidate[] = [];
  private hypothesisIndex = 0;
  private switchedAt = 0;
  private lastHitAt = 0;
  private frameWidth = 1;
  private frameHeight = 1;

  get active(): boolean { return this.state !== "SEARCH"; }
  get locked(): boolean { return this.state === "GRID_LOCK" || this.state === "TRACK" || this.state === "PARTIAL_LOSS"; }

  reset(): void {
    this.state = "SEARCH";
    this.identity = "";
    this.observations = [];
    this.candidate = undefined;
    this.ranked = [];
    this.hypothesisIndex = 0;
    this.lastHitAt = 0;
  }

  accept(detection: GridDetection, frameWidth: number, frameHeight: number): GridSnapshot | null {
    if (!validGeometry(detection, frameWidth, frameHeight)) return null;
    const declaredLayout = detection.layoutId === undefined ? undefined : gridLayoutById(detection.layoutId);
    if (detection.layoutId !== undefined && (!declaredLayout || detection.slotIndex === undefined ||
      detection.slotIndex >= declaredLayout.cols * declaredLayout.rows || detection.gridEsi === undefined ||
      detection.gridEsi % (declaredLayout.cols * declaredLayout.rows) !== detection.slotIndex)) return null;
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
      this.state = "TRACK";
    } else {
      this.rankCandidates();
      this.candidate = this.ranked[this.hypothesisIndex % Math.max(1, this.ranked.length)];
      if (!this.candidate) return null;
      const distinct = this.candidate.observations.length;
      const codeCount = this.candidate.layout.cols * this.candidate.layout.rows;
      const largeSingle = Math.max(detection.box.w / this.frameWidth, detection.box.h / this.frameHeight) > 0.38;
      const scanCount = new Set(this.observations.map((item) => item.scanId)).size;
      // New senders put the exact layout and physical slot in every CRC-checked
      // packet. One decoded quad therefore fixes all eight homography degrees
      // of freedom and identifies the entire lattice immediately; waiting for
      // a second QR only traps acquisition behind the no-longer-needed global
      // detector. Legacy packets still earn a lock from repeated evidence.
      if (declaredLayout || distinct >= 2 || (codeCount === 1 && largeSingle && scanCount >= 2)) this.state = "GRID_LOCK";
      else this.state = "GRID_HYPOTHESIS";
    }
    return this.snapshot();
  }

  tick(now: number): GridSnapshot | null {
    if (this.active && this.state !== "REACQUIRE" && now - this.lastHitAt > WHOLE_GRID_LOSS_MS) {
      // Keep the last coherent transform while reacquiring. It provides the
      // bounded expanding ROIs; a new decoded packet will replace it.
      this.state = "REACQUIRE";
      return this.candidate ? this.snapshot() : null;
    }
    if (this.state === "GRID_HYPOTHESIS" && now - this.switchedAt > HYPOTHESIS_DWELL_MS && this.ranked.length > 1) {
      this.hypothesisIndex = (this.hypothesisIndex + 1) % this.ranked.length;
      this.candidate = this.ranked[this.hypothesisIndex];
      this.switchedAt = now;
      return this.snapshot();
    }
    return this.candidate ? this.snapshot() : null;
  }

  noteMissing(anyMissing: boolean): void {
    if (!this.locked) return;
    this.state = anyMissing ? "PARTIAL_LOSS" : "TRACK";
  }

  beginReacquire(): void {
    if (this.candidate) this.state = "REACQUIRE";
  }

  private rankCandidates(): void {
    const declared = this.observations.at(-1)?.layoutId;
    const layouts: Layout[] = declared === undefined
      ? [...GRID_LAYOUTS]
      : [gridLayoutById(declared)!];
    this.ranked = layouts.map((layout) => this.makeCandidate(layout)).filter((candidate): candidate is Candidate => Boolean(candidate));
    this.ranked.sort((a, b) => b.score - a.score);
    this.hypothesisIndex = 0;
    this.switchedAt = this.lastHitAt;
  }

  private makeCandidate(layout: Layout): Candidate | null {
    const count = layout.cols * layout.rows;
    const latest = new Map<number, GridDetection>();
    for (const observation of this.observations) {
      if (observation.layoutId !== undefined) {
        const declared = gridLayoutById(observation.layoutId);
        if (!declared || declared.cols !== layout.cols || declared.rows !== layout.rows) continue;
      }
      latest.set(observation.slotIndex ?? observation.seq % count, observation);
    }
    let observations = [...latest.values()];
    if (!observations.length) return null;
    const newest = observations.reduce((a, b) => a.at > b.at ? a : b);
    const pairsFor = (items: GridDetection[]) => items.flatMap((observation) => {
      const slot = observation.slotIndex ?? observation.seq % count;
      return slotWorld(layout, observation.modules, slot).map((world, index) => ({ world, image: corners(observation.quad)[index]! }));
    });
    // A moving camera invalidates old image coordinates, not the sender grid.
    // Seed from the newest identified QR, discard stale-transform outliers,
    // then refine from the coherent currently visible set.
    const seed = fitHomography(pairsFor([newest]));
    if (!seed) return null;
    observations = observations.filter((observation) => {
      const projected = slotWorld(layout, observation.modules, observation.slotIndex ?? observation.seq % count).map((point) => project(seed, point));
      const image = corners(observation.quad);
      const edge = Math.max(1, Math.sqrt(observation.box.w * observation.box.h));
      const residual = Math.sqrt(projected.reduce((sum, point, index) => sum + (point.x - image[index]!.x) ** 2 + (point.y - image[index]!.y) ** 2, 0) / 4) / edge;
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
    const edge = Math.max(1, Math.sqrt(observations[0]!.box.w * observations[0]!.box.h));
    const error = Math.sqrt(squaredError / pairs.length) / edge;
    if (error > 0.22) return null;
    let inside = 0;
    for (let slot = 0; slot < count; slot++) {
      const center = project(transform, slotWorld(layout, observations[0]!.modules, slot).reduce((p, q) => ({ x: p.x + q.x / 4, y: p.y + q.y / 4 }), { x: 0, y: 0 }));
      if (center.x > -edge * 0.5 && center.y > -edge * 0.5 && center.x < this.frameWidth + edge * 0.5 && center.y < this.frameHeight + edge * 0.5) inside++;
    }
    const observedFraction = Math.sqrt((observations[0]!.box.w * observations[0]!.box.h) / (this.frameWidth * this.frameHeight));
    const expectedFraction = 0.68 / Math.sqrt(count);
    const sizePrior = -Math.abs(Math.log(Math.max(0.01, observedFraction) / expectedFraction)) * 8;
    const score = observations.length * 100 - error * 80 + sizePrior + inside / count * 12;
    return { layout, transform, observations, score, error };
  }

  private snapshot(): GridSnapshot {
    const candidate = this.candidate!;
    const count = candidate.layout.cols * candidate.layout.rows;
    const modules = candidate.observations[0]!.modules;
    const decoded = new Set(candidate.observations.map((observation) => observation.slotIndex ?? observation.seq % count));
    const slots: GridSlot[] = [];
    for (let index = 0; index < count; index++) {
      const points = slotWorld(candidate.layout, modules, index).map((point) => project(candidate.transform, point));
      const quad: SymbolQuad = { topLeft: points[0]!, topRight: points[1]!, bottomRight: points[2]!, bottomLeft: points[3]! };
      slots.push({ index, quad, box: bounds(quad), decoded: decoded.has(index) });
    }
    // Confidence measures agreement among identified visible observations. It
    // is intentionally independent of how many sender slots lie offscreen.
    const confidence = Math.max(0, Math.min(1, candidate.observations.length / Math.min(3, candidate.observations.length + 1) * (1 - candidate.error)));
    return { state: this.state, confidence, layout: candidate.layout, modules, slots };
  }
}
