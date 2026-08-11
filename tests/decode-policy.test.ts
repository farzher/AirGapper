import assert from "node:assert/strict";
import test from "node:test";
import { shouldRunFullDecode } from "../shared/decode-policy.ts";

test("tracked failure always falls back to full QR acquisition", () => {
  assert.equal(shouldRunFullDecode(false, true, false), true);
  assert.equal(shouldRunFullDecode(false, true, true), false);
  assert.equal(shouldRunFullDecode(false, false, false), true);
  assert.equal(shouldRunFullDecode(true, false, false), true);
});
