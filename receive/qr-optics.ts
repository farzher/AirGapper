import type { SymbolQuad } from "../shared/worker-pool";

export interface QrOpticalTarget {
  quad: SymbolQuad;
  modules: number;
}

export interface QrOpticalMetrics {
  confidence: number;
  focusScore: number;
  exposureScore: number;
  transitionWidthModules: number;
  blackLevel: number;
  whiteLevel: number;
  separation: number;
  noise: number;
  clipping: number;
  banding: number;
  tiles: number;
  sampledModules: number;
}

const MAX_MODULE_SAMPLES = 640;
const MAX_EDGE_SAMPLES = 128;
const MAX_TILES = 5;

function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }

export class StaticQrOpticsAnalyzer {
  private readonly black = new Float32Array(MAX_MODULE_SAMPLES);
  private readonly white = new Float32Array(MAX_MODULE_SAMPLES);
  private readonly edges = new Float32Array(MAX_EDGE_SAMPLES);
  private readonly tileFocus = new Float32Array(MAX_TILES);
  private readonly tileExposure = new Float32Array(MAX_TILES);
  private readonly tileConfidence = new Float32Array(MAX_TILES);
  private readonly tileTransition = new Float32Array(MAX_TILES);
  private readonly tileBlack = new Float32Array(MAX_TILES);
  private readonly tileWhite = new Float32Array(MAX_TILES);
  private readonly tileSeparation = new Float32Array(MAX_TILES);
  private readonly tileNoise = new Float32Array(MAX_TILES);
  private readonly tileClipping = new Float32Array(MAX_TILES);
  private readonly tileBanding = new Float32Array(MAX_TILES);
  private readonly transform = new Float64Array(8);
  private blackCount = 0;
  private whiteCount = 0;
  private edgeCount = 0;
  private correct = 0;
  private noiseSquared = 0;
  private noiseCount = 0;

  analyze(
    image: ImageData,
    targets: readonly QrOpticalTarget[],
    offsetX = 0,
    offsetY = 0,
  ): QrOpticalMetrics | undefined {
    let tileCount = 0;
    const stride = Math.max(1, Math.ceil(targets.length / MAX_TILES));
    for (let index = 0; index < targets.length && tileCount < MAX_TILES; index += stride) {
      const target = targets[index]!;
      if (target.modules < 21 || target.modules > 177 || target.modules % 4 !== 1) continue;
      if (!this.setTransform(target.quad, target.modules, offsetX, offsetY)) continue;
      const metric = this.analyzeTarget(image, target.modules);
      if (!metric) continue;
      this.tileFocus[tileCount] = metric.focusScore;
      this.tileExposure[tileCount] = metric.exposureScore;
      this.tileConfidence[tileCount] = metric.confidence;
      this.tileTransition[tileCount] = metric.transitionWidthModules;
      this.tileBlack[tileCount] = metric.blackLevel;
      this.tileWhite[tileCount] = metric.whiteLevel;
      this.tileSeparation[tileCount] = metric.separation;
      this.tileNoise[tileCount] = metric.noise;
      this.tileClipping[tileCount] = metric.clipping;
      this.tileBanding[tileCount] = metric.banding;
      tileCount++;
    }
    if (!tileCount) return undefined;
    const black = this.median(this.tileBlack, tileCount);
    const white = this.median(this.tileWhite, tileCount);
    const separation = this.median(this.tileSeparation, tileCount);
    let spread = 0;
    for (let i = 0; i < tileCount; i++) {
      spread += Math.abs(this.tileSeparation[i]! - separation) +
        0.35 * Math.abs((this.tileWhite[i]! + this.tileBlack[i]!) - (white + black));
    }
    const banding = Math.max(
      this.median(this.tileBanding, tileCount),
      clamp01(spread / tileCount / Math.max(24, separation) / 1.6),
    );
    return {
      confidence: this.median(this.tileConfidence, tileCount),
      focusScore: this.median(this.tileFocus, tileCount),
      exposureScore: clamp01(this.median(this.tileExposure, tileCount) - banding * 0.18),
      transitionWidthModules: this.median(this.tileTransition, tileCount),
      blackLevel: black,
      whiteLevel: white,
      separation,
      noise: this.median(this.tileNoise, tileCount),
      clipping: this.median(this.tileClipping, tileCount),
      banding,
      tiles: tileCount,
      sampledModules: this.blackCount + this.whiteCount,
    };
  }

  private analyzeTarget(image: ImageData, modules: number): QrOpticalMetrics | undefined {
    this.blackCount = 0;
    this.whiteCount = 0;
    this.edgeCount = 0;
    this.correct = 0;
    this.noiseSquared = 0;
    this.noiseCount = 0;

    this.finder(image, 0, 0);
    this.finder(image, modules - 7, 0);
    this.finder(image, 0, modules - 7);
    this.separators(image, modules);
    for (let p = 8; p <= modules - 9; p++) {
      this.module(image, p, 6, (p & 1) === 0);
      this.module(image, 6, p, (p & 1) === 0);
    }
    const centers = this.alignmentCenters(modules);
    for (let yi = 0; yi < centers.length; yi++) for (let xi = 0; xi < centers.length; xi++) {
      const cx = centers[xi]!, cy = centers[yi]!;
      if ((cx < 10 && cy < 10) || (cx > modules - 11 && cy < 10) || (cx < 10 && cy > modules - 11)) continue;
      for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
        this.module(image, cx + x, cy + y, Math.max(Math.abs(x), Math.abs(y)) === 2 || (x === 0 && y === 0));
      }
    }
    if (this.blackCount < 30 || this.whiteCount < 20) return undefined;
    const black = this.median(this.black, this.blackCount);
    const white = this.median(this.white, this.whiteCount);
    const separation = white - black;
    if (separation < 2) return undefined;
    const midpoint = (black + white) / 2;
    for (let i = 0; i < this.blackCount; i++) if (this.black[i]! < midpoint) this.correct++;
    for (let i = 0; i < this.whiteCount; i++) if (this.white[i]! > midpoint) this.correct++;
    const confidence = this.correct / (this.blackCount + this.whiteCount);

    this.finderEdges(image, 0, 0, black, white);
    this.finderEdges(image, modules - 7, 0, black, white);
    this.finderEdges(image, 0, modules - 7, black, white);
    for (let p = 8; p < modules - 9 && this.edgeCount < MAX_EDGE_SAMPLES; p += 2) {
      this.edge(image, p, 6, p + 1, 6, true, black, white);
      this.edge(image, 6, p, 6, p + 1, true, black, white);
    }
    const transition = this.edgeCount ? this.median(this.edges, this.edgeCount) : 1;
    const noise = Math.sqrt(this.noiseSquared / Math.max(1, this.noiseCount));
    let clipped = 0;
    for (let i = 0; i < this.blackCount; i++) if (this.black[i]! <= 3) clipped++;
    for (let i = 0; i < this.whiteCount; i++) if (this.white[i]! >= 252) clipped++;
    const clipping = clipped / (this.blackCount + this.whiteCount);
    const finderSignals = [
      this.luma(image, 7.5, 3.5) - this.luma(image, 3.5, 3.5),
      this.luma(image, modules - 3.5, 7.5) - this.luma(image, modules - 3.5, 3.5),
      this.luma(image, 7.5, modules - 3.5) - this.luma(image, 3.5, modules - 3.5),
    ];
    const banding = finderSignals.some((value) => !Number.isFinite(value)) ? 1 : clamp01(
      (Math.max(...finderSignals) - Math.min(...finderSignals)) / Math.max(20, separation) / 1.5,
    );
    const focusScore = clamp01((0.76 - transition) / 0.62) * clamp01((confidence - 0.55) / 0.4);
    const signal = clamp01((separation - 35) / 95);
    const exposureScore = signal * clamp01((confidence - 0.55) / 0.4) * clamp01(1 - noise / Math.max(18, separation * 0.32)) * (1 - clipping * 0.08) * (1 - banding * 0.3);
    return {
      confidence, focusScore, exposureScore, transitionWidthModules: transition,
      blackLevel: black, whiteLevel: white, separation, noise, clipping, banding,
      tiles: 1, sampledModules: this.blackCount + this.whiteCount,
    };
  }

  private finder(image: ImageData, ox: number, oy: number): void {
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      const dark = x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4);
      this.module(image, ox + x, oy + y, dark);
    }
  }

  private separators(image: ImageData, modules: number): void {
    for (let p = 0; p < 8; p++) {
      this.module(image, 7, p, false); this.module(image, p, 7, false);
      this.module(image, modules - 8, p, false); this.module(image, modules - 1 - p, 7, false);
      this.module(image, 7, modules - 1 - p, false); this.module(image, p, modules - 8, false);
    }
  }

  private finderEdges(image: ImageData, ox: number, oy: number, black: number, white: number): void {
    for (let y = 0; y < 7; y++) for (let x = 0; x < 6; x++) {
      const a = x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4);
      const nx = x + 1;
      const b = nx === 0 || nx === 6 || y === 0 || y === 6 || (nx >= 2 && nx <= 4 && y >= 2 && y <= 4);
      if (a !== b) this.edge(image, ox + x, oy + y, ox + nx, oy + y, a, black, white);
    }
    for (let y = 0; y < 6; y++) for (let x = 0; x < 7; x++) {
      const a = x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4);
      const ny = y + 1;
      const b = x === 0 || x === 6 || ny === 0 || ny === 6 || (x >= 2 && x <= 4 && ny >= 2 && ny <= 4);
      if (a !== b) this.edge(image, ox + x, oy + y, ox + x, oy + ny, a, black, white);
    }
  }

  private module(image: ImageData, x: number, y: number, dark: boolean): void {
    if (this.blackCount + this.whiteCount >= MAX_MODULE_SAMPLES) return;
    const center = this.luma(image, x + 0.5, y + 0.5);
    if (center < 0) return;
    if (dark) this.black[this.blackCount++] = center;
    else this.white[this.whiteCount++] = center;
    if (((x + y) & 3) === 0) {
      const a = this.luma(image, x + 0.35, y + 0.5);
      const b = this.luma(image, x + 0.65, y + 0.5);
      if (a >= 0 && b >= 0) {
        this.noiseSquared += (a - center) ** 2 + (b - center) ** 2;
        this.noiseCount += 2;
      }
    }
  }

  private edge(
    image: ImageData, ax: number, ay: number, bx: number, by: number,
    aDark: boolean, black: number, white: number,
  ): void {
    if (this.edgeCount >= MAX_EDGE_SAMPLES) return;
    let lowAt = NaN, highAt = NaN;
    for (let i = 0; i < 9; i++) {
      const t = -0.5 + i / 8;
      const mx = (ax + bx + 1) / 2 + (bx - ax) * t;
      const my = (ay + by + 1) / 2 + (by - ay) * t;
      const value = this.luma(image, mx, my);
      if (value < 0) return;
      const normalized = clamp01((value - black) / Math.max(1, white - black));
      const oriented = aDark ? normalized : 1 - normalized;
      if (!Number.isFinite(lowAt) && oriented >= 0.2) lowAt = t;
      if (!Number.isFinite(highAt) && oriented >= 0.8) highAt = t;
    }
    if (Number.isFinite(lowAt) && Number.isFinite(highAt)) this.edges[this.edgeCount++] = Math.max(0.04, highAt - lowAt);
  }

  private setTransform(quad: SymbolQuad, modules: number, offsetX: number, offsetY: number): boolean {
    const p0 = quad.topLeft, p1 = quad.topRight, p2 = quad.bottomRight, p3 = quad.bottomLeft;
    const sx = p0.x - p1.x + p2.x - p3.x;
    const sy = p0.y - p1.y + p2.y - p3.y;
    const dx1x = p1.x - p2.x, dx1y = p1.y - p2.y;
    const dx2x = p3.x - p2.x, dx2y = p3.y - p2.y;
    const denominator = dx1x * dx2y - dx2x * dx1y;
    const g = Math.abs(denominator) < 1e-8 ? 0 : (sx * dx2y - dx2x * sy) / denominator;
    const h = Math.abs(denominator) < 1e-8 ? 0 : (dx1x * sy - sx * dx1y) / denominator;
    const t = this.transform;
    t[0] = (p1.x - p0.x + g * p1.x) / modules;
    t[1] = (p3.x - p0.x + h * p3.x) / modules;
    t[2] = p0.x - offsetX;
    t[3] = (p1.y - p0.y + g * p1.y) / modules;
    t[4] = (p3.y - p0.y + h * p3.y) / modules;
    t[5] = p0.y - offsetY;
    t[6] = g / modules;
    t[7] = h / modules;
    return [...quadPoints(quad)].every((value) => Number.isFinite(value));
  }

  private luma(image: ImageData, mx: number, my: number): number {
    const t = this.transform;
    const d = t[6]! * mx + t[7]! * my + 1;
    const x = (t[0]! * mx + t[1]! * my + t[2]!) / d;
    const y = (t[3]! * mx + t[4]! * my + t[5]!) / d;
    if (x < 0 || y < 0 || x >= image.width - 1 || y >= image.height - 1) return -1;
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const data = image.data, width = image.width;
    const p00 = (iy * width + ix) * 4;
    const p10 = p00 + 4;
    const p01 = p00 + width * 4;
    const p11 = p01 + 4;
    const at = (index: number) => (data[index]! * 54 + data[index + 1]! * 183 + data[index + 2]! * 19) / 256;
    const top = at(p00) * (1 - fx) + at(p10) * fx;
    const bottom = at(p01) * (1 - fx) + at(p11) * fx;
    return top * (1 - fy) + bottom * fy;
  }

  private alignmentCenters(modules: number): number[] {
    const version = (modules - 17) / 4;
    if (version <= 1) return [];
    const count = Math.floor(version / 7) + 2;
    const step = version === 32 ? 26 : Math.ceil((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;
    const result = new Array<number>(count);
    result[0] = 6;
    for (let i = 1; i < count; i++) result[i] = modules - 7 - (count - 1 - i) * step;
    return result;
  }

  private median(values: Float32Array, count: number): number {
    const view = values.subarray(0, count);
    view.sort();
    const middle = count >> 1;
    return count & 1 ? view[middle]! : (view[middle - 1]! + view[middle]!) / 2;
  }
}

function quadPoints(quad: SymbolQuad): number[] {
  return [
    quad.topLeft.x, quad.topLeft.y, quad.topRight.x, quad.topRight.y,
    quad.bottomRight.x, quad.bottomRight.y, quad.bottomLeft.x, quad.bottomLeft.y,
  ];
}
