import assert from "node:assert/strict";

const events = [];
globalThis.document = {
  addEventListener() {},
  getElementById() { return null; }
};
globalThis.window = {
  addEventListener() {},
  dispatchEvent(event) {
    events.push(event);
    return true;
  }
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
};

const { applyAdvancedConstraint } = await import("../receive/camera-constraints.js");

let settings = {
  exposureMode: "manual",
  exposureTime: 33.5,
  iso: 363,
  exposureCompensation: -1
};
let writes = 0;
const track = {
  readyState: "live",
  getCapabilities() {
    return {
      exposureMode: ["continuous", "manual"],
      exposureTime: { min: 1, max: 1000, step: 0.1 },
      iso: { min: 50, max: 3200, step: 1 },
      exposureCompensation: { min: -3, max: 3, step: 0.1 }
    };
  },
  getSettings() {
    return { ...settings };
  },
  async applyConstraints() {
    writes++;
    // Model a HAL that accepts the request but consistently substitutes its own
    // stable ISO/exposure combination. AirGapper must converge to this value
    // instead of writing the impossible requested target forever.
  }
};

const request = {
  exposureMode: "manual",
  exposureTime: 33.5,
  iso: 1295
};

assert.equal(await applyAdvancedConstraint(track, request), true);
assert.equal(writes, 1, "initial manual exposure request should write once");

// First matching observation suppresses an immediate retry but is deliberately
// not enough to declare the HAL result settled; getSettings() can lag a resolved
// applyConstraints() call on real camera stacks.
assert.equal(await applyAdvancedConstraint(track, request), true);
assert.equal(writes, 1, "first stable observation should not rewrite camera");
await Promise.resolve();
assert.equal(events.length, 0, "one observation must not publish a settled HAL value");

// A repeated identical observation is strong enough to adopt the actual value.
assert.equal(await applyAdvancedConstraint(track, request), true);
assert.equal(writes, 1, "confirmed stable HAL substitution should not rewrite camera");
await Promise.resolve();
assert.equal(events.length, 1, "stable HAL substitution should be reported once");
assert.equal(events[0].type, "airgapper:exposure-settled");
assert.equal(events[0].detail.track, track);
assert.equal(events[0].detail.requested.iso, 1295);
assert.equal(events[0].detail.actual.iso, 363);

// Further maintenance passes remain quiet after convergence.
assert.equal(await applyAdvancedConstraint(track, request), true);
await Promise.resolve();
assert.equal(writes, 1);
assert.equal(events.length, 1);

// If hardware state actually moves, the old settled snapshot is no longer
// authoritative and a fresh transaction is allowed.
settings = { ...settings, iso: 500 };
assert.equal(await applyAdvancedConstraint(track, request), true);
assert.equal(writes, 2, "changed hardware state should permit a fresh write");

console.log("AIRGAPPER_CAMERA_CONSTRAINTS_PASS", JSON.stringify({
  writes,
  settledIso: events[0].detail.actual.iso
}));
