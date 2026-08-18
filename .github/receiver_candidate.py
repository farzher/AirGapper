from pathlib import Path

def read(path):
    return Path(path).read_text()

def write(path, text):
    Path(path).write_text(text)

def replace(path, old, new, expected=1):
    text = read(path)
    found = text.count(old)
    if found != expected:
        raise SystemExit(f"{path}: expected {expected} occurrence(s), found {found}: {old[:160]!r}")
    write(path, text.replace(old, new, expected))

# Version/cache bump.
replace("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.308";', 'const SEND_RUNTIME_BUILD = "v0.5.309";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.308";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.309";')
replace("main.js", 'const APP_BUILD = "v0.5.308";', 'const APP_BUILD = "v0.5.309";')
replace("index.html", 'v0.5.308', 'v0.5.309', expected=2)
replace("sw.js", 'airgapper-static-js-v256', 'airgapper-static-js-v257')

# Keep the UI names terse. The status line still exposes the actual resolved density.
replace(
    "index.html",
    '<option value="auto-1">Auto 1 · ≥1 px/module</option><option value="auto-2">Auto 2 · ≥2 px/module</option><option value="auto-3">Auto 3 · ≥3 px/module</option><option value="auto-4">Auto 4 · ≥4 px/module</option>',
    '<option value="auto-1">Auto 1</option><option value="auto-2">Auto 2</option><option value="auto-3">Auto 3</option><option value="auto-4">Auto 4</option>'
)

# One geometry formula for both candidate selection and actual canvas sizing.
anchor = '''function chooseAutoGrid(payloadBytes, txFps, fitScaling, targetModulePx = autoGridTargetModulePx()) {\n'''
insert = '''function gridRasterExtent(modules, cols, rows, margin = GRID_MARGIN) {\n  // Each QR raster owns a margin on both sides, while adjacent cells overlap\n  // one margin to create exactly one shared gap. This is the same extent used\n  // by both Auto selection and the renderer so the gap can never be double-counted.\n  return {\n    width: modules * cols + margin * (cols + 1),\n    height: modules * rows + margin * (rows + 1)\n  };\n}\nfunction senderDisplayBudgetCss() {\n  if (document.body.classList.contains("qr-full")) {\n    return {\n      width: Math.max(1, window.innerWidth),\n      height: Math.max(1, window.innerHeight - stageBottom.offsetHeight)\n    };\n  }\n  if (!stage.hidden) {\n    const rect = stage.getBoundingClientRect();\n    const style = getComputedStyle(stage);\n    return {\n      width: Math.max(1, rect.width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)),\n      height: Math.max(1, rect.height - stageBottom.offsetHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom))\n    };\n  }\n  // Before the first wall is visible there is no measurable stage box yet.\n  // The fullscreen/resize pass will immediately re-evaluate Auto with the real box.\n  return { width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight) };\n}\nfunction chooseAutoGrid(payloadBytes, txFps, fitScaling, targetModulePx = autoGridTargetModulePx()) {\n'''
replace("send/main.js", anchor, insert)

replace(
    "send/main.js",
    '''  const dpr = window.devicePixelRatio || 1;\n  const landscape = landscapeGrid();\n  const budgetW = Math.max(1, window.innerWidth * dpr);\n  const budgetH = Math.max(1, window.innerHeight * dpr);''',
    '''  const dpr = window.devicePixelRatio || 1;\n  const landscape = landscapeGrid();\n  const budgetCss = senderDisplayBudgetCss();\n  const budgetW = Math.max(1, budgetCss.width * dpr);\n  const budgetH = Math.max(1, budgetCss.height * dpr);'''
)

replace(
    "send/main.js",
    '''      const margin = GRID_MARGIN;\n      const totalW = plan.qrModules * layout.cols + margin * (layout.cols + 1);\n      const totalH = plan.qrModules * layout.rows + margin * (layout.rows + 1);''',
    '''      const margin = GRID_MARGIN;\n      const extent = gridRasterExtent(plan.qrModules, layout.cols, layout.rows, margin);\n      const totalW = extent.width;\n      const totalH = extent.height;'''
)

replace(
    "send/main.js",
    '''      const moduleScale = fitScaling ? availableScale : Math.floor(availableScale);\n      if (!(moduleScale > 0)) continue;\n      const changesPerRefresh = codes * txFps / refreshHz;''',
    '''      const moduleScale = fitScaling ? availableScale : Math.floor(availableScale);\n      if (!(moduleScale > 0)) continue;\n      const renderedW = displayW * moduleScale;\n      const renderedH = displayH * moduleScale;\n      const screenFill = Math.max(0, Math.min(1, renderedW * renderedH / Math.max(1, budgetW * budgetH)));\n      const changesPerRefresh = codes * txFps / refreshHz;'''
)

replace(
    "send/main.js",
    '''        codes,\n        moduleScale,\n        changesPerRefresh,''',
    '''        codes,\n        moduleScale,\n        screenFill,\n        changesPerRefresh,'''
)

replace(
    "send/main.js",
    '''    const fragmentationBonus = 1 + fragmentation * AUTO_GRID_FRAGMENTATION_BONUS;\n    if (strict.length) return candidate.payloadPerSecond * fragmentationBonus;\n    const scalePenalty = Math.min(1, candidate.moduleScale / densityTarget);\n    const transitionPenalty = Math.min(1, AUTO_GRID_MAX_CHANGES_PER_REFRESH / Math.max(0.001, candidate.changesPerRefresh));\n    return candidate.payloadPerSecond * fragmentationBonus * scalePenalty * transitionPenalty;''',
    '''    const fragmentationBonus = 1 + fragmentation * AUTO_GRID_FRAGMENTATION_BONUS;\n    // Integer scaling has cliffs: an 8×4 v40 wall at 1× can use less than a\n    // third of a 16:9 screen while 7×4 at 2× nearly fills it. Score the wall\n    // that is ACTUALLY painted, not the fractional scale that almost fit.\n    const fillBonus = fitScaling\n      ? 0.80 + 0.20 * Math.sqrt(candidate.screenFill)\n      : 0.30 + 0.70 * Math.sqrt(candidate.screenFill);\n    if (strict.length) return candidate.payloadPerSecond * fragmentationBonus * fillBonus;\n    const scalePenalty = Math.min(1, candidate.moduleScale / densityTarget);\n    const transitionPenalty = Math.min(1, AUTO_GRID_MAX_CHANGES_PER_REFRESH / Math.max(0.001, candidate.changesPerRefresh));\n    return candidate.payloadPerSecond * fragmentationBonus * fillBonus * scalePenalty * transitionPenalty;'''
)

replace(
    "send/main.js",
    '''    adjustedScore(b) - adjustedScore(a) ||\n    b.codes - a.codes ||\n    b.moduleScale - a.moduleScale ||''',
    '''    adjustedScore(b) - adjustedScore(a) ||\n    b.screenFill - a.screenFill ||\n    b.codes - a.codes ||\n    b.moduleScale - a.moduleScale ||'''
)

replace(
    "send/main.js",
    '''    const stride = modules + gridMargin;\n    const totalW = modules * gridCols + gridMargin * (gridCols + 1);\n    const totalH = modules * gridRows + gridMargin * (gridRows + 1);''',
    '''    const stride = modules + gridMargin;\n    const extent = gridRasterExtent(modules, gridCols, gridRows, gridMargin);\n    const totalW = extent.width;\n    const totalH = extent.height;'''
)

replace(
    "send/main.js",
    '''    let budgetW;\n    let budgetH;\n    if (document.body.classList.contains("qr-full")) {\n      budgetW = window.innerWidth;\n      budgetH = window.innerHeight - stageBottom.offsetHeight;\n    } else {\n      const rect = stage.getBoundingClientRect();\n      const stageStyle = getComputedStyle(stage);\n      budgetW = rect.width - Number.parseFloat(stageStyle.paddingLeft) - Number.parseFloat(stageStyle.paddingRight);\n      budgetH = rect.height - stageBottom.offsetHeight - Number.parseFloat(stageStyle.paddingTop) - Number.parseFloat(stageStyle.paddingBottom);\n    }''',
    '''    const budget = senderDisplayBudgetCss();\n    const budgetW = budget.width;\n    const budgetH = budget.height;'''
)

replace(
    "send/main.js",
    '''    return `Auto ${autoGrid.targetModulePx} · ${gridCols}×${gridRows} · ${gridCodes} QR · v${transport.qrVersion} · ${formatBytes(transport.frameBytes)}/QR · ${autoGrid.moduleScale.toFixed(2)} display px/module · ${txFps} fps''',
    '''    return `Auto ${autoGrid.targetModulePx} · ${gridCols}×${gridRows} · ${gridCodes} QR · v${transport.qrVersion} · ${formatBytes(transport.frameBytes)}/QR · ${autoGrid.moduleScale.toFixed(2)} display px/module · ${Math.round(autoGrid.screenFill * 100)}% screen · ${txFps} fps'''
)

print("v0.5.309 Auto grid tiling candidate applied")
