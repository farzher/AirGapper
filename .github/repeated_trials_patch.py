from pathlib import Path
p=Path('benchmark/offline-runner.mjs')
s=p.read_text()

anchor='''function ratio(numerator, denominator) {'''
insert=r'''function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function trialScore(name, result) {
  if (name === "buffered-rgba") return Number(result.decodeP50Ms) || 0;
  return Number(result.normalized?.guidedMsPerOutput) || Number(result.decodeP50Ms) || 0;
}

function selectMedianTrial(name, trials) {
  const ranked = trials.map((result, index) => ({ result, index, score: trialScore(name, result) }))
    .sort((a, b) => a.score - b.score);
  const chosen = ranked[Math.floor(ranked.length / 2)] ?? ranked[0];
  const result = structuredClone(chosen.result);
  result.trialCount = trials.length;
  result.selectedTrial = chosen.index + 1;
  result.trialMedians = {
    guidedMsPerTrack: median(trials.map((item) => Number(item.normalized?.guidedMsPerTrack))),
    guidedMsPerOutput: median(trials.map((item) => Number(item.normalized?.guidedMsPerOutput))),
    sampleMsPerTrack: median(trials.map((item) => Number(item.normalized?.sampleMsPerTrack))),
    decodeP50Ms: median(trials.map((item) => Number(item.decodeP50Ms))),
    decodeP95Ms: median(trials.map((item) => Number(item.decodeP95Ms))),
    guidedOutputYield: median(trials.map((item) => Number(item.normalized?.guidedOutputYield))),
    turboYield: median(trials.map((item) => Number(item.normalized?.turboYield))),
    stableRsYield: median(trials.map((item) => Number(item.normalized?.stableRsYield))),
    dataOnlyYield: median(trials.map((item) => Number(item.normalized?.dataOnlyYield)))
  };
  result.trialSpread = {
    guidedMsPerOutput: trials.map((item) => Number(item.normalized?.guidedMsPerOutput) || 0),
    sampleMsPerTrack: trials.map((item) => Number(item.normalized?.sampleMsPerTrack) || 0),
    decodeP50Ms: trials.map((item) => Number(item.decodeP50Ms) || 0)
  };
  return result;
}

'''
if 'function selectMedianTrial' not in s:
    if anchor not in s: raise SystemExit('ratio anchor missing')
    s=s.replace(anchor,insert+anchor,1)

old=r'''  const results = {};
  for (const scenario of scenarios) {
    console.log(`AIRGAPPER_FAST_REGRESSION_START ${scenario.name}`);
    const started = performance.now();
    const result = addNormalizedDiagnostics(await page.evaluate(async (input) => window.__airgapperRunFastRegression(input), scenario));
    result.wallTimeMs = Math.round(performance.now() - started);
    assertScenario(scenario.name, result);
    results[scenario.name] = result;
    console.log(`AIRGAPPER_FAST_REGRESSION_RESULT ${scenario.name} ${JSON.stringify(result)}`);
  }
'''
new=r'''  const results = {};
  const requestedTrials = Math.max(1, Math.min(5, Number(process.env.AIRGAPPER_TRIALS || 3) || 3));
  for (const scenario of scenarios) {
    const trialCount = scenario.name === "buffered-rgba" ? 1 : requestedTrials;
    const trials = [];
    for (let trial = 0; trial < trialCount; trial++) {
      console.log(`AIRGAPPER_FAST_REGRESSION_START ${scenario.name} trial=${trial + 1}/${trialCount}`);
      const started = performance.now();
      const result = addNormalizedDiagnostics(await page.evaluate(async (input) => window.__airgapperRunFastRegression(input), scenario));
      result.wallTimeMs = Math.round(performance.now() - started);
      assertScenario(scenario.name, result);
      trials.push(result);
      console.log(`AIRGAPPER_FAST_REGRESSION_TRIAL ${scenario.name} ${trial + 1} ` + JSON.stringify({
        guidedMsPerOutput: result.normalized?.guidedMsPerOutput,
        sampleMsPerTrack: result.normalized?.sampleMsPerTrack,
        p50: result.decodeP50Ms,
        p95: result.decodeP95Ms,
        yield: result.normalized?.guidedOutputYield,
        turbo: result.normalized?.turboYield,
        stableRS: result.normalized?.stableRsYield,
        noRS: result.normalized?.dataOnlyYield
      }));
    }
    const result = selectMedianTrial(scenario.name, trials);
    results[scenario.name] = result;
    console.log(`AIRGAPPER_FAST_REGRESSION_RESULT ${scenario.name} ${JSON.stringify(result)}`);
  }
'''
if old not in s: raise SystemExit('scenario loop anchor missing')
s=s.replace(old,new,1)
p.write_text(s)
