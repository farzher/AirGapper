import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateTransferProgress,
  expectedFountainOverhead,
  formatDuration,
} from "../shared/progress.ts";

// k=100 is a ~300 KB file at 2953 bytes/frame — a very ordinary transfer.
// Live progress reserves 20 frames for carousel repair and mid-cycle joining.
const K = 100;
const EXPECTED_FRAMES = 120;

test("the carousel needs almost no fountain overhead, and the model says so", () => {
  // v2 measurement: p50 AND p90 over 100 zero-loss trials are exactly 1.00
  // for every k in {5, 25, 100, 400, 1600} — one caught sweep is the whole
  // file. The model quotes a hair above so the bar never finishes early.
  for (const k of [2, 5, 25, 100, 500, 5000, 65535]) {
    const value = expectedFountainOverhead(k);
    assert.ok(value >= 1 && value <= 1.05, `k=${k}: ${value}`);
  }
  assert.equal(expectedFountainOverhead(1), 1, "a single block needs exactly one frame");
  assert.equal(expectedFountainOverhead(0), 1, "guards against a zero-block stream");
});

test("progress and ETA follow the observed unique-frame rate", () => {
  const progress = estimateTransferProgress(K, 50, 10);
  assert.equal(progress.expectedFrames, EXPECTED_FRAMES);
  assert.ok(Math.abs(progress.fraction - 0.97 * 50 / EXPECTED_FRAMES) < 1e-12);
  assert.equal(progress.phase, "collecting");
  // 70 frames still wanted at the observed 5 frames/s.
  assert.equal(progress.etaSeconds, 14);
});

test("progress follows useful information and reserves 100% for completion", () => {
  const at = (frames: number) => estimateTransferProgress(K, frames, 20).fraction;

  assert.equal(estimateTransferProgress(K, 2, 4).etaSeconds, undefined, "too early to guess");
  assert.ok(at(50) > 0.4 && at(50) < 0.41);
  assert.ok(at(K) > 0.8 && at(K) < 0.81, "k leaves a visible repair reserve");
  assert.equal(at(EXPECTED_FRAMES), 0.97, "expected carousel time fills the main range");
  assert.ok(at(EXPECTED_FRAMES + 30) > 0.98 && at(EXPECTED_FRAMES + 30) < 0.99);
});

test("the ETA keeps quoting a time once a stream runs long", () => {
  // Past the expected count the target steps up one redundancy block at a time
  // rather than going silent — which is exactly when someone is wondering
  // whether the transfer has stalled.
  const overrun = estimateTransferProgress(K, EXPECTED_FRAMES + 5, 30);
  assert.ok(overrun.etaSeconds !== undefined && overrun.etaSeconds > 0);
  assert.equal(overrun.phase, "decoding");
});

test("a peeling cascade cannot hold back or jump the visible progress", () => {
  const early = estimateTransferProgress(K, 70, 20, 10).fraction;
  assert.equal(estimateTransferProgress(K, 70, 20, 69).fraction, early);
  assert.ok(estimateTransferProgress(K, 100, 20, 100).fraction > early);
});

test("durations stay compact and readable", () => {
  assert.equal(formatDuration(12.1), "13s");
  assert.equal(formatDuration(75.1), "1m 16s");
  assert.equal(formatDuration(3_661), "1h 1m");
});
