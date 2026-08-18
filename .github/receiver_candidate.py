from pathlib import Path

def rep(path, old, new):
    p = Path(path); s = p.read_text()
    if old not in s: raise SystemExit(f'missing anchor {path}')
    p.write_text(s.replace(old, new, 1))

for path, old, new in [
('receive/main.js','const RECEIVER_RUNTIME_BUILD = "v0.5.296";','const RECEIVER_RUNTIME_BUILD = "v0.5.297";'),
('send/main.js','const SEND_RUNTIME_BUILD = "v0.5.296";','const SEND_RUNTIME_BUILD = "v0.5.297";'),
('main.js','const APP_BUILD = "v0.5.296";','const APP_BUILD = "v0.5.297";'),
('index.html','main.js?build=v0.5.296','main.js?build=v0.5.297'),
('index.html','<span class="brand">AirGapper <span class="app-version">v0.5.296</span></span>','<span class="brand">AirGapper <span class="app-version">v0.5.297</span></span>'),
('sw.js','airgapper-static-js-v244','airgapper-static-js-v245')]: rep(path, old, new)

rep('receive/worker.js', '''        const readDenseSeed = (maxSymbols = 1) => decodePixelFormat === "y8"
          ? zx.readDenseY(ptr + inputOffset, pw, ph, inputStride, maxSymbols)
          : zx.readFull(ptr, pw, ph, true, maxSymbols, false);''', '''        const readDenseSeed = (maxSymbols = 1) => decodePixelFormat === "y8"
          ? zx.readDenseY(ptr + inputOffset, pw, ph, inputStride, maxSymbols)
          : zx.readFull(ptr, pw, ph, true, maxSymbols, false);
        const acquireWithScaleFallback = (maxSymbols = 1) => {
          readFullAttempts++;
          appendResults(readDenseSeed(maxSymbols), false);
          if (symbols.length === 0 && decodePixelFormat === "y8" && Math.max(pw, ph) >= 900) {
            readFullAttempts++;
            appendResults(readFull(true, maxSymbols, false), false);
          }
        };''')

rep('receive/worker.js', '''          if (!targetedAttempts) {
            readFullAttempts++;
            appendResults(readDenseSeed(1), false);
          }
        } else {
          // Cold acquisition still returns the first useful packet immediately.
          readFullAttempts++;
          appendResults(readDenseSeed(), false);
        }''', '''          if (symbols.length === 0) acquireWithScaleFallback(1);
        } else if (fullMode === "seed") {
          readFullAttempts++;
          appendResults(readDenseSeed(1), false);
        } else {
          acquireWithScaleFallback(1);
        }''')

worker = Path('receive/worker.js').read_text()
for x in ['acquireWithScaleFallback','fullMode === "seed"','readFull(true, maxSymbols, false)']:
    if x not in worker: raise SystemExit(f'missing v297 invariant {x}')
