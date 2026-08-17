from pathlib import Path

root = Path('.')
main = root / 'receive/main.js'
s = main.read_text()

assert 'const RECEIVER_RUNTIME_BUILD = "v0.5.151";' in s
s = s.replace('const RECEIVER_RUNTIME_BUILD = "v0.5.151";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.152";', 1)

old = '''const AUTO_OPTICS_GAIN_MIN_ATTEMPTS = 12;\nconst AUTO_OPTICS_GAIN_IMPROVEMENT = 1.03;'''
new = '''const AUTO_OPTICS_GAIN_MIN_ATTEMPTS = 12;\nconst AUTO_OPTICS_GAIN_IMPROVEMENT = 1.03;\nconst AUTO_OPTICS_GAIN_MAX_PROBES = 5;'''
assert old in s
s = s.replace(old, new, 1)

start = s.index('async function tuneAutomaticQrIso(track, exposure, baseIso, isoRange, maxAutoIso) {')
end = s.index('\nasync function settleAutomaticQrOptics(track, now) {', start)
old_fn = s[start:end]
new_fn = '''async function tuneAutomaticQrIso(track, exposure, baseIso, isoRange, maxAutoIso) {
  // The per-axis Auto flags belong to manual Optics mode. When the top-level
  // Optics controller is Auto, it owns exposure + gain for its one-time camera
  // calibration. A previously hand-pinned ISO must not silently disable this
  // search while the manual controls are hidden. Preserve the pin for the next
  // time the user explicitly switches Optics off, but ignore it here.
  if (!automaticOpticsSessionAlive(track)) return { iso: baseIso, probes: [] };
  autoOpticsRuntimeState = "tuning";
  autoOpticsTuneSummary = "calibrating ISO";

  const cap = Math.max(isoRange.min, Math.min(isoRange.max, maxAutoIso));
  const base = quantizeCameraRange(Math.min(cap, baseIso), isoRange);
  const probes = [];
  const measured = new Set();
  const probe = async (candidate) => {
    const requested = quantizeCameraRange(Math.min(cap, Math.max(isoRange.min, candidate)), isoRange);
    const key = String(requested);
    if (measured.has(key)) return probes.find((item) => String(item.requestedIso) === key) || null;
    if (measured.size >= AUTO_OPTICS_GAIN_MAX_PROBES) return null;
    measured.add(key);
    const result = await measureAutomaticIsoCandidate(track, exposure, requested, isoRange);
    if (result) probes.push(result);
    autoOpticsTuneSummary = probes.map(describeAutoIsoProbe).join(" · ");
    return result;
  };
  const scoreOf = (item) => item?.valid ? item.score : 0;
  const better = (candidate, incumbent) => scoreOf(candidate) > scoreOf(incumbent) * AUTO_OPTICS_GAIN_IMPROVEMENT;
  const geometricMidpoint = (a, b) => Math.sqrt(Math.max(isoRange.min, a) * Math.max(isoRange.min, b));

  // Coarse bracket first. A 2x brightness jump has already proven useful on
  // real camera traces, so keep that decisive first comparison.
  const baseline = await probe(base);
  if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
  const brighter = await probe(base * 2);
  if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };

  if (better(brighter, baseline)) {
    // v151 made the wrong refinement here: after 2x won, it tested sqrt(2)x,
    // back toward the loser. Continue uphill first, then bisect the winning
    // bracket only after we have actually found the other side of the peak.
    const upper = await probe(base * 2 * Math.SQRT2);
    if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
    if (better(upper, brighter)) {
      const far = await probe(base * 4);
      if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
      if (far && upper && !better(far, upper))
        await probe(geometricMidpoint(upper.requestedIso, far.requestedIso));
    } else if (upper && brighter) {
      await probe(geometricMidpoint(brighter.requestedIso, upper.requestedIso));
    }
  } else {
    // If 2x did not help, establish the lower side of the bracket and spend
    // the final probe between the best point and its strongest adjacent rival.
    const darker = await probe(base / Math.SQRT2);
    if (!automaticOpticsSessionAlive(track)) return { iso: base, probes };
    const validNow = [baseline, brighter, darker].filter((item) => item?.valid).sort((a, b) => a.requestedIso - b.requestedIso);
    if (validNow.length >= 2) {
      const bestNow = validNow.reduce((winner, item) => item.score > winner.score ? item : winner);
      const bestIndex = validNow.indexOf(bestNow);
      const neighbors = [validNow[bestIndex - 1], validNow[bestIndex + 1]].filter(Boolean);
      if (neighbors.length) {
        const rival = neighbors.reduce((winner, item) => item.score > winner.score ? item : winner);
        await probe(geometricMidpoint(bestNow.requestedIso, rival.requestedIso));
      }
    }
  }

  const valid = probes.filter((item) => item.valid);
  const best = valid.length
    ? valid.reduce((winner, item) => item.score > winner.score ? item : winner)
    : baseline || brighter || { iso: base, requestedIso: base, rate: 0, yieldRate: 0, score: 0 };
  const finalIso = quantizeCameraRange(Math.min(cap, best.iso || best.requestedIso || base), isoRange);
  if (automaticOpticsSessionAlive(track)) {
    const actual = Number(track.getSettings().iso);
    const step = Number(isoRange.step) || 0;
    if (!Number.isFinite(actual) || Math.abs(actual - finalIso) > Math.max(step * 0.75, finalIso * 0.02))
      await applyCameraConstraint(track, { exposureMode: "manual", exposureTime: exposure, iso: finalIso });
  }
  autoOpticsTuneSummary = `${probes.map(describeAutoIsoProbe).join(" · ")} → ${Math.round(finalIso)}`;
  return { iso: finalIso, probes, best };
}'''
s = s[:start] + new_fn + s[end:]
main.write_text(s)

for name in ['index.html', 'main.js']:
    p = root / name
    text = p.read_text()
    assert 'v0.5.151' in text, name
    p.write_text(text.replace('v0.5.151', 'v0.5.152'))

sw = root / 'sw.js'
text = sw.read_text()
assert 'airgapper-static-js-v113' in text
sw.write_text(text.replace('airgapper-static-js-v113', 'airgapper-static-js-v114', 1))
