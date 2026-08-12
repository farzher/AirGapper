import assert from "node:assert/strict";
import test from "node:test";
import { PlainQrPolicy } from "../shared/plain-qr-policy.ts";

test("plain QR text must remain stable before it can finish", () => {
  const policy = new PlainQrPolicy(2000, 3);
  assert.equal(policy.addPlain("hello", 100), null);
  assert.equal(policy.addPlain("hello", 1000), null);
  assert.equal(policy.addPlain("hello", 2099), null);
  assert.equal(policy.addPlain("hello", 2100), "hello");
});

test("changing plain decodes restarts the settling window", () => {
  const policy = new PlainQrPolicy(1000, 2);
  assert.equal(policy.addPlain("0658", 0), null);
  assert.equal(policy.addPlain("different", 900), null);
  assert.equal(policy.addPlain("different", 1500), null);
  assert.equal(policy.addPlain("different", 1900), "different");
});

test("one fountain frame permanently suppresses plain QR candidates", () => {
  const policy = new PlainQrPolicy(100, 2);
  assert.equal(policy.addPlain("0658", 0), null);
  policy.noteFramed();
  assert.equal(policy.addPlain("0658", 1000), null);
  assert.equal(policy.addPlain("0658", 2000), null);
});

test("reset permits a plain QR in the next receive session", () => {
  const policy = new PlainQrPolicy(100, 2);
  policy.noteFramed();
  policy.reset();
  assert.equal(policy.addPlain("hello", 0), null);
  assert.equal(policy.addPlain("hello", 100), "hello");
});
