from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f"{label} anchor missing")
    return text.replace(old, new, 1)

p = Path('receive/main.js')
s = p.read_text()

# Coverage collapse is useful evidence before it is strong enough to destroy a
# proven lattice. Arm cheap predicted-slot rescue after two bad current jobs;
# keep the existing four-job/180ms rule as the destructive-reset threshold.
s = replace_once(
    s,
    'let geometryCoverageCollapseStartedAt = 0;\nlet geometryCoverageLastScanId = -1;\n',
    'let geometryCoverageCollapseStartedAt = 0;\nlet geometryCoverageLastScanId = -1;\nlet geometryRecoveryAssistUntil = 0;\n',
    'coverage assist state'
)

old = '''    if (coverage >= GEOMETRY_COLLAPSE_HEALTHY_RATIO) {
      geometryCoverageHealthy = true;
      geometryCoverageCollapseStreak = 0;
      geometryCoverageCollapseLastAt = 0;
      geometryCoverageCollapseStartedAt = 0;
    } else if (geometryCoverageHealthy && coverage <= GEOMETRY_COLLAPSE_BAD_RATIO) {
      if (now - geometryCoverageCollapseLastAt > GEOMETRY_COLLAPSE_MAX_GAP_MS) {
        geometryCoverageCollapseStreak = 0;
        geometryCoverageCollapseStartedAt = now;
      }
      if (!geometryCoverageCollapseStreak) geometryCoverageCollapseStartedAt = now;
      geometryCoverageCollapseLastAt = now;
      geometryCoverageCollapseStreak++;
      if (geometryCoverageCollapseStreak >= GEOMETRY_COLLAPSE_STREAK &&
          now - geometryCoverageCollapseStartedAt >= GEOMETRY_COLLAPSE_MIN_SPAN_MS) {
        notePipelineEvent("geometry-coverage-collapse", trackedOutputs);
        enterGeometryRecovery(`tracked coverage collapsed ${trackedOutputs}/${auditMode.tracks}; fresh acquisition`, now, true);
      }
    } else if (coverage > GEOMETRY_COLLAPSE_BAD_RATIO) {
      geometryCoverageCollapseStreak = 0;
      geometryCoverageCollapseLastAt = 0;
      geometryCoverageCollapseStartedAt = 0;
    }
'''
new = '''    if (coverage >= GEOMETRY_COLLAPSE_HEALTHY_RATIO) {
      geometryCoverageHealthy = true;
      geometryCoverageCollapseStreak = 0;
      geometryCoverageCollapseLastAt = 0;
      geometryCoverageCollapseStartedAt = 0;
      geometryRecoveryAssistUntil = 0;
    } else if (geometryCoverageHealthy && coverage <= GEOMETRY_COLLAPSE_BAD_RATIO) {
      if (now - geometryCoverageCollapseLastAt > GEOMETRY_COLLAPSE_MAX_GAP_MS) {
        geometryCoverageCollapseStreak = 0;
        geometryCoverageCollapseStartedAt = now;
      }
      if (!geometryCoverageCollapseStreak) geometryCoverageCollapseStartedAt = now;
      geometryCoverageCollapseLastAt = now;
      geometryCoverageCollapseStreak++;
      if (geometryCoverageCollapseStreak >= 2) {
        // Do not wait for the destructive reacquire threshold before helping.
        // A predicted-slot seed scan is cheap and one CRC-valid QR can now
        // re-homography the entire wall. Reset its throttle so the next fresh
        // camera frame gets a recovery opportunity immediately.
        geometryRecoveryAssistUntil = Math.max(geometryRecoveryAssistUntil, now + 550);
        lastFullScan = 0;
        notePipelineEvent("geometry-recovery-assist", trackedOutputs);
      }
      if (geometryCoverageCollapseStreak >= GEOMETRY_COLLAPSE_STREAK &&
          now - geometryCoverageCollapseStartedAt >= GEOMETRY_COLLAPSE_MIN_SPAN_MS) {
        notePipelineEvent("geometry-coverage-collapse", trackedOutputs);
        enterGeometryRecovery(`tracked coverage collapsed ${trackedOutputs}/${auditMode.tracks}; fresh acquisition`, now, true);
      }
    } else if (coverage > GEOMETRY_COLLAPSE_BAD_RATIO) {
      geometryCoverageCollapseStreak = 0;
      geometryCoverageCollapseLastAt = 0;
      geometryCoverageCollapseStartedAt = 0;
      geometryRecoveryAssistUntil = 0;
    }
'''
s = replace_once(s, old, new, 'coverage assist behavior')

old = '''  const geometryProbeDue = lockedGeometryTrusted && freshLockedHits === 0 &&
    lockedDecodeSilenceMs >= GEOMETRY_FAST_PROBE_SILENCE_MS;
'''
new = '''  const coverageRecoveryAssist = lockedGeometryTrusted && geometryRecoveryAssistUntil > now;
  const geometryProbeDue = lockedGeometryTrusted && (coverageRecoveryAssist ||
    freshLockedHits === 0 && lockedDecodeSilenceMs >= GEOMETRY_FAST_PROBE_SILENCE_MS);
'''
s = replace_once(s, old, new, 'coverage assist scheduler')

# The transport WASM and camera permission/open are independent. Start both at
# once rather than serializing a cold RaptorQ initialization ahead of getUserMedia.
old = '''  pool.resize(selectedWorkerCount());
  try {
    await prepareRaptorQ();
  } catch (error) {
    if (startAttempt === cameraStartGen) pool.resize(0);
    offerRetry(`Transport: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (startAttempt !== cameraStartGen || receiverPaused) return;
'''
new = '''  pool.resize(selectedWorkerCount());
  const transportReady = prepareRaptorQ().then(() => null, (error) => error);
  if (startAttempt !== cameraStartGen || receiverPaused) return;
'''
s = replace_once(s, old, new, 'parallel transport startup')

old = '''  if (startAttempt !== cameraStartGen || receiverPaused) {
    acquiredStream.getTracks().forEach((track) => track.stop());
    return;
  }
  stream = acquiredStream;
'''
new = '''  if (startAttempt !== cameraStartGen || receiverPaused) {
    acquiredStream.getTracks().forEach((track) => track.stop());
    return;
  }
  const transportError = await transportReady;
  if (transportError) {
    acquiredStream.getTracks().forEach((track) => track.stop());
    if (startAttempt === cameraStartGen) pool.resize(0);
    offerRetry(`Transport: ${transportError instanceof Error ? transportError.message : String(transportError)}`);
    return;
  }
  if (startAttempt !== cameraStartGen || receiverPaused) {
    acquiredStream.getTracks().forEach((track) => track.stop());
    return;
  }
  stream = acquiredStream;
'''
s = replace_once(s, old, new, 'join transport and camera startup')

# If TrackProcessor intermittently wedges on Android, 800ms of deliberate idle
# is too visible. Normal devices deliver in tens of milliseconds; fall back to
# rVFC after 250ms only when zero processor frames have arrived.
s = replace_once(s, '      }, 800);\n', '      }, 250);\n', 'TrackProcessor startup watchdog')

# Reset transient assist state with the rest of the session diagnostics.
s = replace_once(
    s,
    '  geometryCoverageCollapseStartedAt = 0;\n  geometryCoverageLastScanId = -1;\n',
    '  geometryCoverageCollapseStartedAt = 0;\n  geometryCoverageLastScanId = -1;\n  geometryRecoveryAssistUntil = 0;\n',
    'coverage assist reset'
)

# Make the assist visible in diagnostics without adding any fast DOM work.
s = replace_once(
    s,
    'Recovery probes ${geometryRecoveryProbes} · sighting nudges ${geometrySightingNudges} · resets ${geometryRecoveryResets}',
    'Recovery probes ${geometryRecoveryProbes} · assist ${geometryRecoveryAssistUntil > perfNow ? `${Math.max(0, geometryRecoveryAssistUntil - perfNow).toFixed(0)}ms` : "no"} · sighting nudges ${geometrySightingNudges} · resets ${geometryRecoveryResets}',
    'recovery assist diagnostics'
)

# Correct an outdated acquisition comment after v271 raised the cold cap to 3.
s = s.replace('  // and memory bandwidth. Two fresh-frame seed searches are enough to keep\n',
              '  // and memory bandwidth. Three fresh-frame seed searches are enough to keep\n', 1)

s = replace_once(s, 'const RECEIVER_RUNTIME_BUILD = "v0.5.271";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.272";', 'receiver version')
p.write_text(s)

p = Path('main.js')
s = p.read_text()
s = replace_once(s, 'const APP_BUILD = "v0.5.271";', 'const APP_BUILD = "v0.5.272";', 'app version')
p.write_text(s)

p = Path('index.html')
s = p.read_text()
if s.count('v0.5.271') < 2:
    raise SystemExit('index version anchors missing')
s = s.replace('v0.5.271', 'v0.5.272')
p.write_text(s)

p = Path('sw.js')
s = p.read_text()
s = replace_once(s, 'airgapper-static-js-v219', 'airgapper-static-js-v220', 'service worker cache')
p.write_text(s)
