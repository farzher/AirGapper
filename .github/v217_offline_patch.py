from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:180]!r}")
    p.write_text(s.replace(old, new, count))


replace("index.html", "v0.5.216", "v0.5.217")
replace("main.js", 'const APP_BUILD = "v0.5.216";', 'const APP_BUILD = "v0.5.217";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.216";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.217";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v178";', 'const CACHE = "airgapper-static-js-v179";')

p = Path("receive/main.js")
s = p.read_text()
anchor = '''function updateStats(forceDiagnostics = false) {'''
if anchor not in s:
    raise SystemExit("updateStats anchor missing")
insert = r'''
async function offlineBenchmarkImage(url) {
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
function offlineBenchmarkResult(result) {
  const reasons = {};
  for (const failure of result?.failures ?? []) reasons[failure.reason] = (reasons[failure.reason] ?? 0) + 1;
  const guided = result?.performance?.byKind?.["Y8 GUIDED TRACKED"] ?? result?.performance?.byKind?.["GUIDED TRACKED"];
  return {
    version: result?.version,
    acquisition: result?.acquisition,
    recovery: result?.recovery,
    throughput: result?.throughput,
    performance: {
      frameDropPercent: result?.performance?.frameDropPercent,
      workerBusyPercent: result?.performance?.workerBusyPercent,
      decodeP50Ms: result?.performance?.decodeP50Ms,
      decodeP95Ms: result?.performance?.decodeP95Ms,
      uniqueUsefulQrPerCpuSecond: result?.performance?.uniqueUsefulQrPerCpuSecond,
      uniqueUsefulBytesPerCpuSecond: result?.performance?.uniqueUsefulBytesPerCpuSecond,
      processedPixelsPerSecond: result?.performance?.processedPixelsPerSecond,
      byKind: result?.performance?.byKind,
      guided
    },
    hotPath: result?.hotPath,
    failureCount: result?.failures?.length ?? 0,
    failureReasons: reasons,
    transitions: result?.transitions?.length ?? 0
  };
}
window.__airgapperRunOfflineImages = async ({ urls, repeats = 1, fps = 30, mode = "performance" }) => {
  if (!Array.isArray(urls) || !urls.length) throw new Error("Offline benchmark needs images");
  const images = [];
  for (const url of urls) images.push(await offlineBenchmarkImage(url));
  const width = images[0].width;
  const height = images[0].height;
  if (images.some((image) => image.width !== width || image.height !== height))
    throw new Error("Offline benchmark images must have matching dimensions");
  const frameMs = 1000 / Math.max(1, fps);
  const records = [];
  let sequence = 0;
  for (let repeat = 0; repeat < Math.max(1, repeats); repeat++) {
    for (const image of images) {
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
      sequence++;
    }
  }
  benchmarkCorpus = AgcapCorpus.fromRecords({
    format: "AirGapper offline image corpus",
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
    startedAt: `offline-${width}x${height}-${images.length}-${records.length}`
  }, records);
  benchmarkPendingBlob = void 0;
  replayMode.value = mode;
  await runReceiverBenchmark();
  if (!benchmarkResult) throw new Error(benchmarkStatus.textContent || "Offline benchmark failed");
  return offlineBenchmarkResult(benchmarkResult);
};

'''
s = s.replace(anchor, insert + anchor, 1)
p.write_text(s)
