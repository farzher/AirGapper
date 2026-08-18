from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f"{label} anchor missing")
    return text.replace(old, new, 1)

# Dense AirGapper acquisition: one verified QR is now sufficient to seed the
# entire declared wall, so return the first dense QR instead of continuing a
# generic multi-symbol search designed for the old multi-slot lock rule.
p = Path('receive/worker.js')
s = p.read_text()
old = '''      if (full) {
        // Acquisition needs a small set of distinct slots before a multi-QR
        // lattice becomes trusted. Keep this far cheaper than the historical
        // 16->24 symbol scan, but do not stop after the easiest single QR.
        // Normal scans collect up to four current-frame seeds; occasional deep
        // scans use the same bound with tryHarder's downscale sweep.
        const fullMode = acquisitionMode ?? (thorough ? "thorough" : "fast");
        const readFull = (tryHarder, maxSymbols, returnErrors) => decodePixelFormat === "y8"
          ? zx.readFullY(ptr + inputOffset, pw, ph, inputStride, tryHarder, maxSymbols, returnErrors)
          : zx.readFull(ptr, pw, ph, tryHarder, maxSymbols, returnErrors);
        if (fullMode === "thorough") {
          readFullAttempts++;
          appendResults(readFull(true, 16, false), false);
          if (symbols.length === 0) {
            readFullAttempts++;
            appendResults(readFull(true, 24, true), true);
          }
        } else if (fullMode === "seed") {
          readFullAttempts++;
          appendResults(readFull(true, 2, false), false);
        } else {
          readFullAttempts++;
          appendResults(readFull(fullMode === "deep", 4, false), false);
        }
      } else {
'''
new = '''      if (full) {
        // One CRC-valid AirGapper QR now seeds the complete declared wall. At
        // dense v40 scale, use the codec's dedicated full-resolution finder:
        // it keeps tryHarder's 3-row scan stride but deliberately skips the
        // useless 1/3 and 1/9 image pyramids. Return after the first QR so the
        // main thread can lock/predict all slots immediately. An occasional
        // deep scan retains generic downscale coverage for a distant wall.
        const fullMode = acquisitionMode ?? (thorough ? "thorough" : "fast");
        const readFull = (tryHarder, maxSymbols, returnErrors) => decodePixelFormat === "y8"
          ? zx.readFullY(ptr + inputOffset, pw, ph, inputStride, tryHarder, maxSymbols, returnErrors)
          : zx.readFull(ptr, pw, ph, tryHarder, maxSymbols, returnErrors);
        const readDenseSeed = () => decodePixelFormat === "y8"
          ? zx.readDenseY(ptr + inputOffset, pw, ph, inputStride, 1)
          : zx.readFull(ptr, pw, ph, true, 1, false);
        if (fullMode === "thorough") {
          readFullAttempts++;
          appendResults(readFull(true, 16, false), false);
          if (symbols.length === 0) {
            readFullAttempts++;
            appendResults(readFull(true, 24, true), true);
          }
        } else if (fullMode === "deep") {
          readFullAttempts++;
          appendResults(readFull(true, 1, false), false);
        } else {
          // Both global fast acquisition and bounded seed/recovery crops are
          // optimized for the first useful AirGapper packet, not symbol count.
          readFullAttempts++;
          appendResults(readDenseSeed(), false);
        }
      } else {
'''
s = replace_once(s, old, new, 'dense first QR acquisition')
p.write_text(s)

# Focus recovery remains completely dormant during healthy LOCKED decoding.
# Once the optical target genuinely disappears, however, sample quickly enough
# to notice its return and escalate to continuous AF after ~0.65s rather than
# sitting in a 1.6s grace sampled only every 700ms.
p = Path('receive/focus-controller.js')
s = p.read_text()
s = replace_once(s, '  targetLostGraceMs: 1600,\n', '  targetLostGraceMs: 650,\n', 'target lost grace')
old = '''    if (this.expectsProbeFrame) return 0;
    return this.state === "LOCKED" || this.state === "TARGET_LOST_GRACE" ? CAMERA_TUNING.lockedOpticalIntervalMs : CAMERA_TUNING.seekingOpticalIntervalMs;
'''
new = '''    if (this.expectsProbeFrame) return 0;
    if (this.state === "TARGET_LOST_GRACE") return CAMERA_TUNING.seekingOpticalIntervalMs;
    return this.state === "LOCKED" ? CAMERA_TUNING.lockedOpticalIntervalMs : CAMERA_TUNING.seekingOpticalIntervalMs;
'''
s = replace_once(s, old, new, 'target lost optical cadence')
p.write_text(s)

p = Path('receive/main.js')
s = p.read_text()
s = replace_once(s, 'const RECEIVER_RUNTIME_BUILD = "v0.5.272";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.273";', 'receiver version')
p.write_text(s)

p = Path('main.js')
s = p.read_text()
s = replace_once(s, 'const APP_BUILD = "v0.5.272";', 'const APP_BUILD = "v0.5.273";', 'app version')
p.write_text(s)

p = Path('index.html')
s = p.read_text()
if s.count('v0.5.272') < 2:
    raise SystemExit('index version anchors missing')
s = s.replace('v0.5.272', 'v0.5.273')
p.write_text(s)

p = Path('sw.js')
s = p.read_text()
s = replace_once(s, 'airgapper-static-js-v220', 'airgapper-static-js-v221', 'service worker cache')
p.write_text(s)
