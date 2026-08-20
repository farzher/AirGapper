import assert from "node:assert/strict";
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

const viewPacket = new Uint8Array(previewPacket());
endpoint.onmessage({ data: viewPacket });
assert.equal(previews.length, 3, "native-v2 should accept ArrayBuffer views defensively");

const fallbackBytes = new Uint8Array(previewPacket());
endpoint.onmessage({ data: JSON.stringify({
  event: "binaryFallback",
  data: Buffer.from(fallbackBytes).toString("base64")
}) });
assert.equal(previews.length, 4, "base64 fallback must use the same preview parser");
assert.deepEqual([...previews[3].y], [10, 20, 30, 40]);

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
