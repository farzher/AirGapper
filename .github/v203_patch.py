from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:240]!r}")
    p.write_text(s.replace(old, new, count))

# Version/cache.
replace("index.html", "v0.5.202", "v0.5.203")
replace("main.js", 'const APP_BUILD = "v0.5.202";', 'const APP_BUILD = "v0.5.203";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.202";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.203";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v164";', 'const CACHE = "airgapper-static-js-v165";')
replace("vendor/decimen-codec/source/VERSION", "0.1.25", "0.1.26")

# ---------------------------------------------------------------------------
# Grid lattice: stop feeding raw one-frame decoder corner jitter back into the
# hot path. Learn persistent per-slot lens residuals relative to the coherent
# whole-wall homography, then publish global pose + slowly learned local shape.
# ---------------------------------------------------------------------------
grid = Path("receive/grid-lattice.js")
s = grid.read_text()

old = '''const CURRENT_FIT_MS = 420;\nconst EXACT_GEOMETRY_MS = 420;'''
new = '''const CURRENT_FIT_MS = 420;\nconst EXACT_GEOMETRY_MS = 420;\n// CRC-backed QR corner estimates still carry ~subpixel/pixel frame noise. The\n// wall itself is rigid, so publish coherent global motion and retain only the\n// slowly learned local residual that represents lens distortion.\nconst LOCAL_GEOMETRY_LEARN_MAX_ERROR = 0.08;\nconst LOCAL_GEOMETRY_MAX_RESIDUAL = 0.08;\nconst LOCAL_GEOMETRY_ALPHA = 0.08;'''
if old not in s: raise SystemExit("grid constants missing")
s = s.replace(old, new, 1)

old = '''    __publicField(this, "observations", []);\n    __publicField(this, "candidate");'''
new = '''    __publicField(this, "observations", []);\n    __publicField(this, "slotCorrections", /* @__PURE__ */ new Map());\n    __publicField(this, "candidate");'''
if old not in s: raise SystemExit("grid constructor missing")
s = s.replace(old, new, 1)

old = '''    this.identity = "";\n    this.observations = [];\n    this.candidate = void 0;'''
new = '''    this.identity = "";\n    this.observations = [];\n    this.slotCorrections.clear();\n    this.candidate = void 0;'''
if old not in s: raise SystemExit("grid reset missing")
s = s.replace(old, new, 1)

old = '''    this.transition("REACQUIRE", reason, at);\n    this.observations = [];\n    this.candidate = void 0;'''
new = '''    this.transition("REACQUIRE", reason, at);\n    this.observations = [];\n    this.slotCorrections.clear();\n    this.candidate = void 0;'''
if old not in s: raise SystemExit("grid reacquire missing")
s = s.replace(old, new, 1)

old = '''    if (this.candidate && this.candidate.layout.id !== declaredLayout.id) {\n      this.observations = [];\n      this.candidate = void 0;\n    }'''
new = '''    if (this.candidate && this.candidate.layout.id !== declaredLayout.id) {\n      this.observations = [];\n      this.slotCorrections.clear();\n      this.candidate = void 0;\n    }'''
if old not in s: raise SystemExit("grid layout reset missing")
s = s.replace(old, new, 1)

old = '''    }\n    return this.snapshot();\n  }\n  tick(now) {'''
new = '''    }\n    this.learnSlotCorrection(detection);\n    return this.snapshot();\n  }\n  learnSlotCorrection(detection) {\n    const candidate = this.candidate;\n    if (!this.locked || !candidate || candidate.error > LOCAL_GEOMETRY_LEARN_MAX_ERROR) return;\n    const measured = corners(detection.quad);\n    if (!validPoints(measured) || !detection.box) return;\n    const predicted = slotWorld(candidate.layout, detection.modules, detection.slotIndex)\n      .map((point) => project(candidate.transform, point));\n    const edge = Math.max(1, Math.sqrt(detection.box.w * detection.box.h));\n    const residual = measured.map((point, index) => ({\n      x: point.x - predicted[index].x,\n      y: point.y - predicted[index].y\n    }));\n    if (residual.some((point) => Math.hypot(point.x, point.y) > edge * LOCAL_GEOMETRY_MAX_RESIDUAL)) return;\n    const previous = this.slotCorrections.get(detection.slotIndex);\n    if (!previous || previous.length !== 4) {\n      // First CRC-backed sample establishes the local lens residual immediately;\n      // later samples only nudge it slowly so decoder corner noise cannot move\n      // one QR independently from the rest of the wall.\n      this.slotCorrections.set(detection.slotIndex, residual);\n      return;\n    }\n    const next = residual.map((point, index) => ({\n      x: previous[index].x + (point.x - previous[index].x) * LOCAL_GEOMETRY_ALPHA,\n      y: previous[index].y + (point.y - previous[index].y) * LOCAL_GEOMETRY_ALPHA\n    }));\n    this.slotCorrections.set(detection.slotIndex, next);\n  }\n  tick(now) {'''
if old not in s: raise SystemExit("grid accept/tick boundary missing")
s = s.replace(old, new, 1)

old = '''    const decoded = new Set(observed.keys());\n    const slots = [];\n    for (let index = 0; index < count; index++) {\n      const observation = observed.get(index);\n      let quad;\n      if (observation && validGeometry(observation)) {\n        const points = corners(observation.quad);\n        quad = {\n          topLeft: { ...points[0] },\n          topRight: { ...points[1] },\n          bottomRight: { ...points[2] },\n          bottomLeft: { ...points[3] }\n        };\n      } else {\n        const points = slotWorld(candidate.layout, modules, index).map((point) => project(candidate.transform, point));\n        quad = { topLeft: points[0], topRight: points[1], bottomRight: points[2], bottomLeft: points[3] };\n      }\n      const box = bounds(quad);'''
new = '''    const decoded = new Set(observed.keys());\n    const slots = [];\n    for (let index = 0; index < count; index++) {\n      // Never publish a raw per-frame QR quad. The whole wall moves through one\n      // homography; each slot carries only its persistent local lens residual.\n      // This removes independent overlay/track jitter while preserving the\n      // non-projective distortion Guided calibrated for the hot sampler.\n      let points = slotWorld(candidate.layout, modules, index).map((point) => project(candidate.transform, point));\n      const correction = this.slotCorrections.get(index);\n      if (correction && correction.length === 4) {\n        points = points.map((point, cornerIndex) => ({\n          x: point.x + correction[cornerIndex].x,\n          y: point.y + correction[cornerIndex].y\n        }));\n      }\n      const quad = { topLeft: points[0], topRight: points[1], bottomRight: points[2], bottomLeft: points[3] };\n      const box = bounds(quad);'''
if old not in s: raise SystemExit("grid snapshot raw-quad block missing")
s = s.replace(old, new, 1)

old = '''      observedSlots: observed.size, storedSlots: this.observations.length, fitSlots: candidate.observations.length,\n      fitError: candidate.error'''
new = '''      observedSlots: observed.size, correctedSlots: this.slotCorrections.size,\n      storedSlots: this.observations.length, fitSlots: candidate.observations.length,\n      fitError: candidate.error'''
if old not in s: raise SystemExit("grid snapshot diagnostics missing")
s = s.replace(old, new, 1)

grid.write_text(s)

# ---------------------------------------------------------------------------
# Codec diagnostics + slightly more realistic rigid-stability tolerance.
# ---------------------------------------------------------------------------
header = Path("vendor/decimen-codec/source/wrapper/decimen_codec.h")
s = header.read_text()
old = '''\tuint32_t sparseSuccessMask;\n\tuint32_t reserved2;\n};'''
new = '''\tuint32_t sparseSuccessMask;\n\tuint32_t reserved2;\n\tuint32_t stableRsAttempts;\n\tuint32_t stableRsSuccesses;\n\tuint32_t stableEligibleTracks;\n};'''
if old not in s: raise SystemExit("guided metrics tail missing")
s = s.replace(old, new, 1)
header.write_text(s)

cpp = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = cpp.read_text()
old = '''    return module >= GUIDED_TURBO_CANARY_MIN_MODULE &&\n           residual <= std::max(0.65f, module * 0.24f);'''
new = '''    return module >= GUIDED_TURBO_CANARY_MIN_MODULE &&\n           residual <= std::max(1.0f, module * 0.40f);'''
if old not in s: raise SystemExit("stable rigid threshold missing")
s = s.replace(old, new, 1)

old = '''            const bool stableEligible = stableReference && turboStableRigidEligible(*cache, track, residual);\n            const bool directMode = !turboAdaptive.promoted || !turboAdaptive.rsMode;'''
new = '''            const bool stableEligible = stableReference && turboStableRigidEligible(*cache, track, residual);\n            if (stableEligible)\n                ++metrics->stableEligibleTracks;\n            const bool directMode = !turboAdaptive.promoted || !turboAdaptive.rsMode;'''
if old not in s: raise SystemExit("stable eligible site missing")
s = s.replace(old, new, 1)

old = '''                if (levels.ok) {\n                    stableRsAttempted = true;\n                    ++metrics->sampleAttempts;\n                    ++metrics->sparseRsFallbacks;\n                    auto decoded = decodeTurboStableRS(*cache, track, yPlane, width, height, stride,\n                                                       dx, dy, levels, *metrics);\n                    success = commitTurbo(i, decoded, dx, dy);\n                }'''
new = '''                if (levels.ok) {\n                    stableRsAttempted = true;\n                    ++metrics->sampleAttempts;\n                    ++metrics->sparseRsFallbacks;\n                    ++metrics->stableRsAttempts;\n                    auto decoded = decodeTurboStableRS(*cache, track, yPlane, width, height, stride,\n                                                       dx, dy, levels, *metrics);\n                    success = commitTurbo(i, decoded, dx, dy);\n                    if (success)\n                        ++metrics->stableRsSuccesses;\n                }'''
if old not in s: raise SystemExit("stable RS attempt site missing")
s = s.replace(old, new, 1)
cpp.write_text(s)

# ---------------------------------------------------------------------------
# JS ABI + cumulative diagnostics.
# ---------------------------------------------------------------------------
worker = Path("receive/worker.js")
s = worker.read_text()
s = s.replace('const GUIDED_METRICS_BYTES = 144;', 'const GUIDED_METRICS_BYTES = 156;', 1)
old = '''    sparseSuccessMask: metricsView.getUint32(136, true),\n    turboSuccesses: metricsView.getUint32(140, true)\n  };'''
new = '''    sparseSuccessMask: metricsView.getUint32(136, true),\n    turboSuccesses: metricsView.getUint32(140, true),\n    stableRsAttempts: metricsView.getUint32(144, true),\n    stableRsSuccesses: metricsView.getUint32(148, true),\n    stableEligibleTracks: metricsView.getUint32(152, true)\n  };'''
if old not in s: raise SystemExit("worker guided metric mapping missing")
s = s.replace(old, new, 1)
worker.write_text(s)

main = Path("receive/main.js")
s = main.read_text()
old = '''  guidedTurboAttempts: 0,\n  guidedTurboSuccesses: 0,\n  guidedJobs: 0,'''
new = '''  guidedTurboAttempts: 0,\n  guidedTurboSuccesses: 0,\n  guidedStableRsAttempts: 0,\n  guidedStableRsSuccesses: 0,\n  guidedStableEligibleTracks: 0,\n  guidedJobs: 0,'''
if old not in s: raise SystemExit("livePipeline turbo fields missing")
s = s.replace(old, new, 1)

old = '''    guidedTurboAttempts: 0, guidedTurboSuccesses: 0,\n    guidedJobs: 0, guidedOutputs: 0,'''
new = '''    guidedTurboAttempts: 0, guidedTurboSuccesses: 0,\n    guidedStableRsAttempts: 0, guidedStableRsSuccesses: 0, guidedStableEligibleTracks: 0,\n    guidedJobs: 0, guidedOutputs: 0,'''
if old not in s: raise SystemExit("reset pipeline turbo fields missing")
s = s.replace(old, new, 1)

old = '''      livePipeline.guidedTurboAttempts += Math.max(0, Number(guided.turboAttempts) || 0);\n      livePipeline.guidedTurboSuccesses += Math.max(0, Number(guided.turboSuccesses) || 0);\n      livePipeline.guidedFinderAttempts += Math.max(0, Number(guided.finderAttempts) || 0);'''
new = '''      livePipeline.guidedTurboAttempts += Math.max(0, Number(guided.turboAttempts) || 0);\n      livePipeline.guidedTurboSuccesses += Math.max(0, Number(guided.turboSuccesses) || 0);\n      livePipeline.guidedStableRsAttempts += Math.max(0, Number(guided.stableRsAttempts) || 0);\n      livePipeline.guidedStableRsSuccesses += Math.max(0, Number(guided.stableRsSuccesses) || 0);\n      livePipeline.guidedStableEligibleTracks += Math.max(0, Number(guided.stableEligibleTracks) || 0);\n      livePipeline.guidedFinderAttempts += Math.max(0, Number(guided.finderAttempts) || 0);'''
if old not in s: raise SystemExit("guided accumulation missing")
s = s.replace(old, new, 1)

old = ''' · noRS ${lastGuidedMetrics.sparseNoRsSuccesses}/${lastGuidedMetrics.sparseNoRsAttempts} · RS ${lastGuidedMetrics.sparseRsFallbacks} · sparse-skip'''
new = ''' · noRS ${lastGuidedMetrics.sparseNoRsSuccesses}/${lastGuidedMetrics.sparseNoRsAttempts} · stableRS ${lastGuidedMetrics.stableRsSuccesses ?? 0}/${lastGuidedMetrics.stableRsAttempts ?? 0} eligible ${lastGuidedMetrics.stableEligibleTracks ?? 0} · RS ${lastGuidedMetrics.sparseRsFallbacks} · sparse-skip'''
if old not in s: raise SystemExit("last Guided diagnostics missing")
s = s.replace(old, new, 1)

old = '''Guided  ${guidedRollout.state} · ${livePipeline.guidedJobs} jobs · ${livePipeline.guidedOutputs} outputs · turbo ${livePipeline.guidedTurboSuccesses}/${livePipeline.guidedTurboAttempts} · finders'''
new = '''Guided  ${guidedRollout.state} · ${livePipeline.guidedJobs} jobs · ${livePipeline.guidedOutputs} outputs · turbo ${livePipeline.guidedTurboSuccesses}/${livePipeline.guidedTurboAttempts} · stableRS ${livePipeline.guidedStableRsSuccesses}/${livePipeline.guidedStableRsAttempts} · rigid ${livePipeline.guidedStableEligibleTracks} · finders'''
if old not in s: raise SystemExit("aggregate Guided diagnostics missing")
s = s.replace(old, new, 1)

old = '''Geometry ${lastGridSnapshot ? `${lastGridSnapshot.provisional ? "provisional · " : ""}${lastGridSnapshot.observedSlots ?? 0}/${lastGridSnapshot.slots.length} exact · global fit'''
new = '''Geometry ${lastGridSnapshot ? `${lastGridSnapshot.provisional ? "provisional · " : ""}${lastGridSnapshot.observedSlots ?? 0}/${lastGridSnapshot.slots.length} fresh · calibrated ${lastGridSnapshot.correctedSlots ?? 0}/${lastGridSnapshot.slots.length} · global fit'''
if old not in s: raise SystemExit("geometry diagnostics missing")
s = s.replace(old, new, 1)

main.write_text(s)
