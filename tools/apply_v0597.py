from pathlib import Path

def read(path):
    return Path(path).read_text()

def write(path, text):
    Path(path).write_text(text)

def replace_once(path, old, new):
    text = read(path)
    if old not in text:
        raise SystemExit(f"anchor not found in {path}: {old[:120]!r}")
    write(path, text.replace(old, new, 1))

replace_once("index.html", "v0.5.96", "v0.5.97")
replace_once("main.js", 'const APP_BUILD = "v0.5.96";', 'const APP_BUILD = "v0.5.97";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.96";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.97";')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v59";', 'const CACHE = "airgapper-static-js-v60";')
replace_once("vendor/decimen-codec/source/VERSION", "0.1.12", "0.1.13")

replace_once(
    "shared/worker-pool.js",
'''          nativeMetrics: message.nativeMetrics,
          pixelPath: message.pixelPath,
          directFrameFailed: Boolean(message.directFrameFailed),
          symbols,''',
'''          nativeMetrics: message.nativeMetrics,
          pixelPath: message.pixelPath,
          exactMapCoverage: message.exactMapCoverage,
          exactMapTotal: message.exactMapTotal,
          exactMapsSeeded: message.exactMapsSeeded ?? 0,
          nativeMs: message.nativeMs ?? 0,
          robustMs: message.robustMs ?? 0,
          exactFastPath: Boolean(message.exactFastPath),
          directFrameFailed: Boolean(message.directFrameFailed),
          symbols,''')

replace_once(
    "receive/main.js",
'''let lastExactMapCoverage = "—";
let lastNativePhaseMs = 0;
let lastRobustPhaseMs = 0;''',
'''let lastExactMapCoverage = "—";
let lastExactMapsSeeded = 0;
let lastNativePhaseMs = 0;
let lastRobustPhaseMs = 0;''')
replace_once(
    "receive/main.js",
'''  if (completion.exactMapTotal) lastExactMapCoverage = `${completion.exactMapCoverage ?? 0}/${completion.exactMapTotal}`;
  if (Number.isFinite(completion.nativeMs)) lastNativePhaseMs = completion.nativeMs;
  if (Number.isFinite(completion.robustMs)) lastRobustPhaseMs = completion.robustMs;''',
'''  if (completion.exactMapTotal) {
    lastExactMapCoverage = `${completion.exactMapCoverage ?? 0}/${completion.exactMapTotal}`;
    lastExactMapsSeeded = completion.exactMapsSeeded ?? 0;
  }
  if (Number.isFinite(completion.nativeMs)) lastNativePhaseMs = completion.nativeMs;
  if (Number.isFinite(completion.robustMs)) lastRobustPhaseMs = completion.robustMs;''')
replace_once(
    "receive/main.js",
'''Pixel path ${lastDirectPixelPath.toUpperCase()} · exact maps ${lastExactMapCoverage} · native ${lastNativePhaseMs.toFixed(1)}ms · robust ${lastRobustPhaseMs.toFixed(1)}ms${lastNativeMetrics ? ` · bin ${Number(lastNativeMetrics.binarizeMs ?? 0).toFixed(1)}ms · exact ${lastNativeMetrics.exactMapSuccesses ?? 0}/${lastNativeMetrics.exactMapAttempts ?? 0}` : ""}''',
'''Pixel path ${lastDirectPixelPath.toUpperCase()} · exact maps ${lastExactMapCoverage} · seeded +${lastExactMapsSeeded} · native ${lastNativePhaseMs.toFixed(1)}ms · robust ${lastRobustPhaseMs.toFixed(1)}ms${lastNativeMetrics ? ` · bin ${Number(lastNativeMetrics.binarizeMs ?? 0).toFixed(1)}ms · exact ${lastNativeMetrics.exactMapSuccesses ?? 0}/${lastNativeMetrics.exactMapAttempts ?? 0}` : ""}''')

worker_path = "receive/worker.js"
worker = read(worker_path)
old = '''function rememberExactSampleMap(id, dim, sampleMap, ox, oy) {
  if (!sampleMap || sampleMap.length !== dim * dim * 2) return false;
  const xy = new Float32Array(sampleMap.length);
  for (let i = 0; i < sampleMap.length; i += 2) {
    xy[i] = sampleMap[i] + ox;
    xy[i + 1] = sampleMap[i + 1] + oy;
  }
  nativeExactMaps.set(id, { dim, xy, version: nativeExactMapVersion++ });
  return true;
}
function applyExactSampleMap(zx, nativeSlot, map, ox, oy) {
  const pointCount = map.dim * map.dim;
  const floats = pointCount * 2;
  if (floats > nativeSampleScratchFloats) {
    if (nativeSampleScratchPtr) zx._free(nativeSampleScratchPtr);
    nativeSampleScratchPtr = zx._malloc(floats * 4);
    nativeSampleScratchFloats = floats;
  }
  if (!nativeSampleScratchPtr) return false;
  const out = new Float32Array(zx.HEAPU8.buffer, nativeSampleScratchPtr, floats);
  for (let i = 0; i < floats; i += 2) {
    out[i] = map.xy[i] - ox;
    out[i + 1] = map.xy[i + 1] - oy;
  }
  return Boolean(zx._setTrackedDecoderSampleMap(nativeBatchHandle, nativeSlot, nativeSampleScratchPtr, pointCount));
}'''
new = '''function copyQuad(q) {
  return {
    topLeft: { ...q.topLeft },
    topRight: { ...q.topRight },
    bottomRight: { ...q.bottomRight },
    bottomLeft: { ...q.bottomLeft }
  };
}
function maxQuadDelta(a, b) {
  if (!validQuad(a) || !validQuad(b)) return Infinity;
  return Math.max(
    Math.hypot(a.topLeft.x - b.topLeft.x, a.topLeft.y - b.topLeft.y),
    Math.hypot(a.topRight.x - b.topRight.x, a.topRight.y - b.topRight.y),
    Math.hypot(a.bottomRight.x - b.bottomRight.x, a.bottomRight.y - b.bottomRight.y),
    Math.hypot(a.bottomLeft.x - b.bottomLeft.x, a.bottomLeft.y - b.bottomLeft.y)
  );
}
function squareToQuad(q) {
  if (!validQuad(q)) return null;
  const x0 = q.topLeft.x, y0 = q.topLeft.y;
  const x1 = q.topRight.x, y1 = q.topRight.y;
  const x2 = q.bottomRight.x, y2 = q.bottomRight.y;
  const x3 = q.bottomLeft.x, y3 = q.bottomLeft.y;
  const dx3 = x0 - x1 + x2 - x3;
  const dy3 = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (Math.abs(dx3) > 1e-7 || Math.abs(dy3) > 1e-7) {
    const dx1 = x1 - x2, dx2 = x3 - x2;
    const dy1 = y1 - y2, dy2 = y3 - y2;
    const denominator = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(denominator) < 1e-8) return null;
    g = (dx3 * dy2 - dx2 * dy3) / denominator;
    h = (dx1 * dy3 - dx3 * dy1) / denominator;
  }
  return {
    a: x1 - x0 + g * x1,
    b: x3 - x0 + h * x3,
    c: x0,
    d: y1 - y0 + g * y1,
    e: y3 - y0 + h * y3,
    f: y0,
    g,
    h
  };
}
function projectUnitQuad(model, u, v) {
  const denominator = model.g * u + model.h * v + 1;
  return {
    x: (model.a * u + model.b * v + model.c) / denominator,
    y: (model.d * u + model.e * v + model.f) / denominator
  };
}
function rememberExactSampleMap(id, dim, sampleMap, ox, oy, localQuad) {
  if (!sampleMap || sampleMap.length !== dim * dim * 2 || !validQuad(localQuad)) return false;
  const anchorQuad = shifted(localQuad, ox, oy);
  const anchorModel = squareToQuad(anchorQuad);
  if (!anchorModel) return false;
  const residual = new Float32Array(sampleMap.length);
  let i = 0;
  for (let y = 0; y < dim; y++) {
    const v = (y + 0.5) / dim;
    for (let x = 0; x < dim; x++, i += 2) {
      const u = (x + 0.5) / dim;
      const projected = projectUnitQuad(anchorModel, u, v);
      residual[i] = sampleMap[i] + ox - projected.x;
      residual[i + 1] = sampleMap[i + 1] + oy - projected.y;
    }
  }
  nativeExactMaps.set(id, { dim, residual, version: nativeExactMapVersion++ });
  return true;
}
function applyExactSampleMap(zx, nativeSlot, map, track, ox, oy) {
  const pointCount = map.dim * map.dim;
  const floats = pointCount * 2;
  const currentModel = squareToQuad(track.quad);
  if (!currentModel) return false;
  if (floats > nativeSampleScratchFloats) {
    if (nativeSampleScratchPtr) zx._free(nativeSampleScratchPtr);
    nativeSampleScratchPtr = zx._malloc(floats * 4);
    nativeSampleScratchFloats = floats;
  }
  if (!nativeSampleScratchPtr) return false;
  const out = new Float32Array(zx.HEAPU8.buffer, nativeSampleScratchPtr, floats);
  let i = 0;
  for (let y = 0; y < map.dim; y++) {
    const v = (y + 0.5) / map.dim;
    for (let x = 0; x < map.dim; x++, i += 2) {
      const u = (x + 0.5) / map.dim;
      const projected = projectUnitQuad(currentModel, u, v);
      out[i] = projected.x + map.residual[i] - ox;
      out[i + 1] = projected.y + map.residual[i + 1] - oy;
    }
  }
  return Boolean(zx._setTrackedDecoderSampleMap(nativeBatchHandle, nativeSlot, nativeSampleScratchPtr, pointCount));
}'''
if old not in worker:
    raise SystemExit("exact map helper block anchor not found")
worker = worker.replace(old, new, 1)

old = '''    const exactMap = nativeExactMaps.get(id);
    const exactVersion = exactMap?.dim === track.dim ? exactMap.version : 0;
    const mustConfigure = originChanged || nativeRefresh.has(slot) || !previous || previous.id !== id || previous.dim !== track.dim || previous.crc32 !== track.crc32 || previous.exactVersion !== exactVersion;'''
new = '''    const exactMap = nativeExactMaps.get(id);
    const exactVersion = exactMap?.dim === track.dim ? exactMap.version : 0;
    const exactGeometryChanged = exactVersion && (!previous?.appliedQuad || maxQuadDelta(previous.appliedQuad, track.quad) > 0.25);
    const mustConfigure = originChanged || nativeRefresh.has(slot) || !previous || previous.id !== id || previous.dim !== track.dim || previous.crc32 !== track.crc32 || previous.exactVersion !== exactVersion || exactGeometryChanged;'''
if old not in worker:
    raise SystemExit("configure exactVersion anchor not found")
worker = worker.replace(old, new, 1)

old = '''      const exactApplied = exactVersion ? applyExactSampleMap(zx, slot, exactMap, ox, oy) : false;
      nativeConfigured[slot] = { id, dim: track.dim, crc32: track.crc32, baseQuad: track.quad, exactVersion: exactApplied ? exactVersion : 0 };'''
new = '''      const exactApplied = exactVersion ? applyExactSampleMap(zx, slot, exactMap, track, ox, oy) : false;
      nativeConfigured[slot] = {
        id,
        dim: track.dim,
        crc32: track.crc32,
        baseQuad: copyQuad(track.quad),
        appliedQuad: copyQuad(track.quad),
        exactVersion: exactApplied ? exactVersion : 0
      };'''
if old not in worker:
    raise SystemExit("apply exact map anchor not found")
worker = worker.replace(old, new, 1)

old = '''    const robustLaneFirst = !strictHotPath && !full && Array.isArray(tracks) && tracks.length > 0 && (usedDirectFrame || pixelFormat === "rgba");'''
new = '''    const robustLaneFirst = !strictHotPath && !full && Array.isArray(tracks) && tracks.length > 0
      && (usedDirectFrame || pixelFormat === "rgba" || pixelFormat === "y8");'''
if old not in worker:
    raise SystemExit("robustLaneFirst anchor not found")
worker = worker.replace(old, new, 1)

old = '''          if (slot !== void 0 && exactReader && rememberExactSampleMap(slot, result.modules, result.sampleMap, ox, oy)) mapsSeeded++;'''
new = '''          if (slot !== void 0 && exactReader && rememberExactSampleMap(slot, result.modules, result.sampleMap, ox, oy, result.position)) mapsSeeded++;'''
if old not in worker:
    raise SystemExit("remember exact map call anchor not found")
worker = worker.replace(old, new, 1)
write(worker_path, worker)

cpp_path = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"
cpp = read(cpp_path)

old = '''\tbool calibrated = false;
\tint calibrationCooldown = 0;'''
new = '''\tbool calibrated = false;
\tbool exactSampleMap = false;
\tint calibrationCooldown = 0;'''
if old not in cpp:
    raise SystemExit("PersistentTrack calibration anchor not found")
cpp = cpp.replace(old, new, 1)

old = '''\t// At high optical density a v40 matrix can contain a few bad modules even
\t// when its geometry is perfectly usable. Do not run a detector, re-sample,
\t// or recalibrate for that. Apply QR's own error correction directly to the
\t// already-cached matrix, then require the AirGapper CRC as the final oracle.
\tif (!track.calibrated)
\t\treturn {};

\tconst double rsStarted = emscripten_get_now();
\tauto corrected = QRCode::Decode(track.sampled);
\tmeasured.rsFallbackMs += emscripten_get_now() - rsStarted;
\t++measured.rsFallbacks;
\tif (!corrected.isValid())
\t\treturn {};

\tauto packet = packetFromBytes(corrected.content().bytes);
\tif (!packet.empty())
\t\t++measured.alignmentFitSuccesses;
\treturn packet;'''
new = '''\t// AirGapper cached-Y misses are erasures. v0.5.96 accidentally ran QR
\t// Reed-Solomon here for every calibrated miss even while the caller's
\t// fallback budget was zero. Hybrid/exact-map recovery below owns any
\t// optional RS budget; this first stage never does.
\treturn {};'''
if old not in cpp:
    raise SystemExit("decodeCachedTrack RS block anchor not found")
cpp = cpp.replace(old, new, 1)

old = '''\ttrack.calibrated = true;
\ttrack.calibrationCooldown = 0;
\ttrack.consecutiveMisses = 0;
\treturn true;
}

static void addBatchMetrics'''
new = '''\ttrack.calibrated = true;
\ttrack.exactSampleMap = false;
\ttrack.calibrationCooldown = 0;
\ttrack.consecutiveMisses = 0;
\treturn true;
}

static void addBatchMetrics'''
if old not in cpp:
    raise SystemExit("calibrate exact flag anchor not found")
cpp = cpp.replace(old, new, 1)

old = '''static ByteArray decodeExactMapBits(PersistentTrack& track, const BitMatrix& imageBits, DecimenBatchMetrics& measured)'''
new = '''static ByteArray decodeExactMapBits(PersistentTrack& track, const BitMatrix& imageBits,
\t\t\t\t\t\t\t\t\t bool allowRS, DecimenBatchMetrics& measured)'''
if old not in cpp:
    raise SystemExit("decodeExactMapBits signature anchor not found")
cpp = cpp.replace(old, new, 1)

old = '''\tconst double rsStarted = emscripten_get_now();
\tauto corrected = QRCode::Decode(track.sampled);
\tmeasured.rsFallbackMs += emscripten_get_now() - rsStarted;
\t++measured.rsFallbacks;
\tif (!corrected.isValid())
\t\treturn {};
\tauto packet = packetFromBytes(corrected.content().bytes);
\tif (!packet.empty())
\t\t++measured.exactMapSuccesses;
\treturn packet;
}

static int decodeBatchExactMapBits'''
new = '''\tif (!allowRS)
\t\treturn {};

\tconst double rsStarted = emscripten_get_now();
\tauto corrected = QRCode::Decode(track.sampled);
\tmeasured.rsFallbackMs += emscripten_get_now() - rsStarted;
\t++measured.rsFallbacks;
\tif (!corrected.isValid())
\t\treturn {};
\tauto packet = packetFromBytes(corrected.content().bytes);
\tif (!packet.empty())
\t\t++measured.exactMapSuccesses;
\treturn packet;
}

static int decodeBatchExactMapBits'''
if old not in cpp:
    raise SystemExit("exact map RS block anchor not found")
cpp = cpp.replace(old, new, 1)

marker = "static int decodeBatchExactMapBits"
pos = cpp.find(marker)
if pos < 0:
    raise SystemExit("decodeBatchExactMapBits marker missing")
head, tail = cpp[:pos], cpp[pos:]

old = '''\tint resultCount = 0, outputUsed = 0;
\tfor (auto& track : decoder.tracks) {'''
new = '''\tint resultCount = 0, outputUsed = 0, budgetedFallbacks = 0;
\tfor (auto& track : decoder.tracks) {'''
if old not in tail:
    raise SystemExit("exact batch counters anchor not found")
tail = tail.replace(old, new, 1)

old = '''\t\tif (!track.calibrated || !track.crc32Payload) {'''
new = '''\t\tif (!track.exactSampleMap || !track.crc32Payload) {'''
if old not in tail:
    raise SystemExit("exact batch eligibility anchor not found")
tail = tail.replace(old, new, 1)

old = '''\t\tauto packet = decodeExactMapBits(track, imageBits, measured);'''
new = '''\t\tconst bool allowRS = budgetedFallbacks < decoder.maxRSFallbacks;
\t\tif (allowRS)
\t\t\t++budgetedFallbacks;
\t\tauto packet = decodeExactMapBits(track, imageBits, allowRS, measured);'''
if old not in tail:
    raise SystemExit("exact decode call anchor not found")
tail = tail.replace(old, new, 1)
cpp = head + tail

set_track_marker = 'EMSCRIPTEN_KEEPALIVE int setTrackedDecoderTrack'
pos = cpp.find(set_track_marker)
if pos < 0:
    raise SystemExit("setTrack marker missing")
head, tail = cpp[:pos], cpp[pos:]
old = '''\t\ttrack.calibrated = false;
\t\ttrack.calibrationCooldown = 0;'''
new = '''\t\ttrack.calibrated = false;
\t\ttrack.exactSampleMap = false;
\t\ttrack.calibrationCooldown = 0;'''
if old not in tail:
    raise SystemExit("setTrack calibration reset anchor not found")
tail = tail.replace(old, new, 1)
cpp = head + tail

old = '''\ttrack.multiSample = false;
\ttrack.calibrated = true;
\ttrack.calibrationCooldown = 0;'''
new = '''\ttrack.multiSample = false;
\ttrack.calibrated = true;
\ttrack.exactSampleMap = true;
\ttrack.calibrationCooldown = 0;'''
if old not in cpp:
    raise SystemExit("setSampleMap exact flag anchor not found")
cpp = cpp.replace(old, new, 1)

old = '''\t\tbool haveExactMaps = false;
\t\tfor (const auto& track : decoder->tracks)
\t\t\thaveExactMaps = haveExactMaps || (track.active && track.calibrated);'''
new = '''\t\tbool haveExactMaps = false;
\t\tfor (const auto& track : decoder->tracks)
\t\t\thaveExactMaps = haveExactMaps || (track.active && track.exactSampleMap);'''
if old not in cpp:
    raise SystemExit("haveExactMaps anchor not found")
cpp = cpp.replace(old, new, 1)

old = '''\t\t\tif (!track.calibrated && track.calibrationCooldown == 0)
\t\t\t\tcalibrationDue = true;'''
new = '''\t\t\tif (!track.crc32Payload && !track.calibrated && track.calibrationCooldown == 0)
\t\t\t\tcalibrationDue = true;'''
if old not in cpp:
    raise SystemExit("calibrationDue anchor not found")
cpp = cpp.replace(old, new, 1)

write(cpp_path, cpp)
print("patched v0.5.97: motion-warped exact maps + erasure-only native misses")
