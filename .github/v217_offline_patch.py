from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:220]!r}")
    p.write_text(s.replace(old, new, count))


replace("index.html", "v0.5.216", "v0.5.217")
replace("main.js", 'const APP_BUILD = "v0.5.216";', 'const APP_BUILD = "v0.5.217";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.216";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.217";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v178";', 'const CACHE = "airgapper-static-js-v179";')

# Keep the existing interactive benchmark unchanged by default, but allow CI and
# optimization work to replay only the production receiver. This deliberately
# skips the expensive full-frame reference/oracle passes.
replace(
    "receive/main.js",
    "async function runReceiverBenchmark() {",
    "async function runReceiverBenchmark({ productionOnly = false } = {}) {"
)

oracle_block = '''    const savedReference = window.__airgapperBenchmarkReference;\n    const savedCorpus = savedReference == null ? void 0 : savedReference.corpus;\n    const savedFrames = savedReference == null ? void 0 : savedReference.frames;\n    let oracleLatencies = [];\n    if ((savedCorpus == null ? void 0 : savedCorpus.width) === corpus.header.width && savedCorpus.height === corpus.header.height && savedCorpus.startedAt === corpus.header.startedAt && savedCorpus.framesStored === corpus.header.framesStored && (savedFrames == null ? void 0 : savedFrames.length) === benchmarkTraces.length && savedFrames.every((item, index) => item.sequence === benchmarkTraces[index].sequence)) {\n      for (let index = 0; index < benchmarkTraces.length; index++) {\n        benchmarkTraces[index].reference = savedFrames[index].reference;\n      }\n      benchmarkStatus.textContent = "Reference map reused";\n    } else {\n      oracleLatencies = await runOracle(corpus);\n    }\n    for (const trace of benchmarkTraces) {\n      const known = new Set(trace.reference.map((item) => item.esi));\n      for (const packet of trace.decoded) {\n        if (known.has(packet.esi)) continue;\n        known.add(packet.esi);\n        trace.reference.push({ slot: packet.slot, esi: packet.esi, quad: packet.quad });\n      }\n    }\n'''
production_or_oracle = '''    let oracleLatencies = [];\n    if (productionOnly) {\n      benchmarkStatus.textContent = "Production replay complete";\n    } else {\n      const savedReference = window.__airgapperBenchmarkReference;\n      const savedCorpus = savedReference == null ? void 0 : savedReference.corpus;\n      const savedFrames = savedReference == null ? void 0 : savedReference.frames;\n      if ((savedCorpus == null ? void 0 : savedCorpus.width) === corpus.header.width && savedCorpus.height === corpus.header.height && savedCorpus.startedAt === corpus.header.startedAt && savedCorpus.framesStored === corpus.header.framesStored && (savedFrames == null ? void 0 : savedFrames.length) === benchmarkTraces.length && savedFrames.every((item, index) => item.sequence === benchmarkTraces[index].sequence)) {\n        for (let index = 0; index < benchmarkTraces.length; index++) {\n          benchmarkTraces[index].reference = savedFrames[index].reference;\n        }\n        benchmarkStatus.textContent = "Reference map reused";\n      } else {\n        oracleLatencies = await runOracle(corpus);\n      }\n      for (const trace of benchmarkTraces) {\n        const known = new Set(trace.reference.map((item) => item.esi));\n        for (const packet of trace.decoded) {\n          if (known.has(packet.esi)) continue;\n          known.add(packet.esi);\n          trace.reference.push({ slot: packet.slot, esi: packet.esi, quad: packet.quad });\n        }\n      }\n    }\n'''
replace("receive/main.js", oracle_block, production_or_oracle)

replace(
    "receive/main.js",
    '''    const extraPackets = benchmarkTraces.flatMap((trace) => {\n      const reference = new Set(trace.reference.map((item) => item.esi));\n      return trace.decoded.filter((item) => !reference.has(item.esi));\n    });''',
    '''    const extraPackets = productionOnly ? [] : benchmarkTraces.flatMap((trace) => {\n      const reference = new Set(trace.reference.map((item) => item.esi));\n      return trace.decoded.filter((item) => !reference.has(item.esi));\n    });'''
)
replace(
    "receive/main.js",
    'oracleP50Ms: percentile(oracleLatencies, 0.5),',
    'oracleP50Ms: productionOnly ? null : percentile(oracleLatencies, 0.5),'
)
replace(
    "receive/main.js",
    'format: "AirGapper receiver benchmark",',
    'format: productionOnly ? "AirGapper fast production regression" : "AirGapper receiver benchmark",\n      productionOnly,'
)

p = Path("receive/main.js")
s = p.read_text()
anchor = '''function updateStats(forceDiagnostics = false) {'''
if anchor not in s:
    raise SystemExit("updateStats anchor missing")
insert = r'''
async function fastRegressionImage(url) {
  const response = await fetch(url);
  if (!response.ok && !url.startsWith("data:")) throw new Error(`Benchmark image failed: ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, canvas.width, canvas.height);
  } finally {
    bitmap.close();
  }
}
function fastRegressionResult(result, expectedFrames) {
  const frames = result?.frames ?? [];
  const jobs = frames.flatMap((frame) => frame.jobs ?? []);
  const decoded = frames.flatMap((frame) => frame.decoded ?? []);
  const unique = new Set(decoded.map((packet) => packet.esi));
  const guidedKinds = Object.entries(result?.performance?.byKind ?? {})
    .filter(([kind]) => kind.includes("GUIDED") || kind.includes("TRACKED"));
  const guidedJobs = guidedKinds.reduce((sum, [, value]) => sum + (value.jobs ?? 0), 0);
  const guidedTracks = guidedKinds.reduce((sum, [, value]) => sum + (value.tracks ?? 0), 0);
  const guidedOutputs = guidedKinds.reduce((sum, [, value]) => sum + (value.outputSymbols ?? 0), 0);
  const fullJobs = jobs.filter((job) => job.full).length;
  const trackedJobs = jobs.length - fullJobs;
  const decodeErrors = jobs.filter((job) => job.error).map((job) => String(job.error));
  const resultObject = {
    version: result?.version,
    productionOnly: result?.productionOnly === true,
    frames: frames.length,
    expectedFrames,
    decodedPackets: decoded.length,
    uniqueSymbols: unique.size,
    qrPerSecond: result?.throughput?.qrPerSecond ?? 0,
    uniqueUsefulQrPerSecond: result?.throughput?.uniqueUsefulQrPerSecond ?? 0,
    verifiedKBPerSecond: result?.throughput?.verifiedKBPerSecond ?? 0,
    firstProductionFrame: result?.acquisition?.firstProductionFrame,
    firstGridLockFrame: result?.acquisition?.firstGridLockFrame,
    transitions: result?.transitions?.length ?? 0,
    jobs: jobs.length,
    fullJobs,
    trackedJobs,
    guidedJobs,
    guidedTracks,
    guidedOutputs,
    decodeP50Ms: result?.performance?.decodeP50Ms ?? 0,
    decodeP95Ms: result?.performance?.decodeP95Ms ?? 0,
    workerBusyPercent: result?.performance?.workerBusyPercent ?? 0,
    hotPath: result?.hotPath,
    byKind: result?.performance?.byKind ?? {},
    decodeErrors
  };
  resultObject.checks = {
    productionOnly: resultObject.productionOnly,
    allFramesReplayed: resultObject.frames === expectedFrames,
    decodedSomething: resultObject.decodedPackets > 0,
    discoveredLayout: resultObject.firstProductionFrame !== null && resultObject.firstProductionFrame !== void 0,
    scheduledWork: resultObject.jobs > 0,
    noDecodeErrors: resultObject.decodeErrors.length === 0,
    oracleSkipped: result?.performance?.oracleP50Ms === null
  };
  resultObject.ok = Object.values(resultObject.checks).every(Boolean);
  return resultObject;
}
window.__airgapperRunFastRegression = async ({ urls, order, repeats = 1, fps = 30, mode = "performance" }) => {
  if (!Array.isArray(urls) || !urls.length) throw new Error("Fast regression needs images");
  const images = [];
  for (const url of urls) images.push(await fastRegressionImage(url));
  const width = images[0].width;
  const height = images[0].height;
  if (images.some((image) => image.width !== width || image.height !== height))
    throw new Error("Fast regression images must have matching dimensions");
  let frameOrder;
  if (Array.isArray(order) && order.length) {
    frameOrder = order.map((index) => {
      if (!Number.isInteger(index) || index < 0 || index >= images.length) throw new Error(`Invalid fast regression frame index ${index}`);
      return index;
    });
  } else {
    frameOrder = [];
    for (let repeat = 0; repeat < Math.max(1, repeats); repeat++)
      for (let index = 0; index < images.length; index++) frameOrder.push(index);
  }
  const frameMs = 1000 / Math.max(1, fps);
  const records = [];
  for (let sequence = 0; sequence < frameOrder.length; sequence++) {
    const image = images[frameOrder[sequence]];
    const at = sequence * frameMs;
    records.push({
      meta: {
        sequence,
        width,
        height,
        stride: width * 4,
        callbackTimeMs: at,
        mediaTimeMs: at,
        presentationTimeMs: at,
        expectedDisplayTimeMs: at
      },
      pixels: new Uint8ClampedArray(image.data)
    });
  }
  benchmarkCorpus = AgcapCorpus.fromRecords({
    format: "AirGapper fast production regression corpus",
    formatVersion: 4,
    pixelFormat: "RGBA8888",
    compression: "raw",
    width,
    height,
    stride: width * 4,
    framesStored: records.length,
    recorderDrops: 0,
    estimatedCameraDrops: 0,
    cameraSettings: { width, height, frameRate: fps },
    startedAt: `fast-${width}x${height}-${images.length}-${records.length}`
  }, records);
  benchmarkPendingBlob = void 0;
  replayMode.value = mode;
  await runReceiverBenchmark({ productionOnly: true });
  if (!benchmarkResult) throw new Error(benchmarkStatus.textContent || "Fast regression failed to produce a result");
  const summary = fastRegressionResult(benchmarkResult, records.length);
  if (!summary.ok) {
    const failed = Object.entries(summary.checks).filter(([, ok]) => !ok).map(([name]) => name).join(", ");
    throw new Error(`Fast regression invariant failed: ${failed} · ${JSON.stringify(summary)}`);
  }
  return summary;
};

'''
s = s.replace(anchor, insert + anchor, 1)
p.write_text(s)
