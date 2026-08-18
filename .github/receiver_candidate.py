from pathlib import Path

def rep(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing anchor {path}: {old[:120]!r}")
    p.write_text(s.replace(old, new, count))

for path, old, new in [
    ('receive/main.js','const RECEIVER_RUNTIME_BUILD = "v0.5.299";','const RECEIVER_RUNTIME_BUILD = "v0.5.301";'),
    ('send/main.js','const SEND_RUNTIME_BUILD = "v0.5.299";','const SEND_RUNTIME_BUILD = "v0.5.301";'),
    ('main.js','const APP_BUILD = "v0.5.299";','const APP_BUILD = "v0.5.301";'),
    ('index.html','main.js?build=v0.5.299','main.js?build=v0.5.301'),
    ('index.html','<span class="brand">AirGapper <span class="app-version">v0.5.299</span></span>','<span class="brand">AirGapper <span class="app-version">v0.5.301</span></span>'),
    ('sw.js','airgapper-static-js-v247','airgapper-static-js-v249'),
]:
    rep(path, old, new)

send = Path('send/main.js').read_text()

old = 'const SEND_SETTINGS_KEY = "airgapper:send-settings:v1";\nconst SEND_RUNTIME_BUILD = "v0.5.301";'
new = '''const SEND_SETTINGS_KEY = "airgapper:send-settings:v1";
// A rolling-shutter camera may expose each sensor row briefly while taking most
// of a camera frame to move that exposure window across the sensor. A single QR
// that changes near the camera frame rate can therefore be captured as an
// undecodable splice of two consecutive pages. Keep animated 1x1 symbols stable
// for at least ~66 ms on the common 30 fps camera path. Multi-QR walls keep their
// existing faster cell-phased cadence because temporal damage is spatially local.
const SINGLE_QR_SAFE_UNIQUE_FPS = 15;
const SEND_RUNTIME_BUILD = "v0.5.301";'''
if old not in send:
    raise SystemExit('missing sender settings/build anchor')
send = send.replace(old, new, 1)

old = '''  const layoutMode = staticStream ? "single" : configuredLayout;
  const { cols: gridCols, rows: gridRows, codes: gridCodes } = layoutGrid(layoutMode);
  const gridMargin = gridCodes === 1 ? 4 : GRID_MARGIN;'''
new = '''  const layoutMode = staticStream ? "single" : configuredLayout;
  const { cols: gridCols, rows: gridRows, codes: gridCodes } = layoutGrid(layoutMode);
  const effectivePageFps = (fps) => {
    const requested = Math.max(1, Number(fps) || 1);
    return !staticStream && gridCodes === 1 ? Math.min(requested, SINGLE_QR_SAFE_UNIQUE_FPS) : requested;
  };
  const effectiveTxFps = effectivePageFps(txFps);
  const temporalHold = !staticStream && gridCodes === 1 && effectiveTxFps < txFps ? txFps / effectiveTxFps : 1;
  const gridMargin = gridCodes === 1 ? 4 : GRID_MARGIN;'''
if old not in send:
    raise SystemExit('missing grid layout anchor')
send = send.replace(old, new, 1)

old = '''            settings: {
              txFps,
              frameBytes,'''
new = '''            settings: {
              txFps,
              effectiveTxFps,
              temporalHold,
              frameBytes,'''
if old not in send:
    raise SystemExit('missing sender settings diagnostics anchor')
send = send.replace(old, new, 1)

old = '''    let pageInterval = 1e3 / txFps;
    let cellInterval = pageInterval / gridCodes;
    let nextCellAt = 0;
    activeSendFpsSetter = (fps) => {
      pageInterval = 1e3 / Math.max(1, fps);
      cellInterval = pageInterval / gridCodes;'''
new = '''    let pageInterval = 1e3 / effectiveTxFps;
    let cellInterval = pageInterval / gridCodes;
    let nextCellAt = 0;
    activeSendFpsSetter = (fps) => {
      pageInterval = 1e3 / effectivePageFps(fps);
      cellInterval = pageInterval / gridCodes;'''
if old not in send:
    raise SystemExit('missing parallel sender cadence anchor')
send = send.replace(old, new, 1)

old = '''  let interval = 1e3 / txFps;
  let nextAt = performance.now() + interval;
  activeSendFpsSetter = (fps) => {
    interval = 1e3 / Math.max(1, fps);
    nextAt = Math.min(nextAt, performance.now() + interval);'''
new = '''  let interval = 1e3 / effectiveTxFps;
  let nextAt = performance.now() + interval;
  activeSendFpsSetter = (fps) => {
    interval = 1e3 / effectivePageFps(fps);
    nextAt = Math.min(nextAt, performance.now() + interval);'''
if old not in send:
    raise SystemExit('missing fallback sender cadence anchor')
send = send.replace(old, new, 1)

Path('send/main.js').write_text(send)

for path, needle in [
    ('send/main.js', 'SINGLE_QR_SAFE_UNIQUE_FPS = 15'),
    ('send/main.js', 'const effectiveTxFps = effectivePageFps(txFps)'),
    ('send/main.js', 'pageInterval = 1e3 / effectivePageFps(fps)'),
    ('send/main.js', 'interval = 1e3 / effectivePageFps(fps)'),
    ('send/main.js', 'temporalHold,'),
]:
    if needle not in Path(path).read_text():
        raise SystemExit(f'missing v301 invariant {path}: {needle}')
