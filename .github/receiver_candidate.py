from pathlib import Path

def rep(path, old, new, count=1):
    p = Path(path); s = p.read_text()
    if old not in s: raise SystemExit(f"missing anchor {path}: {old[:120]!r}")
    p.write_text(s.replace(old, new, count))

for path, old, new in [
('receive/main.js','const RECEIVER_RUNTIME_BUILD = "v0.5.301";','const RECEIVER_RUNTIME_BUILD = "v0.5.302";'),
('send/main.js','const SEND_RUNTIME_BUILD = "v0.5.301";','const SEND_RUNTIME_BUILD = "v0.5.302";'),
('main.js','const APP_BUILD = "v0.5.301";','const APP_BUILD = "v0.5.302";'),
('index.html','main.js?build=v0.5.301','main.js?build=v0.5.302'),
('index.html','<span class="brand">AirGapper <span class="app-version">v0.5.301</span></span>','<span class="brand">AirGapper <span class="app-version">v0.5.302</span></span>'),
('sw.js','airgapper-static-js-v249','airgapper-static-js-v250')]: rep(path, old, new)

send = Path('send/main.js').read_text()
old = '''// A rolling-shutter camera may expose each sensor row briefly while taking most
// of a camera frame to move that exposure window across the sensor. A single QR
// that changes near the camera frame rate can therefore be captured as an
// undecodable splice of two consecutive pages. Keep animated 1x1 symbols stable
// for at least ~66 ms on the common 30 fps camera path. Multi-QR walls keep their
// existing faster cell-phased cadence because temporal damage is spatially local.
const SINGLE_QR_SAFE_UNIQUE_FPS = 15;
const SEND_RUNTIME_BUILD = "v0.5.302";'''
new = '''// Sender FPS is always the user's requested presentation rate. Rolling-shutter
// mitigation must remain an explicit/testable transport strategy, never a hidden
// cap that changes the selected rate.
const SEND_RUNTIME_BUILD = "v0.5.302";'''
if old not in send: raise SystemExit('missing v301 cap block')
send = send.replace(old, new, 1)
old = '''  const { cols: gridCols, rows: gridRows, codes: gridCodes } = layoutGrid(layoutMode);
  const effectivePageFps = (fps) => {
    const requested = Math.max(1, Number(fps) || 1);
    return !staticStream && gridCodes === 1 ? Math.min(requested, SINGLE_QR_SAFE_UNIQUE_FPS) : requested;
  };
  const effectiveTxFps = effectivePageFps(txFps);
  const temporalHold = !staticStream && gridCodes === 1 && effectiveTxFps < txFps ? txFps / effectiveTxFps : 1;
  const gridMargin = gridCodes === 1 ? 4 : GRID_MARGIN;'''
new = '''  const { cols: gridCols, rows: gridRows, codes: gridCodes } = layoutGrid(layoutMode);
  const gridMargin = gridCodes === 1 ? 4 : GRID_MARGIN;'''
if old not in send: raise SystemExit('missing v301 effective fps block')
send = send.replace(old, new, 1)
send = send.replace('''              txFps,
              effectiveTxFps,
              temporalHold,
              frameBytes,''','''              txFps,
              frameBytes,''',1)
send = send.replace('let pageInterval = 1e3 / effectiveTxFps;','let pageInterval = 1e3 / txFps;',1)
send = send.replace('pageInterval = 1e3 / effectivePageFps(fps);','pageInterval = 1e3 / Math.max(1, fps);',1)
send = send.replace('let interval = 1e3 / effectiveTxFps;','let interval = 1e3 / txFps;',1)
send = send.replace('interval = 1e3 / effectivePageFps(fps);','interval = 1e3 / Math.max(1, fps);',1)
Path('send/main.js').write_text(send)

for needle in ['SINGLE_QR_SAFE_UNIQUE_FPS','effectivePageFps','temporalHold']:
    if needle in send: raise SystemExit(f'v302 must remove hidden sender cap: {needle}')
if 'pageInterval = 1e3 / Math.max(1, fps);' not in send: raise SystemExit('missing unrestricted live fps setter')
