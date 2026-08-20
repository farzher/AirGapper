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


def replace_all_exact(path, old, new, expected, label):
    text = path.read_text(encoding="utf-8")
    if old not in text and text.count(new) == expected:
        return False
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"{label}: expected {expected} matches, found {count}")
    path.write_text(text.replace(old, new), encoding="utf-8")
    return True


java = Path("android/app/src/main/java/com/airgapper/app/NativeCameraV2Bridge.java")
js_bridge = Path("shared/native-camera-v2.js")
receiver = Path("receive/main.js")
smoke = Path("benchmark/native-camera-v2-bridge-smoke.mjs")

changed = []

if replace_once(
    java,
    "    private static final long PREVIEW_INTERVAL_NS = 200_000_000L;",
    "    private static final long PREVIEW_INTERVAL_NS = 33_333_333L;\n    private static final long PREVIEW_FALLBACK_INTERVAL_NS = 100_000_000L;",
    "native preview cadence",
): changed.append(str(java))

text = java.read_text(encoding="utf-8")
old = "    private boolean previewDue() { return System.nanoTime() - lastPreviewNs >= PREVIEW_INTERVAL_NS; }\n\n    private void maybeSendPreview(ByteBuffer plane, int offset, int width, int height, int stride, long timestampNs) {\n        long now = System.nanoTime();\n        if (now - lastPreviewNs < PREVIEW_INTERVAL_NS || plane == null || width <= 0 || height <= 0) return;"
new = "    private long previewIntervalNs() {\n        return binaryFallbackActive && !binaryTransportAcked ? PREVIEW_FALLBACK_INTERVAL_NS : PREVIEW_INTERVAL_NS;\n    }\n\n    private boolean previewDue() { return System.nanoTime() - lastPreviewNs >= previewIntervalNs(); }\n\n    private static void samplePreviewPlane(Image.Plane plane, int sourceWidth, int sourceHeight,\n                                           byte[] packet, int outputOffset, int outputWidth, int outputHeight) {\n        ByteBuffer buffer = plane.getBuffer().duplicate();\n        int base = buffer.position();\n        int limit = buffer.limit();\n        int rowStride = plane.getRowStride();\n        int pixelStride = plane.getPixelStride();\n        for (int y = 0; y < outputHeight; y++) {\n            int sy = Math.min(sourceHeight - 1, (int) ((y + 0.5f) * sourceHeight / outputHeight));\n            int row = base + sy * rowStride;\n            for (int x = 0; x < outputWidth; x++) {\n                int sx = Math.min(sourceWidth - 1, (int) ((x + 0.5f) * sourceWidth / outputWidth));\n                int at = row + sx * pixelStride;\n                packet[outputOffset + y * outputWidth + x] = at >= base && at < limit ? buffer.get(at) : 0;\n            }\n        }\n    }\n\n    private void maybeSendYuvPreview(Image image) {\n        long now = System.nanoTime();\n        if (image == null || now - lastPreviewNs < previewIntervalNs()) return;\n        Image.Plane[] planes = image.getPlanes();\n        if (planes == null || planes.length < 3 || image.getWidth() <= 0 || image.getHeight() <= 0) return;\n        int width = image.getWidth();\n        int height = image.getHeight();\n        int outWidth = Math.min(320, width);\n        int outHeight = Math.max(2, Math.round(height * (outWidth / (float) width)));\n        outWidth &= ~1;\n        outHeight &= ~1;\n        if (outWidth < 2 || outHeight < 2) return;\n        int chromaWidth = outWidth / 2;\n        int chromaHeight = outHeight / 2;\n        int yBytes = outWidth * outHeight;\n        int chromaBytes = chromaWidth * chromaHeight;\n        byte[] packet = new byte[PREVIEW_HEADER_BYTES + yBytes + chromaBytes * 2];\n        ByteBuffer header = ByteBuffer.wrap(packet).order(ByteOrder.LITTLE_ENDIAN);\n        header.putInt(PREVIEW_MAGIC); header.putShort((short) PREVIEW_HEADER_BYTES); header.putShort((short) 2);\n        header.putInt(outWidth); header.putInt(outHeight); header.putInt(activeSensorOrientation);\n        header.putInt(width); header.putInt(height);\n        samplePreviewPlane(planes[0], width, height, packet, PREVIEW_HEADER_BYTES, outWidth, outHeight);\n        samplePreviewPlane(planes[1], (width + 1) / 2, (height + 1) / 2,\n                packet, PREVIEW_HEADER_BYTES + yBytes, chromaWidth, chromaHeight);\n        samplePreviewPlane(planes[2], (width + 1) / 2, (height + 1) / 2,\n                packet, PREVIEW_HEADER_BYTES + yBytes + chromaBytes, chromaWidth, chromaHeight);\n        lastPreviewNs = now;\n        postBinary(packet);\n    }\n\n    private void maybeSendPreview(ByteBuffer plane, int offset, int width, int height, int stride, long timestampNs) {\n        long now = System.nanoTime();\n        if (now - lastPreviewNs < previewIntervalNs() || plane == null || width <= 0 || height <= 0) return;"
if new not in text:
    if old not in text:
        raise SystemExit("native preview sender anchor not found")
    java.write_text(text.replace(old, new, 1), encoding="utf-8")
    if str(java) not in changed: changed.append(str(java))

if replace_all_exact(
    java,
    "maybeSendPreview(buffer, offset, image.getWidth(), image.getHeight(), plane.getRowStride(), image.getTimestamp());",
    "maybeSendYuvPreview(image);",
    1,
    "idle YUV preview",
):
    if str(java) not in changed: changed.append(str(java))
if replace_all_exact(
    java,
    "maybeSendPreview(buffer, offset, owned.getWidth(), owned.getHeight(), plane.getRowStride(), metadata.timestampNs);",
    "maybeSendYuvPreview(owned);",
    1,
    "decoded YUV preview",
):
    if str(java) not in changed: changed.append(str(java))

text = js_bridge.read_text(encoding="utf-8")
start = text.find("function parsePreview(buffer, view) {")
end = text.find("\nfunction parseDecodeResult", start)
if start < 0 or end < 0:
    raise SystemExit("parsePreview function anchors not found")
parse_preview = '''function parsePreview(buffer, view) {
  if (buffer.byteLength < PREVIEW_HEADER_BYTES) return null;
  const headerBytes = view.getUint16(4, true);
  const version = view.getUint16(6, true);
  const width = view.getInt32(8, true);
  const height = view.getInt32(12, true);
  if (headerBytes < PREVIEW_HEADER_BYTES || width <= 0 || height <= 0) return null;
  const yBytes = width * height;
  if (version === 1) {
    if (headerBytes + yBytes > buffer.byteLength) return null;
    return {
      type: "preview",
      format: "y8",
      width,
      height,
      orientation: view.getInt32(16, true),
      sourceWidth: view.getInt32(20, true),
      sourceHeight: view.getInt32(24, true),
      y: new Uint8Array(buffer, headerBytes, yBytes)
    };
  }
  if (version !== 2 || (width & 1) || (height & 1)) return null;
  const chromaWidth = width >> 1;
  const chromaHeight = height >> 1;
  const chromaBytes = chromaWidth * chromaHeight;
  if (headerBytes + yBytes + chromaBytes * 2 > buffer.byteLength) return null;
  return {
    type: "preview",
    format: "yuv420p",
    width,
    height,
    orientation: view.getInt32(16, true),
    sourceWidth: view.getInt32(20, true),
    sourceHeight: view.getInt32(24, true),
    y: new Uint8Array(buffer, headerBytes, yBytes),
    u: new Uint8Array(buffer, headerBytes + yBytes, chromaBytes),
    v: new Uint8Array(buffer, headerBytes + yBytes + chromaBytes, chromaBytes)
  };
}'''
if text[start:end] != parse_preview:
    js_bridge.write_text(text[:start] + parse_preview + text[end:], encoding="utf-8")
    changed.append(str(js_bridge))

text = receiver.read_text(encoding="utf-8")
old_mode = '''function nativeAutoMode(camera) {
  const modes = camera?.modes ?? [];
  const exact = (width, height, fps) => modes.find((mode) =>
    mode.width === width && mode.height === height && mode.fps === fps && mode.fixedFps);
  return exact(1280, 720, 60)
    ?? exact(1920, 1080, 60)
    ?? modes.find((mode) => mode.fps === 60 && mode.fixedFps)
    ?? modes.find((mode) => mode.fps === 60)
    ?? exact(1280, 720, 30)
    ?? modes[modes.length - 1];
}'''
new_mode = '''function nativeAutoMode(camera) {
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
if new_mode not in text:
    if text.count(old_mode) != 1:
        raise SystemExit(f"nativeAutoMode: expected one old function, found {text.count(old_mode)}")
    text = text.replace(old_mode, new_mode, 1)

start = text.find("function drawNativeV2Preview(packet) {")
end = text.find("\nfunction nativeV2SourceFrame", start)
if start < 0 or end < 0:
    raise SystemExit("drawNativeV2Preview function anchors not found")
draw_preview = '''function drawNativeV2Preview(packet) {
  if (!nativePreviewCtx || !packet?.y || !packet.width || !packet.height) return;
  const rotation = nativePreviewRotation({ sensorOrientation: packet.orientation, facing: nativeCameraInfo?.facing });
  const rotated = rotation === 90 || rotation === 270;
  const outWidth = rotated ? packet.height : packet.width;
  const outHeight = rotated ? packet.width : packet.height;
  if (nativePreview.width !== outWidth || nativePreview.height !== outHeight) {
    nativePreview.width = outWidth;
    nativePreview.height = outHeight;
    nativePreviewImage = void 0;
  }
  cameraBox.style.aspectRatio = `${outWidth} / ${outHeight}`;
  const rgba = nativePreviewImage ?? nativePreviewCtx.createImageData(outWidth, outHeight);
  nativePreviewImage = rgba;
  const color = packet.format === "yuv420p" && packet.u?.length && packet.v?.length;
  const chromaWidth = packet.width >> 1;
  const clampByte = (value) => value < 0 ? 0 : value > 255 ? 255 : value;
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      let sx = x, sy = y;
      if (rotation === 90) { sx = y; sy = packet.height - 1 - x; }
      else if (rotation === 180) { sx = packet.width - 1 - x; sy = packet.height - 1 - y; }
      else if (rotation === 270) { sx = packet.width - 1 - y; sy = x; }
      const luma = packet.y[sy * packet.width + sx];
      const at = (y * outWidth + x) * 4;
      if (color) {
        const uv = (sy >> 1) * chromaWidth + (sx >> 1);
        const c = Math.max(0, luma - 16) * 298;
        const d = packet.u[uv] - 128;
        const e = packet.v[uv] - 128;
        rgba.data[at] = clampByte((c + 409 * e + 128) >> 8);
        rgba.data[at + 1] = clampByte((c - 100 * d - 208 * e + 128) >> 8);
        rgba.data[at + 2] = clampByte((c + 516 * d + 128) >> 8);
      } else {
        rgba.data[at] = luma;
        rgba.data[at + 1] = luma;
        rgba.data[at + 2] = luma;
      }
      rgba.data[at + 3] = 255;
    }
  }
  nativePreviewCtx.putImageData(rgba, 0, 0);
}'''
if text[start:end] != draw_preview:
    text = text[:start] + draw_preview + text[end:]
receiver.write_text(text, encoding="utf-8")
if str(receiver) not in changed: changed.append(str(receiver))

text = smoke.read_text(encoding="utf-8")
anchor = '''const direct = previewPacket();
endpoint.onmessage({ data: direct });
assert.equal(previews.length, 1);
assert.deepEqual([...previews[0].y], [10, 20, 30, 40]);
assert.ok(calls.some((call) => call.op === "binaryAck"), "native-v2 must acknowledge working ArrayBuffer delivery");
'''
addition = anchor + '''
function colorPreviewPacket() {
  const buffer = new ArrayBuffer(34);
  const view = new DataView(buffer);
  view.setUint32(0, 0x32565041, true);
  view.setUint16(4, 28, true);
  view.setUint16(6, 2, true);
  view.setInt32(8, 2, true);
  view.setInt32(12, 2, true);
  view.setInt32(16, 90, true);
  view.setInt32(20, 1280, true);
  view.setInt32(24, 720, true);
  new Uint8Array(buffer, 28).set([81, 81, 81, 81, 90, 240]);
  return buffer;
}

endpoint.onmessage({ data: colorPreviewPacket() });
assert.equal(previews.length, 2);
assert.equal(previews[1].format, "yuv420p");
assert.deepEqual([...previews[1].y], [81, 81, 81, 81]);
assert.deepEqual([...previews[1].u], [90]);
assert.deepEqual([...previews[1].v], [240]);
'''
if "function colorPreviewPacket()" not in text:
    if text.count(anchor) != 1:
        raise SystemExit("preview smoke insertion anchor not found")
    text = text.replace(anchor, addition, 1)
    text = text.replace('assert.equal(previews.length, 2, "native-v2 should accept ArrayBuffer views defensively");',
                        'assert.equal(previews.length, 3, "native-v2 should accept ArrayBuffer views defensively");', 1)
    text = text.replace('assert.equal(previews.length, 3, "base64 fallback must use the same preview parser");',
                        'assert.equal(previews.length, 4, "base64 fallback must use the same preview parser");', 1)
    text = text.replace('assert.deepEqual([...previews[2].y], [10, 20, 30, 40]);',
                        'assert.deepEqual([...previews[3].y], [10, 20, 30, 40]);', 1)
    smoke.write_text(text, encoding="utf-8")
    changed.append(str(smoke))

# Release v0.5.360. Keep all user-visible/cache/app package versions aligned.
for path, replacements in {
    Path("index.html"): [("v0.5.359", "v0.5.360")],
    Path("main.js"): [("v0.5.359", "v0.5.360")],
    Path("receive/main.js"): [("v0.5.359", "v0.5.360")],
    Path("sw.js"): [("airgapper-static-js-v359", "airgapper-static-js-v360")],
    Path("android/app/build.gradle"): [("versionCode 359", "versionCode 360"), ('versionName "0.5.359"', 'versionName "0.5.360"')],
    Path(".github/workflows/build-apk.yml"): [("v0.5.359", "v0.5.360")],
}.items():
    text = path.read_text(encoding="utf-8")
    updated = text
    for old_value, new_value in replacements:
        if old_value in updated:
            updated = updated.replace(old_value, new_value)
        elif new_value not in updated:
            raise SystemExit(f"{path}: missing both {old_value!r} and {new_value!r}")
    if updated != text:
        path.write_text(updated, encoding="utf-8")
        if str(path) not in changed: changed.append(str(path))

print("patched:", ", ".join(changed) if changed else "already applied")
