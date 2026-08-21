import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AutoPhasePolicy, parseAutoPhaseDiagnostics } from "../receive/auto-phase-policy.js";

function diagnostics({
  acquiring = false,
  raceMs = 900,
  finderHints = 0,
  visible = 1,
  decodable = 1,
  submitted = 30,
  completed = 30,
  validRate = 21,
  validTotal = 100,
  completions = 120,
  silenceSeconds = 0.1,
  opticsController = "HOLD",
  opticsRuntime = "manual"
} = {}) {
  return [
    `Capacity ${decodable || "—"} decodable / ${visible || "—"} visible · 1.0 scheduled/frame × 30.0 fps = 30.0 QR/s · submitted ${submitted.toFixed(1)} (100%) · completed ${completed.toFixed(1)}`,
    `Output   valid ${validRate.toFixed(1)} · unique ${validRate.toFixed(1)} · duplicate 0.0 QR/s · useful 0.0 KB/s`,
    "Rolling  —",
    `AutoOptics ${opticsController === "OFF" ? "off" : `${opticsController} · ${opticsRuntime}`}`,
    `Payload  valid ${validTotal} · completions ${completions} · silence ${silenceSeconds.toFixed(1)}s · decode gap —ms · completion gap —ms`,
    `Acquire  ${acquiring ? `${raceMs}ms race` : "done"} · robust hunts 2 · sighting retries 1 · finder hints ${finderHints}`
  ].join("\n");
}

function sample(options, now, extras = {}) {
  return {
    ...parseAutoPhaseDiagnostics(diagnostics(options)),
    now,
    opticsAllowed: extras.opticsAllowed ?? true,
    phaseAvailable: extras.phaseAvailable ?? true
  };
}

const recoverySource = await readFile(new URL("../receive/auto-phase.js", import.meta.url), "utf8");
assert.match(recoverySource, /getElementById\("focus-diagnostics"\)/);
assert.match(recoverySource, /<span>Auto recovery<\/span>/);
assert.match(recoverySource, /camera-exposure-auto/);
assert.doesNotMatch(recoverySource, /const diagnostics = document\.getElementById\("transport-diagnostics"\)/);

// Keep the parser pinned to the diagnostic shape reported by a real device.
const live = parseAutoPhaseDiagnostics(`
Capacity 1 decodable / 1 visible · 1.0 scheduled/frame × 28.0 fps = 28.0 QR/s · submitted 28.0 (100%) · completed 29.0
Output   valid 21.0 · unique 21.0 · duplicate 0.0 QR/s · useful 60.1 KB/s
Rolling  —
AutoOptics HOLD · manual · hold 90% · remembered winner proven · 8.31 ms · ISO 262 · hold 90%
Payload  valid 957 · completions 2337 · silence 0.1s · decode gap 34ms · completion gap 33ms
Acquire  done · robust hunts 1 · sighting retries 1 · finder hints 4`);
assert.ok(live);
assert.equal(live.visibleSlots, 1);
assert.equal(live.completedRate, 29);
assert.equal(live.validRate, 21);

// Disabled means no camera mutation.
{
  const policy = new AutoPhasePolicy();
  assert.equal(policy.observe(sample({ validRate: 0, silenceSeconds: 2 }, 5000)).kind, "hold");
}

// Healthy decode yield is GOOD and freezes camera mutations.
{
  const policy = new AutoPhasePolicy();
  policy.setEnabled(true, 0);
  const decision = policy.observe(sample({ validRate: 21, completed: 29, silenceSeconds: 0.1 }, 1000));
  assert.equal(decision.reason, "healthy");
  assert.equal(decision.state, "GOOD");
}

// One QR needs no seam model: sustained zero output tries phase first.
{
  const policy = new AutoPhasePolicy();
  policy.setEnabled(true, 0);
  assert.equal(policy.observe(sample({ validRate: 0, completed: 30, silenceSeconds: 1.2 }, 700)).reason, "bad-dwell");
  const decision = policy.observe(sample({ validRate: 0, completed: 30, silenceSeconds: 1.8 }, 1400));
  assert.equal(decision.kind, "phase");
  assert.equal(decision.state, "RECOVER");
}

// Recovery judges the actual decoder result after a pulse and immediately stops if healthy.
{
  const policy = new AutoPhasePolicy({ phaseSettleMs: 100, phaseMeasureMs: 100 });
  policy.setEnabled(true, 0);
  let bad = sample({ validRate: 0, completed: 30, silenceSeconds: 1.5 }, 700);
  policy.observe(bad);
  bad = { ...bad, now: 1400 };
  assert.equal(policy.observe(bad).kind, "phase");
  policy.noteActionStarted("phase", bad, 1400);
  const good = sample({ validRate: 24, completed: 30, silenceSeconds: 0.1 }, 1650);
  const result = policy.observe(good);
  assert.equal(result.reason, "action-recovered");
  assert.equal(result.state, "GOOD");
}

// Finder structure but no decode points to phase before optics.
{
  const policy = new AutoPhasePolicy();
  policy.setEnabled(true, 0);
  policy.observe(sample({ acquiring: true, raceMs: 800, finderHints: 1, visible: 0, decodable: 0, submitted: 0, completed: 0, validRate: 0, silenceSeconds: 2 }, 800));
  const decision = policy.observe(sample({ acquiring: true, raceMs: 1500, finderHints: 4, visible: 0, decodable: 0, submitted: 0, completed: 0, validRate: 0, silenceSeconds: 2 }, 1500));
  assert.equal(decision.kind, "phase");
}

// Totally blind acquisition lets auto optics take the first recovery attempt.
{
  const policy = new AutoPhasePolicy();
  policy.setEnabled(true, 0);
  policy.observe(sample({ acquiring: true, raceMs: 800, finderHints: 0, visible: 0, decodable: 0, submitted: 0, completed: 0, validRate: 0, silenceSeconds: 2 }, 800));
  const decision = policy.observe(sample({ acquiring: true, raceMs: 1800, finderHints: 0, visible: 0, decodable: 0, submitted: 0, completed: 0, validRate: 0, silenceSeconds: 2 }, 1800));
  assert.equal(decision.kind, "optics");
}

// Manual optics are genuinely off limits; the same blind case becomes phase-only.
{
  const policy = new AutoPhasePolicy();
  policy.setEnabled(true, 0);
  policy.observe(sample({ acquiring: true, raceMs: 800, finderHints: 0, visible: 0, decodable: 0, submitted: 0, completed: 0, validRate: 0, silenceSeconds: 2 }, 800, { opticsAllowed: false }));
  const decision = policy.observe(sample({ acquiring: true, raceMs: 1800, finderHints: 0, visible: 0, decodable: 0, submitted: 0, completed: 0, validRate: 0, silenceSeconds: 2 }, 1800, { opticsAllowed: false }));
  assert.equal(decision.kind, "phase");
}

// Locked recovery explores phase first, then permits one optics recalibration.
{
  const policy = new AutoPhasePolicy({ phaseSettleMs: 0, phaseMeasureMs: 0, phaseBeforeOptics: 3 });
  policy.setEnabled(true, 0);
  let bad = sample({ validRate: 0, completed: 30, silenceSeconds: 2 }, 700);
  policy.observe(bad);
  bad = { ...bad, now: 1400 };
  for (let i = 0; i < 3; i++) {
    assert.equal(policy.observe(bad).kind, "phase");
    policy.noteActionStarted("phase", bad, bad.now);
    bad = { ...bad, now: bad.now + 200 };
    policy.observe(bad);
    bad = { ...bad, now: bad.now + 200 };
  }
  assert.equal(policy.observe(bad).kind, "optics");
}

console.log("simple camera recovery policy smoke passed");
