from pathlib import Path
import re


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:220]!r}")
    p.write_text(s.replace(old, new, count))


def regex_replace(path, pattern, replacement, count=1):
    p = Path(path)
    s = p.read_text()
    out, n = re.subn(pattern, replacement, s, count=count, flags=re.S)
    if n != count:
        raise SystemExit(f"regex replacement count {n} != {count} in {path}: {pattern[:180]!r}")
    p.write_text(out)


# Version/cache.
replace("index.html", "v0.5.207", "v0.5.208")
replace("main.js", 'const APP_BUILD = "v0.5.207";', 'const APP_BUILD = "v0.5.208";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.207";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.208";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v169";', 'const CACHE = "airgapper-static-js-v170";')
replace("vendor/decimen-codec/source/VERSION", "0.1.28", "0.1.29")

# ---------------------------------------------------------------------------
# C ABI: name the fields the way JS already treats them, and make all hot ABI
# sizes/offsets compile-time invariants so an alignment edit cannot silently
# turn into a worker heap overwrite again.
# ---------------------------------------------------------------------------
header = Path("vendor/decimen-codec/source/wrapper/decimen_codec.h")
s = header.read_text()
s = s.replace("\tuint32_t reserved;\n", "\tuint32_t turboAttempts;\n", 1)
s = s.replace("\tuint32_t reserved2;\n", "\tuint32_t turboSuccesses;\n", 1)
header.write_text(s)

cpp = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = cpp.read_text()
s = s.replace('#include <cmath>\n', '#include <cmath>\n#include <cstddef>\n', 1)
old = '''static_assert(sizeof(DecimenGuidedMetrics) == 160,
              "DecimenGuidedMetrics JS ABI must allocate 160 bytes");'''
new = '''static_assert(sizeof(DecimenGuidedTrack) == 40,
              "DecimenGuidedTrack JS ABI must use 40-byte records");
static_assert(sizeof(DecimenGuidedResult) == 52,
              "DecimenGuidedResult JS ABI must use 52-byte records");
static_assert(sizeof(DecimenGuidedMetrics) == 160,
              "DecimenGuidedMetrics JS ABI must allocate 160 bytes");
static_assert(offsetof(DecimenGuidedMetrics, turboAttempts) == 124,
              "DecimenGuidedMetrics turboAttempts JS offset changed");
static_assert(offsetof(DecimenGuidedMetrics, turboSuccesses) == 140,
              "DecimenGuidedMetrics turboSuccesses JS offset changed");
static_assert(offsetof(DecimenGuidedMetrics, stableRsAttempts) == 144,
              "DecimenGuidedMetrics stableRsAttempts JS offset changed");
static_assert(offsetof(DecimenGuidedMetrics, stableEligibleTracks) == 152,
              "DecimenGuidedMetrics stableEligibleTracks JS offset changed");'''
if old not in s: raise SystemExit("ABI assertion block missing")
s = s.replace(old, new, 1)

# canarySuccesses has had no reader since Stable-RS got its own attempts/success
# evidence. Keeping a write-only aggregate obscures the state machine.
s = s.replace("    int canarySuccesses = 0;\n", "", 1)
s = s.replace("    adaptive.canarySuccesses = 0;\n", "", 1)
s = s.replace("                turboAdaptive.canarySuccesses += int(success);\n", "", 1)
s = s.replace("                    turboAdaptive.canarySuccesses = 0;\n", "", 1)

# Old generic matrix Turbo-RS was superseded by Stable-RS and has zero callers.
# Remove the entire second decoder so the optimized path has one RS implementation.
pattern = r'''\nstatic DecoderResult decodeTurboWithRS\(const GuidedTurboTrack& cache, const DecimenGuidedTrack& track,.*?\n}\n\nstatic TurboLevels turboReadLevelsRigid'''
replacement = '''\nstatic TurboLevels turboReadLevelsRigid'''
s, n = re.subn(pattern, replacement, s, count=1, flags=re.S)
if n != 1: raise SystemExit("dead decodeTurboWithRS block missing")

# A rigid reference is only valid if at least one finder-level offset candidate
# actually passed. Previously a total search miss silently returned the predicted
# point and marked stableReference=true.
old = '''static PointF turboRefineRigidOffset(const GuidedTurboTrack& cache,
                                     const uint8_t* yPlane, int width, int height, int stride,
                                     float predictedX, float predictedY)
{
    PointF best{predictedX, predictedY};
    int bestScore = -1;
    int bestMatches = -1;
    auto consider = [&](float dx, float dy) {
        const auto levels = turboReadLevelsRigid(cache, yPlane, width, height, stride, dx, dy);
        if (!levels.ok) return;
        const int score = levels.matches * 4 + levels.separation;
        if (score > bestScore) {
            bestScore = score;
            bestMatches = levels.matches;
            best = PointF{dx, dy};
        }
    };
    for (int oy = -1; oy <= 1; ++oy)
        for (int ox = -1; ox <= 1; ++ox)
            consider(predictedX + ox, predictedY + oy);
    if (bestMatches < 143) {
        for (int oy = -2; oy <= 2; ++oy)
            for (int ox = -2; ox <= 2; ++ox)
                if (std::max(std::abs(ox), std::abs(oy)) == 2)
                    consider(predictedX + ox, predictedY + oy);
    }
    const PointF coarse = best;
    for (int hy = -1; hy <= 1; ++hy)
        for (int hx = -1; hx <= 1; ++hx)
            consider(coarse.x + hx * 0.5f, coarse.y + hy * 0.5f);
    return best;
}'''
new = '''static std::optional<PointF> turboRefineRigidOffset(const GuidedTurboTrack& cache,
                                                    const uint8_t* yPlane, int width, int height, int stride,
                                                    float predictedX, float predictedY)
{
    PointF best{predictedX, predictedY};
    int bestScore = -1;
    int bestMatches = -1;
    auto consider = [&](float dx, float dy) {
        const auto levels = turboReadLevelsRigid(cache, yPlane, width, height, stride, dx, dy);
        if (!levels.ok) return;
        const int score = levels.matches * 4 + levels.separation;
        if (score > bestScore) {
            bestScore = score;
            bestMatches = levels.matches;
            best = PointF{dx, dy};
        }
    };
    for (int oy = -1; oy <= 1; ++oy)
        for (int ox = -1; ox <= 1; ++ox)
            consider(predictedX + ox, predictedY + oy);
    if (bestMatches < 143) {
        for (int oy = -2; oy <= 2; ++oy)
            for (int ox = -2; ox <= 2; ++ox)
                if (std::max(std::abs(ox), std::abs(oy)) == 2)
                    consider(predictedX + ox, predictedY + oy);
    }
    if (bestScore < 0)
        return std::nullopt;
    const PointF coarse = best;
    for (int hy = -1; hy <= 1; ++hy)
        for (int hx = -1; hx <= 1; ++hx)
            consider(coarse.x + hx * 0.5f, coarse.y + hy * 0.5f);
    return best;
}'''
if old not in s: raise SystemExit("rigid refine function missing")
s = s.replace(old, new, 1)
old = '''            const PointF refined = turboRefineRigidOffset(*cache, yPlane, width, height, stride, poseX, poseY);
            stableResidualX = refined.x - poseX;
            stableResidualY = refined.y - poseY;
            stableReference = true;
            break;'''
new = '''            const auto refined = turboRefineRigidOffset(*cache, yPlane, width, height, stride, poseX, poseY);
            if (!refined)
                continue;
            stableResidualX = refined->x - poseX;
            stableResidualY = refined->y - poseY;
            stableReference = true;
            break;'''
if old not in s: raise SystemExit("stable reference caller missing")
s = s.replace(old, new, 1)

# Stable-RS knows the plan is exactly whole codewords. Fill a pre-sized output
# byte-by-byte instead of maintaining vector push/modulo state for ~30k bits.
old = '''    ByteArray raw;
    raw.reserve(totalCodewords);
    uint8_t currentByte = 0;
    bool failed = false;
    for (size_t bitIndex = 0; bitIndex < plan.size(); ++bitIndex) {
        const uint32_t entry = plan[bitIndex];
        const int xx = int(entry & 0xff);
        const int y = int((entry >> 8) & 0xff);
        const bool mask = ((entry >> 16) & 1) != 0;
        const int threshold = turboThreshold(levels, xx, y, dim);
        const PointF p = cache.samples[size_t(y) * dim + xx];
        const int lum = turboLum(yPlane, width, height, stride, p, dx, dy);
        if (lum < 0) { failed = true; break; }
        const bool black = lum <= threshold;
        currentByte = uint8_t((currentByte << 1) | uint8_t(mask != black));
        if ((bitIndex & 7) == 7) {
            raw.push_back(currentByte);
            currentByte = 0;
        }
    }
    metrics.sampleMs += guidedNowMs() - sampleStarted;
    if (failed || int(raw.size()) != totalCodewords)
        return {};'''
new = '''    ByteArray raw(totalCodewords);
    bool failed = false;
    for (int codeword = 0; codeword < totalCodewords && !failed; ++codeword) {
        uint8_t value = 0;
        const size_t firstBit = size_t(codeword) * 8;
        for (int bit = 0; bit < 8; ++bit) {
            const uint32_t entry = plan[firstBit + bit];
            const int xx = int(entry & 0xff);
            const int y = int((entry >> 8) & 0xff);
            const bool mask = ((entry >> 16) & 1) != 0;
            const int threshold = turboThreshold(levels, xx, y, dim);
            const PointF p = cache.samples[size_t(y) * dim + xx];
            const int lum = turboLum(yPlane, width, height, stride, p, dx, dy);
            if (lum < 0) { failed = true; break; }
            value = uint8_t((value << 1) | uint8_t(mask != (lum <= threshold)));
        }
        raw[codeword] = value;
    }
    metrics.sampleMs += guidedNowMs() - sampleStarted;
    if (failed)
        return {};'''
if old not in s: raise SystemExit("stable RS bit loop missing")
s = s.replace(old, new, 1)

s = s.replace("++metrics->reserved; // Turbo attempts (ABI-reserved field)", "++metrics->turboAttempts", 1)
s = s.replace("++metrics->reserved2; // Turbo successes (ABI-reserved field)", "++metrics->turboSuccesses", 1)
cpp.write_text(s)

# ---------------------------------------------------------------------------
# Worker: eliminate hot per-job temporary arrays/Sets and make partial WASM
# allocation failures recoverable instead of leaking or reporting init success.
# ---------------------------------------------------------------------------
worker = Path("receive/worker.js")
s = worker.read_text()
old = '''function validQuad(p) {
  if (!p) return false;
  return [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft].every((point) =>
    point && Number.isFinite(point.x) && Number.isFinite(point.y)
  );
}
function boundsOf(p, ox, oy) {
  if (!validQuad(p)) return null;
  const xs = [p.topLeft.x, p.topRight.x, p.bottomRight.x, p.bottomLeft.x];
  const ys = [p.topLeft.y, p.topRight.y, p.bottomRight.y, p.bottomLeft.y];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x: ox + x, y: oy + y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
function shifted(p, ox, oy) {
  if (!validQuad(p)) return null;
  const s = (pt) => ({ x: pt.x + ox, y: pt.y + oy });
  return {
    topLeft: s(p.topLeft),
    topRight: s(p.topRight),
    bottomRight: s(p.bottomRight),
    bottomLeft: s(p.bottomLeft)
  };
}'''
new = '''function validPoint(point) {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));
}
function validQuad(p) {
  return Boolean(p && validPoint(p.topLeft) && validPoint(p.topRight) &&
    validPoint(p.bottomRight) && validPoint(p.bottomLeft));
}
function boundsOf(p, ox, oy) {
  if (!validQuad(p)) return null;
  const minX = Math.min(p.topLeft.x, p.topRight.x, p.bottomRight.x, p.bottomLeft.x);
  const minY = Math.min(p.topLeft.y, p.topRight.y, p.bottomRight.y, p.bottomLeft.y);
  const maxX = Math.max(p.topLeft.x, p.topRight.x, p.bottomRight.x, p.bottomLeft.x);
  const maxY = Math.max(p.topLeft.y, p.topRight.y, p.bottomRight.y, p.bottomLeft.y);
  return { x: ox + minX, y: oy + minY, w: maxX - minX, h: maxY - minY };
}
function shifted(p, ox, oy) {
  if (!validQuad(p)) return null;
  return {
    topLeft: { x: p.topLeft.x + ox, y: p.topLeft.y + oy },
    topRight: { x: p.topRight.x + ox, y: p.topRight.y + oy },
    bottomRight: { x: p.bottomRight.x + ox, y: p.bottomRight.y + oy },
    bottomLeft: { x: p.bottomLeft.x + ox, y: p.bottomLeft.y + oy }
  };
}'''
if old not in s: raise SystemExit("worker quad helpers missing")
s = s.replace(old, new, 1)
old = '''function inputBuffer(zx, bytes) {
  if (bytes <= inputCapacity) return inputPtr;
  if (inputPtr) zx._free(inputPtr);
  inputPtr = zx._malloc(bytes);
  inputCapacity = bytes;
  return inputPtr;
}'''
new = '''function inputBuffer(zx, bytes) {
  if (inputPtr && bytes <= inputCapacity) return inputPtr;
  const next = zx._malloc(bytes);
  if (!next) return 0;
  if (inputPtr) zx._free(inputPtr);
  inputPtr = next;
  inputCapacity = bytes;
  return inputPtr;
}'''
if old not in s: raise SystemExit("worker inputBuffer missing")
s = s.replace(old, new, 1)
old = '''function ensureGuidedBatch(zx) {
  if (guidedTracksPtr && guidedResultsPtr && guidedMetricsPtr && guidedOutputPtr) return true;
  guidedTracksPtr = zx._malloc(NATIVE_BATCH_MAX_TRACKS * GUIDED_TRACK_BYTES);
  guidedResultsPtr = zx._malloc(NATIVE_BATCH_MAX_TRACKS * GUIDED_RESULT_BYTES);
  guidedMetricsPtr = zx._malloc(GUIDED_METRICS_BYTES);
  guidedOutputPtr = zx._malloc(GUIDED_OUTPUT_BYTES);
  return Boolean(guidedTracksPtr && guidedResultsPtr && guidedMetricsPtr && guidedOutputPtr);
}'''
new = '''function ensureGuidedBatch(zx) {
  if (!guidedTracksPtr) guidedTracksPtr = zx._malloc(NATIVE_BATCH_MAX_TRACKS * GUIDED_TRACK_BYTES);
  if (!guidedResultsPtr) guidedResultsPtr = zx._malloc(NATIVE_BATCH_MAX_TRACKS * GUIDED_RESULT_BYTES);
  if (!guidedMetricsPtr) guidedMetricsPtr = zx._malloc(GUIDED_METRICS_BYTES);
  if (!guidedOutputPtr) guidedOutputPtr = zx._malloc(GUIDED_OUTPUT_BYTES);
  return Boolean(guidedTracksPtr && guidedResultsPtr && guidedMetricsPtr && guidedOutputPtr);
}'''
if old not in s: raise SystemExit("ensureGuidedBatch missing")
s = s.replace(old, new, 1)
old = '''  const expectedSlots = new Set(tracks.flatMap((track) => track.slot === void 0 ? [] : [track.slot]));
  const decodedSlots = /* @__PURE__ */ new Set();
  for (let i = 0; i < count; i++) {'''
new = '''  let expectedSlotsMask = 0;
  for (const track of tracks) {
    const slot = Number(track.slot);
    if (Number.isInteger(slot) && slot >= 0 && slot < 32)
      expectedSlotsMask = (expectedSlotsMask | ((1 << slot) >>> 0)) >>> 0;
  }
  let decodedSlotsMask = 0;
  for (let i = 0; i < count; i++) {'''
if old not in s: raise SystemExit("guided slot sets missing")
s = s.replace(old, new, 1)
old = '''    const slot = packet?.header.slotIndex;
    if (!packet || slot === void 0 || expectedSlots.size && !expectedSlots.has(slot) || decodedSlots.has(slot)) continue;
    decodedSlots.add(slot);'''
new = '''    const slot = packet?.header.slotIndex;
    if (!packet || !Number.isInteger(slot) || slot < 0 || slot >= 32) continue;
    const slotBit = (1 << slot) >>> 0;
    if (expectedSlotsMask && !(expectedSlotsMask & slotBit) || decodedSlotsMask & slotBit) continue;
    decodedSlotsMask = (decodedSlotsMask | slotBit) >>> 0;'''
if old not in s: raise SystemExit("guided slot validation missing")
s = s.replace(old, new, 1)
old = '''function ensureNativeBatch(zx) {
  if (nativeBatchHandle) return true;
  nativeBatchHandle = zx._createTrackedDecoder(NATIVE_BATCH_MAX_TRACKS, 177);
  if (!nativeBatchHandle) return false;
  nativeResultsPtr = zx._malloc(NATIVE_BATCH_MAX_TRACKS * NATIVE_TRACK_RESULT_BYTES);
  nativeOutputPtr = zx._malloc(NATIVE_BATCH_OUTPUT_BYTES);
  nativeMetricsPtr = zx._malloc(NATIVE_BATCH_METRICS_BYTES);
  zx._setTrackedDecoderFallbackBudget(nativeBatchHandle, 0);
  return Boolean(nativeResultsPtr && nativeOutputPtr && nativeMetricsPtr);
}'''
new = '''function ensureNativeBatch(zx) {
  if (!nativeBatchHandle) nativeBatchHandle = zx._createTrackedDecoder(NATIVE_BATCH_MAX_TRACKS, 177);
  if (!nativeBatchHandle) return false;
  if (!nativeResultsPtr) nativeResultsPtr = zx._malloc(NATIVE_BATCH_MAX_TRACKS * NATIVE_TRACK_RESULT_BYTES);
  if (!nativeOutputPtr) nativeOutputPtr = zx._malloc(NATIVE_BATCH_OUTPUT_BYTES);
  if (!nativeMetricsPtr) nativeMetricsPtr = zx._malloc(NATIVE_BATCH_METRICS_BYTES);
  if (!nativeResultsPtr || !nativeOutputPtr || !nativeMetricsPtr) return false;
  zx._setTrackedDecoderFallbackBudget(nativeBatchHandle, 0);
  return true;
}'''
if old not in s: raise SystemExit("ensureNativeBatch missing")
s = s.replace(old, new, 1)
worker.write_text(s)

# ---------------------------------------------------------------------------
# Lattice/main: a predicted Turbo packet has no new geometry. Do not rebuild
# the entire 18-slot snapshot for every fast symbol; just keep the lattice alive
# and mark the already-existing slot decoded. Measured Guided/full results remain
# the only path that changes wall geometry.
# ---------------------------------------------------------------------------
grid = Path("receive/grid-lattice.js")
s = grid.read_text()
old = '''  noteValidPacket(at = this.lastHitAt) {
    if (!this.candidate) return null;
    const packetIsCurrent = at >= this.lastHitAt;
    this.lastHitAt = Math.max(this.lastHitAt, at);
    if (packetIsCurrent && this.locked)
      this.transition("TRACK", "valid predicted packet kept lattice alive", at);
    return this.snapshot();
  }'''
new = '''  noteValidPacket(at = this.lastHitAt) {
    if (!this.candidate) return false;
    const packetIsCurrent = at >= this.lastHitAt;
    this.lastHitAt = Math.max(this.lastHitAt, at);
    if (packetIsCurrent && this.locked)
      this.transition("TRACK", "valid predicted packet kept lattice alive", at);
    return true;
  }'''
if old not in s: raise SystemExit("noteValidPacket missing")
s = s.replace(old, new, 1)
s = s.replace("    const decoded = new Set(observed.keys());\n", "", 1)
s = s.replace("decoded: decoded.has(index), observed: Boolean(observation)", "decoded: observed.has(index), observed: Boolean(observation)", 1)
grid.write_text(s)

main = Path("receive/main.js")
s = main.read_text()
old = '''function syncGrid(snapshot, now, decodedSlot, info) {
  var _a, _b;
  lastGridSnapshot = snapshot;'''
new = '''function markGridRegionDecoded(region, now, info) {
  if (!region) return void 0;
  region.decoded = true;
  region.seen = now;
  region.decodedSeen = now;
  region.sightedSeen = now;
  region.consecutiveMisses = 0;
  region.detectionConfidence = 1;
  region.decodeConfidence = 1;
  region.decodeSuccesses++;
  region.crc32 = info?.crc32 ?? true;
  if (info?.scanId !== void 0)
    region.lastHitScanId = Math.max(region.lastHitScanId ?? -1, info.scanId);
  if (region.gridSlot !== void 0) noteSlotDecoded(region.gridSlot);
  lastDecodedRegionSize = Math.max(lastDecodedRegionSize, region.w || 0, region.h || 0);
  return region;
}
function syncGrid(snapshot, now, decodedSlot, info) {
  lastGridSnapshot = snapshot;'''
if old not in s: raise SystemExit("syncGrid header missing")
s = s.replace(old, new, 1)
old = '''    if (slot.index === decodedSlot) {
      region.decoded = true;
      region.seen = now;
      region.decodedSeen = now;
      region.sightedSeen = now;
      region.consecutiveMisses = 0;
      region.detectionConfidence = 1;
      region.decodeConfidence = 1;
      region.decodeSuccesses++;
      region.crc32 = (_a = info == null ? void 0 : info.crc32) != null ? _a : true;
      if ((info == null ? void 0 : info.scanId) !== void 0) region.lastHitScanId = Math.max((_b = region.lastHitScanId) != null ? _b : -1, info.scanId);
      decodedRegion = region;
    }'''
new = '''    if (slot.index === decodedSlot)
      decodedRegion = markGridRegionDecoded(region, now, info);'''
if old not in s: raise SystemExit("syncGrid decoded block missing")
s = s.replace(old, new, 1)
old = '''  let decodedRegion;
  if (!optimizerAttribution && box && validQuadObject(info == null ? void 0 : info.quad) && info.modules) {
    const priorBenchmarkFrame = activeBenchmarkFrame;
    if (productionTrace) activeBenchmarkFrame = productionTrace;
    const packetAt = info.scanId === void 0 ? decodedAt : (_b = scanCapturedAt.get(info.scanId)) != null ? _b : decodedAt;
    const snapshot = info.geometryMeasured === false
      ? gridLattice.noteValidPacket(packetAt)
      : gridLattice.accept({
          identity,
          layoutId: header.layoutId,
          slotIndex: header.slotIndex,
          at: packetAt,
          scanId: (_c = info.scanId) != null ? _c : -1,
          box,
          quad: info.quad,
          modules: info.modules
        }, receiverFrameWidth, receiverFrameHeight);
    if (snapshot) {
      decodedRegion = syncGrid(
        snapshot,
        decodedAt,
        header.slotIndex,
        { ...info, crc32: true }
      );
    }
    if (productionTrace) productionTrace.stateAfter = gridLattice.state;
    activeBenchmarkFrame = priorBenchmarkFrame;
  }'''
new = '''  let decodedRegion;
  if (!optimizerAttribution) {
    const priorBenchmarkFrame = activeBenchmarkFrame;
    if (productionTrace) activeBenchmarkFrame = productionTrace;
    const packetAt = info?.scanId === void 0 ? decodedAt : scanCapturedAt.get(info.scanId) ?? decodedAt;
    const geometryInfo = { ...info, crc32: true };
    if (info?.geometryMeasured === false) {
      gridLattice.noteValidPacket(packetAt);
      decodedRegion = markGridRegionDecoded(
        regions.find((region) => region.gridSlot === header.slotIndex),
        decodedAt,
        geometryInfo
      );
    } else if (box && validQuadObject(info?.quad) && info?.modules) {
      const snapshot = gridLattice.accept({
        identity,
        layoutId: header.layoutId,
        slotIndex: header.slotIndex,
        at: packetAt,
        scanId: info?.scanId ?? -1,
        box,
        quad: info.quad,
        modules: info.modules
      }, receiverFrameWidth, receiverFrameHeight);
      if (snapshot)
        decodedRegion = syncGrid(snapshot, decodedAt, header.slotIndex, geometryInfo);
    }
    if (productionTrace) productionTrace.stateAfter = gridLattice.state;
    activeBenchmarkFrame = priorBenchmarkFrame;
  }'''
if old not in s: raise SystemExit("onDecoded geometry block missing")
s = s.replace(old, new, 1)
main.write_text(s)
