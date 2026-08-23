from pathlib import Path
import re

p = Path('send/main.js')
s = p.read_text()

# Add explicit Auto Size state.
needle = 'function updateAutoGridControlState() {'
pos = s.index(needle)
end = s.index('\n}\n', pos) + 3
replacement = '''function autoSizeEnabled() {
  return cfgSize.value === "auto";
}
function updateAutoGridControlState() {
  const automatic = isAutoLayout();
  cfgSize.disabled = false;
  cfgSize.title = autoSizeEnabled()
    ? automatic
      ? `Auto Size + Auto ${autoGridTargetModulePx()}px jointly optimize QR bytes and wall geometry`
      : "Auto Size uses the largest transport size for manual layouts"
    : automatic
      ? `Auto ${autoGridTargetModulePx()} physical px/module keeps this exact Size and fits the most QR codes`
      : "";
}
'''
s = s[:pos] + replacement + s[end:]

# Replace Auto solver as one unit; no whitespace-sensitive patching inside it.
start = s.index('function chooseAutoGrid(')
end = s.index('function monitorDisplayRefreshRate()', start)
choose = r'''function chooseAutoGrid(
  payloadBytes,
  txFps,
  fitScaling,
  targetModulePx = autoGridTargetModulePx(),
  selectedMaximumFrameBytes = FRAME_BYTES_OPTIONS[FRAME_BYTES_OPTIONS.length - 1],
  optimizeSize = false
) {
  const densityTarget = Math.max(1, Math.min(4, Number(targetModulePx) || 2));
  const requestedFrameBytes = FRAME_BYTES_OPTIONS.includes(selectedMaximumFrameBytes)
    ? selectedMaximumFrameBytes
    : FRAME_BYTES_OPTIONS[FRAME_BYTES_OPTIONS.length - 1];
  const frameByteChoices = optimizeSize ? FRAME_BYTES_OPTIONS : [requestedFrameBytes];
  const landscape = landscapeGrid();
  const budgetCss = senderDisplayBudgetCss();
  const dpr = window.devicePixelRatio || 1;
  const budgetW = Math.max(1, Math.floor(budgetCss.width * dpr));
  const budgetH = Math.max(1, Math.floor(budgetCss.height * dpr));
  const refreshHz = Math.max(30, Number(measuredDisplayHz) || 60);
  const budgetAspect = budgetW / budgetH;
  const candidates = [];

  for (const maximumFrameBytes of frameByteChoices) {
    if (!fitsInOneStream(payloadBytes, maximumFrameBytes, true)) continue;
    const plan = selectTransportPlan(payloadBytes, maximumFrameBytes, true);
    if (plan.mode === "direct") continue;
    for (const layout of AUTO_GRID_LAYOUTS) {
      const codes = layout.cols * layout.rows;
      const extent = gridRasterExtent(plan.qrModules, layout.cols, layout.rows, GRID_MARGIN);
      const displayW = landscape ? extent.height : extent.width;
      const displayH = landscape ? extent.width : extent.height;
      const availableScale = Math.min(budgetW / displayW, budgetH / displayH);
      const moduleScale = fitScaling ? availableScale : Math.floor(availableScale);
      if (moduleScale + 1e-9 < densityTarget) continue;
      const renderedW = displayW * moduleScale;
      const renderedH = displayH * moduleScale;
      const screenFill = Math.max(0, Math.min(1, renderedW * renderedH / Math.max(1, budgetW * budgetH)));
      const changesPerRefresh = codes * txFps / refreshHz;
      const sourceBytesPerQr = plan.frameBytes * (1 - plan.overheadFraction);
      const payloadPerSecond = sourceBytesPerQr * codes * txFps;
      const aspectError = Math.abs(Math.log((displayW / displayH) / budgetAspect));
      candidates.push({ maximumFrameBytes, plan, layout, codes, moduleScale,
        displayModulePx: moduleScale, screenFill, changesPerRefresh,
        payloadPerSecond, refreshHz, aspectError });
    }
  }
  if (!candidates.length) {
    const sizeLabel = optimizeSize ? "any available Size" : `the selected ${formatBytes(requestedFrameBytes)} Size`;
    throw new Error(`Auto ${densityTarget}px cannot fit ${sizeLabel} in this viewport.`);
  }
  if (optimizeSize) {
    candidates.sort((a, b) => {
      const rateDelta = b.payloadPerSecond - a.payloadPerSecond;
      const tied = Math.abs(rateDelta) <= Math.max(a.payloadPerSecond, b.payloadPerSecond) * 0.02;
      if (!tied) return rateDelta;
      return b.codes - a.codes || b.moduleScale - a.moduleScale ||
        b.screenFill - a.screenFill || a.aspectError - b.aspectError ||
        b.maximumFrameBytes - a.maximumFrameBytes || a.layout.id - b.layout.id;
    });
  } else {
    candidates.sort((a, b) => b.codes - a.codes || b.moduleScale - a.moduleScale ||
      b.screenFill - a.screenFill || a.aspectError - b.aspectError || a.layout.id - b.layout.id);
  }
  return { ...candidates[0], targetModulePx: densityTarget, autoSize: optimizeSize,
    requestedMaximumFrameBytes: requestedFrameBytes };
}
'''
s = s[:start] + choose + '\n' + s[end:]

# Persist Auto vs exact Size.
s, n = re.subn(r'    if \(typeof saved\.sizeLevel === "number"[\s\S]*?      cfgSize\.value = String\(saved\.sizeLevel\);\n    \}', '''    if (saved.sizeMode === "auto") {
      cfgSize.value = "auto";
    } else if (typeof saved.sizeLevel === "number" && Number.isInteger(saved.sizeLevel) && saved.sizeLevel >= 0 && saved.sizeLevel < FRAME_BYTES_OPTIONS.length) {
      cfgSize.value = String(saved.sizeLevel);
    }''', s, count=1)
if n != 1: raise SystemExit('restore Size patch failed')
s = s.replace('      sizeLevel: Number(cfgSize.value),', '      sizeMode: autoSizeEnabled() ? "auto" : "exact",\n      sizeLevel: autoSizeEnabled() ? null : Number(cfgSize.value),', 1)

# Auto is the default Size choice; numeric entries remain explicit/exact choices.
old = '  Array.from(FRAME_BYTES_OPTIONS.entries()).reverse().forEach(([level, bytes], index) => cfgSize.add(new Option(formatBytes(bytes), String(level), false, index === 0)));'
if old not in s: raise SystemExit('Size option population patch failed')
s = s.replace(old, '  cfgSize.add(new Option("Auto", "auto", false, true));\n  Array.from(FRAME_BYTES_OPTIONS.entries()).reverse().forEach(([level, bytes]) => cfgSize.add(new Option(formatBytes(bytes), String(level))));', 1)
s = s.replace('if (el === cfgLayout) updateAutoGridControlState();', 'if (el === cfgLayout || el === cfgSize) updateAutoGridControlState();', 1)

# Interpret Size setting before selecting transport.
old = '  const sizeLevel = Number(cfgSize.value);\n  const fitScaling = cfgScaling.value === "fit";'
if old not in s: raise SystemExit('Size selection patch failed')
s = s.replace(old, '  const autoSize = autoSizeEnabled();\n  const sizeLevel = autoSize ? FRAME_BYTES_OPTIONS.length - 1 : Number(cfgSize.value);\n  const fitScaling = cfgScaling.value === "fit";', 1)
s = s.replace('  // Size is always respected. Auto chooses geometry only; it never silently\n  // substitutes a smaller Size option.\n  const maximumFrameBytes = manualFrameBytes;\n  if (!fitsInOneStream(payload.length, manualFrameBytes, autoMode)) {', '  // Numeric Size is exact. Auto Size may compare every available transport size,\n  // but only when explicitly selected by the user.\n  const maximumFrameBytes = manualFrameBytes;\n  if (!autoSize && !fitsInOneStream(payload.length, manualFrameBytes, autoMode)) {', 1)

# Pass explicit Auto Size state to the Auto solver.
old = '        autoGridTargetModulePx(configuredLayout),\n        maximumFrameBytes\n      );'
if old not in s: raise SystemExit('Auto solver call patch failed')
s = s.replace(old, '        autoGridTargetModulePx(configuredLayout),\n        maximumFrameBytes,\n        autoSize\n      );', 1)

# Make diagnostics tell us when Auto Size chose a concrete candidate.
old = 'return `Auto ${autoGrid.targetModulePx}px · ${displayCols}×${displayRows} display · ${gridCodes} QR · Size ${formatBytes(autoGrid.maximumFrameBytes)} · v${transport.qrVersion} · ${formatBytes(transport.frameBytes)}/QR encoded · ${autoGrid.displayModulePx.toFixed(2)} physical px/module · ${Math.round(autoGrid.screenFill * 100)}% screen · ${txFps} fps · ${Math.round(autoGrid.refreshHz)} Hz display · ${autoGrid.changesPerRefresh.toFixed(2)} QR updates/refresh · ${updatePatternLabel}`;'
if old not in s: raise SystemExit('diagnostic Size label patch failed')
s = s.replace(old, 'const sizeLabel = autoGrid.autoSize ? `Auto Size→${formatBytes(autoGrid.maximumFrameBytes)}` : `Size ${formatBytes(autoGrid.maximumFrameBytes)}`;\n  return `Auto ${autoGrid.targetModulePx}px · ${displayCols}×${displayRows} display · ${gridCodes} QR · ${sizeLabel} · v${transport.qrVersion} · ${formatBytes(transport.frameBytes)}/QR encoded · ${autoGrid.displayModulePx.toFixed(2)} physical px/module · ${Math.round(autoGrid.screenFill * 100)}% screen · ${txFps} fps · ${Math.round(autoGrid.refreshHz)} Hz display · ${autoGrid.changesPerRefresh.toFixed(2)} QR updates/refresh · ${updatePatternLabel}`;', 1)

p.write_text(s)

p = Path('index.html')
s = p.read_text().replace('<label><span>Max size</span><select id="cfg-size"></select></label>', '<label><span>Size</span><select id="cfg-size"></select></label>', 1)
p.write_text(s)

p = Path('version.js')
s = p.read_text()
if 'APP_VERSION = "0.5.380"' not in s: raise SystemExit('unexpected current version')
p.write_text(s.replace('APP_VERSION = "0.5.380"', 'APP_VERSION = "0.5.381"', 1))
