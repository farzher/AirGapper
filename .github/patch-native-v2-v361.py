from pathlib import Path


def replace_once(path, old, new, label):
    text = path.read_text(encoding="utf-8")
    if new in text:
        return False
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    return True


def replace_all(path, old, new, expected, label):
    text = path.read_text(encoding="utf-8")
    if old not in text and text.count(new) == expected:
        return False
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"{label}: expected {expected} matches, found {count}")
    path.write_text(text.replace(old, new), encoding="utf-8")
    return True

java = Path("android/app/src/main/java/com/airgapper/app/NativeCameraV2Bridge.java")
jni = Path("android/app/src/main/cpp/airgapper_native_jni.cpp")
receiver = Path("receive/main.js")

replace_once(
    java,
    "    private static final long PREVIEW_FALLBACK_INTERVAL_NS = 100_000_000L;",
    "    private static final long PREVIEW_FALLBACK_INTERVAL_NS = 50_000_000L;",
    "fallback preview cadence",
)
replace_all(java, "int outWidth = Math.min(320, width);", "int outWidth = Math.min(240, width);", 2, "native preview width")

old_yuv = '''            FrameMetadata metadata = metadataForTimestamp(image.getTimestamp());
            DecodePlan plan = claimPlan();
            if (plan == null) {
                maybeSendYuvPreview(image);
                return;
            }
            Image owned = image;
            image = null;
            decodeHandler.post(() -> {
                try {
                    byte[] packet = decodePlan(plan, buffer, offset, owned.getWidth(), owned.getHeight(), plane.getRowStride(), metadata, 2);
                    maybeSendYuvPreview(owned);
                    if (packet != null) postBinary(packet); else postEvent("decodeError", "Native YUV decode failed");
'''
new_yuv = '''            FrameMetadata metadata = metadataForTimestamp(image.getTimestamp());
            // Preview must never wait behind a QR decode. Sampling the tiny 240px
            // YUV preview here keeps display cadence independent of full-scan cost.
            maybeSendYuvPreview(image);
            DecodePlan plan = claimPlan();
            if (plan == null) return;
            Image owned = image;
            image = null;
            decodeHandler.post(() -> {
                try {
                    byte[] packet = decodePlan(plan, buffer, offset, owned.getWidth(), owned.getHeight(), plane.getRowStride(), metadata, 2);
                    if (packet != null) postBinary(packet); else postEvent("decodeError", "Native YUV decode failed");
'''
replace_once(java, old_yuv, new_yuv, "decouple YUV preview from decode")

old_rotation = '''function nativePreviewRotation(info = nativeCameraInfo ?? selectedNativeCamera()) {
  if (!info) return 0;
  const sensor = Number(info.sensorOrientation) || 0;
  const device = Number(screen.orientation?.angle ?? window.orientation ?? 0) || 0;
  const sign = info.facing === "front" ? 1 : -1;
  return ((sensor - device * sign) % 360 + 360) % 360;
}'''
new_rotation = '''function nativePreviewRotation(info = nativeCameraInfo ?? selectedNativeCamera()) {
  if (!info) return 0;
  const sensor = Number(info.sensorOrientation) || 0;
  const device = Number(screen.orientation?.angle ?? window.orientation ?? 0) || 0;
  // Android Camera2: rear output rotates against device rotation; front output
  // rotates with it (mirroring is a separate display concern). The old signs
  // were reversed, which broke landscape and some 270-degree sensors.
  const rotation = info.facing === "front" ? sensor + device : sensor - device;
  return ((rotation % 360) + 360) % 360;
}'''
replace_once(receiver, old_rotation, new_rotation, "native preview rotation")

old_selected = '''function selectedNativeCamera() {
  const cameras = nativeCameraCatalog?.cameras ?? [];
  if (preferredCameraDeviceId) {
    const explicit = cameras.find((camera) => camera.id === preferredCameraDeviceId);
    if (explicit) return explicit;
  }
  return cameras.find((camera) => camera.facing === "rear" && camera.modes?.length)
    ?? cameras.find((camera) => camera.modes?.length)
    ?? cameras[0];
}'''
new_selected = '''function selectedNativeCamera() {
  const cameras = nativeCameraCatalog?.cameras ?? [];
  const usable = (camera) => camera?.modes?.some((mode) => mode.pipeline === "yuv" && !mode.highSpeed);
  if (preferredCameraDeviceId) {
    const explicit = cameras.find((camera) => camera.id === preferredCameraDeviceId && usable(camera));
    if (explicit) return explicit;
  }
  return cameras.find((camera) => camera.facing === "rear" && usable(camera))
    ?? cameras.find(usable)
    ?? cameras[0];
}'''
replace_once(receiver, old_selected, new_selected, "native camera YUV selection")

start = receiver.read_text(encoding="utf-8")
old_mode = '''function nativeAutoMode(camera) {
  const modes = camera?.modes ?? [];
  const exact = (width, height, fps, pipeline) => modes.find((mode) =>
    mode.width === width && mode.height === height && mode.fps === fps && mode.fixedFps &&
    (!pipeline || mode.pipeline === pipeline));
  // Prefer direct YUV frames. PRIVATE/GPU modes require a synchronous full-frame
  // readback before native decode and are a useful manual experiment, not a safe
  // automatic default on phones where YUV tops out below 60 fps.
  return exact(1280, 720, 60, "yuv")
    ?? exact(1280, 720, 30, "yuv")
    ?? exact(1920, 1080, 30, "yuv")
    ?? modes.find((mode) => mode.pipeline === "yuv" && mode.fps === 30 && mode.fixedFps)
    ?? modes.find((mode) => mode.pipeline === "yuv" && mode.fixedFps)
    ?? exact(1280, 720, 60)
    ?? exact(1920, 1080, 60)
    ?? modes.find((mode) => mode.fps === 60 && mode.fixedFps)
    ?? modes.find((mode) => mode.fps === 60)
    ?? modes[modes.length - 1];
}'''
new_mode = '''function nativeAutoMode(camera) {
  const modes = (camera?.modes ?? []).filter((mode) => mode.pipeline === "yuv" && !mode.highSpeed);
  const exact = (width, height, fps) => modes.find((mode) =>
    mode.width === width && mode.height === height && mode.fps === fps && mode.fixedFps);
  // Keep the production native path on direct ImageReader YUV. PRIVATE/GPU
  // modes synchronously glReadPixels a full frame and only produce luma preview;
  // leave them out until that experimental path has real-device validation.
  return exact(1280, 720, 60)
    ?? exact(1280, 720, 30)
    ?? exact(1920, 1080, 30)
    ?? modes.find((mode) => mode.fps === 30 && mode.fixedFps)
    ?? modes.find((mode) => mode.fixedFps)
    ?? modes[0];
}'''
replace_once(receiver, old_mode, new_mode, "native auto YUV-only mode")

old_modes = '''  browserModes = (camera?.modes ?? []).map((mode) => ({ ...mode, label: nativeModeLabel(mode) }))
    .sort((a, b) => a.width - b.width || a.height - b.height || a.fps - b.fps);'''
new_modes = '''  browserModes = (camera?.modes ?? [])
    .filter((mode) => mode.pipeline === "yuv" && !mode.highSpeed)
    .map((mode) => ({ ...mode, label: nativeModeLabel(mode) }))
    .sort((a, b) => a.width - b.width || a.height - b.height || a.fps - b.fps);'''
replace_once(receiver, old_modes, new_modes, "hide native GPU modes")

old_decode = '''    try {
        ImageView image(crop, w, h, ImageFormat::Lum, stride, 1);
        auto options = ReaderOptions()
                .formats(BarcodeFormat::QRCode)
                .tryHarder(tryHarder == JNI_TRUE)
                .tryRotate(false)
                .tryInvert(false)
                .tryDownscale(tryDownscale == JNI_TRUE)
                .returnErrors(returnErrors == JNI_TRUE)
                .maxNumberOfSymbols(std::max(1, static_cast<int>(maxSymbols)));
        auto barcodes = ReadBarcodes(image, options);

        const int count = static_cast<int>(barcodes.size());
'''
new_decode = '''    try {
        ImageView image(crop, w, h, ImageFormat::Lum, stride, 1);
        const auto read = [&](bool downscale, bool errors) {
            auto options = ReaderOptions()
                    .formats(BarcodeFormat::QRCode)
                    .tryHarder(tryHarder == JNI_TRUE)
                    .tryRotate(false)
                    .tryInvert(false)
                    .tryDownscale(downscale)
                    .returnErrors(errors)
                    .maxNumberOfSymbols(std::max(1, static_cast<int>(maxSymbols)));
            return ReadBarcodes(image, options);
        };
        auto barcodes = read(tryDownscale == JNI_TRUE, returnErrors == JNI_TRUE);
        const auto validPayload = [](const auto& barcode) {
            return barcode.isValid() && !barcode.bytes().empty();
        };
        // Match the browser acquisition path: dense full-resolution finder first,
        // then immediately retry the scale pyramid when the dense pass yields no
        // valid AirGapper QR. Native v2 previously omitted this retry entirely.
        if (tryDownscale != JNI_TRUE && std::max(w, h) >= 900 &&
                std::none_of(barcodes.begin(), barcodes.end(), validPayload)) {
            auto fallback = read(true, false);
            if (std::any_of(fallback.begin(), fallback.end(), validPayload))
                barcodes = std::move(fallback);
        }

        const int count = static_cast<int>(barcodes.size());
'''
replace_once(jni, old_decode, new_decode, "native acquisition scale fallback")

# Release metadata.
replace_all(Path("index.html"), "v0.5.360", "v0.5.361", 2, "index version")
replace_once(Path("main.js"), 'const APP_BUILD = "v0.5.360";', 'const APP_BUILD = "v0.5.361";', "main build")
replace_once(receiver, 'const RECEIVER_RUNTIME_BUILD = "v0.5.360";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.361";', "receiver build")
replace_once(Path("sw.js"), 'const CACHE = "airgapper-static-js-v360";', 'const CACHE = "airgapper-static-js-v361";', "service worker cache")
replace_once(Path("android/app/build.gradle"), "versionCode 360", "versionCode 361", "android version code")
replace_once(Path("android/app/build.gradle"), 'versionName "0.5.360"', 'versionName "0.5.361"', "android version name")

print("AIRGAPPER_V361_PATCH_OK")
