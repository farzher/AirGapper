from pathlib import Path


def replace(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing pattern in {path}: {old[:160]!r}")
    p.write_text(text.replace(old, new))


replace("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.310";', 'const SEND_RUNTIME_BUILD = "v0.5.311";')

replace("send/main.js", '''function updateAutoGridControlState() {
  const automatic = isAutoLayout();
  cfgSize.disabled = automatic;
  cfgSize.title = automatic ? `Auto ${autoGridTargetModulePx()} chooses QR payload size to preserve module density` : "";
}''', '''function updateAutoGridControlState() {
  const automatic = isAutoLayout();
  // Size remains a real user control in Auto. It is the preferred QR payload
  // ceiling; Auto only steps down when that size cannot preserve the requested
  // module density in the current viewport.
  cfgSize.disabled = false;
  cfgSize.title = automatic
    ? `Auto ${autoGridTargetModulePx()} uses this Size when it fits and steps down only when needed`
    : "";
}''')

old_choose = '''function chooseAutoGrid(payloadBytes, txFps, fitScaling, targetModulePx = autoGridTargetModulePx()) {
  const densityTarget = Math.max(1, Math.min(4, Number(targetModulePx) || 2));
  const dpr = window.devicePixelRatio || 1;
  const landscape = landscapeGrid();
  const budgetCss = senderDisplayBudgetCss();
  const budgetW = Math.max(1, budgetCss.width * dpr);
  const budgetH = Math.max(1, budgetCss.height * dpr);
  const refreshHz = Math.max(30, Number(measuredDisplayHz) || 60);
  const candidates = [];
  for (const maximumFrameBytes of FRAME_BYTES_OPTIONS) {
    if (!fitsInOneStream(payloadBytes, maximumFrameBytes)) continue;
    const plan = selectTransportPlan(payloadBytes, maximumFrameBytes);
    if (plan.mode === "direct") continue;
    for (const layout of GRID_LAYOUTS) {
      const codes = layout.cols * layout.rows;
      if (codes <= 1 || codes > 32) continue;
      const margin = GRID_MARGIN;
      const extent = gridRasterExtent(plan.qrModules, layout.cols, layout.rows, margin);
      const totalW = extent.width;
      const totalH = extent.height;
      const displayW = landscape ? totalH : totalW;
      const displayH = landscape ? totalW : totalH;
      const availableScale = Math.min(budgetW / displayW, budgetH / displayH);
      const moduleScale = fitScaling ? availableScale : Math.floor(availableScale);
      if (!(moduleScale > 0)) continue;
      const renderedW = displayW * moduleScale;
      const renderedH = displayH * moduleScale;
      const screenFill = Math.max(0, Math.min(1, renderedW * renderedH / Math.max(1, budgetW * budgetH)));
      const changesPerRefresh = codes * txFps / refreshHz;
      const sourceBytesPerQr = plan.frameBytes * (1 - plan.overheadFraction);
      const payloadPerSecond = sourceBytesPerQr * codes * txFps;
      candidates.push({
        maximumFrameBytes,
        plan,
        layout,
        codes,
        moduleScale,
        screenFill,
        changesPerRefresh,
        payloadPerSecond,
        refreshHz
      });
    }
  }
  if (!candidates.length) throw new Error("Auto Grid could not find a valid QR layout for this transfer.");
  const strict = candidates.filter((candidate) =>
    candidate.moduleScale >= densityTarget &&
    candidate.changesPerRefresh <= AUTO_GRID_MAX_CHANGES_PER_REFRESH
  );
  const pool = strict.length ? strict : candidates;
  const adjustedScore = (candidate) => {
    // A rolling-shutter stripe destroys a smaller fraction of a wall made from
    // more independent QRs. Allow up to an 18% theoretical throughput trade
    // across the 8→32 QR range when fragmentation improves substantially.
    const fragmentation = Math.max(0, Math.min(1, (candidate.codes - 8) / 24));
    const fragmentationBonus = 1 + fragmentation * AUTO_GRID_FRAGMENTATION_BONUS;
    // Integer scaling has cliffs: an 8×4 v40 wall at 1× can use less than a
    // third of a 16:9 screen while 7×4 at 2× nearly fills it. Score the wall
    // that is ACTUALLY painted, not the fractional scale that almost fit.
    const fillBonus = fitScaling
      ? 0.80 + 0.20 * Math.sqrt(candidate.screenFill)
      : 0.30 + 0.70 * Math.sqrt(candidate.screenFill);
    if (strict.length) return candidate.payloadPerSecond * fragmentationBonus * fillBonus;
    const scalePenalty = Math.min(1, candidate.moduleScale / densityTarget);
    const transitionPenalty = Math.min(1, AUTO_GRID_MAX_CHANGES_PER_REFRESH / Math.max(0.001, candidate.changesPerRefresh));
    return candidate.payloadPerSecond * fragmentationBonus * fillBonus * scalePenalty * transitionPenalty;
  };
  pool.sort((a, b) =>
    adjustedScore(b) - adjustedScore(a) ||
    b.screenFill - a.screenFill ||
    b.codes - a.codes ||
    b.moduleScale - a.moduleScale ||
    b.plan.frameBytes - a.plan.frameBytes ||
    a.layout.id - b.layout.id
  );
  return { ...pool[0], constrained: strict.length > 0, targetModulePx: densityTarget };
}'''

new_choose = '''function chooseAutoGrid(
  payloadBytes,
  txFps,
  fitScaling,
  targetModulePx = autoGridTargetModulePx(),
  preferredMaximumFrameBytes = FRAME_BYTES_OPTIONS[FRAME_BYTES_OPTIONS.length - 1]
) {
  const densityTarget = Math.max(1, Math.min(4, Number(targetModulePx) || 2));
  const requestedMaximumFrameBytes = FRAME_BYTES_OPTIONS.includes(preferredMaximumFrameBytes)
    ? preferredMaximumFrameBytes
    : FRAME_BYTES_OPTIONS[FRAME_BYTES_OPTIONS.length - 1];
  const allowedFrameBytes = FRAME_BYTES_OPTIONS
    .filter((bytes) => bytes <= requestedMaximumFrameBytes)
    .sort((a, b) => b - a);
  const dpr = window.devicePixelRatio || 1;
  const landscape = landscapeGrid();
  const budgetCss = senderDisplayBudgetCss();
  const budgetW = Math.max(1, budgetCss.width * dpr);
  const budgetH = Math.max(1, budgetCss.height * dpr);
  const refreshHz = Math.max(30, Number(measuredDisplayHz) || 60);
  const candidates = [];
  for (const maximumFrameBytes of allowedFrameBytes) {
    if (!fitsInOneStream(payloadBytes, maximumFrameBytes)) continue;
    const plan = selectTransportPlan(payloadBytes, maximumFrameBytes);
    if (plan.mode === "direct") continue;
    for (const layout of GRID_LAYOUTS) {
      const codes = layout.cols * layout.rows;
      if (codes <= 1 || codes > 32) continue;
      const margin = GRID_MARGIN;
      const extent = gridRasterExtent(plan.qrModules, layout.cols, layout.rows, margin);
      const totalW = extent.width;
      const totalH = extent.height;
      const displayW = landscape ? totalH : totalW;
      const displayH = landscape ? totalW : totalH;
      const availableScale = Math.min(budgetW / displayW, budgetH / displayH);
      const moduleScale = fitScaling ? availableScale : Math.floor(availableScale);
      if (!(moduleScale > 0)) continue;
      const renderedW = displayW * moduleScale;
      const renderedH = displayH * moduleScale;
      const screenFill = Math.max(0, Math.min(1, renderedW * renderedH / Math.max(1, budgetW * budgetH)));
      const changesPerRefresh = codes * txFps / refreshHz;
      const sourceBytesPerQr = plan.frameBytes * (1 - plan.overheadFraction);
      const payloadPerSecond = sourceBytesPerQr * codes * txFps;
      candidates.push({
        maximumFrameBytes,
        plan,
        layout,
        codes,
        moduleScale,
        screenFill,
        changesPerRefresh,
        payloadPerSecond,
        refreshHz
      });
    }
  }
  if (!candidates.length) throw new Error("Auto Grid could not find a valid QR layout for this transfer.");

  // Size is a preference, not something Auto is free to ignore. Find the
  // largest selected-or-smaller Size that can actually preserve Auto N's
  // module density, then optimize the grid only within that Size.
  const densityCandidates = candidates.filter((candidate) => candidate.moduleScale >= densityTarget);
  if (!densityCandidates.length) {
    throw new Error(
      `Auto ${densityTarget} cannot fit ${formatBytes(requestedMaximumFrameBytes)} or any smaller Size at ${densityTarget} px/module in this viewport.`
    );
  }
  const resolvedMaximumFrameBytes = allowedFrameBytes.find((bytes) =>
    densityCandidates.some((candidate) => candidate.maximumFrameBytes === bytes)
  );
  const sizePool = densityCandidates.filter((candidate) => candidate.maximumFrameBytes === resolvedMaximumFrameBytes);
  const strict = sizePool.filter((candidate) => candidate.changesPerRefresh <= AUTO_GRID_MAX_CHANGES_PER_REFRESH);
  const pool = strict.length ? strict : sizePool;
  const adjustedScore = (candidate) => {
    // A rolling-shutter stripe destroys a smaller fraction of a wall made from
    // more independent QRs. Allow up to an 18% theoretical throughput trade
    // across the 8→32 QR range when fragmentation improves substantially.
    const fragmentation = Math.max(0, Math.min(1, (candidate.codes - 8) / 24));
    const fragmentationBonus = 1 + fragmentation * AUTO_GRID_FRAGMENTATION_BONUS;
    // Integer scaling has cliffs: score the wall that is ACTUALLY painted.
    const fillBonus = fitScaling
      ? 0.80 + 0.20 * Math.sqrt(candidate.screenFill)
      : 0.30 + 0.70 * Math.sqrt(candidate.screenFill);
    if (strict.length) return candidate.payloadPerSecond * fragmentationBonus * fillBonus;
    const transitionPenalty = Math.min(1, AUTO_GRID_MAX_CHANGES_PER_REFRESH / Math.max(0.001, candidate.changesPerRefresh));
    return candidate.payloadPerSecond * fragmentationBonus * fillBonus * transitionPenalty;
  };
  pool.sort((a, b) =>
    adjustedScore(b) - adjustedScore(a) ||
    b.screenFill - a.screenFill ||
    b.codes - a.codes ||
    b.moduleScale - a.moduleScale ||
    b.plan.frameBytes - a.plan.frameBytes ||
    a.layout.id - b.layout.id
  );
  return {
    ...pool[0],
    constrained: strict.length > 0,
    targetModulePx: densityTarget,
    requestedMaximumFrameBytes,
    sizeFallback: resolvedMaximumFrameBytes !== requestedMaximumFrameBytes
  };
}'''
replace("send/main.js", old_choose, new_choose)

replace("send/main.js", '''  const maximumFrameBytes = autoMode ? FRAME_BYTES_OPTIONS[FRAME_BYTES_OPTIONS.length - 1] : manualFrameBytes;
  if (!autoMode && !fitsInOneStream(payload.length, manualFrameBytes)) {''', '''  // Size is meaningful in both manual and Auto layouts. Auto may step down
  // from this value to preserve its module-density target, but never above it.
  const maximumFrameBytes = manualFrameBytes;
  if (!fitsInOneStream(payload.length, manualFrameBytes)) {''')

replace("send/main.js", '''      autoGrid = chooseAutoGrid(payload.length, txFps, fitScaling, autoGridTargetModulePx(configuredLayout));''', '''      autoGrid = chooseAutoGrid(
        payload.length,
        txFps,
        fitScaling,
        autoGridTargetModulePx(configuredLayout),
        maximumFrameBytes
      );''')

replace("send/main.js", '''    const fallback = autoGrid.constrained ? "" : " · fallback constraints";
    return `Auto ${autoGrid.targetModulePx} · ${gridCols}×${gridRows} · ${gridCodes} QR · v${transport.qrVersion} · ${formatBytes(transport.frameBytes)}/QR · ${autoGrid.moduleScale.toFixed(2)} display px/module · ${Math.round(autoGrid.screenFill * 100)}% screen · ${txFps} fps · ${Math.round(autoGrid.refreshHz)} Hz display · ${autoGrid.changesPerRefresh.toFixed(2)} QR changes/refresh · ${updatePatternLabel}${fallback}`;''', '''    const fallback = autoGrid.constrained ? "" : " · refresh fallback";
    const sizeFallback = autoGrid.sizeFallback
      ? ` · Size ${formatBytes(autoGrid.requestedMaximumFrameBytes)}→${formatBytes(autoGrid.maximumFrameBytes)}`
      : "";
    return `Auto ${autoGrid.targetModulePx} · ${gridCols}×${gridRows} · ${gridCodes} QR · v${transport.qrVersion} · ${formatBytes(transport.frameBytes)}/QR · ${autoGrid.moduleScale.toFixed(2)} display px/module · ${Math.round(autoGrid.screenFill * 100)}% screen · ${txFps} fps · ${Math.round(autoGrid.refreshHz)} Hz display · ${autoGrid.changesPerRefresh.toFixed(2)} QR changes/refresh · ${updatePatternLabel}${sizeFallback}${fallback}`;''')

replace("main.js", 'const APP_BUILD = "v0.5.310";', 'const APP_BUILD = "v0.5.311";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v258";', 'const CACHE = "airgapper-static-js-v259";')
