from pathlib import Path

def rep(path, old, new, count=1):
    p = Path(path); s = p.read_text()
    if old not in s: raise SystemExit(f"missing anchor {path}: {old[:100]!r}")
    p.write_text(s.replace(old, new, count))

for path, old, new in [
('receive/main.js','const RECEIVER_RUNTIME_BUILD = "v0.5.299";','const RECEIVER_RUNTIME_BUILD = "v0.5.300";'),
('send/main.js','const SEND_RUNTIME_BUILD = "v0.5.299";','const SEND_RUNTIME_BUILD = "v0.5.300";'),
('main.js','const APP_BUILD = "v0.5.299";','const APP_BUILD = "v0.5.300";'),
('index.html','main.js?build=v0.5.299','main.js?build=v0.5.300'),
('index.html','<span class="brand">AirGapper <span class="app-version">v0.5.299</span></span>','<span class="brand">AirGapper <span class="app-version">v0.5.300</span></span>'),
('sw.js','airgapper-static-js-v247','airgapper-static-js-v248')]: rep(path, old, new)

main = Path('receive/main.js').read_text()
old = '''      callbackTimeMs: frame.callbackTimeMs,
      width: frame.width,
      height: frame.height,
      stride: frame.width * 4,
      orientation
    }, frame.videoFrame, video);'''
new = '''      callbackTimeMs: frame.callbackTimeMs,
      opticsEpoch: frame.opticsEpoch ?? null,
      cameraSettings: (() => {
        try { return track?.getSettings?.() ?? null; } catch { return null; }
      })(),
      autoOptics: {
        enabled: automaticOptics,
        runtimeState: autoOpticsRuntimeState,
        summary: autoOpticsTuneSummary || null
      },
      width: frame.width,
      height: frame.height,
      stride: frame.width * 4,
      orientation
    }, frame.videoFrame, video);'''
if old not in main: raise SystemExit('missing recorder frame metadata anchor')
Path('receive/main.js').write_text(main.replace(old, new, 1))

runner = Path('benchmark/offline-runner.mjs').read_text()
old = '''    recorder.addFrame({ sequence: 0, mediaTimeMs: 0, presentationTimeMs: 0, expectedDisplayTimeMs: 0, callbackTimeMs: 0, width: 560, height: 480, stride: 560 }, source);'''
new = '''    recorder.addFrame({ sequence: 0, mediaTimeMs: 0, presentationTimeMs: 0, expectedDisplayTimeMs: 0, callbackTimeMs: 0,
      opticsEpoch: 7, cameraSettings: { exposureTime: 33, iso: 400, focusDistance: 2.5 },
      autoOptics: { enabled: true, runtimeState: "hold", summary: "roundtrip" },
      width: 560, height: 480, stride: 560 }, source);'''
if old not in runner: raise SystemExit('missing raw corpus metadata fixture anchor')
runner = runner.replace(old, new, 1)
old = '''    const metadataPreserved = recorded.visibleRect?.width === copied.meta.visibleRect.width &&
      recorded.visibleRect?.height === copied.meta.visibleRect.height &&
      recorded.displayWidth === copied.meta.displayWidth && recorded.displayHeight === copied.meta.displayHeight &&
      Number.isFinite(recorded.codedWidth) && Number.isFinite(recorded.codedHeight);'''
new = '''    const metadataPreserved = recorded.visibleRect?.width === copied.meta.visibleRect.width &&
      recorded.visibleRect?.height === copied.meta.visibleRect.height &&
      recorded.displayWidth === copied.meta.displayWidth && recorded.displayHeight === copied.meta.displayHeight &&
      Number.isFinite(recorded.codedWidth) && Number.isFinite(recorded.codedHeight) &&
      recorded.opticsEpoch === 7 && recorded.cameraSettings?.exposureTime === 33 && recorded.cameraSettings?.iso === 400 &&
      recorded.cameraSettings?.focusDistance === 2.5 && recorded.autoOptics?.runtimeState === "hold";'''
if old not in runner: raise SystemExit('missing metadata preservation assertion')
Path('benchmark/offline-runner.mjs').write_text(runner.replace(old, new, 1))

for path, needle in [
('receive/main.js','opticsEpoch: frame.opticsEpoch ?? null'),
('receive/main.js','cameraSettings: (() =>'),
('receive/main.js','runtimeState: autoOpticsRuntimeState'),
('benchmark/offline-runner.mjs','recorded.cameraSettings?.focusDistance === 2.5')]:
    if needle not in Path(path).read_text(): raise SystemExit(f'missing v300 invariant {path}: {needle}')
