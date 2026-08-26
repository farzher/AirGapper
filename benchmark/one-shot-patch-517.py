from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, got {count}")
    return text.replace(old, new, 1)


# Compact manual optics markup: global Optics Auto is the only mode switch.
p = Path("index.html")
s = p.read_text()
old = '''            <div id="camera-optics-manual" class="optics-manual" hidden>
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
new = '''            <div id="camera-optics-manual" class="optics-manual" hidden>
              <div id="camera-exposure-manual" class="axis-control">
                <div class="axis-heading"><span class="axis-title">Exposure</span><output id="camera-exposure-value">—</output></div>
                <input id="camera-exposure" type="range" min="0" max="0" value="0" step="1" aria-label="Exposure time" />
              </div>
              <div id="camera-iso-control" class="axis-control" hidden>
                <div class="axis-heading"><span class="axis-title">ISO</span><output id="camera-iso-value">—</output></div>
                <input id="camera-iso" type="range" min="0" max="0" step="1" value="0" aria-label="ISO" />
              </div>
            </div>'''
s = replace_once(s, old, new, "manual optics markup")
if any(token in s for token in ("axis-auto-toggle", "exposure-axis-auto", "iso-axis-auto", "axis-scale")):
    raise SystemExit("manual optics toggle/helper markup survived")
p.write_text(s)

# Small, flat sliders instead of nested cards.
p = Path("shared/style.css")
s = p.read_text()
old = '''.optics-manual { grid-column: 1 / -1; grid-row: 2; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
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
.axis-control.is-auto .axis-scale { opacity: .55; }'''
new = '''.optics-manual { grid-column: 1 / -1; grid-row: 2; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 10px; align-items: center; }
.optics-manual[hidden], .optics-manual .axis-control[hidden] { display: none !important; }
.axis-control { display: grid; grid-template-columns: auto minmax(72px, 1fr); align-items: center; gap: 6px; min-width: 0; padding: 0; background: transparent; border: 0; border-radius: 0; }
.axis-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 5px; min-width: 76px; }
.axis-title { min-width: 0; color: var(--muted); font-size: 10px; font-weight: 650; text-transform: uppercase; letter-spacing: .04em; }
.axis-heading output { min-width: 0; color: var(--ink); font-size: 10px; font-weight: 650; font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.axis-control input[type="range"] { min-width: 0; width: 100%; min-height: 18px; height: 18px; margin: 0; padding: 0; background: transparent; border: 0; border-radius: 0; }'''
s = replace_once(s, old, new, "manual optics css")
landscape = '''

/* Browser tabs cannot reliably lock orientation, especially on iOS. In a short
   landscape receiver viewport, spend the height on the camera instead. */
@media (orientation: landscape) and (max-height: 600px) {
  body.receive-mode .app-header { display: none; }
  body.receive-mode .app-main { width: 100%; max-width: none; padding: 0; }
  body.receive-mode .receiver-primary { gap: 0; }
  body.receive-mode .receiver-heading { display: none; }
  body.receive-mode .preview-zone { flex: 1 1 0; min-height: 0; }
  body.receive-mode .transfer-panel { padding: 6px 10px; border-inline: 0; border-bottom: 0; border-radius: 0; }
  body.receive-mode .transfer-panel details.settings > .row { max-height: min(140px, 42vh); padding-bottom: 6px; }
  body.receive-mode .progress { height: 5px; margin-top: 6px; }
  body.receive-mode .transfer-meta { margin-top: 5px; }
}
'''
if "@media (orientation: landscape) and (max-height: 600px)" in s:
    raise SystemExit("landscape receiver rule already exists")
p.write_text(s + landscape)

# Global Optics Auto is now the sole mode. The internal per-axis flags remain as
# fixed false invariants so the mature manual constraint path needs no rewrite.
p = Path("receive/runtime.js")
s = p.read_text()
s = replace_once(s, '''const exposureAxisAuto = document.getElementById("exposure-axis-auto");
const isoAxisAuto = document.getElementById("iso-axis-auto");
const exposureAxisToggle = document.getElementById("exposure-axis-toggle");
const isoAxisToggle = document.getElementById("iso-axis-toggle");
''', "", "axis DOM refs")
s = replace_once(s, "let automaticExposureAxis = true;\nlet automaticIsoAxis = true;", "let automaticExposureAxis = false;\nlet automaticIsoAxis = false;", "axis defaults")
s = replace_once(s, '''    if (typeof saved.automaticExposureAxis === "boolean") automaticExposureAxis = saved.automaticExposureAxis;
    if (typeof saved.automaticIsoAxis === "boolean") automaticIsoAxis = saved.automaticIsoAxis;
''', "", "axis restore")
s = replace_once(s, '''      automaticExposureAxis,
      automaticIsoAxis,
''', "", "axis save")
old = '''function quantizedInputValue(input, value) {
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
new = '''function syncExposureControls() {
  cameraExposureAuto.checked = automaticOptics;
  cameraOpticsManual.hidden = automaticOptics || cameraExposureControl.hidden;
  opticsAutoActions.hidden = !automaticOptics;
  cameraExposure.disabled = false;
  cameraIso.disabled = false;
  cameraExposureValue.value = preferredExposureTime > 0 ? formatExposureMs(preferredExposureTime) : "—";
  cameraIsoValue.value = preferredIso > 0 ? String(Number(preferredIso.toPrecision(4))) : "—";
}'''
s = replace_once(s, old, new, "sync exposure controls")
s = replace_once(s, '''  automaticOptics = cameraExposureAuto.checked;
  resetAutomaticOpticsRuntime();
  clearTimeout(exposureApplyTimer);
''', '''  automaticOptics = cameraExposureAuto.checked;
  automaticExposureAxis = false;
  automaticIsoAxis = false;
  resetAutomaticOpticsRuntime();
  clearTimeout(exposureApplyTimer);
''', "global optics toggle")
start = s.find('exposureAxisAuto.addEventListener("change", () => {')
end = s.find("function queueExposureChange", start)
if start < 0 or end < 0:
    raise SystemExit("axis listener block not found")
s = s[:start] + s[end:]
s = replace_once(s, '''  preferredIso = Number(cameraIso.value);
  automaticIsoAxis = false;
  isoAxisAuto.checked = false;
''', '''  preferredIso = Number(cameraIso.value);
  automaticIsoAxis = false;
''', "ISO slider obsolete checkbox")
if any(token in s for token in ("exposureAxisAuto", "isoAxisAuto", "exposureAxisToggle", "isoAxisToggle")):
    raise SystemExit("obsolete axis UI runtime reference survived")
p.write_text(s)

# State and px/module are useful developer diagnostics, not normal-user chrome.
p = Path("receive/user-overlay.js")
s = p.read_text()
s = replace_once(s, '''  status.style.display = developer ? "none" : "";
  if (!developer) {
    updateStatus();
    scheduleDraw();
  }''', '''  status.style.display = developer ? "" : "none";
  updateStatus();
  if (!developer) scheduleDraw();''', "overlay status mode")
p.write_text(s)

p = Path("version.js")
s = p.read_text()
if "v0.5.516" not in s:
    raise SystemExit("expected v0.5.516 version source")
p.write_text(s.replace("v0.5.516", "v0.5.517"))
