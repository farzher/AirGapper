from pathlib import Path

p = Path("receive/main.js")
s = p.read_text()

old = '''let activeBenchmarkFrame;
let benchmarkCorpus;
let benchmarkPendingBlob;'''
new = '''let activeBenchmarkFrame;
let benchmarkCorpus;
// Fast regression can optionally supply tightly packed I420 frames so replay
// enters the same VideoFrame -> Y8 receiver path as a TrackProcessor camera.
// Normal recorded .agcap replay remains lossless RGBA and is unchanged.
let fastRegressionCameraFrames;
let benchmarkPendingBlob;'''
if old not in s:
    raise SystemExit("benchmark globals target not found")
s = s.replace(old, new, 1)

old = '''      captureFrame({
        sequence: frame.meta.sequence,
        width: frame.meta.width,
        height: frame.meta.height,
        callbackTimeMs: frame.meta.callbackTimeMs,
        mediaTimeMs: frame.meta.mediaTimeMs,
        presentationTimeMs: frame.meta.presentationTimeMs,
        expectedDisplayTimeMs: frame.meta.expectedDisplayTimeMs,
        image: new ImageData(new Uint8ClampedArray(frame.rgba), frame.meta.width, frame.meta.height)
      });'''
new = '''      const cameraPixels = fastRegressionCameraFrames?.[index];
      let cameraFrame;
      if (cameraPixels) {
        if (frame.meta.width & 1 || frame.meta.height & 1)
          throw new Error("I420 fast regression requires even frame dimensions");
        cameraFrame = new VideoFrame(cameraPixels, {
          format: "I420",
          codedWidth: frame.meta.width,
          codedHeight: frame.meta.height,
          timestamp: Math.max(0, Math.round(frame.meta.callbackTimeMs * 1000))
        });
      }
      try {
        captureFrame({
          sequence: frame.meta.sequence,
          width: frame.meta.width,
          height: frame.meta.height,
          callbackTimeMs: frame.meta.callbackTimeMs,
          mediaTimeMs: frame.meta.mediaTimeMs,
          presentationTimeMs: frame.meta.presentationTimeMs,
          expectedDisplayTimeMs: frame.meta.expectedDisplayTimeMs,
          ...(cameraFrame
            ? { videoFrame: cameraFrame }
            : { image: new ImageData(new Uint8ClampedArray(frame.rgba), frame.meta.width, frame.meta.height) })
        });
      } finally {
        cameraFrame?.close();
      }'''
if old not in s:
    raise SystemExit("production replay capture target not found")
s = s.replace(old, new, 1)

old = '''  const guidedKinds = Object.entries(result?.performance?.byKind ?? {})
    .filter(([kind]) => kind.includes("GUIDED") || kind.includes("TRACKED"));
  const guidedJobs = guidedKinds.reduce((sum, [, value]) => sum + (value.jobs ?? 0), 0);
  const guidedTracks = guidedKinds.reduce((sum, [, value]) => sum + (value.tracks ?? 0), 0);
  const guidedOutputs = guidedKinds.reduce((sum, [, value]) => sum + (value.outputSymbols ?? 0), 0);'''
new = '''  const guidedMetrics = jobs.flatMap((job) => job.guidedMetrics ? [job.guidedMetrics] : []);
  const guidedJobs = guidedMetrics.length;
  const sumGuided = (key) => guidedMetrics.reduce((sum, metrics) => sum + (Number(metrics[key]) || 0), 0);
  const guidedTracks = sumGuided("tracks");
  const guidedOutputs = sumGuided("successful");
  const guided = {
    jobs: guidedJobs,
    tracks: guidedTracks,
    outputs: guidedOutputs,
    turboAttempts: sumGuided("turboAttempts"),
    turboSuccesses: sumGuided("turboSuccesses"),
    stableEligibleTracks: sumGuided("stableEligibleTracks"),
    stableRsAttempts: sumGuided("stableRsAttempts"),
    stableRsSuccesses: sumGuided("stableRsSuccesses"),
    sparseAttempts: sumGuided("fastDecodeAttempts"),
    sparseSuccesses: sumGuided("fastDecodeSuccesses"),
    genericFallbackTracks: sumGuided("genericFallbackTracks"),
    genericFallbackSuccesses: sumGuided("genericFallbackSuccesses"),
    genericDecodeAttempts: sumGuided("genericDecodeAttempts"),
    binarizeMs: sumGuided("binarizeMs"),
    finderMs: sumGuided("finderMs"),
    sampleMs: sumGuided("sampleMs"),
    decodeMs: sumGuided("decodeMs"),
    totalMs: sumGuided("totalMs")
  };'''
if old not in s:
    raise SystemExit("fast result guided target not found")
s = s.replace(old, new, 1)

old = '''    guidedJobs,
    guidedTracks,
    guidedOutputs,
    tailFullJobs,'''
new = '''    guidedJobs,
    guidedTracks,
    guidedOutputs,
    guided,
    tailFullJobs,'''
if old not in s:
    raise SystemExit("fast result object target not found")
s = s.replace(old, new, 1)

old = '''window.__airgapperRunFastRegression = async ({ urls, order, repeats = 1, fps = 30, mode = "performance" }) => {'''
new = '''function fastRegressionI420(image) {
  const width = image.width;
  const height = image.height;
  if (width & 1 || height & 1) throw new Error("I420 fast regression requires even image dimensions");
  const yBytes = width * height;
  const uvBytes = (width >> 1) * (height >> 1);
  const out = new Uint8Array(yBytes + uvBytes * 2);
  const rgba = image.data;
  // Integer BT.601-ish luminance. The fixture is an emissive black/white QR
  // wall, but using real RGB weights keeps this transport valid for future
  // colored/photographic regression frames too.
  for (let pixel = 0, src = 0; pixel < yBytes; pixel++, src += 4)
    out[pixel] = (77 * rgba[src] + 150 * rgba[src + 1] + 29 * rgba[src + 2] + 128) >> 8;
  out.fill(128, yBytes); // neutral chroma; the receiver consumes plane 0 only
  return out;
}
window.__airgapperRunFastRegression = async ({ urls, order, repeats = 1, fps = 30, mode = "performance", cameraPath = false }) => {'''
if old not in s:
    raise SystemExit("fast regression signature target not found")
s = s.replace(old, new, 1)

old = '''  benchmarkCorpus = AgcapCorpus.fromRecords({
    format: "AirGapper fast production regression corpus",'''
new = '''  fastRegressionCameraFrames = cameraPath
    ? (() => {
        const i420 = images.map(fastRegressionI420);
        return frameOrder.map((index) => i420[index]);
      })()
    : void 0;
  benchmarkCorpus = AgcapCorpus.fromRecords({
    format: "AirGapper fast production regression corpus",'''
if old not in s:
    raise SystemExit("fast corpus target not found")
s = s.replace(old, new, 1)

old = '''  await runReceiverBenchmark({ productionOnly: true });
  if (!benchmarkResult) throw new Error(benchmarkStatus.textContent || "Fast regression failed to produce a result");
  const summary = fastRegressionResult(benchmarkResult, records.length);'''
new = '''  try {
    await runReceiverBenchmark({ productionOnly: true });
  } finally {
    fastRegressionCameraFrames = void 0;
  }
  if (!benchmarkResult) throw new Error(benchmarkStatus.textContent || "Fast regression failed to produce a result");
  const summary = fastRegressionResult(benchmarkResult, records.length);'''
if old not in s:
    raise SystemExit("fast run cleanup target not found")
s = s.replace(old, new, 1)

p.write_text(s)
