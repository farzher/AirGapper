import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const calls = [];
const order = [];
const endpoint = {
  onmessage: undefined,
  postMessage(raw) {
    const message = JSON.parse(raw);
    calls.push(message);
    if (message.op === "ack") {
      order.push("ack");
      return;
    }
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
          pipeline: message.pipeline,
          fpsControl: message.fpsControl,
          capabilities: {
            focusMode: ["continuous", "single-shot", "manual"],
            focusDistance: { min: 0, max: 10, step: 0.05 },
            exposureMode: ["continuous", "manual"],
            exposureTime: { min: 1, max: 100, step: 0.1 },
            iso: { min: 50, max: 3200, step: 1 }
          },
          settings: {
            focusMode: "continuous",
            focusDistance: 1,
            exposureMode: "continuous",
            exposureTime: 35,
            iso: 200,
            exposureCompensation: 0
          }
        };
      } else if (message.op === "apply") {
        response = {
          requestId: message.requestId,
          ok: true,
          settings: { ...message.patch }
        };
      } else if (message.op === "stop") {
        response = { requestId: message.requestId, ok: true };
      } else {
        response = { requestId: message.requestId, ok: false, error: `unexpected op ${message.op}` };
      }
      endpoint.onmessage?.({ data: JSON.stringify(response) });
    });
  }
};

globalThis.AirGapperNativeCamera = endpoint;
const source = readFileSync(new URL("../shared/native-camera.js", import.meta.url), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const native = await import(moduleUrl);

assert.equal(native.nativeCameraAvailable(), true);
const started = await native.startNativeCamera({
  cameraId: "0",
  width: 2560,
  height: 1440,
  fps: 60,
  pipeline: "gpu",
  fpsControl: "manual"
});
assert.equal(started.fps, 60);

const track = native.nativeCameraTrack();
assert.ok(track);
assert.equal(track.readyState, "live");
assert.equal(track.getSettings().frameRate, 60);
assert.ok(track.getCapabilities().exposureMode.includes("manual"));

await track.applyConstraints({
  advanced: [{ exposureMode: "manual", exposureTime: 28, iso: 320 }]
});
const apply = calls.findLast((call) => call.op === "apply");
assert.deepEqual(apply.patch, { exposureMode: "manual", exposureTime: 28, iso: 320 });
assert.equal(track.getSettings().exposureTime, 28);
assert.equal(track.getSettings().iso, 320);

native.setNativeCameraFrameHandler(() => order.push("frame"));
endpoint.onmessage({ data: new ArrayBuffer(64) });
assert.deepEqual(order.slice(-2), ["ack", "frame"], "native frame credit must be returned before receive work begins");

await native.stopNativeCamera();
assert.equal(track.readyState, "ended");
assert.equal(native.nativeCameraTrack(), undefined);

console.log("AIRGAPPER_NATIVE_CAMERA_BRIDGE_SMOKE_OK");
