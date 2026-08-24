// Allocation-light similarity/translation estimator for Guided QR wall motion.
//
// The receiver runs this once per successful dense Guided camera frame. Keep all
// sample/inlier/median storage instance-owned so the estimator performs no array,
// Set, Map or per-sample object allocation at camera cadence. fit() returns one
// mutable result object owned by the accumulator; callers must consume/clone it
// synchronously before the next reset()/fit().

class GuidedMotionAccumulator {
  constructor(capacity = 128) {
    this.capacity = Math.max(2, Math.trunc(Number(capacity) || 128));
    this.dx = new Float64Array(this.capacity);
    this.dy = new Float64Array(this.capacity);
    this.x = new Float64Array(this.capacity);
    this.y = new Float64Array(this.capacity);
    this.edge = new Float64Array(this.capacity);
    this.work = new Float64Array(this.capacity);
    this.candidateInliers = new Uint16Array(this.capacity);
    this.bestInliers = new Uint16Array(this.capacity);
    this.count = 0;
    this.fitScratch = { a: 1, b: 0, tx: 0, ty: 0 };
    this.result = {
      kind: "translation",
      a: 1,
      b: 0,
      tx: 0,
      ty: 0,
      dx: 0,
      dy: 0,
      samples: 0,
      residual: 0,
      maxShift: 0
    };
  }

  reset() {
    this.count = 0;
    return this;
  }

  add(dx, dy, x, y, edge) {
    const index = this.count;
    if (index >= this.capacity) return false;
    this.dx[index] = dx;
    this.dy[index] = dy;
    this.x[index] = x;
    this.y[index] = y;
    this.edge[index] = edge;
    this.count = index + 1;
    return true;
  }

  residual(a, b, tx, ty, index) {
    const px = a * this.x[index] - b * this.y[index] + tx;
    const py = b * this.x[index] + a * this.y[index] + ty;
    return Math.hypot(
      px - (this.x[index] + this.dx[index]),
      py - (this.y[index] + this.dy[index])
    );
  }

  median(values, positiveFiniteOnly = false) {
    let count = 0;
    for (let index = 0; index < this.count; index++) {
      const value = values[index];
      if (positiveFiniteOnly && (!(value > 0) || !Number.isFinite(value))) continue;
      this.work[count++] = value;
    }
    if (!count) return NaN;
    // Counts are normally <=28, so in-place insertion sort over fixed scratch is
    // cheaper than allocating a subarray/view just to invoke TypedArray.sort().
    for (let index = 1; index < count; index++) {
      const value = this.work[index];
      let at = index;
      while (at > 0 && this.work[at - 1] > value) {
        this.work[at] = this.work[at - 1];
        at--;
      }
      this.work[at] = value;
    }
    const mid = count >> 1;
    return count & 1 ? this.work[mid] : (this.work[mid - 1] + this.work[mid]) / 2;
  }

  refitAll() {
    return this.refitIndices(null, this.count);
  }

  refitIndices(indices, count) {
    let meanX = 0, meanY = 0, meanQx = 0, meanQy = 0;
    for (let position = 0; position < count; position++) {
      const index = indices ? indices[position] : position;
      const x = this.x[index], y = this.y[index];
      meanX += x;
      meanY += y;
      meanQx += x + this.dx[index];
      meanQy += y + this.dy[index];
    }
    meanX /= count;
    meanY /= count;
    meanQx /= count;
    meanQy /= count;

    let denom = 0, real = 0, imag = 0;
    for (let position = 0; position < count; position++) {
      const index = indices ? indices[position] : position;
      const px = this.x[index] - meanX;
      const py = this.y[index] - meanY;
      const qx = this.x[index] + this.dx[index] - meanQx;
      const qy = this.y[index] + this.dy[index] - meanQy;
      denom += px * px + py * py;
      real += px * qx + py * qy;
      imag += px * qy - py * qx;
    }
    const a = denom > 1 ? real / denom : 1;
    const b = denom > 1 ? imag / denom : 0;
    const fit = this.fitScratch;
    fit.a = a;
    fit.b = b;
    fit.tx = meanQx - a * meanX + b * meanY;
    fit.ty = meanQy - b * meanX - a * meanY;
    return fit;
  }

  setResult(kind, a, b, tx, ty, dx, dy, samples, residual, maxShift) {
    const result = this.result;
    result.kind = kind;
    result.a = a;
    result.b = b;
    result.tx = tx;
    result.ty = ty;
    result.dx = dx;
    result.dy = dy;
    result.samples = samples;
    result.residual = residual;
    result.maxShift = maxShift;
    return result;
  }

  fit() {
    const count = this.count;
    if (!count) return null;

    if (count === 1) {
      const dx = this.dx[0], dy = this.dy[0];
      const shift = Math.hypot(dx, dy);
      return shift >= 0.08 && shift <= 4.5
        ? this.setResult("translation", 1, 0, dx, dy, dx, dy, 1, 0, shift)
        : null;
    }

    const medianEdgeValue = this.median(this.edge, true);
    const medianEdge = Number.isFinite(medianEdgeValue) ? medianEdgeValue : 64;
    const minSpan = Math.max(80, medianEdge * 1.25);
    const need = Math.max(2, Math.ceil(count * 0.6));

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let index = 0; index < count; index++) {
      minX = Math.min(minX, this.x[index]);
      minY = Math.min(minY, this.y[index]);
      maxX = Math.max(maxX, this.x[index]);
      maxY = Math.max(maxY, this.y[index]);
    }

    let bestCount = 0;
    let bestRms = Infinity;
    let bestUsesAll = false;

    // Healthy dense pages are overwhelmingly coherent. Preserve the original
    // O(n) all-sample fast path and only run pair-seeded RANSAC on a real outlier.
    if (Math.max(maxX - minX, maxY - minY) >= minSpan) {
      const fit = this.refitAll();
      const scale = Math.hypot(fit.a, fit.b);
      const rotation = Math.abs(Math.atan2(fit.b, fit.a));
      let squared = 0, maxResidual = 0, maxShift = 0;
      for (let index = 0; index < count; index++) {
        const residual = this.residual(fit.a, fit.b, fit.tx, fit.ty, index);
        const px = fit.a * this.x[index] - fit.b * this.y[index] + fit.tx;
        const py = fit.b * this.x[index] + fit.a * this.y[index] + fit.ty;
        squared += residual * residual;
        maxResidual = Math.max(maxResidual, residual);
        maxShift = Math.max(maxShift, Math.hypot(px - this.x[index], py - this.y[index]));
      }
      if (scale >= 0.975 && scale <= 1.025 && rotation <= 0.035 &&
          maxResidual <= 1.05 && maxShift <= 5.1) {
        bestCount = count;
        bestRms = Math.sqrt(squared / count);
        bestUsesAll = true;
      }
    }

    // Pair-seeded RANSAC is exactly the prior estimator, but candidate/best
    // inlier membership lives in fixed Uint16 scratch instead of filter() arrays.
    for (let i = 0; !bestCount && i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const ux = this.x[j] - this.x[i];
        const uy = this.y[j] - this.y[i];
        const denom = ux * ux + uy * uy;
        if (denom < minSpan * minSpan) continue;
        const vx = this.x[j] + this.dx[j] - (this.x[i] + this.dx[i]);
        const vy = this.y[j] + this.dy[j] - (this.y[i] + this.dy[i]);
        const a = (ux * vx + uy * vy) / denom;
        const b = (ux * vy - uy * vx) / denom;
        const scale = Math.hypot(a, b);
        const rotation = Math.atan2(b, a);
        if (scale < 0.975 || scale > 1.025 || Math.abs(rotation) > 0.035) continue;
        const tx = this.x[i] + this.dx[i] - a * this.x[i] + b * this.y[i];
        const ty = this.y[i] + this.dy[i] - b * this.x[i] - a * this.y[i];
        let inlierCount = 0;
        let squared = 0;
        for (let index = 0; index < count; index++) {
          const residual = this.residual(a, b, tx, ty, index);
          if (residual > 1.05) continue;
          this.candidateInliers[inlierCount++] = index;
          squared += residual * residual;
        }
        if (inlierCount < need) continue;
        const rms = Math.sqrt(squared / inlierCount);
        if (inlierCount > bestCount || inlierCount === bestCount && rms < bestRms) {
          bestCount = inlierCount;
          bestRms = rms;
          bestUsesAll = false;
          for (let index = 0; index < inlierCount; index++)
            this.bestInliers[index] = this.candidateInliers[index];
        }
      }
    }

    if (bestCount) {
      const fit = bestUsesAll ? this.refitAll() : this.refitIndices(this.bestInliers, bestCount);
      const scale = Math.hypot(fit.a, fit.b);
      const rotation = Math.atan2(fit.b, fit.a);
      let maxResidual = 0, maxShift = 0, sumDx = 0, sumDy = 0, squared = 0;
      for (let position = 0; position < bestCount; position++) {
        const index = bestUsesAll ? position : this.bestInliers[position];
        const residual = this.residual(fit.a, fit.b, fit.tx, fit.ty, index);
        const px = fit.a * this.x[index] - fit.b * this.y[index] + fit.tx;
        const py = fit.b * this.x[index] + fit.a * this.y[index] + fit.ty;
        const dx = px - this.x[index];
        const dy = py - this.y[index];
        squared += residual * residual;
        maxResidual = Math.max(maxResidual, residual);
        maxShift = Math.max(maxShift, Math.hypot(dx, dy));
        sumDx += dx;
        sumDy += dy;
      }
      if (scale >= 0.975 && scale <= 1.025 && Math.abs(rotation) <= 0.035 &&
          maxResidual <= 1.15 && maxShift <= 5.1) {
        return this.setResult(
          "similarity",
          fit.a,
          fit.b,
          fit.tx,
          fit.ty,
          sumDx / bestCount,
          sumDy / bestCount,
          bestCount,
          Math.sqrt(squared / bestCount),
          maxShift
        );
      }
    }

    // Preserve the original conservative translation consensus fallback.
    const dx = this.median(this.dx);
    const dy = this.median(this.dy);
    let coherentCount = 0;
    let maxResidual = 0;
    for (let index = 0; index < count; index++) {
      const residual = Math.hypot(this.dx[index] - dx, this.dy[index] - dy);
      if (residual > 0.75) continue;
      coherentCount++;
      maxResidual = Math.max(maxResidual, residual);
    }
    const maxShift = Math.hypot(dx, dy);
    return coherentCount >= need && maxShift <= 4.5
      ? this.setResult("translation", 1, 0, dx, dy, dx, dy, coherentCount, maxResidual, maxShift)
      : null;
  }
}

export { GuidedMotionAccumulator };
