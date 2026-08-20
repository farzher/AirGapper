from pathlib import Path


def replace_once(path, old, new):
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit(f"expected patch anchor missing in {path}: {old[:100]!r}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


java = "android/app/src/main/java/com/airgapper/app/NativeCameraV2Bridge.java"
replace_once(java,
'''import android.util.Range;\nimport android.util.Rational;\nimport android.util.Size;''',
'''import android.util.Base64;\nimport android.util.Range;\nimport android.util.Rational;\nimport android.util.Size;''')
replace_once(java,
'''    private static final long PREVIEW_INTERVAL_NS = 200_000_000L;''',
'''    private static final long PREVIEW_INTERVAL_NS = 200_000_000L;\n    private static final long BINARY_ACK_GRACE_NS = 350_000_000L;''')
replace_once(java,
'''    private volatile JavaScriptReplyProxy replyProxy;\n    private volatile boolean running;''',
'''    private volatile JavaScriptReplyProxy replyProxy;\n    private volatile boolean binaryTransportAcked;\n    private volatile boolean binaryFallbackActive;\n    private volatile long firstBinaryPostNs;\n    private volatile boolean running;''')
replace_once(java,
'''                case "apply": applyRequested(command); break;\n                case "plan": setDecodePlan(DecodePlan.parse(command.optJSONObject("plan"))); break;''',
'''                case "apply": applyRequested(command); break;\n                case "plan": setDecodePlan(DecodePlan.parse(command.optJSONObject("plan"))); break;\n                case "binaryAck": binaryTransportAcked = true; binaryFallbackActive = false; break;''')
replace_once(java,
'''    private void postBinary(byte[] bytes) {\n        if (bytes == null) return;\n        activity.runOnUiThread(() -> {\n            JavaScriptReplyProxy proxy = replyProxy;\n            if (proxy == null) return;\n            try { proxy.postMessage(bytes); } catch (Exception ignored) {}\n        });\n    }''',
'''    private void postBinary(byte[] bytes) {\n        if (bytes == null) return;\n        activity.runOnUiThread(() -> {\n            JavaScriptReplyProxy proxy = replyProxy;\n            if (proxy == null) return;\n            long now = System.nanoTime();\n            if (!binaryTransportAcked && firstBinaryPostNs > 0 && now - firstBinaryPostNs >= BINARY_ACK_GRACE_NS)\n                binaryFallbackActive = true;\n            if (binaryFallbackActive && !binaryTransportAcked) {\n                postBinaryFallback(proxy, bytes);\n                return;\n            }\n            try {\n                proxy.postMessage(bytes);\n                if (firstBinaryPostNs == 0) firstBinaryPostNs = now;\n            } catch (Exception error) {\n                binaryFallbackActive = true;\n                postBinaryFallback(proxy, bytes);\n            }\n        });\n    }\n\n    private void postBinaryFallback(JavaScriptReplyProxy proxy, byte[] bytes) {\n        try {\n            JSONObject value = new JSONObject();\n            value.put("event", "binaryFallback");\n            value.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));\n            proxy.postMessage(value.toString());\n        } catch (Exception error) {\n            postEvent("decodeError", "Camera2 v2 binary bridge failed: " + message(error));\n        }\n    }''')

js = "shared/native-camera-v2.js"
replace_once(js,
'''const pending = new Map();\n\nconst RESULT_MAGIC''',
'''const pending = new Map();\nlet binaryAckSent = false;\n\nconst RESULT_MAGIC''')
replace_once(js,
'''function parseBinary(buffer) {\n  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 8) return null;\n  const view = new DataView(buffer);\n  const magic = view.getUint32(0, true);\n  if (magic === PREVIEW_MAGIC) return parsePreview(buffer, view);\n  if (magic === RESULT_MAGIC) return parseDecodeResult(buffer, view);\n  return null;\n}\n\nfunction install() {''',
'''function parseBinary(buffer) {\n  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 8) return null;\n  const view = new DataView(buffer);\n  const magic = view.getUint32(0, true);\n  if (magic === PREVIEW_MAGIC) return parsePreview(buffer, view);\n  if (magic === RESULT_MAGIC) return parseDecodeResult(buffer, view);\n  return null;\n}\n\nfunction dispatchBinary(buffer) {\n  const packet = parseBinary(buffer);\n  if (!packet) return false;\n  if (packet.type === "preview") {\n    try { previewHandler?.(packet); } catch (error) { console.error("Native camera v2 preview handler failed", error); }\n  } else {\n    activeTrack?._update({\n      exposureTime: packet.exposureTimeNs > 0 ? packet.exposureTimeNs / 100000 : undefined,\n      iso: packet.iso > 0 ? packet.iso : undefined,\n      focusDistance: packet.focusDistance,\n      settingsEpoch: packet.settingsEpoch\n    });\n    try { resultHandler?.(packet); } catch (error) { console.error("Native camera v2 result handler failed", error); }\n  }\n  return true;\n}\n\nfunction acknowledgeBinaryTransport() {\n  if (binaryAckSent) return;\n  binaryAckSent = true;\n  try { endpoint.postMessage(JSON.stringify({ op: "binaryAck" })); } catch {}\n}\n\nfunction base64ArrayBuffer(value) {\n  const raw = atob(String(value || ""));\n  const bytes = new Uint8Array(raw.length);\n  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);\n  return bytes.buffer;\n}\n\nfunction install() {''')
replace_once(js,
'''    if (data instanceof ArrayBuffer) {\n      const packet = parseBinary(data);\n      if (!packet) return;\n      if (packet.type === "preview") {\n        try { previewHandler?.(packet); } catch (error) { console.error("Native camera v2 preview handler failed", error); }\n      } else {\n        activeTrack?._update({\n          exposureTime: packet.exposureTimeNs > 0 ? packet.exposureTimeNs / 100000 : undefined,\n          iso: packet.iso > 0 ? packet.iso : undefined,\n          focusDistance: packet.focusDistance,\n          settingsEpoch: packet.settingsEpoch\n        });\n        try { resultHandler?.(packet); } catch (error) { console.error("Native camera v2 result handler failed", error); }\n      }\n      return;\n    }\n    if (typeof data !== "string") return;\n    let message;\n    try { message = JSON.parse(data); } catch { return; }''',
'''    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {\n      const buffer = data instanceof ArrayBuffer\n        ? data\n        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);\n      if (dispatchBinary(buffer)) acknowledgeBinaryTransport();\n      return;\n    }\n    if (typeof data !== "string") return;\n    let message;\n    try { message = JSON.parse(data); } catch { return; }\n    if (message?.event === "binaryFallback") {\n      try {\n        if (!dispatchBinary(base64ArrayBuffer(message.data))) console.warn("Native camera v2 fallback packet was invalid");\n      } catch (error) {\n        console.warn("Native camera v2 fallback packet failed", error);\n      }\n      return;\n    }''')

receiver = "receive/main.js"
replace_once(receiver,
'''  const futureGen = captureGen + 1;\n  let started, transportError;\n  try {\n    [started, transportError] = await Promise.all([''',
'''  const futureGen = captureGen + 1;\n  // Install preview delivery before Camera2 starts. Some devices begin producing\n  // frames immediately after session configuration, before the start reply has\n  // crossed back into WebView. Dropping those first packets made a healthy\n  // native session look like a black/blank camera.\n  setNativeCameraV2PreviewHandler(drawNativeV2Preview);\n  let started, transportError;\n  try {\n    [started, transportError] = await Promise.all([''')
replace_once(receiver,
'''  } catch (error) {\n    void stopNativeCameraV2();\n    if (startAttempt !== cameraStartGen || receiverPaused) return;\n    pool.resize(0);\n    offerRetry(`Native Camera2 NDK: ${error instanceof Error ? error.message : String(error)}`);\n    return;\n  }\n  if (transportError) {\n    void stopNativeCameraV2(); pool.resize(0);''',
'''  } catch (error) {\n    setNativeCameraV2PreviewHandler();\n    void stopNativeCameraV2();\n    if (startAttempt !== cameraStartGen || receiverPaused) return;\n    pool.resize(0);\n    offerRetry(`Native Camera2 NDK: ${error instanceof Error ? error.message : String(error)}`);\n    return;\n  }\n  if (transportError) {\n    setNativeCameraV2PreviewHandler();\n    void stopNativeCameraV2(); pool.resize(0);''')
replace_once(receiver,
'''  if (startAttempt !== cameraStartGen || receiverPaused) { void stopNativeCameraV2(); return; }''',
'''  if (startAttempt !== cameraStartGen || receiverPaused) {\n    setNativeCameraV2PreviewHandler();\n    void stopNativeCameraV2();\n    return;\n  }''')
replace_once(receiver,
'''  syncNativePreviewAspect(started.width ?? requestedWidth, started.height ?? requestedHeight, started);\n  setNativeCameraV2PreviewHandler(drawNativeV2Preview);\n  setNativeCameraV2ResultHandler(completeNativeV2Job);''',
'''  syncNativePreviewAspect(started.width ?? requestedWidth, started.height ?? requestedHeight, started);\n  setNativeCameraV2ResultHandler(completeNativeV2Job);''')

smoke = r'''import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const calls = [];
const endpoint = {
  onmessage: undefined,
  postMessage(raw) {
    const message = JSON.parse(raw);
    calls.push(message);
    if (message.op === "binaryAck" || message.op === "plan") return;
    if (!message.requestId) return;
    queueMicrotask(() => {
      let response;
      if (message.op === "list") {
        response = { requestId: message.requestId, ok: true, supported: true, cameras: [] };
      } else if (message.op === "start") {
        response = {
          requestId: message.requestId,
          ok: true,
          cameraId: message.cameraId,
          width: message.width,
          height: message.height,
          fps: message.fps,
          sensorFps: message.sensorFps,
          pipeline: message.pipeline,
          fpsControl: message.fpsControl,
          highSpeed: Boolean(message.highSpeed),
          fixedFps: true,
          sensorOrientation: 90,
          facing: "rear",
          capabilities: { exposureMode: ["continuous"] },
          settings: { exposureMode: "continuous", settingsEpoch: 1 }
        };
      } else if (message.op === "stop") {
        response = { requestId: message.requestId, ok: true };
      } else if (message.op === "apply") {
        response = { requestId: message.requestId, ok: true, settings: { ...message.patch } };
      } else {
        response = { requestId: message.requestId, ok: false, error: `unexpected op ${message.op}` };
      }
      endpoint.onmessage?.({ data: JSON.stringify(response) });
    });
  }
};

globalThis.AirGapperNativeCameraV2 = endpoint;
const source = readFileSync(new URL("../shared/native-camera-v2.js", import.meta.url), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const native = await import(moduleUrl);

assert.equal(native.nativeCameraV2Available(), true);
const started = await native.startNativeCameraV2({
  cameraId: "0", width: 1280, height: 720, fps: 30, sensorFps: 30,
  pipeline: "yuv", fpsControl: "ae", highSpeed: false
});
assert.equal(started.width, 1280);
assert.equal(native.nativeCameraV2Track()?.readyState, "live");

const previews = [];
const frames = [];
native.setNativeCameraV2PreviewHandler((preview) => previews.push(preview));
native.setNativeCameraV2FrameHandler((frame) => frames.push(frame));

function previewPacket() {
  const buffer = new ArrayBuffer(32);
  const view = new DataView(buffer);
  view.setUint32(0, 0x32565041, true);
  view.setUint16(4, 28, true);
  view.setUint16(6, 1, true);
  view.setInt32(8, 2, true);
  view.setInt32(12, 2, true);
  view.setInt32(16, 90, true);
  view.setInt32(20, 1280, true);
  view.setInt32(24, 720, true);
  new Uint8Array(buffer, 28).set([10, 20, 30, 40]);
  return buffer;
}

const direct = previewPacket();
endpoint.onmessage({ data: direct });
assert.equal(previews.length, 1);
assert.deepEqual([...previews[0].y], [10, 20, 30, 40]);
assert.ok(calls.some((call) => call.op === "binaryAck"), "native-v2 must acknowledge working ArrayBuffer delivery");

const viewPacket = new Uint8Array(previewPacket());
endpoint.onmessage({ data: viewPacket });
assert.equal(previews.length, 2, "native-v2 should accept ArrayBuffer views defensively");

const fallbackBytes = new Uint8Array(previewPacket());
endpoint.onmessage({ data: JSON.stringify({
  event: "binaryFallback",
  data: Buffer.from(fallbackBytes).toString("base64")
}) });
assert.equal(previews.length, 3, "base64 fallback must use the same preview parser");
assert.deepEqual([...previews[2].y], [10, 20, 30, 40]);

endpoint.onmessage({ data: JSON.stringify({
  event: "frame", width: 1280, height: 720, frameNumber: 7,
  timestampNs: 123456, settingsEpoch: 2, settings: { iso: 320 }
}) });
assert.equal(frames.length, 1);
assert.equal(frames[0].frameNumber, 7);
assert.equal(native.nativeCameraV2Track().getSettings().iso, 320);

assert.equal(native.submitNativeCameraV2Plan({ mode: "full", jobId: 9, sourceSequence: 9 }), true);
assert.ok(calls.some((call) => call.op === "plan"));

const track = native.nativeCameraV2Track();
await native.stopNativeCameraV2();
assert.equal(track.readyState, "ended");
assert.equal(native.nativeCameraV2Track(), undefined);

console.log("AIRGAPPER_NATIVE_CAMERA_V2_BRIDGE_SMOKE_OK");
'''
Path("benchmark/native-camera-v2-bridge-smoke.mjs").write_text(smoke, encoding="utf-8")

workflow = ".github/workflows/fast-regression.yml"
replace_once(workflow,
'''          node benchmark/native-y8-worker-smoke.mjs\n          node benchmark/native-camera-bridge-smoke.mjs\n          node benchmark/corpus-suite.mjs''',
'''          node benchmark/native-y8-worker-smoke.mjs\n          node benchmark/native-camera-bridge-smoke.mjs\n          node benchmark/native-camera-v2-bridge-smoke.mjs\n          node benchmark/corpus-suite.mjs''')

print("native-v2 preview hotfix applied")
