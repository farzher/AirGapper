from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:220]!r}")
    p.write_text(s.replace(old, new, count))


# Version/cache. Codec is unchanged from 0.1.29.
replace("index.html", "v0.5.208", "v0.5.209")
replace("main.js", 'const APP_BUILD = "v0.5.208";', 'const APP_BUILD = "v0.5.209";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.208";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.209";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v170";', 'const CACHE = "airgapper-static-js-v171";')

# Worker hot-loop cleanup and OOM correctness.
worker = Path("receive/worker.js")
s = worker.read_text()
old = '''    const points = [track.quad.topLeft, track.quad.topRight, track.quad.bottomRight, track.quad.bottomLeft];
    for (let p = 0; p < 4; p++) {
      view.setFloat32(base + 8 + p * 8, points[p].x - ox, true);
      view.setFloat32(base + 12 + p * 8, points[p].y - oy, true);
    }'''
new = '''    const q = track.quad;
    view.setFloat32(base + 8, q.topLeft.x - ox, true);
    view.setFloat32(base + 12, q.topLeft.y - oy, true);
    view.setFloat32(base + 16, q.topRight.x - ox, true);
    view.setFloat32(base + 20, q.topRight.y - oy, true);
    view.setFloat32(base + 24, q.bottomRight.x - ox, true);
    view.setFloat32(base + 28, q.bottomRight.y - oy, true);
    view.setFloat32(base + 32, q.bottomLeft.x - ox, true);
    view.setFloat32(base + 36, q.bottomLeft.y - oy, true);'''
if old not in s: raise SystemExit("guided track point allocation block missing")
s = s.replace(old, new, 1)
old = '''      ptr = inputBuffer(zx, allocationBytes);
      const copyStarted = performance.now();'''
new = '''      ptr = inputBuffer(zx, allocationBytes);
      if (!ptr) throw new Error("Could not allocate WASM camera input buffer");
      const copyStarted = performance.now();'''
if old not in s: raise SystemExit("VideoFrame input allocation site missing")
s = s.replace(old, new, 1)
old = '''      ptr = inputBuffer(zx, pixels.byteLength);
      zx.HEAPU8.set(pixels, ptr);'''
new = '''      ptr = inputBuffer(zx, pixels.byteLength);
      if (!ptr) throw new Error("Could not allocate WASM pixel input buffer");
      zx.HEAPU8.set(pixels, ptr);'''
if old not in s: raise SystemExit("buffer input allocation site missing")
s = s.replace(old, new, 1)
worker.write_text(s)

# Main-thread dead-state cleanup. These two sets were only add/delete/clear
# bookkeeping with no read site, so they could not affect scheduling/recovery.
main = Path("receive/main.js")
s = main.read_text()
s = s.replace('const localReacquireIds = /* @__PURE__ */ new Set();\n', '')
s = s.replace('const fullScanIds = /* @__PURE__ */ new Set();\n', '')
for dead in (
    '  fullScanIds.delete(id);\n',
    '  localReacquireIds.delete(id);\n',
    '      fullScanIds.add(message.id);\n',
    '  fullScanIds.clear();\n',
    '  localReacquireIds.clear();\n',
):
    s = s.replace(dead, '')

# Guided is permanently the production state now. Remove state transitions and
# counters left over from the old warmup/probe/retry rollout implementation.
s = s.replace('  rampGood: 0,\n', '')
s = s.replace('  robustSinceRetry: 0,\n', '')
s = s.replace('  guidedRollout.rampGood = 0;\n', '')
s = s.replace('  guidedRollout.robustSinceRetry = 0;\n', '')
old = '''function noteGuidedRobustBaseline(latencyMs) {
  guidedRollout.robustLatencies.push(latencyMs);
  if (guidedRollout.robustLatencies.length > 24) guidedRollout.robustLatencies.shift();
  if (guidedRollout.state === "warmup" && guidedRollout.robustLatencies.length >= 4)
    guidedRollout.state = "probe";
  if (guidedRollout.state === "retry") {
    const retryAfter = Math.min(16, 3 + guidedRollout.failures * 2);
    if (++guidedRollout.robustSinceRetry >= retryAfter) {
      guidedRollout.robustSinceRetry = 0;
      guidedRollout.state = "probe";
    }
  }
}'''
new = '''function noteGuidedRobustBaseline(latencyMs) {
  guidedRollout.robustLatencies.push(latencyMs);
  if (guidedRollout.robustLatencies.length > 24) guidedRollout.robustLatencies.shift();
}'''
if old not in s: raise SystemExit("obsolete Guided rollout baseline block missing")
s = s.replace(old, new, 1)
s = s.replace('    guidedRollout.rampGood++;\n', '')

# Empty instrumentation branches survived earlier experiments and have no side
# effects. Delete them rather than making future readers infer nonexistent policy.
s = s.replace('''  if (completion.full) {
  } else if (completion.symbolCount === 0) {
  }
  if (completion.trackedAttempted && !completion.trackedHit && completion.fallbackAttempted) {
  }
''', '')
main.write_text(s)
