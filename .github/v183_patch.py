from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old!r}")
    p.write_text(text.replace(old, new, 1))

for path in ["index.html", "main.js", "receive/main.js"]:
    p = Path(path)
    text = p.read_text()
    if "v0.5.182" not in text:
        raise SystemExit(f"expected v0.5.182 in {path}")
    p.write_text(text.replace("v0.5.182", "v0.5.183"))

replace_once("sw.js", "airgapper-static-js-v144", "airgapper-static-js-v145")
replace_once("vendor/decimen-codec/source/VERSION", "0.1.18", "0.1.19")

# ---- Shared cross-worker guided fallback policy -----------------------------
replace_once(
    "receive/main.js",
    '''const slotAdaptiveWeak = new Uint8Array(SLOT_METRIC_COUNT);\nfunction resetSlotMetrics() {''',
    '''const slotAdaptiveWeak = new Uint8Array(SLOT_METRIC_COUNT);\n\n// Full SampleQR fallback is expensive enough that six independent worker-local\n// histories learn far too slowly. Own the policy here, keyed by physical grid\n// slot, and send each guided job one allow-mask. The thresholds intentionally\n// match v175's conservative policy; only the evidence is now shared globally.\nconst GUIDED_FALLBACK_SLOT_COUNT = 32;\nconst guidedFallbackMisses = new Uint8Array(GUIDED_FALLBACK_SLOT_COUNT);\nconst guidedFallbackCooldown = new Uint8Array(GUIDED_FALLBACK_SLOT_COUNT);\nconst guidedFallbackBackoff = new Uint8Array(GUIDED_FALLBACK_SLOT_COUNT);\nfunction resetGuidedFallbackSlot(slot) {\n  guidedFallbackMisses[slot] = 0;\n  guidedFallbackCooldown[slot] = 0;\n  guidedFallbackBackoff[slot] = 0;\n}\nfunction resetGuidedFallbackPolicy() {\n  guidedFallbackMisses.fill(0);\n  guidedFallbackCooldown.fill(0);\n  guidedFallbackBackoff.fill(0);\n}\nfunction guidedFallbackMaskForTracks(tracks) {\n  let mask = 0;\n  for (const track of tracks ?? []) {\n    const slot = Number(track.slot ?? track.id);\n    if (!Number.isInteger(slot) || slot < 0 || slot >= GUIDED_FALLBACK_SLOT_COUNT) continue;\n    if (guidedFallbackCooldown[slot]) {\n      guidedFallbackCooldown[slot]--;\n      continue;\n    }\n    mask = (mask | ((1 << slot) >>> 0)) >>> 0;\n  }\n  return mask >>> 0;\n}\nfunction noteGuidedFallbackMetrics(guided) {\n  if (!guided) return;\n  const sparseSuccess = Number(guided.sparseSuccessMask) >>> 0;\n  const fallbackAttempt = Number(guided.fallbackAttemptMask) >>> 0;\n  const fallbackSuccess = Number(guided.fallbackSuccessMask) >>> 0;\n  for (let slot = 0; slot < GUIDED_FALLBACK_SLOT_COUNT; slot++) {\n    const bit = (1 << slot) >>> 0;\n    if (sparseSuccess & bit) {\n      resetGuidedFallbackSlot(slot);\n      continue;\n    }\n    if (!(fallbackAttempt & bit)) continue;\n    if (fallbackSuccess & bit) {\n      resetGuidedFallbackSlot(slot);\n      continue;\n    }\n    if (++guidedFallbackMisses[slot] < 4) continue;\n    guidedFallbackMisses[slot] = 0;\n    guidedFallbackBackoff[slot] = Math.min(3, guidedFallbackBackoff[slot] + 1);\n    guidedFallbackCooldown[slot] = guidedFallbackBackoff[slot];\n  }\n}\nfunction resetSlotMetrics() {'''
)

replace_once(
    "receive/main.js",
    '''  resetSlotMetrics();\n  resetGuidedRollout();\n}''',
    '''  resetSlotMetrics();\n  resetGuidedFallbackPolicy();\n  resetGuidedRollout();\n}'''
)

replace_once(
    "receive/main.js",
    '''  const guidedStage = chooseGuidedStage(message);\n  const auditMode = {''',
    '''  const guidedStage = chooseGuidedStage(message);\n  if (guidedStage) message.guidedFallbackMask = guidedFallbackMaskForTracks(message.tracks);\n  const auditMode = {'''
)

replace_once(
    "receive/main.js",
    '''    const guided = completion.guidedMetrics;\n    const guidedMs = Math.max(0, Number(guided?.totalMs) || 0);''',
    '''    const guided = completion.guidedMetrics;\n    if (guided) noteGuidedFallbackMetrics(guided);\n    const guidedMs = Math.max(0, Number(guided?.totalMs) || 0);'''
)

replace_once(
    "receive/main.js",
    '''  resetGuidedRollout();\n  strictHotPathLockSeen = false;''',
    '''  resetGuidedRollout();\n  resetGuidedFallbackPolicy();\n  strictHotPathLockSeen = false;'''
)

# ---- Paint 100% before synchronous assembly/hash work -----------------------
replace_once(
    "receive/main.js",
    '''let done = false;\nlet statsTimer;''',
    '''let done = false;\nlet transferFinalizing = false;\nlet statsTimer;'''
)

replace_once(
    "receive/main.js",
    '''  lastDistinctArrivalAt = 0;\n  bar.style.width = "0";''',
    '''  lastDistinctArrivalAt = 0;\n  transferFinalizing = false;\n  bar.style.width = "0";'''
)

replace_once(
    "receive/main.js",
    '''  } else if (decoder.isComplete) {\n    const payload = decoder.assemble();\n    const seconds = (receiverNow() - startTs) / 1e3;\n    const ok = fnv1a(payload) === header.payloadId;\n    void finish(payload, ok, seconds);\n  }\n}\nfunction updateProgressEstimate() {\n  if (!decoder) return;''',
    '''  } else if (decoder.isComplete && !transferFinalizing) {\n    void finalizeCompletedTransfer(header.payloadId);\n  }\n}\nfunction paintTransferComplete() {\n  bar.style.width = "100%";\n  progressEl.setAttribute("aria-valuenow", "100");\n  progressLabel.textContent = "100%";\n  transferSizeLabel.textContent = "";\n  etaLabel.textContent = "Finalizing…";\n}\nfunction waitForProgressPaint() {\n  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));\n}\nasync function finalizeCompletedTransfer(payloadId) {\n  if (!decoder || done || transferFinalizing) return;\n  transferFinalizing = true;\n  const completingDecoder = decoder;\n  const completingGeneration = captureGen;\n  paintTransferComplete();\n  await waitForProgressPaint();\n  if (done || decoder !== completingDecoder || captureGen !== completingGeneration) {\n    transferFinalizing = false;\n    return;\n  }\n  const payload = completingDecoder.assemble();\n  const seconds = (receiverNow() - startTs) / 1e3;\n  const ok = fnv1a(payload) === payloadId;\n  await finish(payload, ok, seconds);\n}\nfunction updateProgressEstimate() {\n  if (!decoder || transferFinalizing) return;'''
)

# ---- Worker: forward allow-mask and read per-slot outcome masks -------------
replace_once("receive/worker.js", "const GUIDED_METRICS_BYTES = 128;", "const GUIDED_METRICS_BYTES = 144;")
replace_once(
    "receive/worker.js",
    '''function decodeGuidedBatch(zx, yPtr, width, height, stride, ox, oy, tracks) {''',
    '''function decodeGuidedBatch(zx, yPtr, width, height, stride, ox, oy, tracks, fallbackAllowedMask = 0xffffffff) {'''
)
replace_once(
    "receive/worker.js",
    '''    guidedOutputPtr, GUIDED_OUTPUT_BYTES,\n    tracks.length, guidedMetricsPtr''',
    '''    guidedOutputPtr, GUIDED_OUTPUT_BYTES,\n    tracks.length, fallbackAllowedMask >>> 0, guidedMetricsPtr'''
)
replace_once(
    "receive/worker.js",
    '''    sparseRsFallbacks: metricsView.getUint32(116, true),\n    sparseSkipped: metricsView.getUint32(120, true)\n  };''',
    '''    sparseRsFallbacks: metricsView.getUint32(116, true),\n    sparseSkipped: metricsView.getUint32(120, true),\n    fallbackAttemptMask: metricsView.getUint32(128, true),\n    fallbackSuccessMask: metricsView.getUint32(132, true),\n    sparseSuccessMask: metricsView.getUint32(136, true)\n  };'''
)
replace_once(
    "receive/worker.js",
    '''const { id, buf, videoFrame, cropX = 0, cropY = 0, w = 0, h = 0, ox = 0, oy = 0, full = true, quad, dim, tracks, isolated = false, oracle = false, oracleSeeds = [], sentAt, pixelFormat = "rgba", yOffset: messageYOffset = 0, yStride: messageYStride = 0, payloadBytes = 0, strictHotPath = false, outputMap, thorough = false, acquisitionMode, guidedDecode = false, sourceSequence, repeatFilter = false, previousFrameSignature } = e.data;''',
    '''const { id, buf, videoFrame, cropX = 0, cropY = 0, w = 0, h = 0, ox = 0, oy = 0, full = true, quad, dim, tracks, isolated = false, oracle = false, oracleSeeds = [], sentAt, pixelFormat = "rgba", yOffset: messageYOffset = 0, yStride: messageYStride = 0, payloadBytes = 0, strictHotPath = false, outputMap, thorough = false, acquisitionMode, guidedDecode = false, guidedFallbackMask = 0xffffffff, sourceSequence, repeatFilter = false, previousFrameSignature } = e.data;'''
)
replace_once(
    "receive/worker.js",
    '''        const guided = decodeGuidedBatch(\n          zx, ptr + inputOffset, pw, ph, inputStride, ox, oy, tracks\n        );''',
    '''        const guided = decodeGuidedBatch(\n          zx, ptr + inputOffset, pw, ph, inputStride, ox, oy, tracks, guidedFallbackMask\n        );'''
)

# ---- Codec ABI: externally-controlled fallback + per-slot outcome masks -----
replace_once(
    "vendor/decimen-codec/source/wrapper/decimen_codec.h",
    '''\tuint32_t sparseSkipped;\n\tuint32_t reserved;\n};''',
    '''\tuint32_t sparseSkipped;\n\tuint32_t reserved;\n\tuint32_t fallbackAttemptMask;\n\tuint32_t fallbackSuccessMask;\n\tuint32_t sparseSuccessMask;\n\tuint32_t reserved2;\n};'''
)
replace_once(
    "vendor/decimen-codec/source/wrapper/decimen_codec.h",
    '''\t\t\t\t\t\t uint8_t* output, int outputCapacity, int maxSymbols,\n\t\t\t\t\t\t DecimenGuidedMetrics* metrics);''',
    '''\t\t\t\t\t\t uint8_t* output, int outputCapacity, int maxSymbols,\n\t\t\t\t\t\t uint32_t fallbackAllowedMask, DecimenGuidedMetrics* metrics);'''
)

cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"
start = '''// Full SampleQR is substantially more expensive than the sparse stage because it\n// searches the complete alignment lattice before RS decode. Keep it hot while it\n// is producing packets, but progressively thin it after repeated *proven* misses.\n// This is deliberately local to the fallback itself: medium-quality QR slots stay\n// in every camera frame, and any success immediately restores full fallback cadence.\nstruct GuidedFallbackState\n{\n    std::array<uint8_t, 64> misses{};\n    std::array<uint8_t, 64> cooldown{};\n    std::array<uint8_t, 64> backoff{};\n};\n\nstatic GuidedFallbackState& guidedFallbackState()\n{\n    static GuidedFallbackState state;\n    return state;\n}\n\nstatic bool guidedFallbackAllowed(int id)\n{\n    if (id < 0 || id >= int(guidedFallbackState().cooldown.size()))\n        return true;\n    auto& cooldown = guidedFallbackState().cooldown[id];\n    if (!cooldown)\n        return true;\n    --cooldown;\n    return false;\n}\n\nstatic void noteGuidedFallbackOutcome(int id, bool success)\n{\n    if (id < 0 || id >= int(guidedFallbackState().misses.size()))\n        return;\n    auto& state = guidedFallbackState();\n    if (success) {\n        state.misses[id] = 0;\n        state.cooldown[id] = 0;\n        state.backoff[id] = 0;\n        return;\n    }\n    if (++state.misses[id] < 4)\n        return;\n    state.misses[id] = 0;\n    state.backoff[id] = std::min<uint8_t>(3, state.backoff[id] + 1);\n    state.cooldown[id] = state.backoff[id];\n}\n\n'''
replace_once(cpp, start, '''// Full SampleQR fallback policy is owned by the main thread so every worker\n// learns from the same physical-slot history. The codec only executes the\n// supplied allow-mask and reports per-slot outcomes back.\n\n''')
replace_once(
    cpp,
    '''                                   uint8_t* output, int outputCapacity, int maxSymbols,\n                                   DecimenGuidedMetrics* metrics)''',
    '''                                   uint8_t* output, int outputCapacity, int maxSymbols,\n                                   uint32_t fallbackAllowedMask, DecimenGuidedMetrics* metrics)'''
)
replace_once(
    cpp,
    '''                    if (decodedTrack) {\n                        ++metrics->fastDecodeSuccesses;\n                        noteGuidedFallbackOutcome(track.id, true);\n                    }''',
    '''                    if (decodedTrack) {\n                        ++metrics->fastDecodeSuccesses;\n                        if (track.id >= 0 && track.id < 32)\n                            metrics->sparseSuccessMask |= uint32_t(1) << track.id;\n                    }'''
)
replace_once(
    cpp,
    '''            // Sparse misses retain the exact proven decoder, but repeated full\n            // fallback misses are no longer allowed to monopolize the worker.\n            // Four consecutive misses introduce a one-frame skip; continued\n            // misses grow that to at most three. A sparse or fallback success\n            // resets the backoff immediately.\n            if (!decodedTrack) {\n                if (!guidedFallbackAllowed(track.id)) {\n                    ++metrics->genericFallbackSkipped;\n                } else {\n                    ++metrics->genericFallbackTracks;\n                    bool fallbackSuccess = false;\n                    for (auto&& detected : QRCode::SampleQR(*bits, finderSet)) {''',
    '''            // Sparse misses retain the exact proven decoder. Full SampleQR is\n            // gated by the receiver-wide physical-slot policy supplied with this\n            // job, so one bad slot cannot relearn the same miss independently in\n            // every worker.\n            if (!decodedTrack) {\n                const bool fallbackAllowed = track.id < 0 || track.id >= 32 ||\n                    (fallbackAllowedMask & (uint32_t(1) << track.id)) != 0;\n                if (!fallbackAllowed) {\n                    ++metrics->genericFallbackSkipped;\n                } else {\n                    ++metrics->genericFallbackTracks;\n                    if (track.id >= 0 && track.id < 32)\n                        metrics->fallbackAttemptMask |= uint32_t(1) << track.id;\n                    bool fallbackSuccess = false;\n                    for (auto&& detected : QRCode::SampleQR(*bits, finderSet)) {'''
)
replace_once(
    cpp,
    '''                            ++metrics->genericFallbackSuccesses;\n                            break;\n                        }\n                    }\n                    noteGuidedFallbackOutcome(track.id, fallbackSuccess);\n                }''',
    '''                            ++metrics->genericFallbackSuccesses;\n                            if (track.id >= 0 && track.id < 32)\n                                metrics->fallbackSuccessMask |= uint32_t(1) << track.id;\n                            break;\n                        }\n                    }\n                }'''
)
