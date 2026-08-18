from pathlib import Path

header = Path('vendor/decimen-codec/source/wrapper/decimen_codec.h')
h = header.read_text()
old = '''\tuint32_t stableEligibleTracks;\n\tuint32_t sparseProfileAttempts;\n\tuint32_t sparseProfileSuccesses;\n};'''
new = '''\tuint32_t stableEligibleTracks;\n\tuint32_t sparseProfileAttempts;\n\tuint32_t sparseProfileSuccesses;\n\tuint32_t translationWarpTracks;\n\tuint32_t affineWarpTracks;\n\tuint32_t perspectiveWarpTracks;\n};'''
if old not in h:
    raise SystemExit('Guided metrics header anchor missing')
header.write_text(h.replace(old, new, 1))

cpp = Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s = cpp.read_text()
anchor = '''        // Stable-RS uses the same coherent projective seed->live warp as\n        // direct Turbo, plus the one shared sub-pixel residual refined above.\n        // RS + AirGapper CRC remain the acceptance oracle, so a stale warp only\n        // causes a cheap miss and Guided fallback.\n\n        for (int i = 0; i < trackCount; ++i) {'''
replacement = '''        // Stable-RS uses the same coherent seed->live warp as direct Turbo, plus\n        // the one shared sub-pixel residual refined above. Record which transform\n        // mode actually carried each attempted cached track so handheld traces can\n        // distinguish stable translation, cheap affine motion, and full perspective.\n        auto noteWarpMode = [&](const TurboFrameTransform& frameTransform) {\n            if (frameTransform.translationOnly) ++metrics->translationWarpTracks;\n            else if (frameTransform.affineOnly) ++metrics->affineWarpTracks;\n            else ++metrics->perspectiveWarpTracks;\n        };\n\n        for (int i = 0; i < trackCount; ++i) {'''
if anchor not in s:
    raise SystemExit('Guided loop anchor missing')
s = s.replace(anchor, replacement, 1)

old = '''                if (frameTransform.isValid()) {\n                    const float dx = wallCorrectionX;'''
new = '''                if (frameTransform.isValid()) {\n                    noteWarpMode(frameTransform);\n                    const float dx = wallCorrectionX;'''
if old not in s:
    raise SystemExit('direct warp anchor missing')
s = s.replace(old, new, 1)

old = '''                } else {\n                    const float dx = wallCorrectionX;\n                    const float dy = wallCorrectionY;\n                    const auto levels = turboReadLevels(*cache, track, frameTransform,'''
new = '''                } else {\n                    noteWarpMode(frameTransform);\n                    const float dx = wallCorrectionX;\n                    const float dy = wallCorrectionY;\n                    const auto levels = turboReadLevels(*cache, track, frameTransform,'''
if old not in s:
    raise SystemExit('stable warp anchor missing')
s = s.replace(old, new, 1)
cpp.write_text(s)

worker = Path('receive/worker.js')
w = worker.read_text()
w = w.replace('const GUIDED_METRICS_BYTES = 168;', 'const GUIDED_METRICS_BYTES = 176;', 1)
old = '''    stableEligibleTracks: metricsView.getUint32(152, true),\n    sparseProfileAttempts: metricsView.getUint32(156, true),\n    sparseProfileSuccesses: metricsView.getUint32(160, true)\n  };'''
new = '''    stableEligibleTracks: metricsView.getUint32(152, true),\n    sparseProfileAttempts: metricsView.getUint32(156, true),\n    sparseProfileSuccesses: metricsView.getUint32(160, true),\n    translationWarpTracks: metricsView.getUint32(164, true),\n    affineWarpTracks: metricsView.getUint32(168, true),\n    perspectiveWarpTracks: metricsView.getUint32(172, true)\n  };'''
if old not in w:
    raise SystemExit('worker metrics parse anchor missing')
worker.write_text(w.replace(old, new, 1))

main = Path('receive/main.js')
m = main.read_text()
old = '''  guidedStableRsAttempts: 0,\n  guidedStableRsSuccesses: 0,\n  guidedStableEligibleTracks: 0,'''
new = '''  guidedStableRsAttempts: 0,\n  guidedStableRsSuccesses: 0,\n  guidedStableEligibleTracks: 0,\n  guidedTranslationWarpTracks: 0,\n  guidedAffineWarpTracks: 0,\n  guidedPerspectiveWarpTracks: 0,'''
if m.count(old) < 1:
    raise SystemExit('main initial warp metrics anchor missing')
m = m.replace(old, new)

old = '''      livePipeline.guidedStableRsAttempts += Math.max(0, Number(guided.stableRsAttempts) || 0);\n      livePipeline.guidedStableRsSuccesses += Math.max(0, Number(guided.stableRsSuccesses) || 0);\n      livePipeline.guidedStableEligibleTracks += Math.max(0, Number(guided.stableEligibleTracks) || 0);'''
new = '''      livePipeline.guidedStableRsAttempts += Math.max(0, Number(guided.stableRsAttempts) || 0);\n      livePipeline.guidedStableRsSuccesses += Math.max(0, Number(guided.stableRsSuccesses) || 0);\n      livePipeline.guidedStableEligibleTracks += Math.max(0, Number(guided.stableEligibleTracks) || 0);\n      livePipeline.guidedTranslationWarpTracks += Math.max(0, Number(guided.translationWarpTracks) || 0);\n      livePipeline.guidedAffineWarpTracks += Math.max(0, Number(guided.affineWarpTracks) || 0);\n      livePipeline.guidedPerspectiveWarpTracks += Math.max(0, Number(guided.perspectiveWarpTracks) || 0);'''
if old not in m:
    raise SystemExit('main warp aggregation anchor missing')
m = m.replace(old, new, 1)

old = ''' · stableRS ${lastGuidedMetrics.stableRsSuccesses ?? 0}/${lastGuidedMetrics.stableRsAttempts ?? 0} stable ${lastGuidedMetrics.stableEligibleTracks ?? 0} · profile'''
new = ''' · stableRS ${lastGuidedMetrics.stableRsSuccesses ?? 0}/${lastGuidedMetrics.stableRsAttempts ?? 0} stable ${lastGuidedMetrics.stableEligibleTracks ?? 0} · warp T/A/P ${lastGuidedMetrics.translationWarpTracks ?? 0}/${lastGuidedMetrics.affineWarpTracks ?? 0}/${lastGuidedMetrics.perspectiveWarpTracks ?? 0} · profile'''
if old not in m:
    raise SystemExit('current Guided display anchor missing')
m = m.replace(old, new, 1)

old = ''' · stableRS ${livePipeline.guidedStableRsSuccesses}/${livePipeline.guidedStableRsAttempts} · stable ${livePipeline.guidedStableEligibleTracks} · finders'''
new = ''' · stableRS ${livePipeline.guidedStableRsSuccesses}/${livePipeline.guidedStableRsAttempts} · stable ${livePipeline.guidedStableEligibleTracks} · warp T/A/P ${livePipeline.guidedTranslationWarpTracks}/${livePipeline.guidedAffineWarpTracks}/${livePipeline.guidedPerspectiveWarpTracks} · finders'''
if old not in m:
    raise SystemExit('aggregate Guided display anchor missing')
m = m.replace(old, new, 1)
main.write_text(m)

for path, old_version, new_version in [
    ('vendor/decimen-codec/source/VERSION', '0.1.50', '0.1.51'),
    ('main.js', 'v0.5.241', 'v0.5.242'),
    ('receive/main.js', 'v0.5.241', 'v0.5.242'),
    ('index.html', 'v0.5.241', 'v0.5.242'),
]:
    p = Path(path)
    text = p.read_text()
    if old_version not in text:
        raise SystemExit(f'{path}: version target {old_version} missing')
    p.write_text(text.replace(old_version, new_version))

sw = Path('sw.js')
text = sw.read_text()
if 'airgapper-static-js-v197' not in text:
    raise SystemExit('sw cache v197 target missing')
sw.write_text(text.replace('airgapper-static-js-v197', 'airgapper-static-js-v198', 1))
