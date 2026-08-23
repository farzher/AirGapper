function quantile(values, q) {
  if (!values?.length) return 0;
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * q));
  const low = Math.floor(index), high = Math.ceil(index), mix = index - low;
  return sorted[low] * (1 - mix) + sorted[high] * mix;
}
function median(values) { return quantile(values, 0.5); }
function sum(values) { return values.reduce((total, value) => total + (Number(value) || 0), 0); }
function boundaryFailureLanes(runs = []) {
  let total = 0;
  for (let i = 1; i + 1 < runs.length; i++) {
    const run = runs[i], before = runs[i - 1], after = runs[i + 1];
    if (run.reason && before.sequence !== undefined && after.sequence !== undefined && before.sequence !== after.sequence)
      total += run.count;
  }
  return total;
}
function successfulRunLengths(runs = []) {
  return runs.filter(run => run.sequence !== undefined && run.count >= 2).map(run => run.count);
}
function airGridNativeMetadata(packet, extras = {}) {
  return {
    captureTimestampMs: Number(packet?.timestampNs) > 0 ? Number(packet.timestampNs) / 1e6 : extras.captureTimestampMs,
    exposureUs: Number(packet?.exposureTimeNs) > 0 ? Number(packet.exposureTimeNs) / 1e3 : extras.exposureUs,
    frameDurationUs: Number(packet?.frameDurationNs) > 0 ? Number(packet.frameDurationNs) / 1e3 : extras.frameDurationUs,
    sensorReadoutUs: Number(packet?.rollingShutterSkewNs) > 0 ? Number(packet.rollingShutterSkewNs) / 1e3 : extras.sensorReadoutUs,
    iso: Number(packet?.iso) > 0 ? Number(packet.iso) : extras.iso,
    copyMs: Number(extras.copyMs) || 0,
    queueMs: Number(extras.queueMs) || 0,
    senderHz: Number(extras.senderHz) || 0
  };
}
function inferBottleneck(snapshot) {
  if (snapshot.cpu.frameBudgetUsedP95 > 0.8) return 'cpu';
  if (snapshot.channel.separationP10 < 24 || snapshot.channel.snrP10 < 4) return 'optics';
  if (snapshot.rollingShutter.boundaryLossRate > 0.05) return 'exposure/rolling-shutter';
  if (snapshot.capture.expectedFps && snapshot.capture.fps < snapshot.capture.expectedFps * 0.85) return 'camera-capture';
  if (snapshot.goodput.targetRatio >= 1) return 'target-cleared';
  if (snapshot.goodput.baselineRatio >= 1) return 'qr-baseline-cleared';
  if (snapshot.channel.validLaneRate > 0.9) return 'spatial-density';
  return 'undetermined';
}
class AirGridDiagnostics {
  constructor({ windowFrames = 120, baselineBytesPerSecond = 2_000_000, targetBytesPerSecond = 2_500_000 } = {}) {
    this.windowFrames = Math.max(8, windowFrames | 0);
    this.baselineBytesPerSecond = Math.max(1, Number(baselineBytesPerSecond) || 2_000_000);
    this.targetBytesPerSecond = Math.max(this.baselineBytesPerSecond, Number(targetBytesPerSecond) || 2_500_000);
    this.frames = [];
  }
  clear() { this.frames.length = 0; }
  observe({ diagnostics, captureTimestampMs, copyMs = 0, queueMs = 0, exposureUs, iso, frameDurationUs, sensorReadoutUs, senderHz } = {}) {
    if (!diagnostics) return this.snapshot();
    const timestampMs = Number.isFinite(captureTimestampMs) ? captureTimestampMs : (globalThis.performance?.now?.() ?? Date.now());
    this.frames.push({
      diagnostics,
      timestampMs,
      copyMs: Number(copyMs) || 0,
      queueMs: Number(queueMs) || 0,
      exposureUs: Number(exposureUs),
      iso: Number(iso),
      frameDurationUs: Number(frameDurationUs),
      sensorReadoutUs: Number(sensorReadoutUs),
      senderHz: Number(senderHz)
    });
    if (this.frames.length > this.windowFrames) this.frames.splice(0, this.frames.length - this.windowFrames);
    return this.snapshot();
  }
  observeNative(packet, diagnostics, extras = {}) {
    return this.observe({ diagnostics, ...airGridNativeMetadata(packet, extras) });
  }
  snapshot() {
    const frames = this.frames;
    const n = frames.length;
    const intervals = [];
    for (let i = 1; i < n; i++) {
      const dt = frames[i].timestampMs - frames[i - 1].timestampMs;
      if (dt > 0 && Number.isFinite(dt)) intervals.push(dt);
    }
    const medianInterval = median(intervals);
    const fps = medianInterval > 0 ? 1000 / medianInterval : 0;
    const expectedFpsValues = frames.map(frame => frame.frameDurationUs > 0 ? 1e6 / frame.frameDurationUs : 0).filter(Boolean);
    const expectedFps = median(expectedFpsValues);
    const totalLanes = sum(frames.map(frame => frame.diagnostics.decode.totalLanes));
    const validLanes = sum(frames.map(frame => frame.diagnostics.decode.validLanes));
    const capacityBytes = sum(frames.map(frame => frame.diagnostics.decode.capacityBytes));
    const decodedBytes = sum(frames.map(frame => frame.diagnostics.decode.bytesDecoded));
    const durationSec = n >= 2 ? Math.max(1e-6, (frames[n - 1].timestampMs - frames[0].timestampMs) / 1000) : 0;
    const scaleForWindow = n > 1 ? (n - 1) / n : 1;
    const goodputBps = durationSec > 0 ? decodedBytes * scaleForWindow / durationSec : 0;
    const capacityBps = durationSec > 0 ? capacityBytes * scaleForWindow / durationSec : 0;
    const separationP10 = quantile(frames.map(frame => frame.diagnostics.optics.separationP10), 0.1);
    const separationP50 = median(frames.map(frame => frame.diagnostics.optics.separationP50));
    const snrP10 = quantile(frames.map(frame => frame.diagnostics.optics.snrP10), 0.1);
    const confidenceP10 = quantile(frames.map(frame => frame.diagnostics.optics.confidenceP10), 0.1);
    const totalMs = frames.map(frame => frame.diagnostics.timing.totalMs + frame.copyMs + frame.queueMs);
    const frameBudgetUsed = medianInterval > 0 ? totalMs.map(ms => ms / medianInterval) : [];
    const boundaryLanes = sum(frames.map(frame => boundaryFailureLanes(frame.diagnostics.rollingShutter.runs)));
    const runLengths = frames.flatMap(frame => successfulRunLengths(frame.diagnostics.rollingShutter.runs));
    const senderHzMedian = median(frames.map(frame => frame.senderHz).filter(value => value > 0));
    const lanesMedian = median(frames.map(frame => frame.diagnostics.decode.totalLanes).filter(Boolean));
    const lanesPerRefresh = median(runLengths);
    const inferredReadoutMs = senderHzMedian > 0 && lanesPerRefresh > 0 ? lanesMedian / lanesPerRefresh * (1000 / senderHzMedian) : 0;
    const sensorReadoutMs = median(frames.map(frame => frame.sensorReadoutUs / 1000).filter(value => value > 0));
    const snapshot = {
      windowFrames: n,
      goodput: {
        bytesPerSecond: goodputBps,
        megabytesPerSecond: goodputBps / 1e6,
        capacityBytesPerSecond: capacityBps,
        utilization: capacityBps > 0 ? goodputBps / capacityBps : 0,
        baselineBytesPerSecond: this.baselineBytesPerSecond,
        baselineRatio: goodputBps / this.baselineBytesPerSecond,
        targetBytesPerSecond: this.targetBytesPerSecond,
        targetRatio: goodputBps / this.targetBytesPerSecond,
        marginOverBaselineBytesPerSecond: goodputBps - this.baselineBytesPerSecond,
        marginToTargetBytesPerSecond: goodputBps - this.targetBytesPerSecond,
        requiredLaneEfficiencyForBaseline: capacityBps > 0 ? this.baselineBytesPerSecond / capacityBps : Infinity,
        requiredLaneEfficiencyForTarget: capacityBps > 0 ? this.targetBytesPerSecond / capacityBps : Infinity
      },
      capture: {
        fps,
        expectedFps,
        intervalP50Ms: medianInterval,
        intervalP95Ms: quantile(intervals, 0.95),
        exposureUs: median(frames.map(frame => frame.exposureUs).filter(Number.isFinite)),
        iso: median(frames.map(frame => frame.iso).filter(Number.isFinite))
      },
      channel: {
        totalLanes,
        validLanes,
        validLaneRate: totalLanes ? validLanes / totalLanes : 0,
        separationP10,
        separationP50,
        snrP10,
        confidenceP10
      },
      rollingShutter: {
        boundaryFailureLanes: boundaryLanes,
        boundaryLossRate: totalLanes ? boundaryLanes / totalLanes : 0,
        senderHz: senderHzMedian,
        lanesPerRefresh,
        inferredReadoutMs,
        sensorReadoutMs
      },
      cpu: {
        samplerP50Ms: median(frames.map(frame => frame.diagnostics.timing.sampleMs)),
        decoderP50Ms: median(frames.map(frame => frame.diagnostics.timing.decodeMs)),
        totalP50Ms: median(totalMs),
        totalP95Ms: quantile(totalMs, 0.95),
        copyP50Ms: median(frames.map(frame => frame.copyMs)),
        queueP50Ms: median(frames.map(frame => frame.queueMs)),
        frameBudgetUsedP50: median(frameBudgetUsed),
        frameBudgetUsedP95: quantile(frameBudgetUsed, 0.95)
      }
    };
    snapshot.bottleneck = inferBottleneck(snapshot);
    return snapshot;
  }
}
function formatAirGridDiagnostics(snapshot) {
  const mb = snapshot.goodput.megabytesPerSecond.toFixed(2);
  const baseline = (snapshot.goodput.baselineBytesPerSecond / 1e6).toFixed(2);
  const target = (snapshot.goodput.targetBytesPerSecond / 1e6).toFixed(2);
  const lane = (snapshot.channel.validLaneRate * 100).toFixed(1);
  const cpu = (snapshot.cpu.frameBudgetUsedP95 * 100).toFixed(0);
  const readout = snapshot.rollingShutter.sensorReadoutMs || snapshot.rollingShutter.inferredReadoutMs;
  return `${mb} MB/s | QR ${baseline} | target ${target} | ${snapshot.capture.fps.toFixed(1)} camera fps | ${lane}% lanes | sep ${snapshot.channel.separationP10.toFixed(1)} | SNR ${snapshot.channel.snrP10.toFixed(1)} | CPU p95 ${cpu}% | readout ${readout.toFixed(2)} ms | ${snapshot.bottleneck}`;
}

export { AirGridDiagnostics, airGridNativeMetadata, boundaryFailureLanes, formatAirGridDiagnostics, inferBottleneck, quantile };
