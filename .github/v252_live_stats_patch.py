from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'{path}: patch anchor missing')
    p.write_text(text.replace(old, new, 1))

# Keep the rolling measurement window at one second, but repaint the small
# user-facing throughput metrics at 10 Hz. Heavy developer diagnostics stay at
# 4 Hz so opening them while benchmarking does not add avoidable main-thread
# string/DOM work.
replace_once(
    'receive/main.js',
    'const STATS_WINDOW_MS = 1e3;\nconst STATS_TICK_MS = 250;',
    'const STATS_WINDOW_MS = 1e3;\nconst STATS_TICK_MS = 100;\nconst DIAGNOSTICS_TICK_MS = 250;\nlet lastDiagnosticsPaintAt = -Infinity;'
)
replace_once(
    'receive/main.js',
    '  const now = receiverNow();\n  if (optimizeEnabled) beginOptimizeWhenReady();\n  if (forceDiagnostics || !receiverDevActions.hidden) renderFocusDiagnostics();',
    '  const now = receiverNow();\n  if (optimizeEnabled) beginOptimizeWhenReady();\n  const paintDiagnostics = forceDiagnostics || !receiverDevActions.hidden && now - lastDiagnosticsPaintAt >= DIAGNOSTICS_TICK_MS;\n  if (paintDiagnostics) {\n    lastDiagnosticsPaintAt = now;\n    renderFocusDiagnostics();\n  }'
)
replace_once(
    'receive/main.js',
    'if ((forceDiagnostics || !receiverDevActions.hidden) && transportDiagnostics) {',
    'if (paintDiagnostics && transportDiagnostics) {'
)

# The compact FPS indicator is intentionally decoder/CPU throughput, never
# camera delivery FPS. Camera delivery already appears in Source diagnostics.
# Use completed decode jobs so "7 fps" means the receiver actually processed
# about seven camera frames in the trailing second.
replace_once(
    'receive/main.js',
    '  metric("m-cap").textContent = `${cameraRate.toFixed(1)} fps`;',
    '  // Intentionally CPU/decoder throughput, not camera capture rate.\n  metric("m-cap").textContent = `${completionRate.toFixed(1)} fps`;'
)

# Preserve this product/debugging convention for future optimization passes.
replace_once(
    'benchmark/README.md',
    'Performance decisions should be validated on handheld hardware. Preserve cheap stable fast paths when available, but prioritize the motion-tolerant tracked/Guided path used during normal hand shake.\n',
    'Performance decisions should be validated on handheld hardware. Preserve cheap stable fast paths when available, but prioritize the motion-tolerant tracked/Guided path used during normal hand shake.\n\nThe receiver UI `fps` metric means **decoder-processed camera frames per second (CPU throughput)**, not camera delivery rate. Camera capture/delivery FPS belongs in developer diagnostics.\n'
)

# Version/cache bump.
for path in ['main.js', 'receive/main.js', 'index.html']:
    replace_once(path, 'v0.5.251', 'v0.5.252')
replace_once('sw.js', 'airgapper-static-js-v207', 'airgapper-static-js-v208')
