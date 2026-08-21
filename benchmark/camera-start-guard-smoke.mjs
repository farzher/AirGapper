import assert from "node:assert/strict";

let resolveFirst;
let calls = 0;
let lastConstraints;
const mediaDevices = {
  getUserMedia(constraints) {
    calls++;
    lastConstraints = constraints;
    if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
    if (calls === 2) return Promise.reject(new DOMException("denied", "NotAllowedError"));
    return Promise.resolve({ id: calls });
  }
};

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)",
    platform: "iPad",
    maxTouchPoints: 5,
    mediaDevices
  }
});

const guard = await import(`../shared/camera-start-guard.js?smoke=${Date.now()}`);
guard.installCameraStartGuard();

const first = navigator.mediaDevices.getUserMedia({
  audio: false,
  video: {
    width: { exact: 1280 },
    height: { exact: 720 },
    frameRate: { exact: 30 },
    deviceId: { exact: "rear-camera" }
  }
});
assert.equal(guard.cameraRequestPending(), true, "pending camera request should be observable by lifecycle code");
assert.deepEqual(lastConstraints.video.width, { ideal: 1280 });
assert.deepEqual(lastConstraints.video.height, { ideal: 720 });
assert.deepEqual(lastConstraints.video.frameRate, { ideal: 30 });
assert.deepEqual(lastConstraints.video.deviceId, { exact: "rear-camera" }, "camera identity must remain exact");
resolveFirst({ id: 1 });
await first;
assert.equal(guard.cameraRequestPending(), false);

await assert.rejects(
  navigator.mediaDevices.getUserMedia({ video: { width: { exact: 1280 } } }),
  (error) => error?.name === "NotAllowedError"
);
assert.equal(calls, 2);
await assert.rejects(
  navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 } } }),
  (error) => error?.name === "NotAllowedError"
);
assert.equal(calls, 2, "immediate exact→ideal fallback must not open a second iOS permission request");

console.log("camera-start-guard smoke passed");
