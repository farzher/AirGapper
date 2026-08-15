from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f"{path}: expected {count} matches, found {actual}: {old[:120]!r}")
    p.write_text(text.replace(old, new))


replace("receive/main.js",
'''function standardBrowserModes() {
  return STANDARD_RESOLUTIONS.flatMap(([width, height]) => [30, 60].map((fps) => ({
    key: `${width}x${height}@${fps}`,
    width,
    height,
    fps,
    label: formatCameraMode(width, height, fps)
  }))).sort((a, b) => a.width - b.width || a.height - b.height || a.fps - b.fps);
}
function populateCameraOptions() {
  browserModes = standardBrowserModes().filter((mode) => browserModeResults[mode.key] !== false);
  cameraResolution.replaceChildren(
    new Option("Auto", "auto"),
    ...browserModes.map((mode) => new Option(
      `${mode.label}${browserModeResults[mode.key] === true ? "" : " · Try"}`,
      mode.key
    ))
  );
  cameraResolution.value = "auto";
}
''',
'''function standardBrowserModes() {
  return STANDARD_RESOLUTIONS.flatMap(([width, height]) => [30, 60].map((fps) => ({
    key: `${width}x${height}@${fps}`,
    width,
    height,
    fps,
    label: formatCameraMode(width, height, fps)
  }))).sort((a, b) => a.width - b.width || a.height - b.height || a.fps - b.fps);
}
function browserModeSuffix(key) {
  return browserModeResults[key] === true ? "" : browserModeResults[key] === false ? " · Retry" : " · Try";
}
function populateCameraOptions() {
  browserModes = standardBrowserModes();
  cameraResolution.replaceChildren(
    new Option("Auto", "auto"),
    ...browserModes.map((mode) => new Option(`${mode.label}${browserModeSuffix(mode.key)}`, mode.key))
  );
  cameraResolution.value = "auto";
}
''')

replace("receive/main.js",
'''  const active = track.getSettings();
  if (cameraResolution.value === "auto" && active.width && active.height) {
    const fps = Math.round((_m = active.frameRate) != null ? _m : 30);
    automaticBrowserMode = {
      key: "auto",
      width: active.width,
      height: active.height,
      fps,
      label: formatCameraMode(active.width, active.height, fps)
    };
  }
  browserModes = standardBrowserModes().filter((mode) => mode.width >= widthMin && mode.width <= widthMax && mode.height >= heightMin && mode.height <= heightMax && mode.fps >= fpsMin && mode.fps <= fpsMax && browserModeResults[mode.key] !== false && !(automaticBrowserMode && sameModeSize(mode, automaticBrowserMode) && Math.abs(mode.fps - automaticBrowserMode.fps) < 1));
  const prior = cameraResolution.value;
  const options = browserModes.map((mode) => ({
    width: mode.width,
    height: mode.height,
    fps: mode.fps,
    option: new Option(`${mode.label}${browserModeResults[mode.key] === true ? "" : " · Try"}`, mode.key)
  }));
  if (automaticBrowserMode) {
    options.push({
      width: automaticBrowserMode.width,
      height: automaticBrowserMode.height,
      fps: automaticBrowserMode.fps,
      option: new Option(`${automaticBrowserMode.label} · Auto`, "auto")
    });
''',
'''  const active = track.getSettings();
  const activeFps = Math.round((_m = active.frameRate) != null ? _m : 30);
  if (active.width && active.height) {
    const activeStandard = standardBrowserModes().find((mode) => sameModeSize(mode, active) && Math.abs(mode.fps - activeFps) < 1);
    if (activeStandard) saveBrowserModeResult(activeStandard.key, true);
  }
  if (cameraResolution.value === "auto" && active.width && active.height) {
    automaticBrowserMode = {
      key: "auto",
      width: active.width,
      height: active.height,
      fps: activeFps,
      label: formatCameraMode(active.width, active.height, activeFps)
    };
  }
  browserModes = standardBrowserModes().filter((mode) => mode.width >= widthMin && mode.width <= widthMax && mode.height >= heightMin && mode.height <= heightMax && mode.fps >= fpsMin && mode.fps <= fpsMax);
  const prior = cameraResolution.value;
  const options = browserModes.map((mode) => ({
    width: mode.width,
    height: mode.height,
    fps: mode.fps,
    option: new Option(`${mode.label}${browserModeSuffix(mode.key)}`, mode.key)
  }));
  if (automaticBrowserMode) {
    options.push({
      width: automaticBrowserMode.width,
      height: automaticBrowserMode.height,
      fps: automaticBrowserMode.fps,
      option: new Option(`Auto · ${automaticBrowserMode.label}`, "auto")
    });
''')

replace("receive/main.js",
'''  const attempted = browserModes.find((mode) => mode.key === cameraResolution.value);
  if (!attempted) return;
  try {
    await mutateCamera(track, () => track.applyConstraints({
''',
'''  const attempted = browserModes.find((mode) => mode.key === cameraResolution.value);
  if (!attempted) return;
  const current = track.getSettings();
  const currentExactSize = sameModeSize(current, attempted);
  const currentExact = currentExactSize && Math.abs((current.frameRate ?? attempted.fps) - attempted.fps) < 1;
  if (currentExact) {
    saveBrowserModeResult(attempted.key, true);
    populateBrowserCapabilities(track);
    cameraResolution.value = attempted.key;
    readRequestedCameraSettings();
    showNegotiatedWebMode(track);
    saveCameraSettings();
    attachCameraController(track);
    return;
  }
  try {
    await mutateCamera(track, () => track.applyConstraints({
''')

replace("receive/main.js",
'''  } catch {
    saveBrowserModeResult(attempted.key, false);
    (_b = cameraResolution.querySelector(`option[value="${CSS.escape(attempted.key)}"]`)) == null ? void 0 : _b.remove();
    cameraResolution.value = "auto";
''',
'''  } catch {
    saveBrowserModeResult(attempted.key, false);
    const failedOption = cameraResolution.querySelector(`option[value="${CSS.escape(attempted.key)}"]`);
    if (failedOption) failedOption.textContent = `${attempted.label} · Retry`;
    cameraResolution.value = "auto";
''')

replace("receive/main.js",
'''let receiverFrameWidth = 0;
let receiverFrameHeight = 0;
''',
'''let receiverFrameWidth = 0;
let receiverFrameHeight = 0;
let lastVideoFrameInfo;
''')

replace("receive/main.js",
'''  const cameraLine = (value) => {
''',
'''  const sourceTrack = stream?.getVideoTracks()[0];
  const sourceSettings = sourceTrack?.getSettings();
  const sourceCaptureRate = captureTimes.reduce((count, at) => count + Number(at > receiverNow() - STATS_WINDOW_MS), 0) / (STATS_WINDOW_MS / 1e3);
  const sourceLine = sourceSettings ? `track ${sourceSettings.width ?? "—"}×${sourceSettings.height ?? "—"}@${sourceSettings.frameRate ? Number(sourceSettings.frameRate).toFixed(1) : "—"} · video ${video.videoWidth || "—"}×${video.videoHeight || "—"} · capture ${receiverFrameWidth || "—"}×${receiverFrameHeight || "—"}@${sourceCaptureRate.toFixed(1)} · VideoFrame ${lastVideoFrameInfo ?? "—"}` : "camera inactive";
  const cameraLine = (value) => {
''')

replace("receive/main.js",
'''    `Camera   focus writes ${cameraFocusWritesTotal} · exposure writes ${cameraExposureWritesTotal}`,
''',
'''    `Camera   focus writes ${cameraFocusWritesTotal} · exposure writes ${cameraExposureWritesTotal}`,
    `Source   ${sourceLine}`,
''')

replace("receive/main.js",
'''function cloneDirectDecodeFrame(source) {
  if (directFrameDisabled || optimizerPipelineActive || source.image || captureNextScan || opticalSampleDue(source) || typeof VideoFrame !== "function") return null;
  let frame = source.videoFrame;
  if (!frame) {
    try {
      frame = source.videoFrame = new VideoFrame(video);
    } catch {
      return null;
    }
  }
  try {
    return { frame: frame.clone(), pixelFormat: DIRECT_LUMA_FORMATS.has(frame.format) ? "y8" : "video-rgba" };
  } catch {
    return null;
  }
}
''',
'''function cloneVideoFrame(source, forceRgba = false) {
  let frame = source.videoFrame;
  if (!frame) {
    try {
      frame = source.videoFrame = new VideoFrame(video);
    } catch {
      return null;
    }
  }
  lastVideoFrameInfo = `${frame.codedWidth || "—"}×${frame.codedHeight || "—"} coded · ${frame.displayWidth || "—"}×${frame.displayHeight || "—"} display · ${frame.format || "—"}`;
  try {
    return { frame: frame.clone(), pixelFormat: forceRgba ? "video-rgba" : DIRECT_LUMA_FORMATS.has(frame.format) ? "y8" : "video-rgba" };
  } catch {
    return null;
  }
}
function cloneDirectDecodeFrame(source) {
  if (directFrameDisabled || optimizerPipelineActive || source.image || captureNextScan || opticalSampleDue(source) || typeof VideoFrame !== "function") return null;
  return cloneVideoFrame(source, false);
}
function cloneDirectFullScanFrame(source) {
  if (directFrameDisabled || optimizerPipelineActive || source.image || captureNextScan || typeof VideoFrame !== "function") return null;
  return cloneVideoFrame(source, true);
}
''')

replace("receive/main.js",
'''if (healthyTrackedGrid && lockedLayout && laneCount > 1 && batchTracks.length > 1 && pool.size >= laneCount) {''',
'''if (healthyTrackedGrid && lockedLayout && laneCount >= 1 && batchTracks.length >= 1 && pool.size >= laneCount) {''')

replace("receive/main.js",
'''    const img = scanX || scanY || scanW !== vw || scanH !== vh
      ? readBoundedVideoCrop(source, scanX, scanY, scanW, scanH)
      : source.image
        ? new ImageData(new Uint8ClampedArray(source.image.data), vw, vh)
        : (ctx.drawImage(video, 0, 0), ctx.getImageData(0, 0, vw, vh));
''',
'''    const directFull = scanX === 0 && scanY === 0 && scanW === vw && scanH === vh && !lockedGeometryTrusted
      ? cloneDirectFullScanFrame(source)
      : null;
    if (directFull) {
      const id = frameId++;
      if (!submitReceiverJob(
        { id, videoFrame: directFull.frame, cropX: 0, cropY: 0, w: vw, h: vh, ox: 0, oy: 0, full: true, pixelFormat: "video-rgba" },
        [directFull.frame],
        "DIRECT FULL FRAME",
        trace,
        source.sequence
      )) directFull.frame.close();
      if (trace) trace.stateAfter = gridLattice.state;
      activeBenchmarkFrame = void 0;
      return;
    }
    const img = scanX || scanY || scanW !== vw || scanH !== vh
      ? readBoundedVideoCrop(source, scanX, scanY, scanW, scanH)
      : source.image
        ? new ImageData(new Uint8ClampedArray(source.image.data), vw, vh)
        : (ctx.drawImage(video, 0, 0), ctx.getImageData(0, 0, vw, vh));
''')

replace("index.html", '<span class="brand">AirGapper <span class="app-version">v0.5.46</span></span>', '<span class="brand">AirGapper <span class="app-version">v0.5.47</span></span>')
replace("sw.js", 'const CACHE = "airgapper-static-js-v9";', 'const CACHE = "airgapper-static-js-v10";')
