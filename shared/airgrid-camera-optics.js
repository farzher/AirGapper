function clampRange(value, range) {
  if (!range || !Number.isFinite(value)) return value;
  const min = Number.isFinite(range.min) ? range.min : value;
  const max = Number.isFinite(range.max) ? range.max : value;
  let out = Math.max(min, Math.min(max, value));
  const step = Number(range.step);
  if (Number.isFinite(step) && step > 0) out = min + Math.round((out - min) / step) * step;
  return Math.max(min, Math.min(max, out));
}

function exposureMs(value) {
  return Number.isFinite(Number(value)) ? Number(value) / 10 : NaN;
}

function probeAirGridCameraOptics(track) {
  const caps = track?.getCapabilities?.() ?? {};
  const settings = track?.getSettings?.() ?? {};
  const manualExposure = Array.isArray(caps.exposureMode) && caps.exposureMode.includes('manual') && caps.exposureTime && Number.isFinite(caps.exposureTime.min) && Number.isFinite(caps.exposureTime.max);
  return {
    caps,
    settings,
    manualExposure:Boolean(manualExposure),
    exposureTime:manualExposure ? caps.exposureTime : null,
    iso:caps.iso && Number.isFinite(caps.iso.min) && Number.isFinite(caps.iso.max) ? caps.iso : null,
    focusModes:Array.isArray(caps.focusMode) ? caps.focusMode : []
  };
}

async function advanced(track, values) {
  if (!track || track.readyState !== 'live' || !values || !Object.keys(values).length) return false;
  try {
    await track.applyConstraints({ advanced:[values] });
    return true;
  } catch {
    return false;
  }
}

function closeEnough(actual, requested, range) {
  if (!Number.isFinite(Number(actual)) || !Number.isFinite(Number(requested))) return false;
  const tolerance = Math.max(Number(range?.step) * 0.75 || 0, Math.abs(Number(requested)) * 0.04, 1e-6);
  return Math.abs(Number(actual) - Number(requested)) <= tolerance;
}

async function applyAirGridManualOptics(track, { exposureTime, iso } = {}) {
  const probe = probeAirGridCameraOptics(track);
  if (!probe.manualExposure) return { ok:false, reason:'manual exposure unsupported', probe, settings:track?.getSettings?.() ?? {} };
  const requestedExposure = clampRange(Number(exposureTime), probe.exposureTime);
  const requestedIso = probe.iso && Number.isFinite(Number(iso)) ? clampRange(Number(iso), probe.iso) : undefined;
  const previousFocus = probe.settings.focusMode;

  await advanced(track, { exposureMode:'manual' });
  const sensor = { exposureTime:requestedExposure };
  if (requestedIso !== undefined) sensor.iso = requestedIso;
  await advanced(track, sensor);
  await new Promise(resolve => setTimeout(resolve, 100));
  let actual = track.getSettings?.() ?? {};
  let exposureAccepted = closeEnough(actual.exposureTime, requestedExposure, probe.exposureTime);
  let isoAccepted = requestedIso === undefined || closeEnough(actual.iso, requestedIso, probe.iso);
  let focusHeld = false;

  // Some Android camera stacks ignore manual sensor writes until 3A focus is
  // held. This mirrors the production AirGapper fallback without importing its
  // much larger auto-optics controller into the lab.
  if ((!exposureAccepted || !isoAccepted) && probe.focusModes.includes('manual')) {
    await advanced(track, { focusMode:'manual' });
    focusHeld = true;
    await new Promise(resolve => setTimeout(resolve, 80));
    await advanced(track, { exposureMode:'manual' });
    await advanced(track, sensor);
    await new Promise(resolve => setTimeout(resolve, 160));
    actual = track.getSettings?.() ?? {};
    exposureAccepted = closeEnough(actual.exposureTime, requestedExposure, probe.exposureTime);
    isoAccepted = requestedIso === undefined || closeEnough(actual.iso, requestedIso, probe.iso);

    // Restore continuous AF only when doing so does not immediately lose the
    // accepted sensor state. Quirk devices simply keep focus held for the lab.
    if (exposureAccepted && isoAccepted && previousFocus && previousFocus !== 'manual' && probe.focusModes.includes(previousFocus)) {
      await advanced(track, { focusMode:previousFocus });
      await new Promise(resolve => setTimeout(resolve, 80));
      const restored = track.getSettings?.() ?? {};
      if (closeEnough(restored.exposureTime, requestedExposure, probe.exposureTime) && (requestedIso === undefined || closeEnough(restored.iso, requestedIso, probe.iso))) {
        actual = restored;
        focusHeld = false;
      } else {
        await advanced(track, { focusMode:'manual' });
        await advanced(track, { exposureMode:'manual' });
        await advanced(track, sensor);
        actual = track.getSettings?.() ?? actual;
      }
    }
  }

  return {
    ok:exposureAccepted && isoAccepted,
    reason:exposureAccepted && isoAccepted ? '' : 'camera did not accept requested sensor values',
    exposureAccepted,
    isoAccepted,
    focusHeld,
    requested:{ exposureTime:requestedExposure, iso:requestedIso },
    settings:actual,
    probe
  };
}

async function applyAirGridShortExposure(track, targetExposureTime = 20) {
  const probe = probeAirGridCameraOptics(track);
  if (!probe.manualExposure) return { ok:false, reason:'manual exposure unsupported', probe, settings:track?.getSettings?.() ?? {} };
  const current = track.getSettings?.() ?? probe.settings;
  const targetExposure = clampRange(targetExposureTime, probe.exposureTime);
  let targetIso;
  if (probe.iso) {
    const currentIso = Number.isFinite(Number(current.iso)) ? Number(current.iso) : Math.max(probe.iso.min, Math.min(probe.iso.max, 100));
    const currentExposure = Number.isFinite(Number(current.exposureTime)) && Number(current.exposureTime) > 0 ? Number(current.exposureTime) : targetExposure;
    targetIso = clampRange(currentIso * currentExposure / Math.max(1e-6, targetExposure), probe.iso);
  }
  return applyAirGridManualOptics(track, { exposureTime:targetExposure, iso:targetIso });
}

async function restoreAirGridAutoExposure(track) {
  const probe = probeAirGridCameraOptics(track);
  const modes = Array.isArray(probe.caps.exposureMode) ? probe.caps.exposureMode : [];
  const mode = modes.includes('continuous') ? 'continuous' : modes.includes('auto') ? 'auto' : null;
  if (!mode) return { ok:false, reason:'automatic exposure mode unavailable', settings:track?.getSettings?.() ?? {}, probe };
  const ok = await advanced(track, { exposureMode:mode });
  await new Promise(resolve => setTimeout(resolve, 120));
  return { ok, reason:ok ? '' : 'camera rejected automatic exposure', settings:track?.getSettings?.() ?? {}, probe };
}

function formatAirGridOpticsSettings(settings = {}) {
  const exposure = exposureMs(settings.exposureTime);
  const bits = [settings.exposureMode || 'mode ?'];
  if (Number.isFinite(exposure)) bits.push(`${exposure.toFixed(exposure < 10 ? 1 : 0)} ms`);
  if (Number.isFinite(Number(settings.iso))) bits.push(`ISO ${Math.round(Number(settings.iso))}`);
  if (settings.focusMode) bits.push(`focus ${settings.focusMode}`);
  return bits.join(' · ');
}

export {
  applyAirGridManualOptics,
  applyAirGridShortExposure,
  exposureMs,
  formatAirGridOpticsSettings,
  probeAirGridCameraOptics,
  restoreAirGridAutoExposure
};
