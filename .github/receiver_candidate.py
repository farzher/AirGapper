from pathlib import Path


def rep(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing anchor {path}: {old[:220]}")
    p.write_text(s.replace(old, new, 1))


rep('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.289";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.290";')
rep('send/main.js', 'const SEND_RUNTIME_BUILD = "v0.5.289";', 'const SEND_RUNTIME_BUILD = "v0.5.290";')
rep('main.js', 'const APP_BUILD = "v0.5.289";', 'const APP_BUILD = "v0.5.290";')
rep('index.html', 'main.js?build=v0.5.289', 'main.js?build=v0.5.290')
rep('index.html', '<span class="brand">AirGapper <span class="app-version">v0.5.289</span></span>', '<span class="brand">AirGapper <span class="app-version">v0.5.290</span></span>')
rep('sw.js', 'airgapper-static-js-v237', 'airgapper-static-js-v238')

# The AE phase is a photometer, not the chosen optics. applyExposureSetting()
# intentionally biases automatic optics by AUTO_QR_EV_BIAS; feeding that already
# darkened product into automaticShortShutterSeed() and multiplying by
# AUTO_QR_LIGHT_SCALE again applied the bias twice (~-1.6 EV). Meter at neutral
# EV=0, then apply the QR bias exactly once when building the manual seed.
rep('receive/main.js', '''async function readAutomaticAeBaseline(track) {
  const beforeSequence = latestSourceFrameSequence;
  await applyExposureSetting(track);
  if (!automaticOpticsSessionAlive(track)) return void 0;
  await waitForFreshAutoOpticsFrames(track, beforeSequence, 2, 500);
  if (!automaticOpticsSessionAlive(track)) return void 0;
  const settings = track.getSettings();
  const exposure = Number(settings.exposureTime);
  const iso = Number(settings.iso);
  if (!(exposure > 0) || !(iso > 0)) return void 0;
  return { exposure, iso, at: receiverNow() };
}''', '''async function readAutomaticAeBaseline(track) {
  const beforeSequence = latestSourceFrameSequence;
  const caps = track.getCapabilities?.() ?? {};
  const patch = { exposureMode: "continuous" };
  if (caps.exposureCompensation && caps.exposureCompensation.min <= 0 && caps.exposureCompensation.max >= 0) {
    patch.exposureCompensation = quantizeCameraRange(0, caps.exposureCompensation);
  }
  delete desiredCamera.exposureTime;
  delete desiredCamera.iso;
  delete desiredCamera.exposureCompensation;
  desiredCamera.exposureMode = "continuous";
  await applyCameraConstraint(track, patch);
  if (!automaticOpticsSessionAlive(track)) return void 0;
  await waitForFreshAutoOpticsFrames(track, beforeSequence, 2, 500);
  if (!automaticOpticsSessionAlive(track)) return void 0;
  const settings = track.getSettings();
  const exposure = Number(settings.exposureTime);
  const iso = Number(settings.iso);
  if (!(exposure > 0) || !(iso > 0)) return void 0;
  return { exposure, iso, at: receiverNow(), neutral: true };
}''')

# Make the invariant executable/documented at the conversion point.
rep('receive/main.js', '''function automaticShortShutterSeed(baseline, exposureRange, isoRange, fps) {
  const aeProduct = baseline.exposure * baseline.iso;
  const targetProduct = Math.max(exposureRange.min * isoRange.min, aeProduct * AUTO_QR_LIGHT_SCALE);''', '''function automaticShortShutterSeed(baseline, exposureRange, isoRange, fps) {
  const aeProduct = baseline.exposure * baseline.iso;
  // readAutomaticAeBaseline() is neutral. Apply AirGapper's deliberate darkness
  // preference exactly once here; remembered/manual winners bypass this meter.
  const targetProduct = Math.max(exposureRange.min * isoRange.min, aeProduct * AUTO_QR_LIGHT_SCALE);''')

main = Path('receive/main.js').read_text()
for needle in [
    'const RECEIVER_RUNTIME_BUILD = "v0.5.290";',
    'patch.exposureCompensation = quantizeCameraRange(0, caps.exposureCompensation);',
    'return { exposure, iso, at: receiverNow(), neutral: true };',
    'Apply AirGapper\'s deliberate darkness'
]:
    if needle not in main:
        raise SystemExit(f'missing v290 invariant: {needle}')
