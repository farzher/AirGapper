const MAX_MODULE_SAMPLES = 640;
const MAX_EDGE_SAMPLES = 128;
const MAX_TILES = 5;
function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}
function validQuad(quad) {
  if (!quad) return false;
  return [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft].every((point) =>
    point && Number.isFinite(point.x) && Number.isFinite(point.y)
  );
}
class StaticQrOpticsAnalyzer {
  constructor() {
    this.black = new Float32Array(MAX_MODULE_SAMPLES);
    this.white = new Float32Array(MAX_MODULE_SAMPLES);
    this.edges = new Float32Array(MAX_EDGE_SAMPLES);
    this.tileFocus = new Float32Array(MAX_TILES);
    this.tileExposure = new Float32Array(MAX_TILES);
    this.tileConfidence = new Float32Array(MAX_TILES);
    this.tileTransition = new Float32Array(MAX_TILES);
    this.tileBlack = new Float32Array(MAX_TILES);
    this.tileWhite = new Float32Array(MAX_TILES);
    this.tileSeparation = new Float32Array(MAX_TILES);
    this.tileNoise = new Float32Array(MAX_TILES);
    this.tileClipping = new Float32Array(MAX_TILES);
    this.tileBanding = new Float32Array(MAX_TILES);
    this.tileTemporal = new Float32Array(MAX_TILES);
    this.transform = new Float64Array(8);
    this.blackCount = 0;
    this.whiteCount = 0;
    this.edgeCount = 0;
    this.correct = 0;
    this.noiseSquared = 0;
    this.noiseCount = 0;
  }
  analyze(image, targets, offsetX = 0, offsetY = 0) {
    let tileCount = 0;
    const stride = Math.max(1, Math.ceil(targets.length / MAX_TILES));
    for (let index = 0; index < targets.length && tileCount < MAX_TILES; index += stride) {
      const target = targets[index];
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
      this.tileTemporal[tileCount] = metric.temporalContamination;
      tileCount++;
    }
    if (!tileCount) return void 0;
    const black = this.median(this.tileBlack, tileCount);
    const white = this.median(this.tileWhite, tileCount);
    const separation = this.median(this.tileSeparation, tileCount);
    let spread = 0;
    for (let i = 0; i < tileCount; i++) {
      spread += Math.abs(this.tileSeparation[i] - separation) + 0.35 * Math.abs(this.tileWhite[i] + this.tileBlack[i] - (white + black));
    }
    const banding = Math.max(
      this.median(this.tileBanding, tileCount),
      clamp01(spread / tileCount / Math.max(24, separation) / 1.6)
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
      temporalContamination: this.median(this.tileTemporal, tileCount),
      tiles: tileCount,
      sampledModules: this.blackCount + this.whiteCount
    };
  }
  /**
   * Fallback used only while Optimize has not decoded a QR yet. The sender is a
   * high-contrast black/white display, so percentile contrast over the central
   * image gives us a useful exposure signal without pretending arbitrary scene
   * brightness is a QR metric. As soon as one QR is decoded, Optimize switches
   * to analyze(), which is much more precise because it samples known function
   * modules.
   */
  analyzeGlobal(image) {
    const width = image.width, height = image.height;
    if (width < 32 || height < 32) return void 0;
    const x0 = Math.floor(width * 0.08), x1 = Math.ceil(width * 0.92);
    const y0 = Math.floor(height * 0.08), y1 = Math.ceil(height * 0.92);
    const area = Math.max(1, (x1 - x0) * (y1 - y0));
    const stride = Math.max(1, Math.floor(Math.sqrt(area / 14e3)));
    const histogram = new Uint32Array(256);
    const gradientHistogram = new Uint32Array(256);
    const data = image.data;
    const lumaAt = (x, y) => {
      const i = (y * width + x) * 4;
      return data[i] * 54 + data[i + 1] * 183 + data[i + 2] * 19 >> 8;
    };
    let count = 0, clipped = 0, gradientCount = 0;
    for (let y = y0; y < y1; y += stride) for (let x = x0; x < x1; x += stride) {
      const value = lumaAt(x, y);
      histogram[value] = histogram[value] + 1;
      if (value <= 3 || value >= 252) clipped++;
      count++;
      if (x + stride < x1) {
        const gradient = Math.min(255, Math.abs(value - lumaAt(x + stride, y)));
        gradientHistogram[gradient] = gradientHistogram[gradient] + 1;
        gradientCount++;
      }
      if (y + stride < y1) {
        const gradient = Math.min(255, Math.abs(value - lumaAt(x, y + stride)));
        gradientHistogram[gradient] = gradientHistogram[gradient] + 1;
        gradientCount++;
      }
    }
    if (count < 64) return void 0;
    const percentile = (hist, total, fraction) => {
      const target = total * fraction;
      let sum = 0;
      for (let i = 0; i < hist.length; i++) {
        sum += hist[i];
        if (sum >= target) return i;
      }
      return hist.length - 1;
    };
    const black = percentile(histogram, count, 0.12);
    const white = percentile(histogram, count, 0.88);
    const separation = white - black;
    if (separation < 2) return void 0;
    const near = separation * 0.23;
    let binaryLike = 0, noiseSquared = 0;
    for (let value = 0; value < 256; value++) {
      const n = histogram[value];
      if (!n) continue;
      const residual = Math.min(Math.abs(value - black), Math.abs(value - white));
      noiseSquared += residual * residual * n;
      if (value <= black + near || value >= white - near) binaryLike += n;
    }
    const noise = Math.sqrt(noiseSquared / count);
    const confidence = clamp01(binaryLike / count * clamp01((separation - 12) / 42));
    const edge90 = gradientCount ? percentile(gradientHistogram, gradientCount, 0.9) : 0;
    const edgeStrength = edge90 / Math.max(1, separation);
    const focusScore = clamp01((edgeStrength - 0.1) / 0.52) * clamp01((separation - 18) / 30);
    const clipping = clipped / count;
    const signal = clamp01((separation - 28) / 90);
    const exposureScore = signal * clamp01((confidence - 0.45) / 0.5) * clamp01(1 - noise / Math.max(24, separation * 0.38)) * (1 - clipping * 0.2);
    return {
      confidence,
      focusScore,
      exposureScore,
      transitionWidthModules: 1 - focusScore,
      blackLevel: black,
      whiteLevel: white,
      separation,
      noise,
      clipping,
      banding: 0,
      temporalContamination: 0,
      tiles: 0,
      sampledModules: count
    };
  }
  analyzeTarget(image, modules) {
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
      const cx = centers[xi], cy = centers[yi];
      if (cx < 10 && cy < 10 || cx > modules - 11 && cy < 10 || cx < 10 && cy > modules - 11) continue;
      for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
        this.module(image, cx + x, cy + y, Math.max(Math.abs(x), Math.abs(y)) === 2 || x === 0 && y === 0);
      }
    }
    if (this.blackCount < 30 || this.whiteCount < 20) return void 0;
    const black = this.median(this.black, this.blackCount);
    const white = this.median(this.white, this.whiteCount);
    const separation = white - black;
    if (separation < 2) return void 0;
    const midpoint = (black + white) / 2;
    for (let i = 0; i < this.blackCount; i++) if (this.black[i] < midpoint) this.correct++;
    for (let i = 0; i < this.whiteCount; i++) if (this.white[i] > midpoint) this.correct++;
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
    const temporalContamination = this.contentNoise(image, modules, black, white);
    let clipped = 0;
    for (let i = 0; i < this.blackCount; i++) if (this.black[i] <= 3) clipped++;
    for (let i = 0; i < this.whiteCount; i++) if (this.white[i] >= 252) clipped++;
    const clipping = clipped / (this.blackCount + this.whiteCount);
    const finderSignals = [
      this.luma(image, 7.5, 3.5) - this.luma(image, 3.5, 3.5),
      this.luma(image, modules - 3.5, 7.5) - this.luma(image, modules - 3.5, 3.5),
      this.luma(image, 7.5, modules - 3.5) - this.luma(image, 3.5, modules - 3.5)
    ];
    const banding = finderSignals.some((value) => !Number.isFinite(value)) ? 1 : clamp01(
      (Math.max(...finderSignals) - Math.min(...finderSignals)) / Math.max(20, separation) / 1.5
    );
    const contrastGate = clamp01((separation - 18) / 32);
    const focusScore = clamp01((0.76 - transition) / 0.62) * contrastGate;
    const signal = clamp01((separation - 35) / 95);
    const exposureScore = signal * clamp01((confidence - 0.55) / 0.4) * clamp01(1 - noise / Math.max(18, separation * 0.32)) * (1 - clipping * 0.25) * (1 - banding * 0.3);
    return {
      confidence,
      focusScore,
      exposureScore,
      transitionWidthModules: transition,
      blackLevel: black,
      whiteLevel: white,
      separation,
      noise,
      clipping,
      banding,
      temporalContamination,
      tiles: 1,
      sampledModules: this.blackCount + this.whiteCount
    };
  }
  contentNoise(image, modules, black, white) {
    const stride = Math.max(1, Math.ceil(modules / 16));
    let squared = 0;
    let count = 0;
    for (let y = 0; y < modules; y += stride) for (let x = 0; x < modules; x += stride) {
      const value = this.luma(image, x + 0.5, y + 0.5);
      if (value < 0) continue;
      const residual = Math.min(Math.abs(value - black), Math.abs(value - white));
      squared += residual * residual;
      count++;
    }
    return Math.sqrt(squared / Math.max(1, count));
  }
  finder(image, ox, oy) {
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      const dark = x === 0 || x === 6 || y === 0 || y === 6 || x >= 2 && x <= 4 && y >= 2 && y <= 4;
      this.module(image, ox + x, oy + y, dark);
    }
  }
  separators(image, modules) {
    for (let p = 0; p < 8; p++) {
      this.module(image, 7, p, false);
      this.module(image, p, 7, false);
      this.module(image, modules - 8, p, false);
      this.module(image, modules - 1 - p, 7, false);
      this.module(image, 7, modules - 1 - p, false);
      this.module(image, p, modules - 8, false);
    }
  }
  finderEdges(image, ox, oy, black, white) {
    for (let y = 0; y < 7; y++) for (let x = 0; x < 6; x++) {
      const a = x === 0 || x === 6 || y === 0 || y === 6 || x >= 2 && x <= 4 && y >= 2 && y <= 4;
      const nx = x + 1;
      const b = nx === 0 || nx === 6 || y === 0 || y === 6 || nx >= 2 && nx <= 4 && y >= 2 && y <= 4;
      if (a !== b) this.edge(image, ox + x, oy + y, ox + nx, oy + y, a, black, white);
    }
    for (let y = 0; y < 6; y++) for (let x = 0; x < 7; x++) {
      const a = x === 0 || x === 6 || y === 0 || y === 6 || x >= 2 && x <= 4 && y >= 2 && y <= 4;
      const ny = y + 1;
      const b = x === 0 || x === 6 || ny === 0 || ny === 6 || x >= 2 && x <= 4 && ny >= 2 && ny <= 4;
      if (a !== b) this.edge(image, ox + x, oy + y, ox + x, oy + ny, a, black, white);
    }
  }
  module(image, x, y, dark) {
    if (this.blackCount + this.whiteCount >= MAX_MODULE_SAMPLES) return;
    const center = this.luma(image, x + 0.5, y + 0.5);
    if (center < 0) return;
    if (dark) this.black[this.blackCount++] = center;
    else this.white[this.whiteCount++] = center;
    if ((x + y & 3) === 0) {
      const a = this.luma(image, x + 0.35, y + 0.5);
      const b = this.luma(image, x + 0.65, y + 0.5);
      if (a >= 0 && b >= 0) {
        this.noiseSquared += (a - center) ** 2 + (b - center) ** 2;
        this.noiseCount += 2;
      }
    }
  }
  edge(image, ax, ay, bx, by, aDark, black, white) {
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
  setTransform(quad, modules, offsetX, offsetY) {
    if (!validQuad(quad)) return false;
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
  luma(image, mx, my) {
    const t = this.transform;
    const d = t[6] * mx + t[7] * my + 1;
    const x = (t[0] * mx + t[1] * my + t[2]) / d;
    const y = (t[3] * mx + t[4] * my + t[5]) / d;
    if (x < 0 || y < 0 || x >= image.width - 1 || y >= image.height - 1) return -1;
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const data = image.data, width = image.width;
    const p00 = (iy * width + ix) * 4;
    const p10 = p00 + 4;
    const p01 = p00 + width * 4;
    const p11 = p01 + 4;
    const at = (index) => (data[index] * 54 + data[index + 1] * 183 + data[index + 2] * 19) / 256;
    const top = at(p00) * (1 - fx) + at(p10) * fx;
    const bottom = at(p01) * (1 - fx) + at(p11) * fx;
    return top * (1 - fy) + bottom * fy;
  }
  alignmentCenters(modules) {
    const version = (modules - 17) / 4;
    if (version <= 1) return [];
    const count = Math.floor(version / 7) + 2;
    const step = version === 32 ? 26 : Math.floor((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;
    const result = new Array(count);
    result[0] = 6;
    for (let i = 1; i < count; i++) result[i] = modules - 7 - (count - 1 - i) * step;
    return result;
  }
  median(values, count) {
    const view = values.subarray(0, count);
    view.sort();
    const middle = count >> 1;
    return count & 1 ? view[middle] : (view[middle - 1] + view[middle]) / 2;
  }
}
function quadPoints(quad) {
  if (!validQuad(quad)) return [];
  return [
    quad.topLeft.x,
    quad.topLeft.y,
    quad.topRight.x,
    quad.topRight.y,
    quad.bottomRight.x,
    quad.bottomRight.y,
    quad.bottomLeft.x,
    quad.bottomLeft.y
  ];
}
export {
  StaticQrOpticsAnalyzer
};
