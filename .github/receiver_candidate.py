from pathlib import Path

def read(path):
    return Path(path).read_text()

def write(path, text):
    Path(path).write_text(text)

def replace(path, old, new, expected=1):
    text = read(path)
    found = text.count(old)
    if found != expected:
        raise SystemExit(f"{path}: expected {expected} occurrence(s), found {found}: {old[:180]!r}")
    write(path, text.replace(old, new, expected))

replace("send/main.js", 'const AUTO_GRID_MIN_MODULE_PX = 2;', 'const AUTO_GRID_FRAGMENTATION_BONUS = 0.18;')
replace("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.307";', 'const SEND_RUNTIME_BUILD = "v0.5.308";')
replace(
    "send/main.js",
    '''function selectedLayout() {\n  const mode = cfgLayout.value;\n  return mode === "auto" || mode === "single" || mode === "one-two" || mode === "two-two" || mode === "two-three" || mode === "three-five" || mode === "three-six" || mode === "four-six" || mode === "four-seven" || mode === "four-eight" ? mode : "four-three";\n}\n''',
    '''function selectedLayout() {\n  const mode = cfgLayout.value;\n  return mode === "auto" || mode === "auto-1" || mode === "auto-2" || mode === "auto-3" || mode === "auto-4" || mode === "single" || mode === "one-two" || mode === "two-two" || mode === "two-three" || mode === "three-five" || mode === "three-six" || mode === "four-six" || mode === "four-seven" || mode === "four-eight" ? mode : "four-three";\n}\nfunction isAutoLayout(mode = selectedLayout()) {\n  return mode === "auto" || mode === "auto-1" || mode === "auto-2" || mode === "auto-3" || mode === "auto-4";\n}\nfunction autoGridTargetModulePx(mode = selectedLayout()) {\n  if (mode === "auto") return 2;\n  const match = /^auto-([1-4])$/.exec(mode);\n  return match ? Number(match[1]) : 0;\n}\n'''
)
replace(
    "send/main.js",
    '''function updateAutoGridControlState() {\n  const automatic = selectedLayout() === "auto";\n  cfgSize.disabled = automatic;\n  cfgSize.title = automatic ? "Auto Grid chooses QR payload size" : "";\n}\n''',
    '''function updateAutoGridControlState() {\n  const automatic = isAutoLayout();\n  cfgSize.disabled = automatic;\n  cfgSize.title = automatic ? `Auto ${autoGridTargetModulePx()} chooses QR payload size to preserve module density` : "";\n}\n'''
)
replace(
    "send/main.js",
    'function chooseAutoGrid(payloadBytes, txFps, fitScaling) {',
    'function chooseAutoGrid(payloadBytes, txFps, fitScaling, targetModulePx = autoGridTargetModulePx()) {\n  const densityTarget = Math.max(1, Math.min(4, Number(targetModulePx) || 2));'
)
replace(
    "send/main.js",
    '''  const strict = candidates.filter((candidate) =>\n    candidate.moduleScale >= AUTO_GRID_MIN_MODULE_PX &&\n    candidate.changesPerRefresh <= AUTO_GRID_MAX_CHANGES_PER_REFRESH\n  );\n  const pool = strict.length ? strict : candidates;\n  const adjustedScore = (candidate) => {\n    if (strict.length) return candidate.payloadPerSecond;\n    const scalePenalty = Math.min(1, candidate.moduleScale / AUTO_GRID_MIN_MODULE_PX);\n    const transitionPenalty = Math.min(1, AUTO_GRID_MAX_CHANGES_PER_REFRESH / Math.max(0.001, candidate.changesPerRefresh));\n    return candidate.payloadPerSecond * scalePenalty * transitionPenalty;\n  };\n  pool.sort((a, b) =>\n    adjustedScore(b) - adjustedScore(a) ||\n    b.moduleScale - a.moduleScale ||\n    b.plan.frameBytes - a.plan.frameBytes ||\n    b.codes - a.codes ||\n    a.layout.id - b.layout.id\n  );\n  return { ...pool[0], constrained: strict.length > 0 };''',
    '''  const strict = candidates.filter((candidate) =>\n    candidate.moduleScale >= densityTarget &&\n    candidate.changesPerRefresh <= AUTO_GRID_MAX_CHANGES_PER_REFRESH\n  );\n  const pool = strict.length ? strict : candidates;\n  const adjustedScore = (candidate) => {\n    // A rolling-shutter stripe destroys a smaller fraction of a wall made from\n    // more independent QRs. Allow up to an 18% theoretical throughput trade\n    // across the 8→32 QR range when fragmentation improves substantially.\n    const fragmentation = Math.max(0, Math.min(1, (candidate.codes - 8) / 24));\n    const fragmentationBonus = 1 + fragmentation * AUTO_GRID_FRAGMENTATION_BONUS;\n    if (strict.length) return candidate.payloadPerSecond * fragmentationBonus;\n    const scalePenalty = Math.min(1, candidate.moduleScale / densityTarget);\n    const transitionPenalty = Math.min(1, AUTO_GRID_MAX_CHANGES_PER_REFRESH / Math.max(0.001, candidate.changesPerRefresh));\n    return candidate.payloadPerSecond * fragmentationBonus * scalePenalty * transitionPenalty;\n  };\n  pool.sort((a, b) =>\n    adjustedScore(b) - adjustedScore(a) ||\n    b.codes - a.codes ||\n    b.moduleScale - a.moduleScale ||\n    b.plan.frameBytes - a.plan.frameBytes ||\n    a.layout.id - b.layout.id\n  );\n  return { ...pool[0], constrained: strict.length > 0, targetModulePx: densityTarget };'''
)
replace("send/main.js", 'selectedLayout() === "auto"', 'isAutoLayout()', expected=3)
replace(
    "send/main.js",
    '''    if (saved.layout === "auto" || saved.layout === "single" || saved.layout === "one-two" || saved.layout === "two-two" || saved.layout === "two-three" || saved.layout === "four-three" || saved.layout === "three-five" || saved.layout === "three-six" || saved.layout === "four-six" || saved.layout === "four-seven" || saved.layout === "four-eight") {\n      cfgLayout.value = saved.layout;\n    } else if (saved.layout === "five-three") {''',
    '''    if (saved.layout === "auto") {\n      // v0.5.307 Auto used a 2 px/module floor. Preserve that behavior when\n      // migrating saved settings into the explicit Auto density family.\n      cfgLayout.value = "auto-2";\n    } else if (saved.layout === "auto-1" || saved.layout === "auto-2" || saved.layout === "auto-3" || saved.layout === "auto-4" || saved.layout === "single" || saved.layout === "one-two" || saved.layout === "two-two" || saved.layout === "two-three" || saved.layout === "four-three" || saved.layout === "three-five" || saved.layout === "three-six" || saved.layout === "four-six" || saved.layout === "four-seven" || saved.layout === "four-eight") {\n      cfgLayout.value = saved.layout;\n    } else if (saved.layout === "five-three") {'''
)
replace(
    "send/main.js",
    '  const autoMode = configuredLayout === "auto";',
    '  const autoMode = isAutoLayout(configuredLayout);'
)
replace(
    "send/main.js",
    '      autoGrid = chooseAutoGrid(payload.length, txFps, fitScaling);',
    '      autoGrid = chooseAutoGrid(payload.length, txFps, fitScaling, autoGridTargetModulePx(configuredLayout));'
)
replace(
    "send/main.js",
    '''    return `Auto Grid · ${gridCols}×${gridRows} · ${gridCodes} QR · v${transport.qrVersion} · ${formatBytes(transport.frameBytes)}/QR · ${autoGrid.moduleScale.toFixed(2)} display px/module · ${txFps} fps · ${Math.round(autoGrid.refreshHz)} Hz display · ${autoGrid.changesPerRefresh.toFixed(2)} QR changes/refresh · ${updatePatternLabel}${fallback}`;''',
    '''    return `Auto ${autoGrid.targetModulePx} · ${gridCols}×${gridRows} · ${gridCodes} QR · v${transport.qrVersion} · ${formatBytes(transport.frameBytes)}/QR · ${autoGrid.moduleScale.toFixed(2)} display px/module · ${txFps} fps · ${Math.round(autoGrid.refreshHz)} Hz display · ${autoGrid.changesPerRefresh.toFixed(2)} QR changes/refresh · ${updatePatternLabel}${fallback}`;'''
)
replace(
    "index.html",
    '<select id="cfg-layout"><option value="auto">Auto</option><option value="single" selected>',
    '<select id="cfg-layout"><option value="auto-1">Auto 1 · ≥1 px/module</option><option value="auto-2">Auto 2 · ≥2 px/module</option><option value="auto-3">Auto 3 · ≥3 px/module</option><option value="auto-4">Auto 4 · ≥4 px/module</option><option value="single" selected>'
)
replace("index.html", "v0.5.307", "v0.5.308", expected=2)
replace("main.js", 'const APP_BUILD = "v0.5.307";', 'const APP_BUILD = "v0.5.308";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.307";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.308";')
replace("sw.js", 'airgapper-static-js-v255', 'airgapper-static-js-v256')
print("v0.5.308 Auto 1-4 density family applied")
