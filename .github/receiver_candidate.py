from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:220]!r}")
    p.write_text(text.replace(old, new, 1))


# A local correction is only compensating non-projective lens distortion. The
# old 8% allowance could permanently poison one slot with a several-module
# scale/shape error from a noisy first measured quad.
replace_once(
    "receive/grid-lattice.js",
    "const LOCAL_GEOMETRY_MAX_RESIDUAL = 0.08;",
    "const LOCAL_GEOMETRY_MAX_RESIDUAL = 0.03;"
)

# Give the receiver a way to discard one poisoned local correction without
# disturbing the proven global wall transform or any other slot.
replace_once(
    "receive/grid-lattice.js",
    """  nudgeTranslation(dx, dy, at = this.lastHitAt) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) > 4.5) return null;
    return this.nudgeMotion({
      kind: \"translation\",
      a: 1, b: 0, tx: dx, ty: dy,
      dx, dy, maxShift: Math.hypot(dx, dy)
    }, at);
  }
  learnSlotCorrection(detection) {
""",
    """  nudgeTranslation(dx, dy, at = this.lastHitAt) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) > 4.5) return null;
    return this.nudgeMotion({
      kind: \"translation\",
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
"""
)

# If a fresh CRC-backed measured quad materially disagrees with an old local
# correction, do not take ~12 slow EMA updates to repair it. The payload CRC is
# the oracle and the newly measured finder geometry should replace the stale
# correction immediately.
replace_once(
    "receive/grid-lattice.js",
    """    const previous = this.slotCorrections.get(detection.slotIndex);
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
""",
    """    const previous = this.slotCorrections.get(detection.slotIndex);
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
"""
)

# Count self-heals in diagnostics.
replace_once(
    "receive/main.js",
    """let geometryRecoveryProbes = 0;
let geometryRecoveryResets = 0;
let geometrySightingNudges = 0;
""",
    """let geometryRecoveryProbes = 0;
let geometryRecoveryResets = 0;
let geometrySlotCorrectionResets = 0;
let geometrySightingNudges = 0;
"""
)

# A coherent rolling-shutter miss is deliberately excluded: temporal corruption
# must not erase good lens calibration. Five consecutive ordinary misses are
# enough evidence to test the global homography without this slot's correction.
replace_once(
    "receive/main.js",
    """        if (!hit && ((_a = region.lastHitScanId) != null ? _a : -1) <= id) {
          region.consecutiveMisses++;
          if (region.consecutiveMisses >= 3) region.decoded = false;
        }
""",
    """        if (!hit && ((_a = region.lastHitScanId) != null ? _a : -1) <= id) {
          region.consecutiveMisses++;
          if (region.consecutiveMisses >= 3) region.decoded = false;
          if (region.consecutiveMisses >= 5 && region.gridSlot !== void 0) {
            const healed = gridLattice.dropSlotCorrection(Number(region.gridSlot));
            if (healed) {
              geometrySlotCorrectionResets++;
              syncGrid(healed, receiverNow());
              notePipelineEvent(\"slot-correction-reset\", Number(region.gridSlot));
              lastRecoveryReason = `slot s${region.gridSlot} dropped stale local geometry (${geometrySlotCorrectionResets})`;
            }
          }
        }
"""
)

replace_once(
    "receive/main.js",
    " · sighting nudges ${geometrySightingNudges} · resets ${geometryRecoveryResets}",
    " · sighting nudges ${geometrySightingNudges} · slot self-heals ${geometrySlotCorrectionResets} · resets ${geometryRecoveryResets}"
)

# Guided only pays this wider search when the normal prediction did not locate
# the finder. Healthy tracks still return at ring 0/1, so their hot-path cost is
# unchanged. A poisoned/interior slot can now recover from roughly twice the
# previous positional error and then CRC-relearn its local correction.
cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"
replace_once(
    cpp,
    "found[index] = locateGuidedFinder(image, predicted[index], moduleSize, 4, metrics);",
    "found[index] = locateGuidedFinder(image, predicted[index], moduleSize, 7, metrics);"
)
replace_once(
    cpp,
    "found[index] = locateGuidedFinder(image, predicted[index] + delta, moduleSize, 2, metrics);",
    "found[index] = locateGuidedFinder(image, predicted[index] + delta, moduleSize, 4, metrics);"
)

replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.335";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.336";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.335";', 'const SEND_RUNTIME_BUILD = "v0.5.336";')
replace_once("main.js", 'const APP_BUILD = "v0.5.335";', 'const APP_BUILD = "v0.5.336";')
replace_once("index.html", '<span class="app-version">v0.5.335</span>', '<span class="app-version">v0.5.336</span>')
replace_once("index.html", './main.js?build=v0.5.335', './main.js?build=v0.5.336')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v283";', 'const CACHE = "airgapper-static-js-v284";')

print("staged v0.5.336: self-heal poisoned per-slot geometry and widen guided finder rescue")
