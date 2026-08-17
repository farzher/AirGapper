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
    if "v0.5.183" not in text:
        raise SystemExit(f"expected v0.5.183 in {path}")
    p.write_text(text.replace("v0.5.183", "v0.5.184"))

replace_once("sw.js", "airgapper-static-js-v145", "airgapper-static-js-v146")
replace_once("vendor/decimen-codec/source/VERSION", "0.1.19", "0.1.20")

# ---- Remove v183 receiver-wide fallback policy ------------------------------
main = "receive/main.js"
p = Path(main)
text = p.read_text()
start = text.index("// Full SampleQR fallback is expensive enough that six independent worker-local")
end = text.index("function resetSlotMetrics()", start)
text = text[:start] + text[end:]
text = text.replace("  resetGuidedFallbackPolicy();\n", "")
text = text.replace("  if (guidedStage) message.guidedFallbackMask = guidedFallbackMaskForTracks(message.tracks);\n", "")
text = text.replace("    if (guided) noteGuidedFallbackMetrics(guided);\n", "")
p.write_text(text)

# ---- Worker: restore pre-v183 guided ABI ------------------------------------
replace_once("receive/worker.js", "const GUIDED_METRICS_BYTES = 144;", "const GUIDED_METRICS_BYTES = 128;")
replace_once(
    "receive/worker.js",
    "function decodeGuidedBatch(zx, yPtr, width, height, stride, ox, oy, tracks, fallbackAllowedMask = 0xffffffff) {",
    "function decodeGuidedBatch(zx, yPtr, width, height, stride, ox, oy, tracks) {"
)
replace_once(
    "receive/worker.js",
    "    guidedOutputPtr, GUIDED_OUTPUT_BYTES,\n    tracks.length, fallbackAllowedMask >>> 0, guidedMetricsPtr",
    "    guidedOutputPtr, GUIDED_OUTPUT_BYTES,\n    tracks.length, guidedMetricsPtr"
)
replace_once(
    "receive/worker.js",
    '''    sparseRsFallbacks: metricsView.getUint32(116, true),\n    sparseSkipped: metricsView.getUint32(120, true),\n    fallbackAttemptMask: metricsView.getUint32(128, true),\n    fallbackSuccessMask: metricsView.getUint32(132, true),\n    sparseSuccessMask: metricsView.getUint32(136, true)\n  };''',
    '''    sparseRsFallbacks: metricsView.getUint32(116, true),\n    sparseSkipped: metricsView.getUint32(120, true)\n  };'''
)
replace_once(
    "receive/worker.js",
    "guidedDecode = false, guidedFallbackMask = 0xffffffff, sourceSequence",
    "guidedDecode = false, sourceSequence"
)
replace_once(
    "receive/worker.js",
    "          zx, ptr + inputOffset, pw, ph, inputStride, ox, oy, tracks, guidedFallbackMask\n",
    "          zx, ptr + inputOffset, pw, ph, inputStride, ox, oy, tracks\n"
)

# ---- Codec: restore v168 sparse cadence and direct proven fallback ----------
h = "vendor/decimen-codec/source/wrapper/decimen_codec.h"
replace_once(
    h,
    '''\tuint32_t sparseSkipped;\n\tuint32_t reserved;\n\tuint32_t fallbackAttemptMask;\n\tuint32_t fallbackSuccessMask;\n\tuint32_t sparseSuccessMask;\n\tuint32_t reserved2;\n};''',
    '''\tuint32_t sparseSkipped;\n\tuint32_t reserved;\n};'''
)
replace_once(
    h,
    '''\t\t\t\t\t\t uint8_t* output, int outputCapacity, int maxSymbols,\n\t\t\t\t\t\t uint32_t fallbackAllowedMask, DecimenGuidedMetrics* metrics);''',
    '''\t\t\t\t\t\t uint8_t* output, int outputCapacity, int maxSymbols,\n\t\t\t\t\t\t DecimenGuidedMetrics* metrics);'''
)

cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"
replace_once(
    cpp,
    '''    if (++state.failures[id] >= 4) {\n        state.failures[id] = 0;\n        // Sparse sampling is materially cheaper than full SampleQR and often\n        // recovers on the very next animated frame. Back off only briefly after\n        // a real miss streak; the old 10-appearance cooldown stranded good slots.\n        state.cooldown[id] = 2;\n    }''',
    '''    if (++state.failures[id] >= 2) {\n        state.failures[id] = 0;\n        // Proven v168 cadence: a weak sparse geometry should not pay an extra\n        // sample + RS decode every animated frame. Re-probe periodically because\n        // a later pose/framing can become friendlier.\n        state.cooldown[id] = 10;\n    }'''
)
replace_once(
    cpp,
    '''                                   uint8_t* output, int outputCapacity, int maxSymbols,\n                                   uint32_t fallbackAllowedMask, DecimenGuidedMetrics* metrics)''',
    '''                                   uint8_t* output, int outputCapacity, int maxSymbols,\n                                   DecimenGuidedMetrics* metrics)'''
)
replace_once(
    cpp,
    '''                    if (decodedTrack) {\n                        ++metrics->fastDecodeSuccesses;\n                        if (track.id >= 0 && track.id < 32)\n                            metrics->sparseSuccessMask |= uint32_t(1) << track.id;\n                    }''',
    '''                    if (decodedTrack)\n                        ++metrics->fastDecodeSuccesses;'''
)
old = '''            // Sparse misses retain the exact proven decoder. Full SampleQR is\n            // gated by the receiver-wide physical-slot policy supplied with this\n            // job, so one bad slot cannot relearn the same miss independently in\n            // every worker.\n            if (!decodedTrack) {\n                const bool fallbackAllowed = track.id < 0 || track.id >= 32 ||\n                    (fallbackAllowedMask & (uint32_t(1) << track.id)) != 0;\n                if (!fallbackAllowed) {\n                    ++metrics->genericFallbackSkipped;\n                } else {\n                    ++metrics->genericFallbackTracks;\n                    if (track.id >= 0 && track.id < 32)\n                        metrics->fallbackAttemptMask |= uint32_t(1) << track.id;\n                    bool fallbackSuccess = false;\n                    for (auto&& detected : QRCode::SampleQR(*bits, finderSet)) {\n                        metrics->sampleAttempts++;\n                        if (!detected.isValid() || detected.bits().width() != track.dimension)\n                            continue;\n                        ++metrics->genericDecodeAttempts;\n                        const double genericStart = guidedNowMs();\n                        auto decoded = QRCode::Decode(detected.bits());\n                        const double genericElapsed = guidedNowMs() - genericStart;\n                        metrics->genericDecodeMs += genericElapsed;\n                        metrics->decodeMs += genericElapsed;\n                        decodeSpent += genericElapsed;\n                        if (commitDecoded(detected, decoded)) {\n                            fallbackSuccess = true;\n                            decodedTrack = true;\n                            ++metrics->genericFallbackSuccesses;\n                            if (track.id >= 0 && track.id < 32)\n                                metrics->fallbackSuccessMask |= uint32_t(1) << track.id;\n                            break;\n                        }\n                    }\n                }\n            }'''
new = '''            // Sparse misses retain the exact proven v168 decoder. Do not add a\n            // second fallback policy here: when sparse is skipped or misses, run\n            // SampleQR directly. The sparse cooldown already bounds double work.\n            if (!decodedTrack) {\n                ++metrics->genericFallbackTracks;\n                for (auto&& detected : QRCode::SampleQR(*bits, finderSet)) {\n                    metrics->sampleAttempts++;\n                    if (!detected.isValid() || detected.bits().width() != track.dimension)\n                        continue;\n                    ++metrics->genericDecodeAttempts;\n                    const double genericStart = guidedNowMs();\n                    auto decoded = QRCode::Decode(detected.bits());\n                    const double genericElapsed = guidedNowMs() - genericStart;\n                    metrics->genericDecodeMs += genericElapsed;\n                    metrics->decodeMs += genericElapsed;\n                    decodeSpent += genericElapsed;\n                    if (commitDecoded(detected, decoded)) {\n                        decodedTrack = true;\n                        ++metrics->genericFallbackSuccesses;\n                        break;\n                    }\n                }\n            }'''
replace_once(cpp, old, new)

print("v184 patch applied")
