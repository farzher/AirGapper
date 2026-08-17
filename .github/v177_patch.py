from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:140]!r}")
    p.write_text(text.replace(old, new, 1))


# App/cache/codec version.
for path in ["index.html", "main.js", "receive/main.js"]:
    p = Path(path)
    text = p.read_text()
    if "v0.5.176" not in text:
        raise SystemExit(f"expected v0.5.176 in {path}")
    p.write_text(text.replace("v0.5.176", "v0.5.177"))
replace_once("sw.js", 'airgapper-static-js-v138', 'airgapper-static-js-v139')
replace_once("vendor/decimen-codec/source/VERSION", '0.1.16', '0.1.17')

# Extend guided metrics append-only. Existing offsets remain unchanged.
replace_once(
    "vendor/decimen-codec/source/wrapper/decimen_codec.h",
    '''\tuint32_t genericFallbackTracks;\n\tuint32_t genericFallbackSuccesses;\n\tuint32_t genericFallbackSkipped;\n\tuint32_t reserved;''',
    '''\tuint32_t genericFallbackTracks;\n\tuint32_t genericFallbackSuccesses;\n\tuint32_t genericFallbackSkipped;\n\tuint32_t sparseNoRsAttempts;\n\tuint32_t sparseNoRsSuccesses;\n\tuint32_t sparseRsFallbacks;\n\tuint32_t sparseSkipped;\n\tuint32_t reserved;'''
)

# The sparse stage is cheaper than full SampleQR and has been succeeding often
# in field traces. Two misses -> ten suppressed appearances was far too sticky;
# use a mild local backoff instead.
replace_once(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''    if (++state.failures[id] >= 2) {\n        state.failures[id] = 0;\n        // A weak geometry should not pay an extra RS decode every frame.\n        // Re-probe periodically because a later pose/framing can be friendlier.\n        state.cooldown[id] = 10;\n    }''',
    '''    if (++state.failures[id] >= 4) {\n        state.failures[id] = 0;\n        // Sparse sampling is materially cheaper than full SampleQR and often\n        // recovers on the very next animated frame. Back off only briefly after\n        // a real miss streak; the old 10-appearance cooldown stranded good slots.\n        state.cooldown[id] = 2;\n    }'''
)

# Report how many real sparse alignment controls were found. The no-RS parser
# is only attempted at the strongest possible geometry: all six non-finder
# controls present in the 3x3 sparse lattice.
replace_once(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''static DetectorResult sampleGuidedSparse(const BitMatrix& image,\n                                         const DecimenGuidedTrack& track,\n                                         const QRCode::FinderPatternSet& fp)''',
    '''static DetectorResult sampleGuidedSparse(const BitMatrix& image,\n                                         const DecimenGuidedTrack& track,\n                                         const QRCode::FinderPatternSet& fp,\n                                         int* alignmentFoundOut)'''
)
replace_once(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''    // If fewer than half of the real sparse alignment controls were found,\n    // avoid a likely-wasted RS decode and use full SampleQR immediately.\n    if (alignmentFound < 3)\n        return {};''',
    '''    if (alignmentFoundOut) *alignmentFoundOut = alignmentFound;\n    // If fewer than half of the real sparse alignment controls were found,\n    // avoid a likely-wasted RS decode and use full SampleQR immediately.\n    if (alignmentFound < 3)\n        return {};'''
)

replace_once(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''            // Sparse distortion-aware tiled sample. Two consecutive misses for\n            // this slot put the experiment on a short cooldown, bounding the\n            // worst-case cost when a particular pose needs full SampleQR.\n            if (guidedSparseAllowed(track.id)) {\n                ++metrics->fastDecodeAttempts;\n                auto sparse = sampleGuidedSparse(*bits, track, finderSet);\n                if (sparse.isValid() && sparse.bits().width() == track.dimension) {\n                    metrics->sampleAttempts++;\n                    const double fastStart = guidedNowMs();\n                    auto decoded = QRCode::Decode(sparse.bits());\n                    const double fastElapsed = guidedNowMs() - fastStart;\n                    metrics->fastDecodeMs += fastElapsed;\n                    metrics->decodeMs += fastElapsed;\n                    decodeSpent += fastElapsed;\n                    decodedTrack = commitDecoded(sparse, decoded);\n                    if (decodedTrack) {\n                        ++metrics->fastDecodeSuccesses;\n                        noteGuidedFallbackOutcome(track.id, true);\n                    }\n                }\n                noteGuidedSparseOutcome(track.id, decodedTrack);\n            }''',
    '''            // Sparse distortion-aware tiled sample. It stays hot unless a slot\n            // produces a sustained miss streak. When all six real sparse alignment\n            // controls are present, first try the parser without QR Reed-Solomon;\n            // AirGapper CRC is the oracle. A miss immediately pays normal RS, so\n            // this cannot reduce decode yield versus the sparse path it replaces.\n            if (guidedSparseAllowed(track.id)) {\n                ++metrics->fastDecodeAttempts;\n                int sparseAlignmentFound = 0;\n                auto sparse = sampleGuidedSparse(*bits, track, finderSet, &sparseAlignmentFound);\n                if (sparse.isValid() && sparse.bits().width() == track.dimension) {\n                    metrics->sampleAttempts++;\n                    const double fastStart = guidedNowMs();\n                    if (sparseAlignmentFound >= 6) {\n                        ++metrics->sparseNoRsAttempts;\n                        auto fast = decodeWithoutErrorCorrection(sparse.bits());\n                        if (fast.isValid() && !fast.content().bytes.empty() && hasValidCRC32(fast.content().bytes)) {\n                            decodedTrack = commitDecoded(sparse, fast);\n                            if (decodedTrack) ++metrics->sparseNoRsSuccesses;\n                        }\n                    }\n                    if (!decodedTrack) {\n                        ++metrics->sparseRsFallbacks;\n                        auto decoded = QRCode::Decode(sparse.bits());\n                        decodedTrack = commitDecoded(sparse, decoded);\n                    }\n                    const double fastElapsed = guidedNowMs() - fastStart;\n                    metrics->fastDecodeMs += fastElapsed;\n                    metrics->decodeMs += fastElapsed;\n                    decodeSpent += fastElapsed;\n                    if (decodedTrack) {\n                        ++metrics->fastDecodeSuccesses;\n                        noteGuidedFallbackOutcome(track.id, true);\n                    }\n                }\n                noteGuidedSparseOutcome(track.id, decodedTrack);\n            } else {\n                ++metrics->sparseSkipped;\n            }'''
)

# Worker ABI reader.
replace_once("receive/worker.js", 'const GUIDED_METRICS_BYTES = 112;', 'const GUIDED_METRICS_BYTES = 128;')
replace_once(
    "receive/worker.js",
    '''    genericFallbackTracks: metricsView.getUint32(96, true),\n    genericFallbackSuccesses: metricsView.getUint32(100, true),\n    genericFallbackSkipped: metricsView.getUint32(104, true)''',
    '''    genericFallbackTracks: metricsView.getUint32(96, true),\n    genericFallbackSuccesses: metricsView.getUint32(100, true),\n    genericFallbackSkipped: metricsView.getUint32(104, true),\n    sparseNoRsAttempts: metricsView.getUint32(108, true),\n    sparseNoRsSuccesses: metricsView.getUint32(112, true),\n    sparseRsFallbacks: metricsView.getUint32(116, true),\n    sparseSkipped: metricsView.getUint32(120, true)'''
)

# Aggregate and expose the experiment so field traces can decide it quickly.
replace_once(
    "receive/main.js",
    '''  guidedGenericFallbackTracks: 0,\n  guidedGenericFallbackSuccesses: 0,\n  guidedGenericFallbackSkipped: 0,\n  guidedJobs: 0,''',
    '''  guidedGenericFallbackTracks: 0,\n  guidedGenericFallbackSuccesses: 0,\n  guidedGenericFallbackSkipped: 0,\n  guidedSparseNoRsAttempts: 0,\n  guidedSparseNoRsSuccesses: 0,\n  guidedSparseRsFallbacks: 0,\n  guidedSparseSkipped: 0,\n  guidedJobs: 0,'''
)
replace_once(
    "receive/main.js",
    '''    guidedGenericFallbackTracks: 0, guidedGenericFallbackSuccesses: 0, guidedGenericFallbackSkipped: 0,\n    guidedJobs: 0,''',
    '''    guidedGenericFallbackTracks: 0, guidedGenericFallbackSuccesses: 0, guidedGenericFallbackSkipped: 0,\n    guidedSparseNoRsAttempts: 0, guidedSparseNoRsSuccesses: 0, guidedSparseRsFallbacks: 0, guidedSparseSkipped: 0,\n    guidedJobs: 0,'''
)
replace_once(
    "receive/main.js",
    '''      livePipeline.guidedGenericFallbackTracks += Math.max(0, Number(guided.genericFallbackTracks) || 0);\n      livePipeline.guidedGenericFallbackSuccesses += Math.max(0, Number(guided.genericFallbackSuccesses) || 0);\n      livePipeline.guidedGenericFallbackSkipped += Math.max(0, Number(guided.genericFallbackSkipped) || 0);\n      livePipeline.guidedFinderAttempts += Math.max(0, Number(guided.finderAttempts) || 0);''',
    '''      livePipeline.guidedGenericFallbackTracks += Math.max(0, Number(guided.genericFallbackTracks) || 0);\n      livePipeline.guidedGenericFallbackSuccesses += Math.max(0, Number(guided.genericFallbackSuccesses) || 0);\n      livePipeline.guidedGenericFallbackSkipped += Math.max(0, Number(guided.genericFallbackSkipped) || 0);\n      livePipeline.guidedSparseNoRsAttempts += Math.max(0, Number(guided.sparseNoRsAttempts) || 0);\n      livePipeline.guidedSparseNoRsSuccesses += Math.max(0, Number(guided.sparseNoRsSuccesses) || 0);\n      livePipeline.guidedSparseRsFallbacks += Math.max(0, Number(guided.sparseRsFallbacks) || 0);\n      livePipeline.guidedSparseSkipped += Math.max(0, Number(guided.sparseSkipped) || 0);\n      livePipeline.guidedFinderAttempts += Math.max(0, Number(guided.finderAttempts) || 0);'''
)
replace_once(
    "receive/main.js",
    '''[sparse ${lastGuidedMetrics.fastDecodeMs.toFixed(1)} ${lastGuidedMetrics.fastDecodeSuccesses}/${lastGuidedMetrics.fastDecodeAttempts} · fallback ${lastGuidedMetrics.genericDecodeMs.toFixed(1)} ${lastGuidedMetrics.genericDecodeAttempts} · hit ${lastGuidedMetrics.genericFallbackSuccesses}/${lastGuidedMetrics.genericFallbackTracks} skip ${lastGuidedMetrics.genericFallbackSkipped}]''',
    '''[sparse ${lastGuidedMetrics.fastDecodeMs.toFixed(1)} ${lastGuidedMetrics.fastDecodeSuccesses}/${lastGuidedMetrics.fastDecodeAttempts} · noRS ${lastGuidedMetrics.sparseNoRsSuccesses}/${lastGuidedMetrics.sparseNoRsAttempts} · RS ${lastGuidedMetrics.sparseRsFallbacks} · sparse-skip ${lastGuidedMetrics.sparseSkipped} · fallback ${lastGuidedMetrics.genericDecodeMs.toFixed(1)} ${lastGuidedMetrics.genericDecodeAttempts} · hit ${lastGuidedMetrics.genericFallbackSuccesses}/${lastGuidedMetrics.genericFallbackTracks} skip ${lastGuidedMetrics.genericFallbackSkipped}]'''
)
replace_once(
    "receive/main.js",
    '''Guided  ${guidedRollout.state} · ${livePipeline.guidedJobs} jobs · ${livePipeline.guidedOutputs} outputs · finders ${livePipeline.guidedFinderSuccesses}/${livePipeline.guidedFinderAttempts} · sparse ${livePipeline.guidedFastDecodeSuccesses}/${livePipeline.guidedFastDecodeAttempts} · fallback ${livePipeline.guidedGenericFallbackSuccesses}/${livePipeline.guidedGenericFallbackTracks} slots · ${livePipeline.guidedGenericDecodeAttempts} decodes · skip ${livePipeline.guidedGenericFallbackSkipped} · baseline p50''',
    '''Guided  ${guidedRollout.state} · ${livePipeline.guidedJobs} jobs · ${livePipeline.guidedOutputs} outputs · finders ${livePipeline.guidedFinderSuccesses}/${livePipeline.guidedFinderAttempts} · sparse ${livePipeline.guidedFastDecodeSuccesses}/${livePipeline.guidedFastDecodeAttempts} · noRS ${livePipeline.guidedSparseNoRsSuccesses}/${livePipeline.guidedSparseNoRsAttempts} · sparseRS ${livePipeline.guidedSparseRsFallbacks} · sparse skip ${livePipeline.guidedSparseSkipped} · fallback ${livePipeline.guidedGenericFallbackSuccesses}/${livePipeline.guidedGenericFallbackTracks} slots · ${livePipeline.guidedGenericDecodeAttempts} decodes · skip ${livePipeline.guidedGenericFallbackSkipped} · baseline p50'''
)
