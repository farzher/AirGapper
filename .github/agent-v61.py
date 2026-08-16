from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))

# main.js: mobile camera UI + explicit rear-camera default
replace_once(
    "receive/main.js",
    'import { applyAdvancedConstraint } from "../shared/platform.js";',
    'import { applyAdvancedConstraint, isAndroid, isIOS } from "../shared/platform.js";',
)
replace_once(
    "receive/main.js",
    'const cameraDevice = document.getElementById("camera-device");',
    'const cameraDevice = document.getElementById("camera-device");\nconst cameraDeviceControl = document.getElementById("camera-device-control");',
)
replace_once(
    "receive/main.js",
    'const receiverDevActions = document.querySelector(".receiver-dev-actions");',
    'const receiverDevActions = document.querySelector(".receiver-dev-actions");\nconst mobileCameraUi = isAndroid || isIOS || navigator.userAgentData?.mobile === true;\nif (mobileCameraUi && cameraDeviceControl && receiverDevActions) receiverDevActions.prepend(cameraDeviceControl);',
)
replace_once(
    "receive/main.js",
    'const CAMERA_SETTINGS_KEY = "airgapper:camera-settings:v8";',
    'const CAMERA_SETTINGS_KEY = "airgapper:camera-settings:v9";',
)
old_refresh = '''async function refreshCameraDevices(activeTrack) {
  if (!cameraDevice || !navigator.mediaDevices?.enumerateDevices) return;
  let devices = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
  } catch {
    return;
  }
  const activeId = activeTrack?.getSettings?.().deviceId ?? "";
  const options = [new Option("Default camera", "")];
  devices.forEach((device, index) => options.push(new Option(device.label || `Camera ${index + 1}`, device.deviceId)));
  cameraDevice.replaceChildren(...options);
  const preferredExists = preferredCameraDeviceId && devices.some((device) => device.deviceId === preferredCameraDeviceId);
  const activeExists = activeId && devices.some((device) => device.deviceId === activeId);
  if (preferredExists) {
    cameraDevice.value = preferredCameraDeviceId;
  } else if (activeExists) {
    // Once Chrome has granted a concrete camera, pin that exact device for the
    // rest of the session. Desktop facingMode is only a preference and can
    // otherwise select a different camera when constraints are retried.
    preferredCameraDeviceId = activeId;
    cameraDevice.value = activeId;
    saveCameraSettings();
  } else {
    preferredCameraDeviceId = "";
    cameraDevice.value = "";
  }
  cameraDevice.disabled = devices.length <= 1;
}
function cameraDeviceConstraint() {
  return preferredCameraDeviceId
    ? { deviceId: { exact: preferredCameraDeviceId } }
    : { facingMode: "environment" };
}'''
new_refresh = '''async function refreshCameraDevices(activeTrack) {
  if (!cameraDevice || !navigator.mediaDevices?.enumerateDevices) return;
  let devices = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
  } catch {
    return;
  }
  const activeId = activeTrack?.getSettings?.().deviceId ?? "";
  const options = [new Option(mobileCameraUi ? "Rear camera (auto)" : "Default camera", "")];
  devices.forEach((device, index) => options.push(new Option(device.label || `Camera ${index + 1}`, device.deviceId)));
  cameraDevice.replaceChildren(...options);
  const preferredExists = preferredCameraDeviceId && devices.some((device) => device.deviceId === preferredCameraDeviceId);
  const activeExists = activeId && devices.some((device) => device.deviceId === activeId);
  if (preferredExists) {
    cameraDevice.value = preferredCameraDeviceId;
  } else if (mobileCameraUi) {
    // Mobile's normal receiver always asks for the rear/environment camera.
    // Do not turn the camera Chrome happened to grant into a persistent exact
    // device choice. The selector is developer-only on mobile; selecting an
    // explicit device there still overrides this default.
    preferredCameraDeviceId = "";
    cameraDevice.value = activeExists ? activeId : "";
  } else if (activeExists) {
    // Desktop has no meaningful facingMode. Once Chrome grants a concrete
    // device, pin it for retries so a resolution fallback cannot jump webcams.
    preferredCameraDeviceId = activeId;
    cameraDevice.value = activeId;
    saveCameraSettings();
  } else {
    preferredCameraDeviceId = "";
    cameraDevice.value = "";
  }
  cameraDevice.disabled = devices.length <= 1;
}
function cameraDeviceConstraint() {
  return preferredCameraDeviceId
    ? { deviceId: { exact: preferredCameraDeviceId } }
    : { facingMode: "environment" };
}'''
replace_once("receive/main.js", old_refresh, new_refresh)

# Pending spatial-lane frames must retain Strict/audit mode.
replace_once(
    "receive/main.js",
    '''    pixelFormat: pending.direct.pixelFormat
  };''',
    '''    pixelFormat: pending.direct.pixelFormat,
    strictHotPath: pending.strictHotPath,
    diagnoseSampler: pending.diagnoseSampler
  };''',
)
replace_once(
    "receive/main.js",
    '      const geometry = { x, y, w, h, tracks: group.tracks, regions: group.regions, sourceSequence: source.sequence, laneCount };',
    '      const geometry = { x, y, w, h, tracks: group.tracks, regions: group.regions, sourceSequence: source.sequence, laneCount, strictHotPath: strictHotPathActive(), diagnoseSampler: !receiverDevActions.hidden };',
)

# Surface current native pixel representation.
replace_once(
    "receive/main.js",
    'let lastNativeMetrics;\nlet lastSamplerDiagnostics = [];',
    'let lastNativeMetrics;\nlet lastDirectPixelPath = "—";\nlet lastSamplerDiagnostics = [];',
)
replace_once(
    "receive/main.js",
    '''  if (completion.nativeMetrics) {
    lastNativeMetrics = { ...completion.nativeMetrics, frameCopyMs: completion.frameCopyMs };
  }''',
    '''  if (completion.nativeMetrics) {
    lastNativeMetrics = { ...completion.nativeMetrics, frameCopyMs: completion.frameCopyMs };
  }
  if (completion.pixelPath) lastDirectPixelPath = completion.pixelPath;''',
)
replace_once(
    "receive/main.js",
    '  lastNativeMetrics = void 0;\n  resetHotPathAudit();',
    '  lastNativeMetrics = void 0;\n  lastDirectPixelPath = "—";\n  resetHotPathAudit();',
)
replace_once(
    "receive/main.js",
    '''Pixel A/B Y8-miss → isolated RGBA CRC ${hotPathAudit.pixelAuditCrcFast}/${hotPathAudit.pixelAuditTracks} · misses ${hotPathAudit.pixelAuditMisses} (anchor ${hotPathAudit.pixelAuditAnchorMisses} · frame ${hotPathAudit.pixelAuditFrameMisses} · bits ${hotPathAudit.pixelAuditBitstreamFailures} · CRC ${hotPathAudit.pixelAuditCrcFailures})''',
    '''Pixel path ${lastDirectPixelPath.toUpperCase()} · A/B Y8-miss → isolated RGBA CRC ${hotPathAudit.pixelAuditCrcFast}/${hotPathAudit.pixelAuditTracks} · misses ${hotPathAudit.pixelAuditMisses} (anchor ${hotPathAudit.pixelAuditAnchorMisses} · frame ${hotPathAudit.pixelAuditFrameMisses} · bits ${hotPathAudit.pixelAuditBitstreamFailures} · CRC ${hotPathAudit.pixelAuditCrcFailures})''',
)

# worker-pool.js: preserve A/B information from worker replies.
replace_once(
    "shared/worker-pool.js",
    '''          nativeMetrics: message.nativeMetrics,
          samplerDiagnostics: message.samplerDiagnostics ?? [],''',
    '''          nativeMetrics: message.nativeMetrics,
          pixelAudit: message.pixelAudit,
          pixelPath: message.pixelPath,
          samplerDiagnostics: message.samplerDiagnostics ?? [],''',
)

# worker.js: evidence-driven Y8 -> RGBA path selection.
replace_once(
    "receive/worker.js",
    'let directPixelAuditDone = false;',
    '''let directPixelMode = "y8";
let directPixelAuditAttempts = 0;
let directPixelRgbaWins = 0;
const DIRECT_PIXEL_AUDIT_LIMIT = 3;''',
)
replace_once(
    "receive/worker.js",
    '''      const rect = { x: cropX, y: cropY, width: w, height: h };
      const copyAsRgba = pixelFormat !== "y8";
      const copyOptions = copyAsRgba ? { rect, format: "RGBA" } : { rect };''',
    '''      const rect = { x: cropX, y: cropY, width: w, height: h };
      const sourceHasDirectY = pixelFormat === "y8";
      const selectedRgba = sourceHasDirectY && directPixelMode === "rgba" && !full && Boolean(tracks?.length);
      const copyAsRgba = pixelFormat !== "y8" || selectedRgba;
      const copyOptions = copyAsRgba ? { rect, format: "RGBA" } : { rect };''',
)
old_audit = '''      // One-shot developer A/B: after a real Y8 miss, feed the exact same
      // VideoFrame crop to an isolated temporary native decoder as RGBA. Never
      // accept its symbols or mutate persistent tracking. This tells us whether
      // the direct Y plane itself is the difference without rescuing Strict mode.
      if (nativeSymbols.length === 0 && strictHotPath && diagnoseSampler && usedDirectFrame &&
          pixelFormat === "y8" && ownedVideoFrame && !directPixelAuditDone) {
        directPixelAuditDone = true;
        const rect = { x: cropX, y: cropY, width: w, height: h };
        const options = { rect, format: "RGBA" };
        const bytes = ownedVideoFrame.allocationSize(options);
        rgbaRecoveryPtr = inputBuffer(zx, bytes);
        const copyStarted = performance.now();
        const planes = await ownedVideoFrame.copyTo(zx.HEAPU8.subarray(rgbaRecoveryPtr, rgbaRecoveryPtr + bytes), options);
        frameCopyMs += performance.now() - copyStarted;
        rgbaRecoveryStride = planes[0]?.stride ?? w * 4;
        pixelAudit = decodeNativeAuditRGBA(zx, rgbaRecoveryPtr + (planes[0]?.offset ?? 0), pw, ph, ox, oy, tracks, rgbaRecoveryStride);
      }'''
new_audit = '''      // Same-frame representation A/B. A Y8 miss gets a bounded number of
      // isolated RGBA retries using the exact same VideoFrame crop and geometry.
      // The probe result is NEVER accepted for this frame and never mutates the
      // persistent native decoder. If RGBA independently wins twice, however,
      // that is strong evidence the browser's direct Y representation is the
      // problem, so subsequent frames on this worker use RGBA as their normal
      // tracked input. This is pixel-format adaptation, not a per-frame rescue.
      if (nativeSymbols.length === 0 && usedDirectFrame && pixelFormat === "y8" &&
          decodePixelFormat === "y8" && ownedVideoFrame && directPixelAuditAttempts < DIRECT_PIXEL_AUDIT_LIMIT) {
        directPixelAuditAttempts++;
        const rect = { x: cropX, y: cropY, width: w, height: h };
        const options = { rect, format: "RGBA" };
        const bytes = ownedVideoFrame.allocationSize(options);
        rgbaRecoveryPtr = inputBuffer(zx, bytes);
        const copyStarted = performance.now();
        const planes = await ownedVideoFrame.copyTo(zx.HEAPU8.subarray(rgbaRecoveryPtr, rgbaRecoveryPtr + bytes), options);
        frameCopyMs += performance.now() - copyStarted;
        rgbaRecoveryStride = planes[0]?.stride ?? w * 4;
        const measured = decodeNativeAuditRGBA(zx, rgbaRecoveryPtr + (planes[0]?.offset ?? 0), pw, ph, ox, oy, tracks, rgbaRecoveryStride);
        if (measured?.crcFastSuccesses > 0) directPixelRgbaWins++;
        if (directPixelRgbaWins >= 2) directPixelMode = "rgba";
        pixelAudit = measured ? {
          ...measured,
          attempt: directPixelAuditAttempts,
          rgbaWins: directPixelRgbaWins,
          selectedPath: directPixelMode
        } : {
          tracks: 0,
          successful: 0,
          misses: 0,
          crcFastSuccesses: 0,
          rsFallbacks: 0,
          anchorMisses: 0,
          outOfFrameMisses: 0,
          bitstreamFailures: 0,
          crcFailures: 0,
          attempt: directPixelAuditAttempts,
          rgbaWins: directPixelRgbaWins,
          selectedPath: directPixelMode
        };
      }'''
replace_once("receive/worker.js", old_audit, new_audit)
replace_once(
    "receive/worker.js",
    '''          nativeMetrics: native?.metrics,
          pixelAudit,
          directFrameFailed,''',
    '''          nativeMetrics: native?.metrics,
          pixelAudit,
          pixelPath: decodePixelFormat,
          directFrameFailed,''',
)
replace_once(
    "receive/worker.js",
    '''        nativeMetrics: native?.metrics,
        samplerDiagnostics,
        latencyMs: performance.now() - startedAt''',
    '''        nativeMetrics: native?.metrics,
        pixelAudit,
        pixelPath: decodePixelFormat,
        samplerDiagnostics,
        latencyMs: performance.now() - startedAt''',
)

replace_once("index.html", "v0.5.60", "v0.5.61")
replace_once("sw.js", 'airgapper-static-js-v23', 'airgapper-static-js-v24')
