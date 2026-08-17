from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing anchor in {path}: {old[:180]!r}")
    p.write_text(text.replace(old, new, 1))


replace_once("index.html", "v0.5.168", "v0.5.169")
replace_once("main.js", 'const APP_BUILD = "v0.5.168";', 'const APP_BUILD = "v0.5.169";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.168";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.169";')
replace_once("sw.js", 'airgapper-static-js-v130', 'airgapper-static-js-v131')

p = Path("receive/main.js")
text = p.read_text()

text = text.replace('const AUTO_OPTICS_WARM_START_MS = 220;\n', '', 1)
text = text.replace('let autoOpticsWarmStartApplied = false;\n', '', 1)
text = text.replace('  autoOpticsWarmStartApplied = false;\n', '', 1)

start = text.find('async function warmStartRememberedAutomaticOptics(track, now) {\n')
end = text.find('function autoOpticsPipelineSnapshot() {\n', start)
if start < 0 or end < 0:
    raise SystemExit('warm-start function block missing')
text = text[:start] + text[end:]

old = '''  const startedFromWarm = autoOpticsRuntimeState === "warm";\n  autoOpticsMutationRunning = true;\n  autoOpticsRuntimeState = "rescue";\n  notePipelineEvent("auto-optics-acquisition-rescue");\n  try {\n    if (startedFromWarm) {\n      await applyExposureSetting(track);\n      if (!await waitForAutoOptics(420, track)) return;\n      settings = track.getSettings();\n    }\n'''
new = '''  autoOpticsMutationRunning = true;\n  autoOpticsRuntimeState = "rescue";\n  notePipelineEvent("auto-optics-acquisition-rescue");\n  try {\n'''
if old not in text:
    raise SystemExit('warm rescue branch missing')
text = text.replace(old, new, 1)

old = '''  if (autoOpticsRuntimeState !== "ae" && autoOpticsRuntimeState !== "warm") return;\n\n  if (!autoOpticsWarmStartApplied && now - autoOpticsAcquisitionSince >= AUTO_OPTICS_WARM_START_MS) {\n    void warmStartRememberedAutomaticOptics(track, now);\n    return;\n  }\n  if (!gridLattice.locked) {\n'''
new = '''  if (autoOpticsRuntimeState !== "ae") return;\n\n  // Cold acquisition stays on hardware AE. Remembered manual exposure can be\n  // badly wrong when ambient/screen brightness changed since the last session;\n  // applying it before the first QR used to create multi-second startup stalls.\n  // Memory is still the first fallback in acquisition rescue and is reused after\n  // lock for the normal motion-safe shutter/ISO tuning pass.\n  if (!gridLattice.locked) {\n'''
if old not in text:
    raise SystemExit('maintain warm-start block missing')
text = text.replace(old, new, 1)

old = 'autoOpticsRuntimeState === "manual" ? " · adaptive hold" : autoOpticsRuntimeState === "warm" ? " · remembered start" : autoOpticsRuntimeState === "ae" ? " · bootstrap AE"'
new = 'autoOpticsRuntimeState === "manual" ? " · adaptive hold" : autoOpticsRuntimeState === "ae" ? " · bootstrap AE"'
if old not in text:
    raise SystemExit('diagnostic warm label missing')
text = text.replace(old, new, 1)

p.write_text(text)
