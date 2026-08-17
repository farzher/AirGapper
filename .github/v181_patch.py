from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old!r}")
    p.write_text(text.replace(old, new, 1))

for path in ["index.html", "main.js", "receive/main.js"]:
    p = Path(path)
    text = p.read_text()
    if "v0.5.180" not in text:
        raise SystemExit(f"expected v0.5.180 in {path}")
    p.write_text(text.replace("v0.5.180", "v0.5.181"))

replace_once("sw.js", "airgapper-static-js-v142", "airgapper-static-js-v143")

replace_once(
    "receive/main.js",
    '''let preferredExposureTime;\nlet manualFocusMode = "camera-auto";\nlet preferredFocusDistance;\nlet preferredIso;''',
    '''// These are the user's persistent MANUAL optics profile. Automatic optics\n// may use arbitrary temporary sensor values, but must never overwrite these.\nlet preferredExposureTime;\nlet manualFocusMode = "camera-auto";\nlet preferredFocusDistance;\nlet preferredIso;'''
)

replace_once(
    "receive/main.js",
    '''  if (requestedExposure === void 0) return;\n  preferredExposureTime = requestedExposure;\n  if (requestedIso !== void 0) preferredIso = requestedIso;\n  if (automaticIsoAxis) delete desiredCamera.iso;''',
    '''  if (requestedExposure === void 0) return;\n  // Per-axis Auto borrows the sensor's current value for this transaction only.\n  // Do not turn that live AE/ISO reading into the user's saved manual profile.\n  if (automaticIsoAxis) delete desiredCamera.iso;'''
)

replace_once(
    "receive/main.js",
    '''    preferredExposureTime = track.getSettings().exposureTime ?? exposure;\n    preferredIso = track.getSettings().iso ?? tuned.iso ?? iso;\n    if (tuned.best?.valid) rememberAutomaticOptics(track, preferredExposureTime, preferredIso, tuned.best.score);\n    saveCameraSettings();''',
    '''    const tunedExposure = track.getSettings().exposureTime ?? exposure;\n    const tunedIso = track.getSettings().iso ?? tuned.iso ?? iso;\n    if (tuned.best?.valid) rememberAutomaticOptics(track, tunedExposure, tunedIso, tuned.best.score);'''
)

replace_once(
    "receive/main.js",
    '''    if (improved) {\n      preferredIso = candidate.iso;\n      autoOpticsFineTuneDirection = direction;\n      rememberAutomaticOptics(track, exposure, candidate.iso, candidate.score);\n      saveCameraSettings();''',
    '''    if (improved) {\n      autoOpticsFineTuneDirection = direction;\n      rememberAutomaticOptics(track, exposure, candidate.iso, candidate.score);'''
)

replace_once(
    "receive/main.js",
    '''    } else {\n      await applyCameraConstraint(track, { exposureMode: "manual", exposureTime: exposure, iso: currentIso });\n      preferredIso = currentIso;\n      autoOpticsFineTuneDirection = -direction;''',
    '''    } else {\n      await applyCameraConstraint(track, { exposureMode: "manual", exposureTime: exposure, iso: currentIso });\n      autoOpticsFineTuneDirection = -direction;'''
)
