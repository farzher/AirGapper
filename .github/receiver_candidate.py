from pathlib import Path


def rep(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'missing anchor {path}: {old[:120]}')
    p.write_text(s.replace(old, new, 1))

# v278 runtime/version.
rep('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.277";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.278";')
rep('main.js', 'const APP_BUILD = "v0.5.277";', 'const APP_BUILD = "v0.5.278";')
p = Path('index.html')
s = p.read_text()
if s.count('v0.5.277') < 2:
    raise SystemExit('index version anchors missing')
p.write_text(s.replace('v0.5.277', 'v0.5.278'))
rep('sw.js', 'airgapper-static-js-v225', 'airgapper-static-js-v226')

# A fresh distributed set must be judged by its own multi-QR fit. The old code
# fitted the newest *single* QR first and used that extrapolation as an outlier
# oracle across the whole wall, which can reject valid opposite-side anchors.
p = Path('receive/grid-lattice.js')
s = p.read_text()
old = '''    const current = observations.filter((observation) => newest.at - observation.at <= CURRENT_FIT_MS);\n    if (distributedFitReady(layout, current)) observations = current;\n    const pairsFor = (items) => items.flatMap((observation) => {\n      const slot = observation.slotIndex;\n      return slotWorld(layout, observation.modules, slot).map((world, index) => ({ world, image: corners(observation.quad)[index] }));\n    });\n    const seed = fitHomography(pairsFor([newest]));\n    if (!seed) return null;\n    observations = observations.filter((observation) => {\n      const projected = slotWorld(layout, observation.modules, observation.slotIndex).map((point) => project(seed, point));\n      const image = corners(observation.quad);\n      const edge2 = Math.max(1, Math.sqrt(observation.box.w * observation.box.h));\n      const residual = Math.sqrt(projected.reduce((sum, point, index) => sum + (point.x - image[index].x) ** 2 + (point.y - image[index].y) ** 2, 0) / 4) / edge2;\n      return residual < 0.3;\n    });\n'''
new = '''    const current = observations.filter((observation) => newest.at - observation.at <= CURRENT_FIT_MS);\n    const currentDistributed = distributedFitReady(layout, current);\n    if (currentDistributed) observations = current;\n    const pairsFor = (items) => items.flatMap((observation) => {\n      const slot = observation.slotIndex;\n      return slotWorld(layout, observation.modules, slot).map((world, index) => ({ world, image: corners(observation.quad)[index] }));\n    });\n    // When this camera-time window already spans both wall axes, seed the\n    // outlier test from the distributed observations themselves. A homography\n    // inferred from one QR is exact locally but is not a safe extrapolation\n    // oracle across a large lens-distorted wall. If a filtering pass would\n    // destroy the fresh cross-axis constraint, keep the CRC-backed fresh set.\n    const seed = fitHomography(pairsFor(currentDistributed ? observations : [newest]));\n    if (!seed) return null;\n    const filtered = observations.filter((observation) => {\n      const projected = slotWorld(layout, observation.modules, observation.slotIndex).map((point) => project(seed, point));\n      const image = corners(observation.quad);\n      const edge2 = Math.max(1, Math.sqrt(observation.box.w * observation.box.h));\n      const residual = Math.sqrt(projected.reduce((sum, point, index) => sum + (point.x - image[index].x) ** 2 + (point.y - image[index].y) ** 2, 0) / 4) / edge2;\n      return residual < 0.3;\n    });\n    if (!currentDistributed || distributedFitReady(layout, filtered)) observations = filtered;\n'''
if old not in s:
    raise SystemExit('distributed fit seed anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)

# Recovery is a low-rate geometry measurement lane, not a second receiver.
# At 30 camera fps, 350 ms caps it below ~3 scouts/s instead of consuming ~9/s.
rep('receive/main.js', 'const LOCKED_RECOVERY_SCAN_MS = 160;', 'const LOCKED_RECOVERY_SCAN_MS = 350;')
rep('receive/main.js', '    if (localRecoverySeedScan) acquisitionMode = "seed";', '    if (localRecoverySeedScan) acquisitionMode = "recovery";')

p = Path('receive/main.js')
s = p.read_text()
old = '''      // A small bump moves the rigid wall coherently. Probe one central predicted\n      // QR at a time instead of rescanning the whole wall; the first CRC-valid\n      // packet re-homographies every slot. Rotate a few central choices so an\n      // occluded/transitioning code cannot stall reacquisition.\n      const cx = vw / 2, cy = vh / 2;\n      const ranked = [...lockedGeometryCandidates].sort((a, b) => {\n        const missDelta = (b.consecutiveMisses || 0) - (a.consecutiveMisses || 0);\n        if (missDelta) return missDelta;\n        const ageDelta = (a.decodedSeen ?? -Infinity) - (b.decodedSeen ?? -Infinity);\n        if (ageDelta) return ageDelta;\n        const ad = Math.hypot(a.x + a.w / 2 - cx, a.y + a.h / 2 - cy);\n        const bd = Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy);\n        return bd - ad;\n      });\n      const poolSize = Math.min(6, ranked.length);\n      const target = ranked[acquisitionTileCursor++ % poolSize];\n      boundedScanCandidates = target ? [target] : [];\n      geometryRecoveryProbes++;\n      notePipelineEvent("local-recovery-probe", geometryRecoveryProbes);\n'''
new = '''      // Repair the missing side, not the side that is already trackable. The\n      // previous recovery pool was lockedGeometryCandidates, which excludes an\n      // OFFSCREEN/invalid prediction by definition and could therefore probe\n      // the surviving half forever. Rank every predicted grid slot, preferring\n      // lost/partial/offscreen and stale slots before healthy active slots.\n      const cx = vw / 2, cy = vh / 2;\n      const statePriority = (region) => region.slotState === "LOST" ? 5\n        : region.slotState === "PARTIAL" ? 4\n          : region.slotState === "OFFSCREEN" ? 3\n            : region.slotState === "LOW_QUALITY" ? 2 : 0;\n      const recoveryPool = regions.filter((region) => region.gridSlot !== void 0 && region.quad && region.dim);\n      const ranked = recoveryPool.sort((a, b) => {\n        const stateDelta = statePriority(b) - statePriority(a);\n        if (stateDelta) return stateDelta;\n        const missDelta = (b.consecutiveMisses || 0) - (a.consecutiveMisses || 0);\n        if (missDelta) return missDelta;\n        const ageDelta = (a.decodedSeen ?? -Infinity) - (b.decodedSeen ?? -Infinity);\n        if (ageDelta) return ageDelta;\n        const ad = Math.hypot(a.x + a.w / 2 - cx, a.y + a.h / 2 - cy);\n        const bd = Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy);\n        return bd - ad;\n      });\n      const poolSize = Math.min(8, ranked.length);\n      const target = poolSize ? ranked[acquisitionTileCursor++ % poolSize] : void 0;\n      boundedScanCandidates = target ? [target] : [];\n      geometryRecoveryProbes++;\n      if (target) lastRecoveryReason = `measuring weak grid slot s${target.gridSlot} ${target.slotState.toLowerCase()}`;\n      notePipelineEvent("local-recovery-probe", geometryRecoveryProbes);\n'''
if old not in s:
    raise SystemExit('recovery target block missing')
s = s.replace(old, new, 1)

old = '''      const typicalEdge = Math.max(...boundedScanCandidates.map((region) => Math.max(region.w, region.h)));\n      const pad = Math.max(24, Math.round(typicalEdge * (provisionalCrop ? 0.9 : localRecoverySeedScan ? 1.0 : 0.7)));\n      const quantum = 16;\n      scanX = Math.max(0, Math.floor((Math.min(...points.map((point) => point.x)) - pad) / quantum) * quantum);\n      scanY = Math.max(0, Math.floor((Math.min(...points.map((point) => point.y)) - pad) / quantum) * quantum);\n      const scanRight = Math.min(vw, Math.ceil((Math.max(...points.map((point) => point.x)) + pad) / quantum) * quantum);\n      const scanBottom = Math.min(vh, Math.ceil((Math.max(...points.map((point) => point.y)) + pad) / quantum) * quantum);\n      scanW = Math.max(32, scanRight - scanX);\n      scanH = Math.max(32, scanBottom - scanY);\n'''
new = '''      const typicalEdge = Math.max(...boundedScanCandidates.map((region) => Math.max(region.w, region.h)));\n      const target = boundedScanCandidates[0];\n      const broadRecovery = localRecoverySeedScan && (target.slotState === "OFFSCREEN" || target.slotState === "PARTIAL" || !validTrackedQuad(target, vw, vh));\n      const quantum = 16;\n      if (broadRecovery) {\n        // If the predicted QR itself is outside/near the edge, a tiny crop can\n        // never rediscover it. Search a broad edge/quadrant tile centered as\n        // close as possible to its predicted location. This is still far less\n        // work than a whole 1440x2560 frame.\n        const predictedX = points.reduce((sum, point) => sum + point.x, 0) / points.length;\n        const predictedY = points.reduce((sum, point) => sum + point.y, 0) / points.length;\n        const wantedW = Math.min(vw, Math.max(typicalEdge * 6, vw * 0.45));\n        const wantedH = Math.min(vh, Math.max(typicalEdge * 6, vh * 0.35));\n        const centerX = Math.max(wantedW / 2, Math.min(vw - wantedW / 2, predictedX));\n        const centerY = Math.max(wantedH / 2, Math.min(vh - wantedH / 2, predictedY));\n        scanX = Math.max(0, Math.floor((centerX - wantedW / 2) / quantum) * quantum);\n        scanY = Math.max(0, Math.floor((centerY - wantedH / 2) / quantum) * quantum);\n        const scanRight = Math.min(vw, Math.ceil((centerX + wantedW / 2) / quantum) * quantum);\n        const scanBottom = Math.min(vh, Math.ceil((centerY + wantedH / 2) / quantum) * quantum);\n        scanW = Math.max(32, scanRight - scanX);\n        scanH = Math.max(32, scanBottom - scanY);\n      } else {\n        const pad = Math.max(24, Math.round(typicalEdge * (provisionalCrop ? 0.9 : localRecoverySeedScan ? 1.5 : 0.7)));\n        scanX = Math.max(0, Math.floor((Math.min(...points.map((point) => point.x)) - pad) / quantum) * quantum);\n        scanY = Math.max(0, Math.floor((Math.min(...points.map((point) => point.y)) - pad) / quantum) * quantum);\n        const scanRight = Math.min(vw, Math.ceil((Math.max(...points.map((point) => point.x)) + pad) / quantum) * quantum);\n        const scanBottom = Math.min(vh, Math.ceil((Math.max(...points.map((point) => point.y)) + pad) / quantum) * quantum);\n        scanW = Math.max(32, scanRight - scanX);\n        scanH = Math.max(32, scanBottom - scanY);\n      }\n'''
if old not in s:
    raise SystemExit('recovery crop block missing')
s = s.replace(old, new, 1)
p.write_text(s)

# A deliberately low-rate recovery tile can afford to return a few real QR
# quads. This lets one camera frame establish cross-wall geometry instead of
# needing several one-symbol scans from different moments.
p = Path('receive/worker.js')
s = p.read_text()
old = '''        const readDenseSeed = () => decodePixelFormat === "y8"\n          ? zx.readDenseY(ptr + inputOffset, pw, ph, inputStride, 1)\n          : zx.readFull(ptr, pw, ph, true, 1, false);\n'''
new = '''        const readDenseSeed = (maxSymbols = 1) => decodePixelFormat === "y8"\n          ? zx.readDenseY(ptr + inputOffset, pw, ph, inputStride, maxSymbols)\n          : zx.readFull(ptr, pw, ph, true, maxSymbols, false);\n'''
if old not in s:
    raise SystemExit('readDenseSeed anchor missing')
s = s.replace(old, new, 1)
old = '''        } else {\n          // Both global fast acquisition and bounded seed/recovery crops are\n          // optimized for the first useful AirGapper packet, not symbol count.\n          readFullAttempts++;\n          appendResults(readDenseSeed(), false);\n        }\n'''
new = '''        } else if (fullMode === "recovery") {\n          readFullAttempts++;\n          appendResults(readDenseSeed(3), false);\n        } else {\n          // Cold acquisition still returns the first useful packet immediately.\n          readFullAttempts++;\n          appendResults(readDenseSeed(), false);\n        }\n'''
if old not in s:
    raise SystemExit('recovery dense mode anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)
