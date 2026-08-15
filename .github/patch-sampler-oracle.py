from pathlib import Path
import re


def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    n = text.count(old)
    if n != count:
        raise SystemExit(f"{path}: expected {count} matches, got {n}: {old[:120]!r}")
    p.write_text(text.replace(old, new))


def sub(path, pattern, repl, count=1, flags=0, label="pattern"):
    p = Path(path)
    text = p.read_text()
    new, n = re.subn(pattern, repl, text, count=count, flags=flags)
    if n != count:
        raise SystemExit(f"{path}: expected {count} {label}, got {n}")
    p.write_text(new)

# ---- receive/worker.js -----------------------------------------------------
p = Path("receive/worker.js")
text = p.read_text()
marker = "function projectedNeighbor(q, dx, dy, stride) {"
if marker not in text:
    raise SystemExit("worker projectedNeighbor marker missing")
helpers = r'''let qrGeneratorPromise;
function localQuad(q, ox, oy) {
  const move = (point) => ({ x: point.x - ox, y: point.y - oy });
  return {
    topLeft: move(q.topLeft),
    topRight: move(q.topRight),
    bottomRight: move(q.bottomRight),
    bottomLeft: move(q.bottomLeft)
  };
}
function globalQuad(q, ox, oy) {
  return shifted(q, ox, oy);
}
function quadMaxDelta(a, b) {
  if (!a || !b) return null;
  return Math.max(...["topLeft", "topRight", "bottomRight", "bottomLeft"].map((name) =>
    Math.hypot(a[name].x - b[name].x, a[name].y - b[name].y)
  ));
}
function sampledMatrixStats(sampled, expected, dim) {
  if (!sampled || sampled.length !== expected.length) {
    return { valid: false, mismatches: expected.length, total: expected.length, percent: 100, bounds: null };
  }
  let mismatches = 0;
  let minX = dim, minY = dim, maxX = -1, maxY = -1;
  for (let index = 0; index < expected.length; index++) {
    if (Number(Boolean(sampled[index])) === expected[index]) continue;
    mismatches++;
    const x = index % dim;
    const y = Math.floor(index / dim);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return {
    valid: true,
    mismatches,
    total: expected.length,
    percent: mismatches / Math.max(1, expected.length) * 100,
    bounds: mismatches ? [minX, minY, maxX, maxY] : null
  };
}
async function diagnoseTrackedSampler(zx, ptr, width, height, ox, oy, track, nativeSlot, result) {
  try {
    const version = (result.modules - 17) / 4;
    if (!Number.isInteger(version) || version < 1 || version > 40 || typeof zx.trackedMatrix !== "function") return null;
    qrGeneratorPromise ??= import("../vendor/qrcode.js");
    const { default: QRCode } = await qrGeneratorPromise;
    const bytes = Uint8Array.from(result.bytes);
    const expectedQr = QRCode.create([{ data: bytes, mode: "byte" }], {
      errorCorrectionLevel: "L",
      version,
      maskPattern: 4
    });
    const dim = expectedQr.modules.size;
    if (dim !== result.modules) return { slot: track.slot, dim: result.modules, error: `regenerated dimension ${dim}` };
    const expected = Uint8Array.from(expectedQr.modules.data, (value) => value ? 1 : 0);
    const freshGlobal = globalQuad(result.position, ox, oy);
    const cachedGlobal = nativeConfigured[nativeSlot]?.baseQuad ?? track.quad;
    const currentGlobal = track.quad;
    const sample = (quad) => sampledMatrixStats(
      zx.trackedMatrix(
        ptr,
        width,
        height,
        dim,
        quad.topLeft.x,
        quad.topLeft.y,
        quad.topRight.x,
        quad.topRight.y,
        quad.bottomRight.x,
        quad.bottomRight.y,
        quad.bottomLeft.x,
        quad.bottomLeft.y
      ),
      expected,
      dim
    );
    const cached = sample(localQuad(cachedGlobal, ox, oy));
    const current = sample(localQuad(currentGlobal, ox, oy));
    const fresh = sample(result.position);
    let classification = "frame/sampler mismatch";
    if (fresh.mismatches === 0 && current.mismatches === 0 && cached.mismatches > 0) classification = "stale native geometry";
    else if (fresh.mismatches === 0 && current.mismatches > 0) classification = "lattice geometry mismatch";
    else if (fresh.mismatches === 0 && current.mismatches === 0 && cached.mismatches === 0) classification = "native fast-path mismatch";
    return {
      slot: track.slot,
      dim,
      classification,
      cached,
      current,
      fresh,
      cachedDeltaPx: quadMaxDelta(cachedGlobal, freshGlobal),
      currentDeltaPx: quadMaxDelta(currentGlobal, freshGlobal)
    };
  } catch (error) {
    return { slot: track.slot, dim: result.modules, error: error instanceof Error ? error.message : String(error) };
  }
}
'''
text = text.replace(marker, helpers + marker, 1)
p.write_text(text)

replace(
    "receive/worker.js",
    'payloadBytes = 0, strictTracked = false } = e.data;',
    'payloadBytes = 0, strictTracked = false, diagnoseSampler = false } = e.data;'
)

# Add diagnostics collection beside the regular output arrays.
replace(
    "receive/worker.js",
    '    const symbols = [];\n    const sightings = [];',
    '    const symbols = [];\n    const sightings = [];\n    const samplerDiagnostics = [];'
)

# Replace robust fallback body with diagnostics + immediate native-cache refresh.
old = '''          if (!packet || slot !== void 0 && expectedSlots.size && !expectedSlots.has(slot) || slot !== void 0 && decodedSlots.has(slot)) continue;
          if (slot !== void 0) decodedSlots.add(slot);
          symbols.push({
            bytes: result.bytes,
            box: boundsOf(result.position, ox, oy),
            quad: shifted(result.position, ox, oy),
            modules: result.modules,
            tracked: false
          });'''
new = '''          if (!packet || slot !== void 0 && expectedSlots.size && !expectedSlots.has(slot) || slot !== void 0 && decodedSlots.has(slot)) continue;
          if (slot !== void 0) decodedSlots.add(slot);
          const trackIndex = tracks.findIndex((track) => track.slot === slot);
          if (trackIndex >= 0) {
            // The robust decoder just gave us a fresh quad. Never keep using a
            // native sample map built from the geometry that needed recovery.
            nativeRefresh.add(trackIndex);
            if (diagnoseSampler) {
              const diagnostic = await diagnoseTrackedSampler(zx, ptr, pw, ph, ox, oy, tracks[trackIndex], trackIndex, result);
              if (diagnostic) samplerDiagnostics.push(diagnostic);
            }
          }
          symbols.push({
            bytes: result.bytes,
            box: boundsOf(result.position, ox, oy),
            quad: shifted(result.position, ox, oy),
            modules: result.modules,
            tracked: false
          });'''
replace("receive/worker.js", old, new)

replace(
    "receive/worker.js",
    '''        fallbackSucceeded: symbols.length > 0,
        readFullAttempts,
        workerWaitMs,
        latencyMs: performance.now() - startedAt''',
    '''        fallbackSucceeded: symbols.length > 0,
        readFullAttempts,
        workerWaitMs,
        frameCopyMs,
        nativeMetrics: native?.metrics,
        samplerDiagnostics,
        latencyMs: performance.now() - startedAt'''
)

# ---- shared/worker-pool.js -------------------------------------------------
replace(
    "shared/worker-pool.js",
    '''          nativeMetrics: message.nativeMetrics,
          directFrameFailed: Boolean(message.directFrameFailed),''',
    '''          nativeMetrics: message.nativeMetrics,
          samplerDiagnostics: message.samplerDiagnostics ?? [],
          directFrameFailed: Boolean(message.directFrameFailed),'''
)

# ---- receive/main.js -------------------------------------------------------
replace(
    "receive/main.js",
    '''let lastDecodeError = "";
let lastNativeMetrics;
let trackingInvalidations = 0;''',
    '''let lastDecodeError = "";
let lastNativeMetrics;
let lastSamplerDiagnostics = [];
let trackingInvalidations = 0;'''
)

replace(
    "receive/main.js",
    '''  if (completion.nativeMetrics) lastNativeMetrics = { ...completion.nativeMetrics, frameCopyMs: completion.frameCopyMs };
  if (fullJob) {''',
    '''  if (completion.nativeMetrics) lastNativeMetrics = { ...completion.nativeMetrics, frameCopyMs: completion.frameCopyMs };
  if (completion.samplerDiagnostics?.length) lastSamplerDiagnostics = completion.samplerDiagnostics;
  if (fullJob) {'''
)

replace(
    "receive/main.js",
    '''  lastDecodeError = "";
  lastNativeMetrics = void 0;
  trackingInvalidations = 0;''',
    '''  lastDecodeError = "";
  lastNativeMetrics = void 0;
  lastSamplerDiagnostics = [];
  trackingInvalidations = 0;'''
)

# Add developer-only sampler line immediately after the native timing line.
needle = '''    lastNativeMetrics ? `Native   ${lastNativeMetrics.totalMs.toFixed(1)}ms · copy ${(lastNativeMetrics.frameCopyMs ?? 0).toFixed(1)} · anchor ${lastNativeMetrics.anchorMs.toFixed(1)} · sample ${lastNativeMetrics.samplingMs.toFixed(1)} · bits ${lastNativeMetrics.bitExtractionMs.toFixed(1)} · CRC ${lastNativeMetrics.crcMs.toFixed(1)} · RS ${lastNativeMetrics.rsFallbackMs.toFixed(1)} · ${lastNativeMetrics.samples} samples · ${lastNativeMetrics.successful}/${lastNativeMetrics.tracks} QR` : "",
'''
replacement = needle + '''    lastSamplerDiagnostics.length ? `Sampler  ${lastSamplerDiagnostics.map((item) => item.error
      ? `s${item.slot ?? "?"} error ${item.error}`
      : `s${item.slot} ${item.classification} · cache ${item.cached.mismatches}/${item.cached.total} (${item.cached.percent.toFixed(2)}%) Δ${item.cachedDeltaPx?.toFixed(2) ?? "?"}px · lattice ${item.current.mismatches}/${item.current.total} (${item.current.percent.toFixed(2)}%) Δ${item.currentDeltaPx?.toFixed(2) ?? "?"}px · fresh ${item.fresh.mismatches}/${item.fresh.total} (${item.fresh.percent.toFixed(2)}%)`
    ).join(" | ")}` : "",
'''
replace("receive/main.js", needle, replacement)

# Enable the expensive oracle only while Developer Settings are visible. It
# still runs only after a native miss followed by successful local recovery.
text = Path("receive/main.js").read_text()
old_lane = '''? { id, videoFrame: direct.frame, cropX: x, cropY: y, w, h, ox: x, oy: y, full: false, tracks: group.tracks, pixelFormat: direct.pixelFormat, strictTracked: false }
        : { id, buf: laneImage.data.buffer, w, h, ox: x, oy: y, full: false, tracks: group.tracks, strictTracked: Boolean(source.image) };'''
new_lane = '''? { id, videoFrame: direct.frame, cropX: x, cropY: y, w, h, ox: x, oy: y, full: false, tracks: group.tracks, pixelFormat: direct.pixelFormat, strictTracked: false, diagnoseSampler: !receiverDevActions.hidden }
        : { id, buf: laneImage.data.buffer, w, h, ox: x, oy: y, full: false, tracks: group.tracks, strictTracked: Boolean(source.image), diagnoseSampler: !receiverDevActions.hidden };'''
if text.count(old_lane) != 1:
    raise SystemExit(f"main lane message expected 1, got {text.count(old_lane)}")
text = text.replace(old_lane, new_lane, 1)
old_shared = '''? { id: id2, videoFrame: sharedDirect.frame, cropX: x, cropY: y, w, h, ox: x, oy: y, full: false, tracks: batchTracks, pixelFormat: sharedDirect.pixelFormat, strictTracked: false }
          : { id: id2, buf: shared.data.buffer, w, h, ox: x, oy: y, full: false, tracks: batchTracks, strictTracked: Boolean(source.image) };'''
new_shared = '''? { id: id2, videoFrame: sharedDirect.frame, cropX: x, cropY: y, w, h, ox: x, oy: y, full: false, tracks: batchTracks, pixelFormat: sharedDirect.pixelFormat, strictTracked: false, diagnoseSampler: !receiverDevActions.hidden }
          : { id: id2, buf: shared.data.buffer, w, h, ox: x, oy: y, full: false, tracks: batchTracks, strictTracked: Boolean(source.image), diagnoseSampler: !receiverDevActions.hidden };'''
if text.count(old_shared) != 1:
    raise SystemExit(f"main shared message expected 1, got {text.count(old_shared)}")
text = text.replace(old_shared, new_shared, 1)
# The non-direct shared fallback is also a tracked batch and can recover locally.
text = text.replace(
    '{ id, buf: shared.data.buffer, w, h, ox: x, oy: y, full: false, tracks: batchTracks },',
    '{ id, buf: shared.data.buffer, w, h, ox: x, oy: y, full: false, tracks: batchTracks, diagnoseSampler: !receiverDevActions.hidden },',
    1
)
Path("receive/main.js").write_text(text)

# Version/cache bump.
replace("index.html", 'v0.5.49', 'v0.5.50')
replace("sw.js", 'airgapper-static-js-v12', 'airgapper-static-js-v13')

# Sanity assertions.
for path in ["receive/worker.js", "receive/main.js", "shared/worker-pool.js"]:
    t = Path(path).read_text()
    if "samplerDiagnostics" not in t:
        raise SystemExit(f"{path}: sampler diagnostics missing")
if "nativeRefresh.add(trackIndex)" not in Path("receive/worker.js").read_text():
    raise SystemExit("worker: immediate native refresh missing")
print("sampler oracle patch ready")
