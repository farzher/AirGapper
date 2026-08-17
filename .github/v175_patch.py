from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing anchor in {path}: {old[:180]!r}")
    p.write_text(s.replace(old, new, 1))


replace_once("index.html", "v0.5.174", "v0.5.175")
replace_once("main.js", 'const APP_BUILD = "v0.5.174";', 'const APP_BUILD = "v0.5.175";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.174";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.175";')
replace_once("sw.js", 'airgapper-static-js-v136', 'airgapper-static-js-v137')
replace_once("vendor/decimen-codec/source/VERSION", "0.1.15", "0.1.16")

# Extend guided metrics without moving existing fields. The first 96 bytes stay ABI-identical.
replace_once(
    "vendor/decimen-codec/source/wrapper/decimen_codec.h",
    '''\tdouble fastDecodeMs;\n\tdouble genericDecodeMs;\n};''',
    '''\tdouble fastDecodeMs;\n\tdouble genericDecodeMs;\n\tuint32_t genericFallbackTracks;\n\tuint32_t genericFallbackSuccesses;\n\tuint32_t genericFallbackSkipped;\n\tuint32_t reserved;\n};'''
)

p = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = p.read_text()

anchor = '''static void noteGuidedSparseOutcome(int id, bool success)\n{\n    if (id < 0 || id >= int(guidedSparseState().failures.size()))\n        return;\n    auto& state = guidedSparseState();\n    if (success) {\n        state.failures[id] = 0;\n        state.cooldown[id] = 0;\n        return;\n    }\n    if (++state.failures[id] >= 2) {\n        state.failures[id] = 0;\n        // A weak geometry should not pay an extra RS decode every frame.\n        // Re-probe periodically because a later pose/framing can be friendlier.\n        state.cooldown[id] = 10;\n    }\n}\n\n'''
insert = anchor + '''// Full SampleQR is substantially more expensive than the sparse stage because it\n// searches the complete alignment lattice before RS decode. Keep it hot while it\n// is producing packets, but progressively thin it after repeated *proven* misses.\n// This is deliberately local to the fallback itself: medium-quality QR slots stay\n// in every camera frame, and any success immediately restores full fallback cadence.\nstruct GuidedFallbackState\n{\n    std::array<uint8_t, 64> misses{};\n    std::array<uint8_t, 64> cooldown{};\n    std::array<uint8_t, 64> backoff{};\n};\n\nstatic GuidedFallbackState& guidedFallbackState()\n{\n    static GuidedFallbackState state;\n    return state;\n}\n\nstatic bool guidedFallbackAllowed(int id)\n{\n    if (id < 0 || id >= int(guidedFallbackState().cooldown.size()))\n        return true;\n    auto& cooldown = guidedFallbackState().cooldown[id];\n    if (!cooldown)\n        return true;\n    --cooldown;\n    return false;\n}\n\nstatic void noteGuidedFallbackOutcome(int id, bool success)\n{\n    if (id < 0 || id >= int(guidedFallbackState().misses.size()))\n        return;\n    auto& state = guidedFallbackState();\n    if (success) {\n        state.misses[id] = 0;\n        state.cooldown[id] = 0;\n        state.backoff[id] = 0;\n        return;\n    }\n    if (++state.misses[id] < 4)\n        return;\n    state.misses[id] = 0;\n    state.backoff[id] = std::min<uint8_t>(3, state.backoff[id] + 1);\n    state.cooldown[id] = state.backoff[id];\n}\n\n'''
if anchor not in s:
    raise SystemExit("guided sparse state anchor missing")
s = s.replace(anchor, insert, 1)

old = '''                    decodedTrack = commitDecoded(sparse, decoded);\n                    if (decodedTrack)\n                        ++metrics->fastDecodeSuccesses;\n                }\n                noteGuidedSparseOutcome(track.id, decodedTrack);\n            }\n\n            // Sparse misses retain the exact proven decoder. No persistent\n            // pixel map and no reduced ECC: SampleQR remains the correctness\n            // oracle and refreshes the returned quad for the lattice.\n            if (!decodedTrack) {\n                for (auto&& detected : QRCode::SampleQR(*bits, finderSet)) {\n                    metrics->sampleAttempts++;\n                    if (!detected.isValid() || detected.bits().width() != track.dimension)\n                        continue;\n                    ++metrics->genericDecodeAttempts;\n                    const double genericStart = guidedNowMs();\n                    auto decoded = QRCode::Decode(detected.bits());\n                    const double genericElapsed = guidedNowMs() - genericStart;\n                    metrics->genericDecodeMs += genericElapsed;\n                    metrics->decodeMs += genericElapsed;\n                    decodeSpent += genericElapsed;\n                    if (commitDecoded(detected, decoded)) {\n                        decodedTrack = true;\n                        break;\n                    }\n                }\n            }\n'''
new = '''                    decodedTrack = commitDecoded(sparse, decoded);\n                    if (decodedTrack) {\n                        ++metrics->fastDecodeSuccesses;\n                        noteGuidedFallbackOutcome(track.id, true);\n                    }\n                }\n                noteGuidedSparseOutcome(track.id, decodedTrack);\n            }\n\n            // Sparse misses retain the exact proven decoder, but repeated full\n            // fallback misses are no longer allowed to monopolize the worker.\n            // Four consecutive misses introduce a one-frame skip; continued\n            // misses grow that to at most three. A sparse or fallback success\n            // resets the backoff immediately.\n            if (!decodedTrack) {\n                if (!guidedFallbackAllowed(track.id)) {\n                    ++metrics->genericFallbackSkipped;\n                } else {\n                    ++metrics->genericFallbackTracks;\n                    bool fallbackSuccess = false;\n                    for (auto&& detected : QRCode::SampleQR(*bits, finderSet)) {\n                        metrics->sampleAttempts++;\n                        if (!detected.isValid() || detected.bits().width() != track.dimension)\n                            continue;\n                        ++metrics->genericDecodeAttempts;\n                        const double genericStart = guidedNowMs();\n                        auto decoded = QRCode::Decode(detected.bits());\n                        const double genericElapsed = guidedNowMs() - genericStart;\n                        metrics->genericDecodeMs += genericElapsed;\n                        metrics->decodeMs += genericElapsed;\n                        decodeSpent += genericElapsed;\n                        if (commitDecoded(detected, decoded)) {\n                            fallbackSuccess = true;\n                            decodedTrack = true;\n                            ++metrics->genericFallbackSuccesses;\n                            break;\n                        }\n                    }\n                    noteGuidedFallbackOutcome(track.id, fallbackSuccess);\n                }\n            }\n'''
if old not in s:
    raise SystemExit("guided fallback decode anchor missing")
s = s.replace(old, new, 1)
p.write_text(s)

# JS worker reads the appended metrics. Existing offsets are unchanged.
replace_once("receive/worker.js", "const GUIDED_METRICS_BYTES = 96;", "const GUIDED_METRICS_BYTES = 112;")
replace_once(
    "receive/worker.js",
    '''    fastDecodeMs: metricsView.getFloat64(80, true),\n    genericDecodeMs: metricsView.getFloat64(88, true)\n''',
    '''    fastDecodeMs: metricsView.getFloat64(80, true),\n    genericDecodeMs: metricsView.getFloat64(88, true),\n    genericFallbackTracks: metricsView.getUint32(96, true),\n    genericFallbackSuccesses: metricsView.getUint32(100, true),\n    genericFallbackSkipped: metricsView.getUint32(104, true)\n'''
)

# Aggregate the new counters so a pasted trace proves whether the optimization is useful.
p = Path("receive/main.js")
s = p.read_text()
s = s.replace(
    '''  guidedFastDecodeSuccesses: 0,\n  guidedGenericDecodeAttempts: 0,\n  guidedJobs: 0,''',
    '''  guidedFastDecodeSuccesses: 0,\n  guidedGenericDecodeAttempts: 0,\n  guidedGenericFallbackTracks: 0,\n  guidedGenericFallbackSuccesses: 0,\n  guidedGenericFallbackSkipped: 0,\n  guidedJobs: 0,'''
)
s = s.replace(
    '''    guidedFastDecodeMs: 0, guidedGenericDecodeMs: 0, guidedFastDecodeAttempts: 0, guidedFastDecodeSuccesses: 0, guidedGenericDecodeAttempts: 0,\n    guidedJobs: 0,''',
    '''    guidedFastDecodeMs: 0, guidedGenericDecodeMs: 0, guidedFastDecodeAttempts: 0, guidedFastDecodeSuccesses: 0, guidedGenericDecodeAttempts: 0,\n    guidedGenericFallbackTracks: 0, guidedGenericFallbackSuccesses: 0, guidedGenericFallbackSkipped: 0,\n    guidedJobs: 0,'''
)
s = s.replace(
    '''      livePipeline.guidedGenericDecodeAttempts += Math.max(0, Number(guided.genericDecodeAttempts) || 0);\n      livePipeline.guidedFinderAttempts += Math.max(0, Number(guided.finderAttempts) || 0);''',
    '''      livePipeline.guidedGenericDecodeAttempts += Math.max(0, Number(guided.genericDecodeAttempts) || 0);\n      livePipeline.guidedGenericFallbackTracks += Math.max(0, Number(guided.genericFallbackTracks) || 0);\n      livePipeline.guidedGenericFallbackSuccesses += Math.max(0, Number(guided.genericFallbackSuccesses) || 0);\n      livePipeline.guidedGenericFallbackSkipped += Math.max(0, Number(guided.genericFallbackSkipped) || 0);\n      livePipeline.guidedFinderAttempts += Math.max(0, Number(guided.finderAttempts) || 0);'''
)
s = s.replace(
    '''Guided  ${guidedRollout.state} · ${livePipeline.guidedJobs} jobs · ${livePipeline.guidedOutputs} outputs · finders ${livePipeline.guidedFinderSuccesses}/${livePipeline.guidedFinderAttempts} · sparse ${livePipeline.guidedFastDecodeSuccesses}/${livePipeline.guidedFastDecodeAttempts} · fallback ${livePipeline.guidedGenericDecodeAttempts} · baseline p50''',
    '''Guided  ${guidedRollout.state} · ${livePipeline.guidedJobs} jobs · ${livePipeline.guidedOutputs} outputs · finders ${livePipeline.guidedFinderSuccesses}/${livePipeline.guidedFinderAttempts} · sparse ${livePipeline.guidedFastDecodeSuccesses}/${livePipeline.guidedFastDecodeAttempts} · fallback ${livePipeline.guidedGenericFallbackSuccesses}/${livePipeline.guidedGenericFallbackTracks} slots · ${livePipeline.guidedGenericDecodeAttempts} decodes · skip ${livePipeline.guidedGenericFallbackSkipped} · baseline p50'''
)
s = s.replace(
    '''fallback ${lastGuidedMetrics.genericDecodeMs.toFixed(1)} ${lastGuidedMetrics.genericDecodeAttempts}] · finders''',
    '''fallback ${lastGuidedMetrics.genericDecodeMs.toFixed(1)} ${lastGuidedMetrics.genericDecodeAttempts} · hit ${lastGuidedMetrics.genericFallbackSuccesses}/${lastGuidedMetrics.genericFallbackTracks} skip ${lastGuidedMetrics.genericFallbackSkipped}] · finders'''
)
for required in [
    'guidedGenericFallbackTracks',
    'guidedGenericFallbackSuccesses',
    'guidedGenericFallbackSkipped',
]:
    if required not in s:
        raise SystemExit(f"main metrics patch missing {required}")
p.write_text(s)
