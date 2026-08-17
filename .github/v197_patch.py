from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:180]!r}")
    p.write_text(s.replace(old, new, count))


# Versions/cache/generated codec version.
replace("index.html", "v0.5.196", "v0.5.197")
replace("main.js", 'const APP_BUILD = "v0.5.196";', 'const APP_BUILD = "v0.5.197";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.196";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.197";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v158";', 'const CACHE = "airgapper-static-js-v159";')
replace("vendor/decimen-codec/source/VERSION", "0.1.20", "0.1.21")

# Near-16:9 28-symbol wall. Under landscape rotation 4x7 becomes 7x4 = 1.75:1.
replace(
    "shared/grid-layout.js",
    '  { id: 9, cols: 4, rows: 8 }\n];',
    '  { id: 9, cols: 4, rows: 8 },\n  { id: 10, cols: 4, rows: 7 }\n];'
)
replace(
    "send/main.js",
    'mode === "three-six" || mode === "four-six" || mode === "four-eight" ? mode : "four-three";',
    'mode === "three-six" || mode === "four-six" || mode === "four-seven" || mode === "four-eight" ? mode : "four-three";'
)
replace(
    "send/main.js",
    '    case "four-six":\n      return { cols: 4, rows: 6, codes: 24 };\n    case "four-eight":',
    '    case "four-six":\n      return { cols: 4, rows: 6, codes: 24 };\n    case "four-seven":\n      return { cols: 4, rows: 7, codes: 28 };\n    case "four-eight":'
)
replace(
    "index.html",
    '<option value="four-six">4:6 · 24</option><option value="four-eight">4:8 · 32</option>',
    '<option value="four-six">4:6 · 24</option><option value="four-seven">4:7 · 28</option><option value="four-eight">4:8 · 32</option>'
)

# ---------------------------------------------------------------------------
# Camera Auto: choose the strongest rear camera instead of trusting whichever
# environment camera Chrome happens to grant. Resolution capability is the
# primary first-use signal; actual AirGapper goodput then breaks ties/learns.
# Explicit user camera choice remains exact and always wins.
# ---------------------------------------------------------------------------
replace(
    "receive/main.js",
    'const BROWSER_MODE_RESULTS_KEY = "airgapper:browser-camera-modes:v1";\n',
    'const BROWSER_MODE_RESULTS_KEY = "airgapper:browser-camera-modes:v1";\nconst CAMERA_PERFORMANCE_KEY = "airgapper:camera-performance:v1";\n'
)
replace(
    "receive/main.js",
    'let automaticBrowserMode;\nlet preferredCameraDeviceId = "";\nfunction loadBrowserModeResults() {',
    '''let automaticBrowserMode;
let preferredCameraDeviceId = "";
let automaticCameraDeviceId = "";
let automaticCameraUpgradeAttempted = false;
let cameraPerformanceSaveAt = 0;
function loadCameraPerformance() {
  try {
    return JSON.parse(localStorage.getItem(CAMERA_PERFORMANCE_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}
const cameraPerformance = loadCameraPerformance();
function saveCameraPerformance() {
  try {
    localStorage.setItem(CAMERA_PERFORMANCE_KEY, JSON.stringify(cameraPerformance));
  } catch {}
}
function learnedAutomaticCameraId() {
  let bestId = "";
  let best = -1;
  for (const [id, record] of Object.entries(cameraPerformance)) {
    const goodput = Math.max(Number(record?.bestGoodputKbs) || 0, Number(record?.lastGoodputKbs) || 0);
    if (goodput > best) {
      best = goodput;
      bestId = id;
    }
  }
  return bestId;
}
function inputDeviceCapabilities(device) {
  try {
    return device?.getCapabilities?.() ?? {};
  } catch {
    return {};
  }
}
function cameraFacingHint(device, caps) {
  const modes = Array.isArray(caps?.facingMode) ? caps.facingMode : caps?.facingMode ? [caps.facingMode] : [];
  const label = String(device?.label ?? "").toLowerCase();
  if (modes.includes("environment") || /back|rear|environment/.test(label)) return "rear";
  if (modes.includes("user") || /front|user|selfie/.test(label)) return "front";
  return "unknown";
}
function automaticCameraScore(device, index) {
  const caps = inputDeviceCapabilities(device);
  const record = cameraPerformance[device.deviceId] ?? {};
  const width = Number(caps?.width?.max) || Number(record.maxWidth) || 0;
  const height = Number(caps?.height?.max) || Number(record.maxHeight) || 0;
  const area = width * height;
  const fps = Number(caps?.frameRate?.max) || Number(record.maxFps) || 0;
  const goodput = Math.max(Number(record.bestGoodputKbs) || 0, Number(record.lastGoodputKbs) || 0);
  const focusModes = Array.isArray(caps?.focusMode) ? caps.focusMode : [];
  const af = focusModes.includes("continuous") ? 1 : 0;
  const mainHint = /camera\s*0(?:\D|$)|main/.test(String(device.label ?? "").toLowerCase()) ? 1 : 0;
  // Sensor/video resolution dominates first-use selection. Measured AirGapper
  // throughput is strong enough to separate cameras exposing similar modes.
  return area + fps * 10000 + goodput * 1000 + af * 50000 + mainHint * 1000 - index;
}
function bestAutomaticCameraDevice(devices) {
  if (!devices.length) return undefined;
  const tagged = devices.map((device, index) => ({ device, index, caps: inputDeviceCapabilities(device) }));
  const rear = tagged.filter(({ device, caps }) => cameraFacingHint(device, caps) === "rear");
  const candidates = rear.length ? rear : tagged.filter(({ device, caps }) => cameraFacingHint(device, caps) !== "front");
  const pool = candidates.length ? candidates : tagged;
  return pool.reduce((best, candidate) =>
    !best || automaticCameraScore(candidate.device, candidate.index) > automaticCameraScore(best.device, best.index)
      ? candidate : best, undefined)?.device;
}
function noteCameraPerformance(goodputKbs, uniqueRate, runSeconds) {
  if (runSeconds < 3 || goodputKbs <= 0 || performance.now() < cameraPerformanceSaveAt) return;
  const track = stream?.getVideoTracks?.()[0];
  const settings = track?.getSettings?.();
  const id = String(settings?.deviceId ?? "");
  if (!id) return;
  cameraPerformanceSaveAt = performance.now() + 2000;
  const record = cameraPerformance[id] ?? {};
  record.bestGoodputKbs = Math.max(Number(record.bestGoodputKbs) || 0, goodputKbs);
  record.lastGoodputKbs = goodputKbs;
  record.bestUniqueQrPerSecond = Math.max(Number(record.bestUniqueQrPerSecond) || 0, uniqueRate);
  record.maxWidth = Math.max(Number(record.maxWidth) || 0, Number(settings.width) || 0);
  record.maxHeight = Math.max(Number(record.maxHeight) || 0, Number(settings.height) || 0);
  record.maxFps = Math.max(Number(record.maxFps) || 0, Number(settings.frameRate) || 0);
  record.updatedAt = Date.now();
  cameraPerformance[id] = record;
  saveCameraPerformance();
}
function loadBrowserModeResults() {'''
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
    preferredCameraDeviceId = "";
    const best = bestAutomaticCameraDevice(devices);
    automaticCameraDeviceId = best?.deviceId || learnedAutomaticCameraId() || "";
    cameraDevice.value = activeExists ? activeId : "";
    // Permission makes labels/capabilities materially richer than they are on
    // the pre-permission call. If Chrome initially handed us a weaker rear
    // camera, reopen once with the newly-ranked sensor. Never loop/reprobe.
    if (activeId && automaticCameraDeviceId && activeId !== automaticCameraDeviceId &&
        !automaticCameraUpgradeAttempted && stream && !done) {
      automaticCameraUpgradeAttempted = true;
      setTimeout(() => {
        if (!stream || done || preferredCameraDeviceId) return;
        stopReceiver();
        void start();
      }, 0);
    }
  } else if (activeExists) {
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
  if (preferredCameraDeviceId) return { deviceId: { exact: preferredCameraDeviceId } };
  if (mobileCameraUi) {
    const learned = automaticCameraDeviceId || learnedAutomaticCameraId();
    if (learned) return { deviceId: { ideal: learned }, facingMode: { ideal: "environment" } };
    return { facingMode: "environment" };
  }
  return {};
}'''
replace("receive/main.js", old_refresh, new_refresh)
replace(
    "receive/main.js",
    '''  const runGoodputKbs = decoder && runSeconds ? decoder.usefulSymbols * decoder.blockLen / expectedCodingOverhead() / 1024 / runSeconds : 0;\n  const fastPercent =''',
    '''  const runGoodputKbs = decoder && runSeconds ? decoder.usefulSymbols * decoder.blockLen / expectedCodingOverhead() / 1024 / runSeconds : 0;\n  noteCameraPerformance(runGoodputKbs, runUniqueRate, runSeconds);\n  const fastPercent ='''
)
replace(
    "receive/main.js",
    '''cameraDevice?.addEventListener("change", () => {\n  preferredCameraDeviceId = cameraDevice.value;\n  saveCameraSettings();''',
    '''cameraDevice?.addEventListener("change", () => {\n  preferredCameraDeviceId = cameraDevice.value;\n  automaticCameraUpgradeAttempted = false;\n  if (!preferredCameraDeviceId) automaticCameraDeviceId = learnedAutomaticCameraId();\n  saveCameraSettings();'''
)

# ---------------------------------------------------------------------------
# Adaptive Turbo at 1440p: low-density images get one cheap canary slot until
# real CRC evidence promotes the worker. Old/soft cameras pay only that bounded
# trial and cool down on failure. >=3.05 px/module retains immediate full Turbo.
# ---------------------------------------------------------------------------
old_turbo_head = '''constexpr float GUIDED_TURBO_SEED_MIN_MODULE = 2.95f;
constexpr float GUIDED_TURBO_RUN_MIN_MODULE = 3.05f;
constexpr int GUIDED_TURBO_RS_BUDGET = 4;
constexpr int GUIDED_TURBO_BAD_COOLDOWN = 6;
constexpr int GUIDED_TURBO_AMBIGUOUS = 11;

struct GuidedTurboTrack
{
    int dimension = 0;
    bool seeded = false;
    bool distortionAware = false;
    std::array<PointF, 4> seedQuad{};
    std::vector<PointF> samples;
    uint8_t misses = 0;
    uint8_t cooldown = 0;
};

static std::array<GuidedTurboTrack, 64>& guidedTurboTracks()
{
    static std::array<GuidedTurboTrack, 64> tracks;
    return tracks;
}

static GuidedTurboTrack* guidedTurboTrack(int id)
{
    return id >= 0 && id < int(guidedTurboTracks().size()) ? &guidedTurboTracks()[id] : nullptr;
}

static bool turboSeedEligible(const DecimenGuidedTrack& track)
{
    return guidedTurboTrack(track.id) && guidedModuleSize(track) >= GUIDED_TURBO_SEED_MIN_MODULE;
}'''
new_turbo_head = '''constexpr float GUIDED_TURBO_CANARY_MIN_MODULE = 2.25f;
constexpr float GUIDED_TURBO_FULL_MIN_MODULE = 3.05f;
constexpr int GUIDED_TURBO_RS_BUDGET = 4;
constexpr int GUIDED_TURBO_BAD_COOLDOWN = 6;
constexpr int GUIDED_TURBO_CANARY_COOLDOWN = 24;
constexpr int GUIDED_TURBO_AMBIGUOUS = 11;

struct GuidedTurboTrack
{
    int dimension = 0;
    bool seeded = false;
    bool distortionAware = false;
    std::array<PointF, 4> seedQuad{};
    std::vector<PointF> samples;
    uint8_t misses = 0;
    uint8_t cooldown = 0;
};

struct GuidedTurboAdaptive
{
    int seedId = -1;
    int canaryAttempts = 0;
    int canarySuccesses = 0;
    int promotedAttempts = 0;
    int promotedSuccesses = 0;
    int cooldown = 0;
    bool promoted = false;
};

static std::array<GuidedTurboTrack, 64>& guidedTurboTracks()
{
    static std::array<GuidedTurboTrack, 64> tracks;
    return tracks;
}

static GuidedTurboAdaptive& guidedTurboAdaptive()
{
    static GuidedTurboAdaptive state;
    return state;
}

static GuidedTurboTrack* guidedTurboTrack(int id)
{
    return id >= 0 && id < int(guidedTurboTracks().size()) ? &guidedTurboTracks()[id] : nullptr;
}

static void coolLowDensityTurbo()
{
    auto& adaptive = guidedTurboAdaptive();
    adaptive.seedId = -1;
    adaptive.canaryAttempts = 0;
    adaptive.canarySuccesses = 0;
    adaptive.promotedAttempts = 0;
    adaptive.promotedSuccesses = 0;
    adaptive.promoted = false;
    adaptive.cooldown = GUIDED_TURBO_CANARY_COOLDOWN;
    for (auto& cache : guidedTurboTracks()) {
        cache.seeded = false;
        cache.samples.clear();
        cache.misses = 0;
        cache.cooldown = 0;
    }
}

static bool turboSeedEligible(const DecimenGuidedTrack& track)
{
    auto* cache = guidedTurboTrack(track.id);
    if (!cache)
        return false;
    const float module = guidedModuleSize(track);
    if (module < GUIDED_TURBO_CANARY_MIN_MODULE)
        return false;
    if (module >= GUIDED_TURBO_FULL_MIN_MODULE)
        return true;
    auto& adaptive = guidedTurboAdaptive();
    if (adaptive.cooldown)
        return false;
    if (adaptive.promoted)
        return true;
    if (adaptive.seedId < 0)
        return true;
    return adaptive.seedId == track.id && !cache->seeded;
}'''
replace("vendor/decimen-codec/source/wrapper/decimen_codec.cpp", old_turbo_head, new_turbo_head)
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''    cache->misses = 0;\n    cache->cooldown = 0;\n}\n\nstatic bool turboPose''',
    '''    cache->misses = 0;\n    cache->cooldown = 0;\n    auto& adaptive = guidedTurboAdaptive();\n    if (adaptive.seedId < 0) adaptive.seedId = id;\n}\n\nstatic bool turboPose'''
)

old_turbo_loop = '''        // Shared wall motion: use one high-resolution cached QR as the pose
        // anchor, then apply its residual correction to every cached slot. The
        // main lattice supplies the large/slow pose change; this only refines a
        // few pixels of worker-latency/hand-motion drift.
        float wallCorrectionX = 0, wallCorrectionY = 0;
        for (int i = 0; i < trackCount; ++i) {
            auto* cache = guidedTurboTrack(tracks[i].id);
            if (!cache || !cache->seeded || guidedModuleSize(tracks[i]) < GUIDED_TURBO_RUN_MIN_MODULE)
                continue;
            float dx = 0, dy = 0, residual = 0;
            if (!turboPose(*cache, tracks[i], dx, dy, residual))
                continue;
            const PointF refined = turboRefineWallOffset(*cache, yPlane, width, height, stride, dx, dy);
            wallCorrectionX = refined.x - dx;
            wallCorrectionY = refined.y - dy;
            break;
        }

        int rsBudget = GUIDED_TURBO_RS_BUDGET;
        for (int i = 0; i < trackCount; ++i) {
            const auto& track = tracks[i];
            auto* cache = guidedTurboTrack(track.id);
            if (!cache || !cache->seeded || guidedModuleSize(track) < GUIDED_TURBO_RUN_MIN_MODULE)
                continue;
            if (cache->cooldown) {
                --cache->cooldown;
                continue;
            }
            float dx = 0, dy = 0, residual = 0;
            if (!turboPose(*cache, track, dx, dy, residual))
                continue;
            dx += wallCorrectionX;
            dy += wallCorrectionY;
            const auto levels = turboReadLevels(*cache, yPlane, width, height, stride, dx, dy);
            if (!levels.ok)
                continue;

            ++metrics->reserved; // turbo attempts (ABI-reserved field)
            ++metrics->sampleAttempts;
            ++metrics->sparseNoRsAttempts;
            const double turboStarted = guidedNowMs();
            auto decoded = decodeTurboDataOnly(*cache, track, yPlane, width, height, stride,
                                               dx, dy, levels, *metrics);
            bool success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);
            if (success) {
                ++metrics->sparseNoRsSuccesses;
            } else if (rsBudget > 0) {
                --rsBudget;
                ++metrics->sparseRsFallbacks;
                decoded = decodeTurboWithRS(*cache, track, yPlane, width, height, stride,
                                            dx, dy, levels, *metrics);
                success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);
            }
            metrics->fastDecodeMs += guidedNowMs() - turboStarted;
            if (success) {
                ++metrics->reserved2; // turbo successes (ABI-reserved field)
                cache->misses = 0;
                cache->cooldown = 0;
            } else if (++cache->misses >= 2) {
                cache->misses = 0;
                cache->cooldown = GUIDED_TURBO_BAD_COOLDOWN;
            }
        }
'''
new_turbo_loop = '''        auto& turboAdaptive = guidedTurboAdaptive();
        if (turboAdaptive.cooldown)
            --turboAdaptive.cooldown;

        bool highDensityTurbo = false;
        for (int i = 0; i < trackCount; ++i) {
            auto* cache = guidedTurboTrack(tracks[i].id);
            if (cache && cache->seeded && guidedModuleSize(tracks[i]) >= GUIDED_TURBO_FULL_MIN_MODULE) {
                highDensityTurbo = true;
                break;
            }
        }

        int canaryIndex = -1;
        if (!highDensityTurbo && !turboAdaptive.promoted && !turboAdaptive.cooldown) {
            for (int i = 0; i < trackCount; ++i) {
                auto* cache = guidedTurboTrack(tracks[i].id);
                if (cache && cache->seeded && guidedModuleSize(tracks[i]) >= GUIDED_TURBO_CANARY_MIN_MODULE &&
                    (turboAdaptive.seedId < 0 || turboAdaptive.seedId == tracks[i].id)) {
                    canaryIndex = i;
                    break;
                }
            }
        }
        auto turboAllowed = [&](int i) {
            const float module = guidedModuleSize(tracks[i]);
            if (module >= GUIDED_TURBO_FULL_MIN_MODULE)
                return true;
            if (module < GUIDED_TURBO_CANARY_MIN_MODULE || turboAdaptive.cooldown)
                return false;
            return turboAdaptive.promoted || i == canaryIndex;
        };

        // Shared wall motion is paid once. In the 1440p canary state only the
        // single proving slot participates, so a soft/old camera cannot turn
        // this experiment into a second full decoder.
        float wallCorrectionX = 0, wallCorrectionY = 0;
        for (int i = 0; i < trackCount; ++i) {
            auto* cache = guidedTurboTrack(tracks[i].id);
            if (!cache || !cache->seeded || !turboAllowed(i))
                continue;
            float dx = 0, dy = 0, residual = 0;
            if (!turboPose(*cache, tracks[i], dx, dy, residual))
                continue;
            const PointF refined = turboRefineWallOffset(*cache, yPlane, width, height, stride, dx, dy);
            wallCorrectionX = refined.x - dx;
            wallCorrectionY = refined.y - dy;
            break;
        }

        int rsBudget = GUIDED_TURBO_RS_BUDGET;
        for (int i = 0; i < trackCount; ++i) {
            const auto& track = tracks[i];
            auto* cache = guidedTurboTrack(track.id);
            if (!cache || !cache->seeded || !turboAllowed(i))
                continue;
            if (cache->cooldown) {
                --cache->cooldown;
                continue;
            }
            float dx = 0, dy = 0, residual = 0;
            if (!turboPose(*cache, track, dx, dy, residual))
                continue;
            dx += wallCorrectionX;
            dy += wallCorrectionY;
            const auto levels = turboReadLevels(*cache, yPlane, width, height, stride, dx, dy);
            if (!levels.ok)
                continue;

            ++metrics->reserved; // turbo attempts (ABI-reserved field)
            ++metrics->sampleAttempts;
            ++metrics->sparseNoRsAttempts;
            const double turboStarted = guidedNowMs();
            auto decoded = decodeTurboDataOnly(*cache, track, yPlane, width, height, stride,
                                               dx, dy, levels, *metrics);
            bool success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);
            if (success) {
                ++metrics->sparseNoRsSuccesses;
            } else if (rsBudget > 0) {
                --rsBudget;
                ++metrics->sparseRsFallbacks;
                decoded = decodeTurboWithRS(*cache, track, yPlane, width, height, stride,
                                            dx, dy, levels, *metrics);
                success = commitTurbo(i, decoded, wallCorrectionX, wallCorrectionY);
            }
            metrics->fastDecodeMs += guidedNowMs() - turboStarted;
            if (success) {
                ++metrics->reserved2; // turbo successes (ABI-reserved field)
                cache->misses = 0;
                cache->cooldown = 0;
            } else if (++cache->misses >= 2) {
                cache->misses = 0;
                cache->cooldown = GUIDED_TURBO_BAD_COOLDOWN;
            }

            if (guidedModuleSize(track) < GUIDED_TURBO_FULL_MIN_MODULE) {
                if (!turboAdaptive.promoted) {
                    ++turboAdaptive.canaryAttempts;
                    turboAdaptive.canarySuccesses += int(success);
                    const bool earlyWin = turboAdaptive.canaryAttempts >= 2 &&
                                          turboAdaptive.canarySuccesses == turboAdaptive.canaryAttempts;
                    if (earlyWin || turboAdaptive.canaryAttempts >= 6) {
                        if (earlyWin || turboAdaptive.canarySuccesses * 2 >= turboAdaptive.canaryAttempts) {
                            turboAdaptive.promoted = true;
                            turboAdaptive.canaryAttempts = 0;
                            turboAdaptive.canarySuccesses = 0;
                        } else {
                            coolLowDensityTurbo();
                        }
                    }
                } else {
                    ++turboAdaptive.promotedAttempts;
                    turboAdaptive.promotedSuccesses += int(success);
                    if (turboAdaptive.promotedAttempts >= 36) {
                        if (turboAdaptive.promotedSuccesses * 4 < turboAdaptive.promotedAttempts)
                            coolLowDensityTurbo();
                        else {
                            turboAdaptive.promotedAttempts = 0;
                            turboAdaptive.promotedSuccesses = 0;
                        }
                    }
                }
            }
        }
'''
replace("vendor/decimen-codec/source/wrapper/decimen_codec.cpp", old_turbo_loop, new_turbo_loop)
