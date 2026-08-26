import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const runtime = fs.readFileSync(new URL("../receive/runtime.js", import.meta.url), "utf8");
const constraints = fs.readFileSync(new URL("../receive/camera-constraints.js", import.meta.url), "utf8");

assert.match(html, /<select id="camera-exposure"[^>]*><\/select>/, "manual shutter should be an exact-value select");
assert.match(html, /<select id="camera-iso"[^>]*><\/select>/, "manual ISO should be an exact-value select");
assert.doesNotMatch(html, /id="camera-exposure"[^>]*type="range"/, "manual shutter slider must not return");
assert.doesNotMatch(html, /id="camera-iso"[^>]*type="range"/, "manual ISO slider must not return");
assert.match(html, /id="camera-optics-readback"[^>]*aria-live="polite"/, "manual optics needs live actual sensor readback");
assert.match(runtime, /window\.addEventListener\("airgapper:exposure-settled"/, "runtime must adopt confirmed hardware substitutions");
assert.match(runtime, /populateManualSelect\([\s\S]{0,100}cameraExposure/, "shutter options should come from camera capabilities");
assert.match(runtime, /populateManualSelect\([\s\S]{0,100}cameraIso/, "ISO options should come from camera capabilities");
assert.doesNotMatch(runtime, /cameraExposure\.addEventListener\("input"/, "select changes should not issue drag-style camera writes");
assert.doesNotMatch(constraints, /exposure-axis-auto|iso-axis-auto/, "constraint layer must not reference removed per-axis Auto controls");

console.log("AIRGAPPER_MANUAL_OPTICS_UI_PASS");
