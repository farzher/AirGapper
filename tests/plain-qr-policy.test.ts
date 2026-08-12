import assert from "node:assert/strict";
import test from "node:test";
import { PlainQrPolicy } from "../shared/plain-qr-policy.ts";

test("the same plain QR in two scans is accepted", () => {
  const policy = new PlainQrPolicy();
  assert.equal(policy.addPlain("hello", 1), null);
  assert.equal(policy.addPlain("hello", 2), "hello");
});

test("duplicate results from one scan count only once", () => {
  const policy = new PlainQrPolicy();
  assert.equal(policy.addPlain("hello", 1), null);
  assert.equal(policy.addPlain("hello", 1), null);
  assert.equal(policy.addPlain("hello", 2), "hello");
});

test("multiple normal QRs do not reset each other's matches", () => {
  const policy = new PlainQrPolicy();
  assert.equal(policy.addPlain("first", 1), null);
  assert.equal(policy.addPlain("second", 1), null);
  assert.equal(policy.addPlain("first", 2), "first");
});

test("one fountain frame permanently suppresses plain QR candidates", () => {
  const policy = new PlainQrPolicy();
  assert.equal(policy.addPlain("0658", 1), null);
  policy.noteFramed();
  assert.equal(policy.addPlain("0658", 2), null);
  assert.equal(policy.addPlain("0658", 3), null);
});

test("reset permits a plain QR in the next receive session", () => {
  const policy = new PlainQrPolicy();
  policy.noteFramed();
  policy.reset();
  assert.equal(policy.addPlain("hello", 1), null);
  assert.equal(policy.addPlain("hello", 2), "hello");
});
