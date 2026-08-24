const OPTIMIZER_TRACE_LIMIT = 200;
const optimizerTrace = [];

export function noteOptimizerTrace(event) {
  optimizerTrace.push(event);
  if (optimizerTrace.length > OPTIMIZER_TRACE_LIMIT) optimizerTrace.splice(0, optimizerTrace.length - OPTIMIZER_TRACE_LIMIT);
}

export function resetOptimizerTrace() {
  optimizerTrace.length = 0;
}

export function optimizerTraceText() {
  if (!optimizerTrace.length) return "";
  return `Optimizer trace\n${optimizerTrace.slice(-20).map((event) =>
    `${event.time.toFixed(0)} ${event.event} ${event.candidateId ?? "—"} ep${event.candidateEpoch ?? "—"} src${event.sourceSequence ?? "—"} scan${event.scanId ?? "—"} E${event.actualExposure ?? event.requestedExposure ?? "—"} ISO${event.actualIso ?? event.requestedIso ?? "—"} valid:${event.validDecode === undefined ? "—" : event.validDecode ? "yes" : "no"} useful:${event.usefulSymbol === undefined ? "—" : event.usefulSymbol ? "yes" : "no"}`
  ).join("\n")}`;
}

const CORPUS_DEVICE_NAMES = {
  "0dc8b7d5f6e84e81cf126349d821a9d948a6db87ea4a810c04a51aec6999401c": "OP5",
  "5e792630f18c1d6bc5fc26e8ce6d90a27163fd50f32c7631256aa9e7bc7b193e": "OP12R"
};

function legacyClipboardCopy(text) {
  try {
    const input = document.createElement("textarea");
    input.value = text;
    input.readOnly = true;
    input.style.position = "fixed";
    input.style.opacity = "0";
    input.style.pointerEvents = "none";
    document.body.append(input);
    input.select();
    input.setSelectionRange(0, input.value.length);
    const copied = document.execCommand("copy");
    input.remove();
    return copied;
  } catch {
    return false;
  }
}

export async function copyDiagnostics(button, text, automatic = false, copyPlatform) {
  if (!text) return false;
  try {
    if (!copyPlatform(text)) {
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
        await navigator.clipboard.writeText(text);
      } catch (error) {
        if (!legacyClipboardCopy(text)) throw error;
      }
    }
    button.textContent = automatic ? "Diagnostics copied" : "Copied";
    setTimeout(() => { button.textContent = "Copy diagnostics"; }, 1500);
    return true;
  } catch {
    if (!automatic) {
      button.textContent = "Copy failed";
      setTimeout(() => { button.textContent = "Copy diagnostics"; }, 1500);
    }
    return false;
  }
}

export function compactDeviceName(header) {
  const id = String(header.cameraSettings.deviceId ?? "");
  return CORPUS_DEVICE_NAMES[id] ?? `D${id.slice(0, 4) || "unk"}`;
}

export function compactVersionName(version) {
  return version.replace(/^v?0\./, "v").replace(/^([^v])/, "v$1");
}

export function compactTimeName(value) {
  const date = value instanceof Date ? value : new Date(value);
  const two = (number) => String(number).padStart(2, "0");
  return `${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}-${two(date.getUTCHours())}${two(date.getUTCMinutes())}`;
}

async function regressionImage(url) {
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

function regressionI420(image) {
  const { width, height, data } = image;
  if (width & 1 || height & 1) throw new Error("I420 fast regression requires even image dimensions");
  const yBytes = width * height;
  const uvBytes = (width >> 1) * (height >> 1);
  const out = new Uint8Array(yBytes + uvBytes * 2);
  for (let pixel = 0, src = 0; pixel < yBytes; pixel++, src += 4) {
    out[pixel] = (77 * data[src] + 150 * data[src + 1] + 29 * data[src + 2] + 128) >> 8;
  }
  out.fill(128, yBytes);
  return out;
}

function regressionSummary(result, expectedFrames) {
  const frames = result?.frames ?? [];
  const jobs = frames.flatMap((frame) => frame.jobs ?? []);
  const decoded = frames.flatMap((frame) => frame.decoded ?? []);
  const unique = new Set(decoded.map((packet) => packet.esi));
  const slotCounts = {};
  for (const packet of decoded) {
    const slot = Number(packet.slot);
    if (Number.isInteger(slot) && slot >= 0) slotCounts[slot] = (slotCounts[slot] ?? 0) + 1;
  }
  const guidedMetrics = jobs.flatMap((job) => job.guidedMetrics ? [job.guidedMetrics] : []);
  const sumGuided = (key) => guidedMetrics.reduce((sum, metrics) => sum + (Number(metrics[key]) || 0), 0);
  const guidedTracks = sumGuided("tracks");
  const moduleWeighted = guidedMetrics.reduce((sum, metrics) => sum + (Number(metrics.moduleSizeAvg) || 0) * (Number(metrics.tracks) || 0), 0);
  const moduleMins = guidedMetrics.map((metrics) => Number(metrics.moduleSizeMin) || 0).filter((value) => value > 0);
  const moduleMaxes = guidedMetrics.map((metrics) => Number(metrics.moduleSizeMax) || 0).filter((value) => value > 0);
  const guided = {
    jobs: guidedMetrics.length,
    moduleSizeAvg: guidedTracks ? moduleWeighted / guidedTracks : 0,
    moduleSizeMin: moduleMins.length ? Math.min(...moduleMins) : 0,
    moduleSizeMax: moduleMaxes.length ? Math.max(...moduleMaxes) : 0,
    tracks: guidedTracks,
    outputs: sumGuided("successful"),
    turboAttempts: sumGuided("turboAttempts"),
    turboSuccesses: sumGuided("turboSuccesses"),
    stableEligibleTracks: sumGuided("stableEligibleTracks"),
    stableRsAttempts: sumGuided("stableRsAttempts"),
    stableRsSuccesses: sumGuided("stableRsSuccesses"),
    sparseProfileAttempts: sumGuided("sparseProfileAttempts"),
    sparseProfileSuccesses: sumGuided("sparseProfileSuccesses"),
    dataOnlyAttempts: sumGuided("sparseNoRsAttempts"),
    dataOnlySuccesses: sumGuided("sparseNoRsSuccesses"),
    rsFallbacks: sumGuided("sparseRsFallbacks"),
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
  };
  const fullJobs = jobs.filter((job) => job.full).length;
  const lockedStates = new Set(["GRID_LOCK", "TRACK", "PARTIAL_LOSS"]);
  const firstLockedStateFrame = frames.findIndex((frame) => lockedStates.has(frame.stateBefore));
  const stateCounts = {};
  for (const frame of frames) {
    const state = frame.stateBefore ?? "unknown";
    stateCounts[state] = (stateCounts[state] ?? 0) + 1;
  }
  const tailJobs = frames.slice(Math.floor(frames.length / 2)).flatMap((frame) => frame.jobs ?? []);
  const tailFullJobs = tailJobs.filter((job) => job.full).length;
  const summary = {
    version: result?.version,
    productionOnly: result?.productionOnly === true,
    frames: frames.length,
    expectedFrames,
    decodedPackets: decoded.length,
    uniqueSymbols: unique.size,
    decodedSlots: Object.keys(slotCounts).map(Number).sort((a, b) => a - b),
    slotCounts,
    qrPerSecond: result?.throughput?.qrPerSecond ?? 0,
    uniqueUsefulQrPerSecond: result?.throughput?.uniqueUsefulQrPerSecond ?? 0,
    verifiedKBPerSecond: result?.throughput?.verifiedKBPerSecond ?? 0,
    firstProductionFrame: result?.acquisition?.firstProductionFrame,
    lockTriggerSourceFrame: result?.acquisition?.firstGridLockFrame,
    firstGridLockFrame: firstLockedStateFrame >= 0 ? (frames[firstLockedStateFrame]?.sequence ?? firstLockedStateFrame) : null,
    firstLockedStateFrame: firstLockedStateFrame >= 0 ? (frames[firstLockedStateFrame]?.sequence ?? firstLockedStateFrame) : null,
    stateCounts,
    finalState: frames.at(-1)?.stateAfter ?? frames.at(-1)?.stateBefore ?? null,
    transitions: result?.transitions?.length ?? 0,
    jobs: jobs.length,
    fullJobs,
    trackedJobs: jobs.length - fullJobs,
    guidedJobs: guided.jobs,
    guidedTracks: guided.tracks,
    guidedOutputs: guided.outputs,
    guided,
    tailFullJobs,
    tailTrackedJobs: tailJobs.length - tailFullJobs,
    decodeP50Ms: result?.performance?.decodeP50Ms ?? 0,
    decodeP95Ms: result?.performance?.decodeP95Ms ?? 0,
    workerBusyPercent: result?.performance?.workerBusyPercent ?? 0,
    hotPath: result?.hotPath,
    byKind: result?.performance?.byKind ?? {},
    decodeErrors: jobs.filter((job) => job.error).map((job) => String(job.error))
  };
  summary.checks = {
    productionOnly: summary.productionOnly,
    allFramesReplayed: summary.frames === expectedFrames,
    decodedSomething: summary.decodedPackets > 0,
    discoveredLayout: summary.firstProductionFrame !== null && summary.firstProductionFrame !== undefined,
    scheduledWork: summary.jobs > 0,
    noDecodeErrors: summary.decodeErrors.length === 0,
    oracleSkipped: result?.performance?.oracleP50Ms === null
  };
  summary.ok = Object.values(summary.checks).every(Boolean);
  return summary;
}

export async function runFastRegression({ urls, order, repeats = 1, fps = 30, mode = "performance", cameraPath = false }, replay) {
  if (!Array.isArray(urls) || !urls.length) throw new Error("Fast regression needs images");
  const { AgcapCorpus } = await replay.loadAgcap();
  const images = [];
  for (const url of urls) images.push(await regressionImage(url));
  const { width, height } = images[0];
  if (images.some((image) => image.width !== width || image.height !== height)) {
    throw new Error("Fast regression images must have matching dimensions");
  }
  let frameOrder;
  if (Array.isArray(order) && order.length) {
    frameOrder = order.map((index) => {
      if (!Number.isInteger(index) || index < 0 || index >= images.length) throw new Error(`Invalid fast regression frame index ${index}`);
      return index;
    });
  } else {
    frameOrder = [];
    for (let repeat = 0; repeat < Math.max(1, repeats); repeat++) {
      for (let index = 0; index < images.length; index++) frameOrder.push(index);
    }
  }
  const frameMs = 1000 / Math.max(1, fps);
  const records = frameOrder.map((imageIndex, sequence) => {
    const image = images[imageIndex];
    const at = sequence * frameMs;
    return {
      meta: {
        sequence, width, height, stride: width * 4,
        callbackTimeMs: at, mediaTimeMs: at,
        presentationTimeMs: at, expectedDisplayTimeMs: at
      },
      pixels: new Uint8ClampedArray(image.data)
    };
  });
  const cameraFrames = cameraPath
    ? (() => {
        const i420 = images.map(regressionI420);
        return frameOrder.map((index) => i420[index]);
      })()
    : undefined;
  const corpus = AgcapCorpus.fromRecords({
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
  const result = await replay.run({ corpus, cameraFrames, mode });
  const summary = regressionSummary(result, records.length);
  if (!summary.ok) {
    const failed = Object.entries(summary.checks).filter(([, ok]) => !ok).map(([name]) => name).join(", ");
    throw new Error(`Fast regression invariant failed: ${failed} · ${JSON.stringify(summary)}`);
  }
  return summary;
}
