from pathlib import Path


def rep(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'missing anchor {path}: {old[:140]}')
    p.write_text(s.replace(old, new, 1))


# Version/cache.
rep('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.280";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.281";')
rep('main.js', 'const APP_BUILD = "v0.5.280";', 'const APP_BUILD = "v0.5.281";')
p = Path('index.html')
s = p.read_text()
if 'v0.5.280' not in s:
    raise SystemExit('index version anchor missing')
p.write_text(s.replace('v0.5.280', 'v0.5.281'))
rep('sw.js', 'airgapper-static-js-v228', 'airgapper-static-js-v229')


# Keep the existing completion-paint fix in this candidate.
p = Path('receive/main.js')
s = p.read_text()
old = '''function paintTransferComplete() {
  bar.style.width = "100%";
  progressEl.setAttribute("aria-valuenow", "100");
  progressLabel.textContent = "100%";
  transferSizeLabel.textContent = "";
  etaLabel.textContent = "Finalizing…";
}'''
new = '''function paintTransferComplete() {
  // Snap, do not animate, the final 100%. Expensive assembly immediately after
  // completion can block animation frames for large transfers; leaving the
  // normal width transition active makes the bar appear stuck around 97-99%.
  bar.classList.add("finalizing");
  bar.getAnimations?.().forEach((animation) => animation.cancel());
  bar.style.width = "100%";
  progressEl.setAttribute("aria-valuenow", "100");
  progressLabel.textContent = "100%";
  transferSizeLabel.textContent = "";
  etaLabel.textContent = "Finalizing…";
}'''
if old not in s:
    raise SystemExit('paintTransferComplete anchor missing')
s = s.replace(old, new, 1)
old = '''function waitForProgressPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}'''
new = '''async function waitForProgressPaint() {
  // rAF callbacks run before paint and promise continuations are microtasks, so
  // a timer task after the rAF gives the compositor an unconditional paint
  // opportunity before we enter synchronous payload assembly.
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await new Promise((resolve) => setTimeout(resolve, 0));
}'''
if old not in s:
    raise SystemExit('waitForProgressPaint anchor missing')
s = s.replace(old, new, 1)
old = '''  bar.style.width = "0";
  bar.classList.remove("error");'''
new = '''  bar.style.width = "0";
  bar.classList.remove("error", "finalizing");'''
if old not in s:
    raise SystemExit('bar reset anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)

p = Path('shared/style.css')
s = p.read_text()
old = '.progress > div { height: 100%; width: 0; background: var(--ink); border-radius: inherit; transition: width .22s ease-out; animation: progress-pulse 1.4s ease-in-out infinite; }\n.progress > div.error { background: var(--bad); animation: none; }'
new = '.progress > div { height: 100%; width: 0; background: var(--ink); border-radius: inherit; transition: width .22s ease-out; animation: progress-pulse 1.4s ease-in-out infinite; }\n.progress > div.finalizing { transition: none; animation: none; opacity: 1; }\n.progress > div.error { background: var(--bad); animation: none; }'
if old not in s:
    raise SystemExit('progress CSS anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)


# Guided Turbo already calculates a CRC-backed local translation residual for
# every successful tracked QR. A rigid translation consensus deliberately threw
# away the useful pattern where residuals vary smoothly across the wall under
# rotation/scale. Preserve each successful QR's center + residual so JS can fit
# a tiny current-frame similarity transform.
p = Path('receive/worker.js')
s = p.read_text()
old = '''        if (Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) <= 4.75)
          predictedMotion.push({ dx, dy });'''
new = '''        if (Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) <= 4.75) {
          const points = [input.quad.topLeft, input.quad.topRight, input.quad.bottomRight, input.quad.bottomLeft];
          const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
          const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
          const edge = points.reduce((sum, point, index) => {
            const next = points[(index + 1) % points.length];
            return sum + Math.hypot(next.x - point.x, next.y - point.y);
          }, 0) / points.length;
          predictedMotion.push({ dx, dy, x, y, edge, slot });
        }'''
if old not in s:
    raise SystemExit('guided predicted motion sample anchor missing')
s = s.replace(old, new, 1)

old = '''  // Full measured geometry wins. Otherwise, two or more CRC-valid predicted
  // QRs agreeing on the same small current-frame offset are strong wall-motion
  // evidence. Median + tight consensus rejects per-slot/local residual outliers.
  if (!measuredGeometryCount && predictedMotion.length >= 2) {
    const median = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    const dx = median(predictedMotion.map((item) => item.dx));
    const dy = median(predictedMotion.map((item) => item.dy));
    const coherent = predictedMotion.filter((item) => Math.hypot(item.dx - dx, item.dy - dy) <= 0.75);
    const need = Math.max(2, Math.ceil(predictedMotion.length * 0.6));
    if (coherent.length >= need && Math.hypot(dx, dy) <= 4.5) {
      const wallMotion = { dx, dy, samples: coherent.length };
      for (const symbol of symbols) if (symbol.geometryMeasured === false) symbol.wallMotion = wallMotion;
    }
  }'''
new = '''  // Full independently measured finder geometry remains absolute authority.
  // Otherwise the Turbo/Stable-RS CRC oracle gives us something almost as
  // valuable every frame: each successful predicted QR says "the wall is this
  // many pixels away HERE". Pure camera translation makes those residuals equal;
  // rotation/scale makes them vary smoothly with position. Fit that residual
  // field as a tiny similarity transform instead of rejecting it as incoherent.
  if (!measuredGeometryCount && predictedMotion.length >= 2) {
    const median = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    const residualFor = (motion, item) => {
      const px = motion.a * item.x - motion.b * item.y + motion.tx;
      const py = motion.b * item.x + motion.a * item.y + motion.ty;
      return Math.hypot(px - (item.x + item.dx), py - (item.y + item.dy));
    };
    const refit = (items) => {
      const meanX = items.reduce((sum, item) => sum + item.x, 0) / items.length;
      const meanY = items.reduce((sum, item) => sum + item.y, 0) / items.length;
      const meanQx = items.reduce((sum, item) => sum + item.x + item.dx, 0) / items.length;
      const meanQy = items.reduce((sum, item) => sum + item.y + item.dy, 0) / items.length;
      let denom = 0, real = 0, imag = 0;
      for (const item of items) {
        const px = item.x - meanX, py = item.y - meanY;
        const qx = item.x + item.dx - meanQx, qy = item.y + item.dy - meanQy;
        denom += px * px + py * py;
        real += px * qx + py * qy;
        imag += px * qy - py * qx;
      }
      const a = denom > 1 ? real / denom : 1;
      const b = denom > 1 ? imag / denom : 0;
      return {
        a, b,
        tx: meanQx - a * meanX + b * meanY,
        ty: meanQy - b * meanX - a * meanY
      };
    };
    const edgeValues = predictedMotion.map((item) => item.edge).filter((value) => Number.isFinite(value) && value > 0);
    const medianEdge = edgeValues.length ? median(edgeValues) : 64;
    const minSpan = Math.max(48, medianEdge * 0.65);
    const need = Math.max(2, Math.ceil(predictedMotion.length * 0.6));
    let best = null;
    // Pair-seeded RANSAC is tiny here (<=32 tracks) and prevents one local
    // fallback residual from rotating the whole lattice.
    for (let i = 0; i < predictedMotion.length; i++) {
      for (let j = i + 1; j < predictedMotion.length; j++) {
        const p = predictedMotion[i], q = predictedMotion[j];
        const ux = q.x - p.x, uy = q.y - p.y;
        const denom = ux * ux + uy * uy;
        if (denom < minSpan * minSpan) continue;
        const vx = q.x + q.dx - (p.x + p.dx);
        const vy = q.y + q.dy - (p.y + p.dy);
        const a = (ux * vx + uy * vy) / denom;
        const b = (ux * vy - uy * vx) / denom;
        const scale = Math.hypot(a, b);
        const rotation = Math.atan2(b, a);
        if (scale < 0.975 || scale > 1.025 || Math.abs(rotation) > 0.035) continue;
        const motion = {
          a, b,
          tx: p.x + p.dx - a * p.x + b * p.y,
          ty: p.y + p.dy - b * p.x - a * p.y
        };
        const inliers = predictedMotion.filter((item) => residualFor(motion, item) <= 1.05);
        if (inliers.length < need) continue;
        const rms = Math.sqrt(inliers.reduce((sum, item) => {
          const r = residualFor(motion, item);
          return sum + r * r;
        }, 0) / inliers.length);
        if (!best || inliers.length > best.inliers.length ||
            inliers.length === best.inliers.length && rms < best.rms)
          best = { inliers, rms };
      }
    }

    let wallMotion = null;
    if (best) {
      const motion = refit(best.inliers);
      const scale = Math.hypot(motion.a, motion.b);
      const rotation = Math.atan2(motion.b, motion.a);
      const residuals = best.inliers.map((item) => residualFor(motion, item));
      const maxResidual = Math.max(...residuals);
      const shifts = best.inliers.map((item) => {
        const px = motion.a * item.x - motion.b * item.y + motion.tx;
        const py = motion.b * item.x + motion.a * item.y + motion.ty;
        return { dx: px - item.x, dy: py - item.y };
      });
      const maxShift = Math.max(...shifts.map((item) => Math.hypot(item.dx, item.dy)));
      const dx = shifts.reduce((sum, item) => sum + item.dx, 0) / shifts.length;
      const dy = shifts.reduce((sum, item) => sum + item.dy, 0) / shifts.length;
      if (scale >= 0.975 && scale <= 1.025 && Math.abs(rotation) <= 0.035 &&
          maxResidual <= 1.15 && maxShift <= 5.1) {
        wallMotion = {
          kind: "similarity",
          ...motion,
          dx, dy,
          samples: best.inliers.length,
          residual: Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / residuals.length),
          maxShift
        };
      }
    }

    // Keep v279's extremely conservative translation consensus as the fallback
    // for clustered successes that do not provide a safe rotation/scale baseline.
    if (!wallMotion) {
      const dx = median(predictedMotion.map((item) => item.dx));
      const dy = median(predictedMotion.map((item) => item.dy));
      const coherent = predictedMotion.filter((item) => Math.hypot(item.dx - dx, item.dy - dy) <= 0.75);
      if (coherent.length >= need && Math.hypot(dx, dy) <= 4.5) {
        wallMotion = {
          kind: "translation",
          a: 1, b: 0, tx: dx, ty: dy,
          dx, dy,
          samples: coherent.length,
          residual: Math.max(...coherent.map((item) => Math.hypot(item.dx - dx, item.dy - dy))),
          maxShift: Math.hypot(dx, dy)
        };
      }
    }
    if (wallMotion)
      for (const symbol of symbols) if (symbol.geometryMeasured === false) symbol.wallMotion = wallMotion;
  }'''
if old not in s:
    raise SystemExit('guided wall motion consensus anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)


# Apply the CRC-gated current-frame similarity transform to the complete lattice,
# including historical distributed anchors and local lens-residual vectors. This
# is the key continuity property: old cross-wall anchors stay in the current pose
# instead of becoming stale rotation/scale constraints after handheld movement.
p = Path('receive/grid-lattice.js')
s = p.read_text()
old = '''  nudgeTranslation(dx, dy, at = this.lastHitAt) {
    if (!this.locked || !this.candidate || !Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    const distance = Math.hypot(dx, dy);
    if (distance < 0.08 || distance > 4.5 || at < this.lastHitAt) return null;
    const shiftQuad = (quad) => {
      const points = corners(quad).map((point) => ({ x: point.x + dx, y: point.y + dy }));
      return { topLeft: points[0], topRight: points[1], bottomRight: points[2], bottomLeft: points[3] };
    };
    const shiftObservation = (observation) => {
      const quad = shiftQuad(observation.quad);
      return { ...observation, quad, box: bounds(quad) };
    };
    this.observations = this.observations.map(shiftObservation);
    const h = [...this.candidate.transform];
    // Output translation of a projective transform: x'=(N/d)+dx, y'=(M/d)+dy.
    h[0] += dx * h[6]; h[1] += dx * h[7]; h[2] += dx;
    h[3] += dy * h[6]; h[4] += dy * h[7]; h[5] += dy;
    this.candidate = {
      ...this.candidate,
      transform: h,
      observations: this.candidate.observations.map(shiftObservation)
    };
    return this.snapshot();
  }'''
new = '''  nudgeMotion(motion, at = this.lastHitAt) {
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
  }'''
if old not in s:
    raise SystemExit('grid nudgeTranslation anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)


# Main-thread source ordering still guarantees at most one pose update per camera
# source frame. Prefer the similarity motion hint when present; measured finder
# geometry remains the only absolute pose authority.
p = Path('receive/main.js')
s = p.read_text()
old = '''let geometryMotionNudges = 0;
let geometryMotionPixels = 0;
let geometryMotionLastSourceSequence = -1;
let geometryCoverageHealthy = false;'''
new = '''let geometryMotionNudges = 0;
let geometryMotionPixels = 0;
let geometrySimilarityNudges = 0;
let geometryMotionLastSourceSequence = -1;
let geometryCoverageHealthy = false;
let geometryCoverageStarvedSince = 0;
let geometryBreadthRecoveryProbes = 0;'''
if old not in s:
    raise SystemExit('geometry diagnostic vars anchor missing')
s = s.replace(old, new, 1)

old = '''  geometryMotionNudges = 0;
  geometryMotionPixels = 0;
  geometryMotionLastSourceSequence = -1;
  geometryCoverageHealthy = false;'''
new = '''  geometryMotionNudges = 0;
  geometryMotionPixels = 0;
  geometrySimilarityNudges = 0;
  geometryMotionLastSourceSequence = -1;
  geometryCoverageHealthy = false;
  geometryCoverageStarvedSince = 0;
  geometryBreadthRecoveryProbes = 0;'''
if old not in s:
    raise SystemExit('geometry reset vars anchor missing')
s = s.replace(old, new, 1)

old = '''      if (Number.isFinite(sourceSequence) && sourceSequence > geometryMotionLastSourceSequence &&
          motion && Number(motion.samples) >= 2 && Number.isFinite(motion.dx) && Number.isFinite(motion.dy)) {
        geometryMotionLastSourceSequence = sourceSequence;
        const snapshot = gridLattice.nudgeTranslation(Number(motion.dx), Number(motion.dy), packetAt);
        if (snapshot) {
          geometryMotionNudges++;
          geometryMotionPixels += Math.hypot(Number(motion.dx), Number(motion.dy));
          syncGrid(snapshot, decodedAt);
        }
      }'''
new = '''      if (Number.isFinite(sourceSequence) && sourceSequence > geometryMotionLastSourceSequence &&
          motion && Number(motion.samples) >= 2 && Number.isFinite(motion.dx) && Number.isFinite(motion.dy)) {
        geometryMotionLastSourceSequence = sourceSequence;
        const hasSimilarity = [motion.a, motion.b, motion.tx, motion.ty].every((value) => Number.isFinite(Number(value)));
        const snapshot = hasSimilarity
          ? gridLattice.nudgeMotion(motion, packetAt)
          : gridLattice.nudgeTranslation(Number(motion.dx), Number(motion.dy), packetAt);
        if (snapshot) {
          geometryMotionNudges++;
          const scale = hasSimilarity ? Math.hypot(Number(motion.a), Number(motion.b)) : 1;
          const rotation = hasSimilarity ? Math.abs(Math.atan2(Number(motion.b), Number(motion.a))) : 0;
          if (hasSimilarity && (Math.abs(scale - 1) >= 0.0005 || rotation >= 0.0005))
            geometrySimilarityNudges++;
          geometryMotionPixels += Number.isFinite(Number(motion.maxShift))
            ? Number(motion.maxShift)
            : Math.hypot(Number(motion.dx), Number(motion.dy));
          syncGrid(snapshot, decodedAt);
        }
      }'''
if old not in s:
    raise SystemExit('main wall motion apply anchor missing')
s = s.replace(old, new, 1)

old = '''  const freshLockedHits = lockedGeometryCandidates.reduce((count, region) =>
    count + Number(now - (region.decodedSeen ?? -Infinity) < GEOMETRY_FAST_HIT_MS), 0
  );'''
new = '''  const freshLockedRegions = lockedGeometryCandidates.filter((region) =>
    now - (region.decodedSeen ?? -Infinity) < GEOMETRY_FAST_HIT_MS
  );
  const freshLockedHits = freshLockedRegions.length;'''
if old not in s:
    raise SystemExit('fresh locked hits anchor missing')
s = s.replace(old, new, 1)

old = '''  const coverageRecoveryAssist = lockedGeometryTrusted && geometryRecoveryAssistUntil > now;
  const wallFreshRatio = freshLockedHits / Math.max(1, visibleGridSlots.length);
  const aggressiveGeometryProbe = freshLockedHits === 0 && lockedDecodeSilenceMs >= GEOMETRY_FAST_PROBE_SILENCE_MS;
  const maintenanceGeometryProbe = coverageRecoveryAssist && wallFreshRatio < 0.55 &&
    now - lastFullScan >= GEOMETRY_MAINTENANCE_SCAN_MS;
  const geometryProbeDue = lockedGeometryTrusted && (aggressiveGeometryProbe || maintenanceGeometryProbe);'''
new = '''  const coverageRecoveryAssist = lockedGeometryTrusted && geometryRecoveryAssistUntil > now;
  const wallFreshRatio = freshLockedHits / Math.max(1, visibleGridSlots.length);
  const liveGridLayout = lastGridSnapshot?.layout;
  const freshCols = new Set();
  const freshRows = new Set();
  for (const region of freshLockedRegions) {
    const slot = Number(region.gridSlot);
    if (!Number.isInteger(slot) || !liveGridLayout) continue;
    freshCols.add(slot % liveGridLayout.cols);
    freshRows.add(Math.floor(slot / liveGridLayout.cols));
  }
  const freshDistributed = !liveGridLayout ? false
    : liveGridLayout.cols === 1 ? freshRows.size >= 2
      : liveGridLayout.rows === 1 ? freshCols.size >= 2
        : freshCols.size >= 2 && freshRows.size >= 2;
  // Partial lock is a pose failure even when an easy strip of QRs keeps the
  // global decoder-silence timer at zero. Sustain the condition briefly so a
  // normal animated frame cannot wake recovery, then actively repair breadth.
  const wallCoverageStarved = lockedGeometryTrusted && visibleGridSlots.length >= SLOT_WEAK_MIN_WALL &&
    freshLockedHits > 0 && wallFreshRatio < 0.55 && (!freshDistributed || wallFreshRatio < 0.38);
  if (wallCoverageStarved) {
    if (!geometryCoverageStarvedSince) geometryCoverageStarvedSince = now;
  } else {
    geometryCoverageStarvedSince = 0;
  }
  const sustainedCoverageStarvation = geometryCoverageStarvedSince > 0 &&
    now - geometryCoverageStarvedSince >= 320;
  const aggressiveGeometryProbe = freshLockedHits === 0 && lockedDecodeSilenceMs >= GEOMETRY_FAST_PROBE_SILENCE_MS;
  const maintenanceInterval = sustainedCoverageStarvation ? 550 : GEOMETRY_MAINTENANCE_SCAN_MS;
  const maintenanceGeometryProbe = (coverageRecoveryAssist || sustainedCoverageStarvation) &&
    wallFreshRatio < 0.55 && now - lastFullScan >= maintenanceInterval;
  const geometryProbeDue = lockedGeometryTrusted && (aggressiveGeometryProbe || maintenanceGeometryProbe);'''
if old not in s:
    raise SystemExit('wall coverage recovery anchor missing')
s = s.replace(old, new, 1)

old = '''      const poolSize = Math.min(8, ranked.length);
      const target = poolSize ? ranked[acquisitionTileCursor++ % poolSize] : void 0;
      boundedScanCandidates = target ? [target] : [];
      geometryRecoveryProbes++;
      if (target) lastRecoveryReason = `measuring weak grid slot s${target.gridSlot} ${target.slotState.toLowerCase()}`;
      notePipelineEvent("local-recovery-probe", geometryRecoveryProbes);'''
new = '''      const poolSize = Math.min(sustainedCoverageStarvation ? 12 : 8, ranked.length);
      const target = poolSize ? ranked[acquisitionTileCursor++ % poolSize] : void 0;
      const selected = target ? [target] : [];
      if (sustainedCoverageStarvation && target && liveGridLayout && poolSize > 1) {
        const gridDistance = (a, b) => {
          const ac = a.gridSlot % liveGridLayout.cols;
          const ar = Math.floor(a.gridSlot / liveGridLayout.cols);
          const bc = b.gridSlot % liveGridLayout.cols;
          const br = Math.floor(b.gridSlot / liveGridLayout.cols);
          return Math.abs(ac - bc) / Math.max(1, liveGridLayout.cols - 1) +
            Math.abs(ar - br) / Math.max(1, liveGridLayout.rows - 1);
        };
        while (selected.length < Math.min(3, poolSize)) {
          const next = ranked.slice(0, poolSize)
            .filter((candidate) => !selected.includes(candidate))
            .map((candidate) => ({
              candidate,
              distance: Math.min(...selected.map((chosen) => gridDistance(candidate, chosen)))
            }))
            .sort((a, b) => b.distance - a.distance ||
              statePriority(b.candidate) - statePriority(a.candidate))[0]?.candidate;
          if (!next) break;
          selected.push(next);
        }
      }
      boundedScanCandidates = selected;
      geometryRecoveryProbes++;
      if (selected.length > 1) geometryBreadthRecoveryProbes++;
      if (selected.length) {
        const slots = selected.map((region) => `s${region.gridSlot}`).join(",");
        lastRecoveryReason = selected.length > 1
          ? `measuring weak grid span ${slots}`
          : `measuring weak grid slot ${slots} ${selected[0].slotState.toLowerCase()}`;
      }
      notePipelineEvent(selected.length > 1 ? "breadth-recovery-probe" : "local-recovery-probe", geometryRecoveryProbes);'''
if old not in s:
    raise SystemExit('local recovery target anchor missing')
s = s.replace(old, new, 1)

old = '''      const target = boundedScanCandidates[0];
      const broadRecovery = localRecoverySeedScan && (target.slotState === "OFFSCREEN" || target.slotState === "PARTIAL" || !validTrackedQuad(target, vw, vh));
      const quantum = 16;
      if (broadRecovery) {
        // If the predicted QR itself is outside/near the edge, a tiny crop can
        // never rediscover it. Search a broad edge/quadrant tile centered as
        // close as possible to its predicted location. This is still far less
        // work than a whole 1440x2560 frame.
        const predictedX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
        const predictedY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
        const wantedW = Math.min(vw, Math.max(typicalEdge * 6, vw * 0.45));
        const wantedH = Math.min(vh, Math.max(typicalEdge * 6, vh * 0.35));
        const centerX = Math.max(wantedW / 2, Math.min(vw - wantedW / 2, predictedX));
        const centerY = Math.max(wantedH / 2, Math.min(vh - wantedH / 2, predictedY));'''
new = '''      const target = boundedScanCandidates[0];
      const broadRecovery = localRecoverySeedScan && boundedScanCandidates.some((region) =>
        region.slotState === "OFFSCREEN" || region.slotState === "PARTIAL" || !validTrackedQuad(region, vw, vh)
      );
      const quantum = 16;
      if (broadRecovery) {
        // Include the whole selected weak span. During a partial-lock failure
        // recovery deliberately asks readDenseY for up to three measured QRs;
        // a one-slot crop can never provide the cross-wall evidence needed to
        // repair rotation/scale in one camera frame.
        const minPX = Math.min(...points.map((point) => point.x));
        const minPY = Math.min(...points.map((point) => point.y));
        const maxPX = Math.max(...points.map((point) => point.x));
        const maxPY = Math.max(...points.map((point) => point.y));
        const recoveryPad = Math.max(24, typicalEdge * 0.9);
        const wantedW = Math.min(vw, Math.max(maxPX - minPX + recoveryPad * 2, typicalEdge * 6, vw * 0.45));
        const wantedH = Math.min(vh, Math.max(maxPY - minPY + recoveryPad * 2, typicalEdge * 6, vh * 0.35));
        const predictedX = (minPX + maxPX) / 2;
        const predictedY = (minPY + maxPY) / 2;
        const centerX = Math.max(wantedW / 2, Math.min(vw - wantedW / 2, predictedX));
        const centerY = Math.max(wantedH / 2, Math.min(vh - wantedH / 2, predictedY));'''
if old not in s:
    raise SystemExit('broad recovery crop anchor missing')
s = s.replace(old, new, 1)

old = '''  const adaptiveWeakSlots = gridLattice.active && adaptiveWeakSlotScheduling(batchCandidates);'''
new = '''  // Weak-slot thinning is a steady-state CPU optimization, not a recovery
  // policy. While wall breadth is starved, spend the available headroom on all
  // predicted slots so a repaired pose is recognized on the very next frame.
  const adaptiveWeakSlots = gridLattice.active && !sustainedCoverageStarvation &&
    adaptiveWeakSlotScheduling(batchCandidates);'''
if old not in s:
    raise SystemExit('adaptive weak scheduling anchor missing')
s = s.replace(old, new, 1)

old = '''    `Recovery probes ${geometryRecoveryProbes} · assist ${geometryRecoveryAssistUntil > perfNow ? `${Math.max(0, geometryRecoveryAssistUntil - perfNow).toFixed(0)}ms` : "no"} · motion ${geometryMotionNudges}/${geometryMotionPixels.toFixed(0)}px · sighting nudges ${geometrySightingNudges} · resets ${geometryRecoveryResets} · worker restarts ${recoveryWorkerRestarts} · aborted ${recoveryAbortedJobs} jobs/${(recoveryAbortedWorkerMs / 1e3).toFixed(1)} worker-s · hold ${decoderFreshnessHoldActive ? `${Math.max(0, decoderFreshnessHoldUntil - perfNow).toFixed(0)}ms` : "no"} · lattice ${gridLattice.state}${gridLattice.active ? "/active" : "/acquiring"} · mode ${frameModeSync ? `syncing ${frameModeSync.width}×${frameModeSync.height}` : "synced"} · mode drops ${frameModeMismatchDrops} · sync timeouts ${frameModeSyncTimeouts} · ${lastRecoveryReason}`,'''
new = '''    `Recovery probes ${geometryRecoveryProbes} · breadth ${geometryBreadthRecoveryProbes} · assist ${geometryRecoveryAssistUntil > perfNow ? `${Math.max(0, geometryRecoveryAssistUntil - perfNow).toFixed(0)}ms` : "no"} · motion ${geometryMotionNudges}/${geometryMotionPixels.toFixed(0)}px · similarity ${geometrySimilarityNudges} · sighting nudges ${geometrySightingNudges} · resets ${geometryRecoveryResets} · worker restarts ${recoveryWorkerRestarts} · aborted ${recoveryAbortedJobs} jobs/${(recoveryAbortedWorkerMs / 1e3).toFixed(1)} worker-s · hold ${decoderFreshnessHoldActive ? `${Math.max(0, decoderFreshnessHoldUntil - perfNow).toFixed(0)}ms` : "no"} · lattice ${gridLattice.state}${gridLattice.active ? "/active" : "/acquiring"} · mode ${frameModeSync ? `syncing ${frameModeSync.width}×${frameModeSync.height}` : "synced"} · mode drops ${frameModeMismatchDrops} · sync timeouts ${frameModeSyncTimeouts} · ${lastRecoveryReason}`,'''
if old not in s:
    raise SystemExit('recovery diagnostics line anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)


# Regression: a CRC-gated similarity motion update must move the whole trusted
# distributed wall coherently, while pathological transforms are rejected.
p = Path('benchmark/grid-lattice-regression.mjs')
s = p.read_text()
old = '''snapshot = lattice.accept(detection(27, 1380, { dx: 150, dy: 95 }), frameWidth, frameHeight);
assert.equal(snapshot.distributedFit, true, "fresh cross-axis evidence should re-establish distributed geometry");
assert.ok(snapshot.fitSlots >= 2);

console.log("grid-lattice regression: ok");'''
new = '''snapshot = lattice.accept(detection(27, 1380, { dx: 150, dy: 95 }), frameWidth, frameHeight);
assert.equal(snapshot.distributedFit, true, "fresh cross-axis evidence should re-establish distributed geometry");
assert.ok(snapshot.fitSlots >= 2);

// Predicted CRC-valid QRs can now carry a tiny current-frame similarity update.
// It must move every distributed anchor together, not merely the easy QR that
// produced the residual.
const beforeMotion = snapshot.slots[27].quad.topLeft;
const motion = { a: 1.004, b: 0.003, tx: -3, ty: 2, dx: 1.5, dy: 1.2, maxShift: 4.2, samples: 4 };
snapshot = lattice.nudgeMotion(motion, 1420);
assert(snapshot, "safe similarity motion should update a locked lattice");
const afterMotion = snapshot.slots[27].quad.topLeft;
assert.ok(Math.abs(afterMotion.x - (motion.a * beforeMotion.x - motion.b * beforeMotion.y + motion.tx)) < 1e-5);
assert.ok(Math.abs(afterMotion.y - (motion.b * beforeMotion.x + motion.a * beforeMotion.y + motion.ty)) < 1e-5);
assert.equal(snapshot.distributedFit, true, "motion feedback must preserve trusted distributed geometry");
assert.equal(lattice.nudgeMotion({ a: 1.2, b: 0, tx: 0, ty: 0, dx: 1, dy: 1, maxShift: 2, samples: 4 }, 1440), null,
  "unsafe scale jumps must be rejected");

console.log("grid-lattice regression: ok");'''
if old not in s:
    raise SystemExit('grid lattice regression tail anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)
