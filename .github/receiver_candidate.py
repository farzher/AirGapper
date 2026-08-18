from pathlib import Path


def rep(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing anchor {path}: {old[:220]}")
    p.write_text(s.replace(old, new, 1))


# v286's controller redesign already promoted. This pass hardens its evidence
# boundaries before hardware testing: exact slot hits, a genuinely independent
# confirmation sample, and no camera write until framing is stable.
rep('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.286";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.287";')
rep('send/main.js', 'const SEND_RUNTIME_BUILD = "v0.5.286";', 'const SEND_RUNTIME_BUILD = "v0.5.287";')
rep('main.js', 'const APP_BUILD = "v0.5.286";', 'const APP_BUILD = "v0.5.287";')
rep('index.html', 'main.js?build=v0.5.286', 'main.js?build=v0.5.287')
rep('sw.js', 'airgapper-static-js-v234', 'airgapper-static-js-v235')

# Store the exact submitted physical slots with every tracked job. A guided
# fallback can occasionally return another QR in the crop; that is useful data
# transport, but it must not be credited as success for the brightness targets
# we intentionally asked this candidate to decode.
rep('receive/main.js', '''    guidedStage,
    kind,
    sourceSequence: Number(sourceSequence)
  };''', '''    guidedStage,
    kind,
    sourceSequence: Number(sourceSequence),
    trackSlots: Array.isArray(message.tracks)
      ? message.tracks.map((track) => Number(track.slot ?? track.id)).filter(Number.isInteger)
      : []
  };''')
rep('receive/main.js', '''    if (!auditMode.full && Number.isFinite(auditMode.sourceSequence)) {
      autoOpticsCompletionSamples.push({
        at: receiverNow(),
        sourceSequence: auditMode.sourceSequence,
        tracks: Math.max(0, Number(auditMode.tracks) || 0),
        outputs: Math.min(Math.max(0, Number(auditMode.tracks) || 0), outputSymbols)
      });
      if (autoOpticsCompletionSamples.length > 512)
        autoOpticsCompletionSamples.splice(0, autoOpticsCompletionSamples.length - 512);
    }''', '''    if (!auditMode.full && Number.isFinite(auditMode.sourceSequence)) {
      const submittedSlots = new Set(auditMode.trackSlots ?? []);
      const attributedOutputs = submittedSlots.size
        ? completion.symbols.reduce((count, symbol) =>
            count + Number(submittedSlots.has(Number(symbol.header?.slotIndex))), 0)
        : Math.min(Math.max(0, Number(auditMode.tracks) || 0), outputSymbols);
      autoOpticsCompletionSamples.push({
        at: receiverNow(),
        sourceSequence: auditMode.sourceSequence,
        tracks: Math.max(0, Number(auditMode.tracks) || 0),
        outputs: Math.min(Math.max(0, Number(auditMode.tracks) || 0), attributedOutputs)
      });
      if (autoOpticsCompletionSamples.length > 512)
        autoOpticsCompletionSamples.splice(0, autoOpticsCompletionSamples.length - 512);
    }''')

# `confirm` deliberately repeats the selected ISO after a fresh-frame boundary.
# v286 accidentally returned the cached first probe before reaching that second
# measurement when the key was already in `measured`.
rep('receive/main.js', '''    if (measured.has(key)) return probes.find((item) => String(item.requestedIso) === key) || null;
    if (measured.size >= AUTO_OPTICS_GAIN_MAX_PROBES && !options.confirm) return null;''', '''    if (measured.has(key) && !options.confirm)
      return probes.find((item) => String(item.requestedIso) === key) || null;
    if (measured.size >= AUTO_OPTICS_GAIN_MAX_PROBES && !options.confirm) return null;''')

# Do not even enter manual exposure while the phone is moving. The per-candidate
# samples remain pose-gated too, so both the start of a tournament and every
# comparison have independent movement fences.
rep('receive/main.js', '''  autoOpticsMutationRunning = true;
  autoOpticsRuntimeState = "tuning";
  notePipelineEvent("auto-optics-short-shutter-search");
  try {
    let exposure = targetExposure;''', '''  autoOpticsMutationRunning = true;
  autoOpticsRuntimeState = "tuning";
  notePipelineEvent("auto-optics-short-shutter-search");
  try {
    if (!await waitForStableAutoOpticsPose(track, AUTO_OPTICS_POSE_WAIT_MS)) {
      autoOpticsRuntimeState = "ae";
      autoOpticsLockSince = 0;
      autoOpticsRetryAt = receiverNow() + 350;
      autoOpticsTuneSummary = "waiting for stable framing · hardware AE";
      return;
    }
    let exposure = targetExposure;''')

receive = Path('receive/main.js').read_text()
if 'measured.has(key) && !options.confirm' not in receive:
    raise SystemExit('confirmation still reuses cached probe')
if 'trackSlots:' not in receive or 'submittedSlots.has' not in receive:
    raise SystemExit('exact slot attribution missing')
if 'waiting for stable framing · hardware AE' not in receive:
    raise SystemExit('pre-write stability fence missing')
