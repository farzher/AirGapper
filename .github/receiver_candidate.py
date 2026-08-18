from pathlib import Path


def rep(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'missing anchor {path}: {old[:100]}')
    p.write_text(s.replace(old, new, 1))

rep('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.276";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.277";')

# Degraded recovery must leave CPU for the tracked decoder and UI.
rep('receive/main.js', 'const LOCKED_RECOVERY_SCAN_MS = 90;', 'const LOCKED_RECOVERY_SCAN_MS = 160;')

p = Path('receive/main.js')
s = p.read_text()

# Coverage collapse is useful evidence for a bounded recovery scout, but worker
# completion timing is not camera timing. Split lanes and 100-450 ms jobs can
# make one short camera miss look like sustained motion. Never destroy a proven
# lattice from this heuristic. The existing 2.8 s whole-wall decode-silence path
# remains the destructive last resort.
old = '''      if (geometryCoverageCollapseStreak >= GEOMETRY_COLLAPSE_STREAK &&
          now - geometryCoverageCollapseStartedAt >= GEOMETRY_COLLAPSE_MIN_SPAN_MS) {
        notePipelineEvent("geometry-coverage-collapse", trackedOutputs);
        enterGeometryRecovery(`tracked coverage collapsed ${trackedOutputs}/${auditMode.tracks}; fresh acquisition`, now, true);
      }
'''
if old not in s:
    raise SystemExit('coverage reset anchor missing')
s = s.replace(old, '', 1)

# When assistance is needed, interrogate the weakest/stalest QR rather than an
# easy central QR that only reconfirms the already-working half of the wall.
old = '''      const ranked = [...lockedGeometryCandidates].sort((a, b) => {
        const ad = Math.hypot(a.x + a.w / 2 - cx, a.y + a.h / 2 - cy);
        const bd = Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy);
        return ad - bd;
      });
      const poolSize = Math.min(5, ranked.length);'''
new = '''      const ranked = [...lockedGeometryCandidates].sort((a, b) => {
        const missDelta = (b.consecutiveMisses || 0) - (a.consecutiveMisses || 0);
        if (missDelta) return missDelta;
        const ageDelta = (a.decodedSeen ?? -Infinity) - (b.decodedSeen ?? -Infinity);
        if (ageDelta) return ageDelta;
        const ad = Math.hypot(a.x + a.w / 2 - cx, a.y + a.h / 2 - cy);
        const bd = Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy);
        return bd - ad;
      });
      const poolSize = Math.min(6, ranked.length);'''
if old not in s:
    raise SystemExit('recovery ranking anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)

rep('main.js', 'const APP_BUILD = "v0.5.276";', 'const APP_BUILD = "v0.5.277";')
p = Path('index.html')
s = p.read_text()
if s.count('v0.5.276') < 2:
    raise SystemExit('index version anchors missing')
p.write_text(s.replace('v0.5.276', 'v0.5.277'))
rep('sw.js', 'airgapper-static-js-v224', 'airgapper-static-js-v225')
