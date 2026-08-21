import assert from "node:assert/strict";
import { AutoPhasePolicy, parseAutoPhaseDiagnostics } from "../receive/auto-phase-policy.js";

function diagnostics({
  acquiring = true,
  raceMs = 900,
  finderHints = 0,
  visible = 0,
  decodable = 0,
  submitted = 0,
  completed = 0,
  validRate = 0,
  validTotal = 0,
  completions = 0,
  silenceSeconds = 1.5,
  opticsController = "ACQUIRE",
  opticsRuntime = "ae",
  rolling = "Rolling  —"
} = {}) {
  return [
    `Capacity ${decodable || "—"} decodable / ${visible || "—"} visible · 1.0 scheduled/frame × 30.0 fps = 30.0 QR/s · submitted ${submitted.toFixed(1)} (100%) · completed ${completed.toFixed(1)}`,
    `Output   valid ${validRate.toFixed(1)} · unique 0.0 · duplicate 0.0 QR/s · useful 0.0 KB/s`,
    rolling,
    `AutoOptics ${opticsController === "OFF" ? "off" : `${opticsController} · ${opticsRuntime}`}`,
    `Payload  valid ${validTotal} · completions ${completions} · silence ${silenceSeconds.toFixed(1)}s · decode gap —ms · completion gap —ms`,
    `Acquire  ${acquiring ? `${raceMs}ms race` : "done"} · robust hunts 2 · sighting retries 1 · finder hints ${finderHints}`
  ].join("\n");
}

const parsed = parseAutoPhaseDiagnostics(diagnostics({
  acquiring: false,
  visible: 2,
  decodable: 2,
  submitted: 60,
  completed: 50,
  validRate: 10,
  silenceSeconds: 0.2,
  opticsController: "HOLD",
  opticsRuntime: "manual"
}));
assert.equal(parsed.visibleSlots, 2);
assert.equal(parsed.completedRate, 50);
assert.equal(parsed.validRate, 10);
assert.equal(parsed.successRatio, 0.2);
assert.equal(parsed.opticsBusy, false);

// Disabled means no automatic phase actuation under any health condition.
{
  const policy = new AutoPhasePolicy();
  const sample = parseAutoPhaseDiagnostics(diagnostics());
  sample.now = 5000;
  assert.equal(policy.observe(sample).kind, "hold");
  assert.equal(policy.pulseCount(), 0);
}

// One QR has no possible geometric seam model. Poor decode health alone must
// still request a phase change.
{
  const policy = new AutoPhasePolicy();
  policy.setEnabled(true, 0);
  let sample = parseAutoPhaseDiagnostics(diagnostics({
    acquiring: false,
    visible: 1,
    decodable: 1,
    submitted: 30,
    completed: 30,
    validRate: 0,
    silenceSeconds: 1.2,
    opticsController: "HOLD",
    opticsRuntime: "manual"
  }));
  sample.now = 800;
  assert.equal(policy.observe(sample).kind, "hold");
  sample = { ...sample, now: 1600 };
  const decision = policy.observe(sample);
  assert.equal(decision.kind, "pulse");
  assert.equal(decision.reason, "decode-silence");
}

// Repeated finder sightings must not postpone acquisition forever. Seeing QR
// structure but decoding nothing is itself evidence worth trying another phase.
{
  const policy = new AutoPhasePolicy();
  policy.setEnabled(true, 0);
  let sample = parseAutoPhaseDiagnostics(diagnostics({ finderHints: 1, raceMs: 800 }));
  sample.now = 800;
  assert.equal(policy.observe(sample).kind, "hold");
  sample = parseAutoPhaseDiagnostics(diagnostics({ finderHints: 6, raceMs: 1600 }));
  sample.now = 1600;
  const decision = policy.observe(sample);
  assert.equal(decision.kind, "pulse");
  assert.equal(decision.reason, "finder-no-decode");
}

// With nothing visible, let an active optics mutation finish first. The blind
// timer keeps running while optics works, so if optics still found nothing the
// next actuator can be a phase step immediately rather than wasting another
// full acquisition delay.
{
  const policy = new AutoPhasePolicy();
  policy.setEnabled(true, 0);
  let sample = parseAutoPhaseDiagnostics(diagnostics({
    finderHints: 0,
    raceMs: 900,
    opticsController: "LEARN",
    opticsRuntime: "settling"
  }));
  sample.now = 900;
  assert.equal(policy.observe(sample).reason, "optics-blind");
  sample = parseAutoPhaseDiagnostics(diagnostics({
    finderHints: 0,
    raceMs: 1900,
    opticsController: "ACQUIRE",
    opticsRuntime: "ae"
  }));
  sample.now = 1900;
  const decision = policy.observe(sample);
  assert.equal(decision.kind, "pulse");
  assert.equal(decision.reason, "blind-acquisition");
}

// Healthy decoding freezes phase and eventually clears the old pulse budget.
{
  const policy = new AutoPhasePolicy();
  policy.setEnabled(true, 0);
  policy.notePulse(700);
  let sample = parseAutoPhaseDiagnostics(diagnostics({
    acquiring: false,
    visible: 2,
    decodable: 2,
    submitted: 60,
    completed: 50,
    validRate: 35,
    silenceSeconds: 0.1,
    opticsController: "HOLD",
    opticsRuntime: "manual"
  }));
  sample.now = 1700;
  assert.equal(policy.observe(sample).reason, "healthy");
  sample = { ...sample, now: 4100 };
  assert.equal(policy.observe(sample).reason, "healthy");
  assert.equal(policy.pulseCount(), 0);
}

console.log("auto-phase decode-health policy smoke passed");
