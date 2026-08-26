from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def replace_once(path, old, new):
    file = ROOT / path
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}")
    file.write_text(text.replace(old, new, 1))

def write(path, content):
    file = ROOT / path
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(content)

# 1) Replace imprecise range sliders + detached output labels with exact selects
# and one explicit live sensor readback.
replace_once("index.html", '''            <div id="camera-optics-manual" class="optics-manual" hidden>
              <div id="camera-exposure-manual" class="axis-control">
                <div class="axis-heading"><span class="axis-title">Exposure</span><output id="camera-exposure-value">—</output></div>
                <input id="camera-exposure" type="range" min="0" max="0" value="0" step="1" aria-label="Exposure time" />
              </div>
              <div id="camera-iso-control" class="axis-control" hidden>
                <div class="axis-heading"><span class="axis-title">ISO</span><output id="camera-iso-value">—</output></div>
                <input id="camera-iso" type="range" min="0" max="0" step="1" value="0" aria-label="ISO" />
              </div>
            </div>''', '''            <div id="camera-optics-manual" class="optics-manual" hidden>
              <label id="camera-exposure-manual" class="axis-control" for="camera-exposure">
                <span class="axis-title">Shutter</span>
                <select id="camera-exposure" aria-label="Shutter speed"></select>
              </label>
              <label id="camera-iso-control" class="axis-control" for="camera-iso" hidden>
                <span class="axis-title">ISO</span>
                <select id="camera-iso" aria-label="ISO"></select>
              </label>
              <div id="camera-optics-readback" class="optics-readback" role="status" aria-live="polite"></div>
            </div>''')

# 2) Make the two manual controls align like normal settings fields.
replace_once("shared/style.css", '''.optics-manual { grid-column: 1 / -1; grid-row: 2; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 10px; align-items: center; }
.optics-manual[hidden], .optics-manual .axis-control[hidden] { display: none !important; }
.axis-control { display: grid; grid-template-columns: auto minmax(72px, 1fr); align-items: center; gap: 6px; min-width: 0; padding: 0; background: transparent; border: 0; border-radius: 0; }
.axis-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 5px; min-width: 76px; }
.axis-title { min-width: 0; color: var(--muted); font-size: 10px; font-weight: 650; text-transform: uppercase; letter-spacing: .04em; }
.axis-heading output { min-width: 0; color: var(--ink); font-size: 10px; font-weight: 650; font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.axis-control input[type="range"] { min-width: 0; width: 100%; min-height: 18px; height: 18px; margin: 0; padding: 0; background: transparent; border: 0; border-radius: 0; }''', '''.optics-manual { grid-column: 1 / -1; grid-row: 2; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px 10px; align-items: end; }
.optics-manual[hidden], .optics-manual .axis-control[hidden] { display: none !important; }
.axis-control { display: flex; flex-direction: column; gap: 4px; min-width: 0; padding: 0; color: var(--muted); background: transparent; border: 0; border-radius: 0; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
.axis-title { min-width: 0; color: var(--muted); font-size: 10px; font-weight: 650; text-transform: uppercase; letter-spacing: .05em; }
.axis-control select { width: 100%; min-width: 0; font-size: 12px; font-variant-numeric: tabular-nums; text-transform: none; letter-spacing: 0; }
.optics-readback { grid-column: 1 / -1; min-height: 14px; margin-top: -1px; color: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; line-height: 1.3; }
.optics-readback:empty { display: none; }''')

# 3) Remove the camera-constraint module's stale direct DOM synchronization.
# It should report settled hardware values; runtime owns receiver UI state.
replace_once("receive/camera-constraints.js", '''function syncManualAxis(id, autoId, actual) {
  const input = document.getElementById(id);
  const automatic = document.getElementById(autoId);
  const value = Number(actual);
  if (!(input instanceof HTMLInputElement) || automatic?.checked || !Number.isFinite(value)) return false;
  if (closeNumber(input.value, value)) return false;
  const min = Number(input.min);
  const max = Number(input.max);
  const clamped = Math.max(Number.isFinite(min) ? min : -Infinity, Math.min(Number.isFinite(max) ? max : Infinity, value));
  input.value = String(clamped);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

function installSettledExposureSync() {
  window.addEventListener("airgapper:exposure-settled", (event) => {
    const detail = event?.detail;
    const track = activeCameraTrack();
    if (!track || detail?.track !== track || track.readyState !== "live") return;
    if (document.getElementById("camera-exposure-auto")?.checked) return;
    const requested = detail.requested ?? {};
    const actual = detail.actual ?? {};

    if (requested.exposureTime !== undefined)
      syncManualAxis("camera-exposure", "exposure-axis-auto", actual.exposureTime);
    if (requested.iso !== undefined)
      syncManualAxis("camera-iso", "iso-axis-auto", actual.iso);
  });
}

''', '')
replace_once("receive/camera-constraints.js", '''installManualToAutoReopen();
installSettledExposureSync();

export { applyAdvancedConstraint };''', '''installManualToAutoReopen();

export { applyAdvancedConstraint };''')

# 4) Runtime DOM refs: selects + one readback instead of output elements.
replace_once("receive/runtime.js", '''const cameraExposureManual = document.getElementById("camera-exposure-manual");
const cameraExposure = document.getElementById("camera-exposure");
const cameraExposureValue = document.getElementById("camera-exposure-value");''', '''const cameraExposure = document.getElementById("camera-exposure");
const cameraOpticsReadback = document.getElementById("camera-optics-readback");''')
replace_once("receive/runtime.js", '''const cameraIsoControl = document.getElementById("camera-iso-control");
const cameraIso = document.getElementById("camera-iso");
const cameraIsoValue = document.getElementById("camera-iso-value");''', '''const cameraIsoControl = document.getElementById("camera-iso-control");
const cameraIso = document.getElementById("camera-iso");''')

# 5) Replace slider/output synchronization with capability-aware exact choices.
replace_once("receive/runtime.js", '''function formatExposureMs(value) {
  return value === void 0 ? "—" : `${Number((value * 0.1).toPrecision(3))} ms`;
}
function showExposureTime(value) {
  cameraExposureValue.value = formatExposureMs(value);
}
function syncExposureControls() {
  cameraExposureAuto.checked = automaticOptics;
  cameraOpticsManual.hidden = automaticOptics || cameraExposureControl.hidden;
  opticsAutoActions.hidden = !automaticOptics;
  cameraExposure.disabled = false;
  cameraIso.disabled = false;
  cameraExposureValue.value = preferredExposureTime > 0 ? formatExposureMs(preferredExposureTime) : "—";
  cameraIsoValue.value = preferredIso > 0 ? String(Number(preferredIso.toPrecision(4))) : "—";
}''', '''function formatExposureMs(value) {
  return value === void 0 ? "—" : `${Number((value * 0.1).toPrecision(3))} ms`;
}
function formatIso(value) {
  return Number.isFinite(Number(value)) ? String(Number(Number(value).toPrecision(4))) : "—";
}
const MANUAL_SHUTTER_MS_OPTIONS = [
  0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.2, 1.5, 1.8, 2, 2.5, 3,
  3.5, 4, 4.5, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 22, 25, 30
];
const MANUAL_ISO_OPTIONS = [
  25, 32, 40, 50, 64, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800,
  1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000, 10000, 12800
];
function normalizedCameraValue(value) {
  return Number(Number(value).toPrecision(8));
}
function manualRangeValues(range, curated, current, preferred, maxGenerated = 160) {
  const min = Number(range?.min);
  const max = Number(range?.max);
  const step = Number(range?.step);
  if (!(Number.isFinite(min) && Number.isFinite(max) && min <= max)) return [];
  const usableStep = Number.isFinite(step) && step > 0 ? step : 0;
  const values = [];
  const add = (raw) => {
    if (!Number.isFinite(Number(raw))) return;
    const value = normalizedCameraValue(quantizeCameraRange(Number(raw), { min, max, step: usableStep }));
    const tolerance = Math.max(usableStep * 0.25, 1e-7);
    if (!values.some((candidate) => Math.abs(candidate - value) <= tolerance)) values.push(value);
  };
  const count = usableStep ? Math.floor((max - min) / usableStep + 1e-7) + 1 : Infinity;
  if (count <= maxGenerated) {
    for (let i = 0; i < count; i++) add(min + i * usableStep);
  } else {
    for (const value of curated) add(value);
  }
  add(min);
  add(max);
  add(current);
  add(preferred);
  return values.sort((a, b) => a - b);
}
function nearestManualValue(values, requested) {
  if (!values.length) return void 0;
  if (!Number.isFinite(Number(requested))) return values[0];
  return values.reduce((best, value) => Math.abs(value - requested) < Math.abs(best - requested) ? value : best, values[0]);
}
function populateManualSelect(select, range, curated, current, preferred, formatter) {
  const values = manualRangeValues(range, curated, current, preferred);
  select.replaceChildren(...values.map((value) => new Option(formatter(value), String(value))));
  const selected = nearestManualValue(values, preferred ?? current);
  if (selected !== void 0) select.value = String(selected);
  return selected;
}
function ensureManualSelectValue(select, value, formatter) {
  value = Number(value);
  if (!Number.isFinite(value)) return;
  let option = [...select.options].find((candidate) => Math.abs(Number(candidate.value) - value) <= 1e-7);
  if (!option) {
    option = new Option(formatter(value), String(normalizedCameraValue(value)));
    select.add(option);
  }
  select.value = option.value;
}
function selectedManualSummary(prefix) {
  const pieces = [];
  if (preferredExposureTime > 0) pieces.push(formatExposureMs(preferredExposureTime));
  if (preferredIso > 0) pieces.push(`ISO ${formatIso(preferredIso)}`);
  return pieces.length ? `${prefix} · ${pieces.join(" · ")}` : prefix;
}
function syncManualOpticsReadback(track = stream?.getVideoTracks?.()[0]) {
  if (!cameraOpticsReadback) return;
  if (automaticOptics || cameraOpticsManual.hidden) {
    cameraOpticsReadback.textContent = "";
    return;
  }
  const actual = track?.getSettings?.() ?? {};
  const pieces = [];
  if (Number(actual.exposureTime) > 0) pieces.push(formatExposureMs(Number(actual.exposureTime)));
  if (Number(actual.iso) > 0) pieces.push(`ISO ${formatIso(Number(actual.iso))}`);
  cameraOpticsReadback.textContent = pieces.length ? `Actual · ${pieces.join(" · ")}` : selectedManualSummary("Selected");
}
function showManualOpticsPending() {
  if (cameraOpticsReadback && !automaticOptics) cameraOpticsReadback.textContent = selectedManualSummary("Applying");
}
function syncExposureControls(track = stream?.getVideoTracks?.()[0]) {
  cameraExposureAuto.checked = automaticOptics;
  cameraOpticsManual.hidden = automaticOptics || cameraExposureControl.hidden;
  opticsAutoActions.hidden = !automaticOptics;
  cameraExposure.disabled = false;
  cameraIso.disabled = false;
  if (preferredExposureTime > 0) ensureManualSelectValue(cameraExposure, preferredExposureTime, formatExposureMs);
  if (preferredIso > 0) ensureManualSelectValue(cameraIso, preferredIso, formatIso);
  syncManualOpticsReadback(track);
}''')

# 6) Make a validated optimizer winner use the same exact-select UI.
replace_once("receive/runtime.js", '''  preferredExposureTime = winner.exposure;
  preferredIso = winner.iso;
  cameraExposure.value = String(winner.exposure);
  showExposureTime(winner.exposure);
  cameraIso.value = String(winner.iso);
  cameraIsoValue.value = String(Number(winner.iso.toPrecision(4)));''', '''  preferredExposureTime = winner.exposure;
  preferredIso = winner.iso;
  ensureManualSelectValue(cameraExposure, winner.exposure, formatExposureMs);
  ensureManualSelectValue(cameraIso, winner.iso, formatIso);''')

# 7) After a manual camera write, report actual sensor state rather than echoing
# the requested values into detached output elements.
replace_once("receive/runtime.js", '''  if (generation !== exposureApplyGeneration || track.readyState !== "live") return;
  if (!automaticExposureAxis) {
    cameraExposure.value = String(requestedExposure);
    showExposureTime(requestedExposure);
  }
  if (!automaticIsoAxis && requestedIso !== void 0) {
    cameraIso.value = String(requestedIso);
    cameraIsoValue.value = String(Number(requestedIso.toPrecision(4)));
  }
  syncExposureControls();
}''', '''  if (generation !== exposureApplyGeneration || track.readyState !== "live") return;
  if (!automaticExposureAxis) ensureManualSelectValue(cameraExposure, requestedExposure, formatExposureMs);
  if (!automaticIsoAxis && requestedIso !== void 0) ensureManualSelectValue(cameraIso, requestedIso, formatIso);
  syncExposureControls(track);
  for (const delay of [140, 360]) setTimeout(() => {
    if (generation === exposureApplyGeneration && track.readyState === "live" && !automaticOptics) syncManualOpticsReadback(track);
  }, delay);
}''')

# 8) Build exact dropdown choices from the camera's real capabilities. If the
# range is small, every supported value is listed; large ranges get a dense set
# of useful photographic values plus min/max/current/saved values.
replace_once("receive/runtime.js", '''  if (exposure && exposureMin < exposureMax) {
    const current = Math.max(exposureMin, Math.min(exposureMax, preferredExposureTime != null ? preferredExposureTime : 100));
    preferredExposureTime = current;
    cameraExposure.min = String(exposureMin);
    cameraExposure.max = String(exposureMax);
    cameraExposure.step = String(Math.max((_c = exposure.step) != null ? _c : 0, 0.1));
    cameraExposure.value = String(current);
    showExposureTime(current);
    syncExposureControls();
  } else {
    cameraOpticsManual.hidden = true;
  }
  const iso = caps.iso;
  cameraIsoControl.hidden = !iso;
  if (iso) {
    preferredIso = Math.max(iso.min, Math.min(iso.max, preferredIso != null ? preferredIso : Number(track.getSettings().iso) || iso.min));
    cameraIso.min = String(iso.min);
    cameraIso.max = String(iso.max);
    cameraIso.step = String((_d = iso.step) != null ? _d : 1);
    cameraIso.value = String(preferredIso);
    cameraIsoValue.value = String(Number(preferredIso.toPrecision(4)));
  }''', '''  if (exposure && exposureMin < exposureMax) {
    const actualExposure = Number(track.getSettings().exposureTime);
    const exposureRange = { min: exposureMin, max: exposureMax, step: Math.max((_c = exposure.step) != null ? _c : 0, 0.1) };
    const current = Math.max(exposureMin, Math.min(exposureMax, preferredExposureTime != null ? preferredExposureTime : actualExposure || 100));
    preferredExposureTime = populateManualSelect(
      cameraExposure, exposureRange, MANUAL_SHUTTER_MS_OPTIONS.map((ms) => ms * 10), actualExposure, current, formatExposureMs
    ) ?? current;
  } else {
    cameraOpticsManual.hidden = true;
  }
  const iso = caps.iso;
  cameraIsoControl.hidden = !iso;
  if (iso) {
    const actualIso = Number(track.getSettings().iso);
    const current = Math.max(iso.min, Math.min(iso.max, preferredIso != null ? preferredIso : actualIso || iso.min));
    preferredIso = populateManualSelect(cameraIso, iso, MANUAL_ISO_OPTIONS, actualIso, current, formatIso) ?? current;
  }
  syncExposureControls(track);''')

# 9) Settled hardware substitutions are authoritative. Adopt them only after the
# camera constraint layer has confirmed the same substituted value repeatedly.
needle = '''navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  void refreshCameraDevices(stream?.getVideoTracks()[0]);
});
cameraExposureAuto.addEventListener("change", () => {'''
replacement = '''navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  void refreshCameraDevices(stream?.getVideoTracks()[0]);
});
window.addEventListener("airgapper:exposure-settled", (event) => {
  const detail = event?.detail;
  const track = stream?.getVideoTracks?.()[0];
  if (!track || detail?.track !== track || track.readyState !== "live" || automaticOptics) return;
  const requested = detail.requested ?? {};
  const actual = detail.actual ?? {};
  if (requested.exposureTime !== void 0 && Number(actual.exposureTime) > 0) {
    preferredExposureTime = Number(actual.exposureTime);
    ensureManualSelectValue(cameraExposure, preferredExposureTime, formatExposureMs);
  }
  if (requested.iso !== void 0 && Number(actual.iso) > 0) {
    preferredIso = Number(actual.iso);
    ensureManualSelectValue(cameraIso, preferredIso, formatIso);
  }
  syncExposureControls(track);
  saveCameraSettings();
});
cameraExposureAuto.addEventListener("change", () => {'''
replace_once("receive/runtime.js", needle, replacement)

# 10) Select changes are discrete exact choices: update immediately and perform
# one camera transaction. No range-drag debounce or hundreds of intermediate writes.
replace_once("receive/runtime.js", '''cameraExposureAuto.addEventListener("change", () => {
  automaticOptics = cameraExposureAuto.checked;
  automaticExposureAxis = false;
  automaticIsoAxis = false;
  resetAutomaticOpticsRuntime();
  clearTimeout(exposureApplyTimer);
  syncExposureControls();
  saveCameraSettings();
  const track = stream == null ? void 0 : stream.getVideoTracks()[0];
  if (!automaticOptics) {
    setOptimizeEnabled(false);
    manualOpticsCheckAt = 0;
    if (track) void applyAndValidateManualExposure(track);
    return;
  }
  if (track) void applyExposureSetting(track);
});
function queueExposureChange(immediate = false) {
  holdDecoderForCameraMutation("manual exposure changing");
  resetGuidedRollout();
  preferredExposureTime = Number(cameraExposure.value);
  showExposureTime(preferredExposureTime);
  saveCameraSettings();
  clearTimeout(exposureApplyTimer);
  const apply = () => {
    const track = stream == null ? void 0 : stream.getVideoTracks()[0];
    if (track && !automaticOptics) void applyAndValidateManualExposure(track);
  };
  if (immediate) apply();
  else exposureApplyTimer = setTimeout(apply, 80);
}
cameraExposure.addEventListener("input", () => queueExposureChange());
cameraExposure.addEventListener("change", () => queueExposureChange(true));
function queueIsoChange(immediate = false) {
  holdDecoderForCameraMutation("manual ISO changing");
  resetGuidedRollout();
  preferredIso = Number(cameraIso.value);
  automaticIsoAxis = false;
  cameraIsoValue.value = String(Number(preferredIso.toPrecision(4)));
  syncExposureControls();
  saveCameraSettings();
  clearTimeout(exposureApplyTimer);
  const apply = () => {
    const track = stream == null ? void 0 : stream.getVideoTracks()[0];
    if (track && !automaticOptics) void applyAndValidateManualExposure(track);
  };
  if (immediate) apply();
  else exposureApplyTimer = setTimeout(apply, 80);
}
cameraIso.addEventListener("input", () => queueIsoChange());
cameraIso.addEventListener("change", () => queueIsoChange(true));''', '''cameraExposureAuto.addEventListener("change", () => {
  automaticOptics = cameraExposureAuto.checked;
  automaticExposureAxis = false;
  automaticIsoAxis = false;
  resetAutomaticOpticsRuntime();
  clearTimeout(exposureApplyTimer);
  const track = stream == null ? void 0 : stream.getVideoTracks()[0];
  syncExposureControls(track);
  saveCameraSettings();
  if (!automaticOptics) {
    setOptimizeEnabled(false);
    manualOpticsCheckAt = 0;
    if (track) void applyAndValidateManualExposure(track);
    return;
  }
  if (track) void applyExposureSetting(track);
});
function applySelectedManualOptics(reason) {
  holdDecoderForCameraMutation(reason);
  resetGuidedRollout();
  showManualOpticsPending();
  saveCameraSettings();
  clearTimeout(exposureApplyTimer);
  const track = stream == null ? void 0 : stream.getVideoTracks()[0];
  if (track && !automaticOptics) void applyAndValidateManualExposure(track);
}
cameraExposure.addEventListener("change", () => {
  preferredExposureTime = Number(cameraExposure.value);
  automaticExposureAxis = false;
  applySelectedManualOptics("manual shutter changing");
});
cameraIso.addEventListener("change", () => {
  preferredIso = Number(cameraIso.value);
  automaticIsoAxis = false;
  applySelectedManualOptics("manual ISO changing");
});''')

# 11) Guard the architecture so sliders/stale per-axis synchronization do not return.
write("benchmark/manual-optics-ui-smoke.mjs", '''import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const runtime = fs.readFileSync(new URL("../receive/runtime.js", import.meta.url), "utf8");
const constraints = fs.readFileSync(new URL("../receive/camera-constraints.js", import.meta.url), "utf8");

assert.match(html, /<select id="camera-exposure"[^>]*><\\/select>/, "manual shutter should be an exact-value select");
assert.match(html, /<select id="camera-iso"[^>]*><\\/select>/, "manual ISO should be an exact-value select");
assert.doesNotMatch(html, /id="camera-exposure"[^>]*type="range"/, "manual shutter slider must not return");
assert.doesNotMatch(html, /id="camera-iso"[^>]*type="range"/, "manual ISO slider must not return");
assert.match(html, /id="camera-optics-readback"[^>]*aria-live="polite"/, "manual optics needs live actual sensor readback");
assert.match(runtime, /window\.addEventListener\("airgapper:exposure-settled"/, "runtime must adopt confirmed hardware substitutions");
assert.match(runtime, /populateManualSelect\(cameraExposure/, "shutter options should come from camera capabilities");
assert.match(runtime, /populateManualSelect\(cameraIso/, "ISO options should come from camera capabilities");
assert.doesNotMatch(runtime, /cameraExposure\.addEventListener\("input"/, "select changes should not issue drag-style camera writes");
assert.doesNotMatch(constraints, /exposure-axis-auto|iso-axis-auto/, "constraint layer must not reference removed per-axis Auto controls");

console.log("AIRGAPPER_MANUAL_OPTICS_UI_PASS");
''')

replace_once(".github/workflows/fast-regression.yml", '''          node --input-type=module --check < benchmark/guided-motion-smoke.mjs
          node --input-type=module --check < benchmark/offline-runner.mjs''', '''          node --input-type=module --check < benchmark/guided-motion-smoke.mjs
          node --input-type=module --check < benchmark/manual-optics-ui-smoke.mjs
          node --input-type=module --check < benchmark/offline-runner.mjs''')
replace_once(".github/workflows/fast-regression.yml", '''          node benchmark/guided-motion-smoke.mjs
          node benchmark/rgba-luma-smoke.mjs''', '''          node benchmark/guided-motion-smoke.mjs
          node benchmark/manual-optics-ui-smoke.mjs
          node benchmark/rgba-luma-smoke.mjs''')

replace_once("version.js", 'export const APP_VERSION = "0.5.522";', 'export const APP_VERSION = "0.5.523";')

# The one-shot patch scaffolding must not survive the commit.
(ROOT / ".github/workflows/one-shot-manual-optics-fix.yml").unlink(missing_ok=True)
Path(__file__).unlink(missing_ok=True)
