import assert from "node:assert/strict";
import test from "node:test";
import { PlainQrPolicy } from "../shared/plain-qr-policy.ts";

test("the same plain QR twice in a row is accepted", () => {
  const policy = new PlainQrPolicy();
  assert.equal(policy.addPlain("hello"), null);
  assert.equal(policy.addPlain("hello"), "hello");
});

test("changing plain decodes restarts the consecutive match", () => {
  const policy = new PlainQrPolicy();
  assert.equal(policy.addPlain("0658"), null);
  assert.equal(policy.addPlain("different"), null);
  assert.equal(policy.addPlain("0658"), null);
  assert.equal(policy.addPlain("0658"), "0658");
});

test("one fountain frame permanently suppresses plain QR candidates", () => {
  const policy = new PlainQrPolicy();
  assert.equal(policy.addPlain("0658"), null);
  policy.noteFramed();
  assert.equal(policy.addPlain("0658"), null);
  assert.equal(policy.addPlain("0658"), null);
});

test("reset permits a plain QR in the next receive session", () => {
  const policy = new PlainQrPolicy();
  policy.noteFramed();
  policy.reset();
  assert.equal(policy.addPlain("hello"), null);
  assert.equal(policy.addPlain("hello"), "hello");
});
