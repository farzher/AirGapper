from pathlib import Path
import re


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one anchor, found {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


def sub_once(path, pattern, replacement, flags=0):
    p = Path(path)
    text = p.read_text()
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one regex match, found {count}: {pattern[:120]!r}")
    p.write_text(updated)


# Manual Optics is deliberately only sensor exposure + gain. Focus remains owned
# by FocusController's automatic strategy in both Auto Optics and Manual Optics.
replace_once(
    "index.html",
    '''            <div id="camera-optics-manual" class="optics-manual" hidden>
              <div id="focus-distance-control" class="axis-control"><span class="axis-heading"><span id="focus-axis-name">Focus</span><button id="focus-axis-reset" type="button" hidden>Focus</button><output id="focus-distance-value" hidden></output></span><select id="focus-mode"><option value="camera-auto">Auto</option><option value="single-shot">Single</option><option value="manual">Manual</option></select><input id="focus-distance" type="range" min="0" max="0" step="1" value="0" aria-label="Focus distance" hidden /></div>
              <div id="camera-exposure-manual" class="axis-control"><span class="axis-heading"><span id="exposure-axis-name">Exposure</span><button id="exposure-axis-reset" type="button" hidden>Exposure</button><output id="camera-exposure-value" hidden></output></span><label id="exposure-axis-toggle" class="setting-toggle" aria-label="Automatic exposure"><input id="exposure-axis-auto" type="checkbox" checked /></label><input id="camera-exposure" type="range" min="0" max="0" value="0" step="1" aria-label="Exposure time" hidden /></div>
              <div id="camera-iso-control" class="axis-control" hidden><span class="axis-heading"><span id="iso-axis-name">ISO</span><button id="iso-axis-reset" type="button" hidden>ISO</button><output id="camera-iso-value" hidden></output></span><label id="iso-axis-toggle" class="setting-toggle" aria-label="Automatic ISO"><input id="iso-axis-auto" type="checkbox" checked /></label><input id="camera-iso" type="range" min="0" max="0" step="1" value="0" aria-label="ISO" hidden /></div>
            </div>''',
    '''            <div id="camera-optics-manual" class="optics-manual" hidden>
              <div id="camera-exposure-manual" class="axis-control">
                <div class="axis-heading"><span class="axis-title">Exposure</span><output id="camera-exposure-value">Auto</output><label id="exposure-axis-toggle" class="axis-auto-toggle"><input id="exposure-axis-auto" type="checkbox" checked /><span>Auto</span></label></div>
                <input id="camera-exposure" type="range" min="0" max="0" value="0" step="1" aria-label="Exposure time" disabled />
                <div class="axis-scale" aria-hidden="true"><span>Faster</span><span>Brighter</span></div>
              </div>
              <div id="camera-iso-control" class="axis-control" hidden>
                <div class="axis-heading"><span class="axis-title">ISO</span><output id="camera-iso-value">Auto</output><label id="iso-axis-toggle" class="axis-auto-toggle"><input id="iso-axis-auto" type="checkbox" checked /><span>Auto</span></label></div>
                <input id="camera-iso" type="range" min="0" max="0" step="1" value="0" aria-label="ISO" disabled />
                <div class="axis-scale" aria-hidden="true"><span>Cleaner</span><span>Brighter</span></div>
              </div>
            </div>'''
)

sub_once(
    "shared/style.css",
    r'''\.optics-manual \{[^}]*\}\n\.optics-manual\[hidden\], \.optics-manual \.axis-control\[hidden\], \.optics-manual \[hidden\] \{[^}]*\}\n\.axis-control \{[^}]*\}\n\.axis-heading \{[^}]*\}\n\.axis-heading output \{[^}]*\}\n\.axis-heading button \{[^}]*\}\n\.axis-control\.manual-focus #focus-axis-reset \{[^}]*\}\n\.axis-control\.manual-focus #focus-mode \{[^}]*\}\n\.axis-control \.setting-toggle \{[^}]*\}\n\.axis-control input\[type="range"\] \{[^}]*\}\n\.axis-control input\[type="checkbox"\] \{[^}]*\}\n''',
    '''.optics-manual { grid-column: 1 / -1; grid-row: 2; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.optics-manual[hidden], .optics-manual .axis-control[hidden] { display: none !important; }
.axis-control { display: grid; grid-template-rows: auto 34px auto; gap: 6px; min-width: 0; padding: 9px 10px 8px; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; }
.axis-heading { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 7px; min-width: 0; }
.axis-title { min-width: 0; color: var(--ink); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.axis-heading output { min-width: 0; color: var(--ink); font-size: 11px; font-weight: 650; font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.axis-heading .axis-auto-toggle { display: flex; flex-direction: row; align-items: center; gap: 4px; width: auto; min-height: 24px; padding: 2px 6px; color: var(--muted); background: var(--card); border: 1px solid var(--line); border-radius: 999px; font-size: 10px; font-weight: 650; text-transform: none; letter-spacing: 0; cursor: pointer; }
.axis-heading .axis-auto-toggle input { width: auto; margin: 0; accent-color: #222; }
.axis-control input[type="range"] { min-width: 0; width: 100%; height: 34px; margin: 0; padding-inline: 4px; }
.axis-control input[type="range"]:disabled { opacity: .42; cursor: default; }
.axis-scale { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 9px; line-height: 1; letter-spacing: .02em; }
.axis-control.is-auto .axis-scale { opacity: .55; }
''',
    flags=re.S
)

replace_once(
    "receive/runtime.js",
    '''const exposureAxisToggle = document.getElementById("exposure-axis-toggle");
const isoAxisToggle = document.getElementById("iso-axis-toggle");
const exposureAxisReset = document.getElementById("exposure-axis-reset");
const isoAxisReset = document.getElementById("iso-axis-reset");
const exposureAxisName = document.getElementById("exposure-axis-name");
const isoAxisName = document.getElementById("iso-axis-name");
const cameraExposure = document.getElementById("camera-exposure");''',
    '''const exposureAxisToggle = document.getElementById("exposure-axis-toggle");
const isoAxisToggle = document.getElementById("iso-axis-toggle");
const cameraExposureManual = document.getElementById("camera-exposure-manual");
const cameraExposure = document.getElementById("camera-exposure");'''
)

replace_once(
    "receive/runtime.js",
    '''const focusDev = document.getElementById("focus-dev");
const focusMode = document.getElementById("focus-mode");
const focusAxisName = document.getElementById("focus-axis-name");
const focusAxisReset = document.getElementById("focus-axis-reset");
const opticsOptimize = document.getElementById("optics-optimize");
const opticsKeep = document.getElementById("optics-keep");
const opticsOptimizeStatus = document.getElementById("optics-optimize-status");
const focusDistanceControl = document.getElementById("focus-distance-control");
const focusDistance = document.getElementById("focus-distance");
const focusDistanceValue = document.getElementById("focus-distance-value");
const cameraIsoControl = document.getElementById("camera-iso-control");''',
    '''const focusDev = document.getElementById("focus-dev");
const opticsOptimize = document.getElementById("optics-optimize");
const opticsKeep = document.getElementById("optics-keep");
const opticsOptimizeStatus = document.getElementById("optics-optimize-status");
const cameraIsoControl = document.getElementById("camera-iso-control");'''
)

replace_once(
    "receive/runtime.js",
    '''let preferredExposureTime;
let manualFocusMode = "camera-auto";
let preferredFocusDistance;
let preferredIso;''',
    '''let preferredExposureTime;
let preferredIso;'''
)

replace_once("receive/runtime.js", "function restoreCameraSettings() {\n  var _a, _b;", "function restoreCameraSettings() {\n  var _a;")
replace_once(
    "receive/runtime.js",
    '''    if (["camera-auto", "single-shot", "manual"].includes((_b = saved.manualFocusMode) != null ? _b : "")) manualFocusMode = saved.manualFocusMode;
    if (typeof saved.focusDistance === "number" && Number.isFinite(saved.focusDistance)) preferredFocusDistance = saved.focusDistance;
''',
    ""
)
replace_once(
    "receive/runtime.js",
    '''      exposureTime: preferredExposureTime,
      workers: decodeWorkers.value,
      manualFocusMode,
      focusDistance: preferredFocusDistance,
      iso: preferredIso''',
    '''      exposureTime: preferredExposureTime,
      workers: decodeWorkers.value,
      iso: preferredIso'''
)
replace_once(
    "receive/runtime.js",
    '''  "auto",
  preferredFocusDistance,
  "auto",''',
    '''  "auto",
  void 0,
  "auto",'''
)

replace_once(
    "receive/runtime.js",
    '''function showExposureTime(value) {
  cameraExposureValue.value = formatExposureMs(value);
}
function syncExposureControls() {
  cameraExposureAuto.checked = automaticOptics;
  exposureAxisAuto.checked = automaticExposureAxis;
  isoAxisAuto.checked = automaticIsoAxis;
  cameraOpticsManual.hidden = automaticOptics || cameraExposureControl.hidden;
  opticsAutoActions.hidden = !automaticOptics;
  focusMode.value = manualFocusMode;
  const manualFocus = manualFocusMode === "manual";
  focusDistanceControl.classList.toggle("manual-focus", manualFocus);
  focusMode.hidden = false;
  focusDistance.hidden = !manualFocus;
  focusDistanceValue.hidden = !manualFocus;
  focusAxisReset.hidden = !manualFocus;
  focusAxisName.hidden = manualFocus;
  for (const [automatic, toggle, slider, output, reset, name] of [
    [automaticExposureAxis, exposureAxisToggle, cameraExposure, cameraExposureValue, exposureAxisReset, exposureAxisName],
    [automaticIsoAxis, isoAxisToggle, cameraIso, cameraIsoValue, isoAxisReset, isoAxisName]
  ]) {
    toggle.hidden = !automatic;
    slider.hidden = automatic;
    output.hidden = automatic;
    reset.hidden = automatic;
    name.hidden = !automatic;
  }
}''',
    '''function showExposureTime(value) {
  cameraExposureValue.value = formatExposureMs(value);
}
function quantizedInputValue(input, value) {
  if (!(Number.isFinite(value) && value > 0)) return void 0;
  const min = Number(input.min);
  const max = Number(input.max);
  const step = Number(input.step);
  if (!(Number.isFinite(min) && Number.isFinite(max) && min < max)) return value;
  return quantizeCameraRange(value, { min, max, step: Number.isFinite(step) && step > 0 ? step : 0 });
}
function seedManualAxisFromTrack(track, key, input) {
  return quantizedInputValue(input, Number(track?.getSettings?.()?.[key]));
}
function syncManualOpticsReadback(track = stream?.getVideoTracks?.()[0]) {
  if (!track || cameraOpticsManual.hidden) return;
  const actual = track.getSettings();
  if (automaticExposureAxis) {
    const value = quantizedInputValue(cameraExposure, Number(actual.exposureTime));
    if (value !== void 0) {
      cameraExposure.value = String(value);
      cameraExposureValue.value = `Auto · ${formatExposureMs(value)}`;
    } else cameraExposureValue.value = "Auto";
  }
  if (automaticIsoAxis) {
    const value = quantizedInputValue(cameraIso, Number(actual.iso));
    if (value !== void 0) {
      cameraIso.value = String(value);
      cameraIsoValue.value = `Auto · ${Number(value.toPrecision(4))}`;
    } else cameraIsoValue.value = "Auto";
  }
}
function syncExposureControls() {
  cameraExposureAuto.checked = automaticOptics;
  exposureAxisAuto.checked = automaticExposureAxis;
  isoAxisAuto.checked = automaticIsoAxis;
  cameraOpticsManual.hidden = automaticOptics || cameraExposureControl.hidden;
  opticsAutoActions.hidden = !automaticOptics;
  for (const [automatic, control, slider, output, manualLabel] of [
    [automaticExposureAxis, cameraExposureManual, cameraExposure, cameraExposureValue,
      preferredExposureTime > 0 ? formatExposureMs(preferredExposureTime) : "—"],
    [automaticIsoAxis, cameraIsoControl, cameraIso, cameraIsoValue,
      preferredIso > 0 ? String(Number(preferredIso.toPrecision(4))) : "—"]
  ]) {
    control.classList.toggle("is-auto", automatic);
    slider.disabled = automatic;
    slider.setAttribute("aria-disabled", String(automatic));
    output.value = automatic ? "Auto" : manualLabel;
  }
  syncManualOpticsReadback();
}'''
)

replace_once(
    "receive/runtime.js",
    '''  cameraExposure.value = String(requestedExposure);
  showExposureTime(requestedExposure);
  if (requestedIso !== void 0) {
    cameraIso.value = String(requestedIso);
    cameraIsoValue.value = String(Number(requestedIso.toPrecision(4)));
  }
}''',
    '''  if (!automaticExposureAxis) {
    cameraExposure.value = String(requestedExposure);
    showExposureTime(requestedExposure);
  }
  if (!automaticIsoAxis && requestedIso !== void 0) {
    cameraIso.value = String(requestedIso);
    cameraIsoValue.value = String(Number(requestedIso.toPrecision(4)));
  }
  syncExposureControls();
}'''
)

sub_once(
    "receive/runtime.js",
    r'''  focusDev\.hidden = diagnostic\.state === "UNAVAILABLE";\n  focusMode\.value = manualFocusMode;\n  for \(const option of focusMode\.options\) option\.disabled = !diagnostic\.availableModes\.includes\(option\.value\);\n  const range = diagnostic\.distanceRange;\n  focusDistanceControl\.hidden = automaticOptics \|\| !range && diagnostic\.availableModes\.length === 0;\n  if \(range\) \{\n    focusDistance\.min = String\(range\.min\);\n    focusDistance\.max = String\(range\.max\);\n    focusDistance\.step = String\(range\.step \|\| \(range\.max - range\.min\) / 100 \|\| 0\.01\);\n    if \(document\.activeElement !== focusDistance\) focusDistance\.value = String\(\(_a = preferredFocusDistance != null \? preferredFocusDistance : diagnostic\.actualDistance\) != null \? _a : range\.min\);\n    focusDistanceValue\.value = Number\(focusDistance\.value\)\.toPrecision\(4\);\n  \}\n''',
    '''  focusDev.hidden = diagnostic.state === "UNAVAILABLE";\n'''
)

sub_once(
    "receive/runtime.js",
    r'''focusMode\.addEventListener\("change", \(\) => \{[\s\S]*?\n\}\);\nfocusDistance\.addEventListener\("input", \(\) => \{[\s\S]*?\n\}\);\n''',
    ""
)
sub_once(
    "receive/runtime.js",
    r'''exposureAxisReset\.addEventListener\("click", \(\) => \{[\s\S]*?\n\}\);\n''',
    ""
)
sub_once(
    "receive/runtime.js",
    r'''isoAxisReset\.addEventListener\("click", \(\) => \{[\s\S]*?\n\}\);\n''',
    ""
)

replace_once(
    "receive/runtime.js",
    '''exposureAxisAuto.addEventListener("change", () => {
  automaticExposureAxis = exposureAxisAuto.checked;
  syncExposureControls();
  saveCameraSettings();
  const track = stream == null ? void 0 : stream.getVideoTracks()[0];
  if (track) void applyExposureSetting(track);
});''',
    '''exposureAxisAuto.addEventListener("change", () => {
  automaticExposureAxis = exposureAxisAuto.checked;
  const track = stream == null ? void 0 : stream.getVideoTracks()[0];
  if (!automaticExposureAxis && track) {
    const value = seedManualAxisFromTrack(track, "exposureTime", cameraExposure);
    if (value !== void 0) {
      preferredExposureTime = value;
      cameraExposure.value = String(value);
    }
  }
  syncExposureControls();
  saveCameraSettings();
  if (track) void applyExposureSetting(track);
});'''
)
replace_once(
    "receive/runtime.js",
    '''isoAxisAuto.addEventListener("change", () => {
  automaticIsoAxis = isoAxisAuto.checked;
  syncExposureControls();
  saveCameraSettings();
  const track = stream == null ? void 0 : stream.getVideoTracks()[0];
  if (track) void applyExposureSetting(track);
});''',
    '''isoAxisAuto.addEventListener("change", () => {
  automaticIsoAxis = isoAxisAuto.checked;
  const track = stream == null ? void 0 : stream.getVideoTracks()[0];
  if (!automaticIsoAxis && track) {
    const value = seedManualAxisFromTrack(track, "iso", cameraIso);
    if (value !== void 0) {
      preferredIso = value;
      cameraIso.value = String(value);
    }
  }
  syncExposureControls();
  saveCameraSettings();
  if (track) void applyExposureSetting(track);
});'''
)

# A historical initialization assignment sits outside the render/sync blocks.
p = Path("receive/runtime.js")
text = p.read_text()
legacy = "focusMode.value = manualFocusMode;\n"
if text.count(legacy) != 1:
    raise SystemExit(f"receive/runtime.js: expected one remaining legacy focus assignment, found {text.count(legacy)}")
p.write_text(text.replace(legacy, "", 1))

replace_once(
    "receive/runtime.js",
    '''  const now = receiverNow();
  if (optimizeEnabled) beginOptimizeWhenReady();
  const paintDiagnostics = forceDiagnostics || !receiverDevActions.hidden && now - lastDiagnosticsPaintAt >= DIAGNOSTICS_TICK_MS;''',
    '''  const now = receiverNow();
  if (optimizeEnabled) beginOptimizeWhenReady();
  if (!cameraOpticsManual.hidden) syncManualOpticsReadback();
  const paintDiagnostics = forceDiagnostics || !receiverDevActions.hidden && now - lastDiagnosticsPaintAt >= DIAGNOSTICS_TICK_MS;'''
)

replace_once("version.js", 'export const APP_VERSION = "0.5.514";', 'export const APP_VERSION = "0.5.515";')
