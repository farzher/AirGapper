from pathlib import Path

def rep(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing anchor {path}: {old[:140]!r}")
    p.write_text(s.replace(old, new, count))

# Build/cache bump.
for path, old, new in [
    ("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.302";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.303";'),
    ("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.302";', 'const SEND_RUNTIME_BUILD = "v0.5.303";'),
    ("main.js", 'const APP_BUILD = "v0.5.302";', 'const APP_BUILD = "v0.5.303";'),
    ("index.html", 'main.js?build=v0.5.302', 'main.js?build=v0.5.303'),
    ("index.html", '<span class="brand">AirGapper <span class="app-version">v0.5.302</span></span>',
                   '<span class="brand">AirGapper <span class="app-version">v0.5.303</span></span>'),
    ("sw.js", 'airgapper-static-js-v250', 'airgapper-static-js-v251'),
]:
    rep(path, old, new)

# Spend the remaining 4-bit layout IDs on useful Auto Grid shapes.
rep(
    "shared/grid-layout.js",
    '''  { id: 9, cols: 4, rows: 8 },
  { id: 10, cols: 4, rows: 7 }
];''',
    '''  { id: 9, cols: 4, rows: 8 },
  { id: 10, cols: 4, rows: 7 },
  { id: 11, cols: 2, rows: 4 },
  { id: 12, cols: 4, rows: 5 },
  { id: 13, cols: 3, rows: 7 },
  { id: 14, cols: 5, rows: 5 },
  { id: 15, cols: 5, rows: 6 }
];'''
)

# New mode only; all manual layouts remain.
rep(
    "index.html",
    '<select id="cfg-layout"><option value="single" selected>1:1</option>',
    '<select id="cfg-layout"><option value="auto">Auto</option><option value="single" selected>1:1</option>'
)

# Auto Grid needs the protocol-known layout catalog.
rep(
    "send/main.js",
    'import { GRID_MARGIN_MODULES, gridLayoutId } from "../shared/grid-layout.js";',
    'import { GRID_LAYOUTS, GRID_MARGIN_MODULES, gridLayoutId } from "../shared/grid-layout.js";'
)

rep(
    "send/main.js",
    '''// Sender FPS is always the user's requested presentation rate. Rolling-shutter
// mitigation must remain an explicit/testable transport strategy, never a hidden
// cap that changes the selected rate.
const SEND_RUNTIME_BUILD = "v0.5.303";''',
    '''// Sender FPS is always the user's requested presentation rate. Auto Grid may
// choose QR count/size, but never silently changes the requested FPS.
const AUTO_GRID_MIN_MODULE_PX = 2;
const AUTO_GRID_MAX_CHANGES_PER_REFRESH = 3;
let measuredDisplayHz = 60;
let autoGridRefreshTimer;
const SEND_RUNTIME_BUILD = "v0.5.303";'''
)

rep(
    "send/main.js",
    '''function selectedLayout() {
  const mode = cfgLayout.value;
  return mode === "single" || mode === "one-two" || mode === "two-two" || mode === "two-three" || mode === "three-five" || mode === "three-six" || mode === "four-six" || mode === "four-seven" || mode === "four-eight" ? mode : "four-three";
}''',
    '''function selectedLayout() {
  const mode = cfgLayout.value;
  return mode === "auto" || mode === "single" || mode === "one-two" || mode === "two-two" || mode === "two-three" || mode === "three-five" || mode === "three-six" || mode === "four-six" || mode === "four-seven" || mode === "four-eight" ? mode : "four-three";
}'''
)

# Helpers: viewport-aware Auto Grid search plus deterministic rolling-shutter phase interleaver.
anchor = '''function selectFps(fps) {
  var _a;
  const preset = Array.from(cfgFps.options).find((option) => Number(option.value) === fps);
  cfgFps.value = (_a = preset == null ? void 0 : preset.value) != null ? _a : "custom";
  cfgFpsCustom.value = String(fps);
  cfgFpsCustom.hidden = cfgFps.value !== "custom";
  speedControl.classList.toggle("has-custom", !cfgFpsCustom.hidden);
}
'''
insert = anchor + '''function updateAutoGridControlState() {
  const automatic = selectedLayout() === "auto";
  cfgSize.disabled = automatic;
  cfgSize.title = automatic ? "Auto Grid chooses QR payload size" : "";
}
function gcd(a, b) {
  a = Math.abs(Math.trunc(a));
  b = Math.abs(Math.trunc(b));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}
function temporalPhaseStep(count) {
  if (count <= 1) return 1;
  let step = Math.max(1, Math.round(count * 0.61803398875));
  while (step < count && gcd(step, count) !== 1) step++;
  if (step >= count) {
    step = Math.max(1, Math.floor(count / 2));
    while (step > 1 && gcd(step, count) !== 1) step--;
  }
  return step;
}
function spatiallyDispersedOrder(cols, rows) {
  const count = cols * rows;
  if (count <= 1) return [0];
  const point = (slot) => ({
    x: (slot % cols + 0.5) / cols,
    y: (Math.floor(slot / cols) + 0.5) / rows
  });
  const dist2 = (a, b) => {
    const pa = point(a), pb = point(b);
    return (pa.x - pb.x) ** 2 + (pa.y - pb.y) ** 2;
  };
  const remaining = new Set(Array.from({ length: count }, (_, slot) => slot));
  const order = [];
  let current = 0;
  while (remaining.size) {
    if (order.length === 0) {
      current = 0;
    } else {
      const recent = order.slice(-Math.min(4, order.length));
      let best = -1, bestScore = -Infinity;
      for (const slot of remaining) {
        const previousDistance = dist2(slot, order[order.length - 1]);
        const recentDistance = Math.min(...recent.map((other) => dist2(slot, other)));
        const score = previousDistance + recentDistance * 0.55;
        if (score > bestScore + 1e-12 || Math.abs(score - bestScore) <= 1e-12 && slot < best) {
          best = slot;
          bestScore = score;
        }
      }
      current = best;
    }
    order.push(current);
    remaining.delete(current);
  }
  return order;
}
function chooseAutoGrid(payloadBytes, txFps, fitScaling) {
  const dpr = window.devicePixelRatio || 1;
  const landscape = landscapeGrid();
  const budgetW = Math.max(1, window.innerWidth * dpr);
  const budgetH = Math.max(1, window.innerHeight * dpr);
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
      const totalW = plan.qrModules * layout.cols + margin * (layout.cols + 1);
      const totalH = plan.qrModules * layout.rows + margin * (layout.rows + 1);
      const displayW = landscape ? totalH : totalW;
      const displayH = landscape ? totalW : totalH;
      const availableScale = Math.min(budgetW / displayW, budgetH / displayH);
      const moduleScale = fitScaling ? availableScale : Math.floor(availableScale);
      if (!(moduleScale > 0)) continue;
      const changesPerRefresh = codes * txFps / refreshHz;
      const sourceBytesPerQr = plan.frameBytes * (1 - plan.overheadFraction);
      const payloadPerSecond = sourceBytesPerQr * codes * txFps;
      candidates.push({
        maximumFrameBytes,
        plan,
        layout,
        codes,
        moduleScale,
        changesPerRefresh,
        payloadPerSecond,
        refreshHz
      });
    }
  }
  if (!candidates.length) throw new Error("Auto Grid could not find a valid QR layout for this transfer.");
  const strict = candidates.filter((candidate) =>
    candidate.moduleScale >= AUTO_GRID_MIN_MODULE_PX &&
    candidate.changesPerRefresh <= AUTO_GRID_MAX_CHANGES_PER_REFRESH
  );
  const pool = strict.length ? strict : candidates;
  const adjustedScore = (candidate) => {
    if (strict.length) return candidate.payloadPerSecond;
    const scalePenalty = Math.min(1, candidate.moduleScale / AUTO_GRID_MIN_MODULE_PX);
    const transitionPenalty = Math.min(1, AUTO_GRID_MAX_CHANGES_PER_REFRESH / Math.max(0.001, candidate.changesPerRefresh));
    return candidate.payloadPerSecond * scalePenalty * transitionPenalty;
  };
  pool.sort((a, b) =>
    adjustedScore(b) - adjustedScore(a) ||
    b.moduleScale - a.moduleScale ||
    b.plan.frameBytes - a.plan.frameBytes ||
    b.codes - a.codes ||
    a.layout.id - b.layout.id
  );
  return { ...pool[0], constrained: strict.length > 0 };
}
'''
rep("send/main.js", anchor, insert)

# Measure every display, not only >60 Hz, and let Auto Grid re-evaluate when refresh class changes.
rep(
    "send/main.js",
    '''      const refreshRate = Math.abs(nearestCommon - measuredRate) / nearestCommon <= 0.03 ? nearestCommon : Math.round(measuredRate);
      if (refreshRate > 60) {''',
    '''      const refreshRate = Math.abs(nearestCommon - measuredRate) / nearestCommon <= 0.03 ? nearestCommon : Math.round(measuredRate);
      const previousMeasuredHz = measuredDisplayHz;
      measuredDisplayHz = Math.max(30, refreshRate);
      if (selectedFile && selectedLayout() === "auto" && Math.abs(previousMeasuredHz - measuredDisplayHz) >= 1) {
        clearTimeout(autoGridRefreshTimer);
        autoGridRefreshTimer = setTimeout(() => void startStream(), 120);
      }
      if (refreshRate > 60) {'''
)

# Auto layout changes must rebuild the transport/grid instead of using the live-FPS shortcut.
rep(
    "send/main.js",
    '''function applyLiveSenderFps() {
  if (!activeSendFpsSetter) return false;
  activeSendFpsSetter(selectedFps());
  return true;
}''',
    '''function applyLiveSenderFps() {
  if (selectedLayout() === "auto") return false;
  if (!activeSendFpsSetter) return false;
  activeSendFpsSetter(selectedFps());
  return true;
}'''
)

# Persist Auto and all current manual layouts.
rep(
    "send/main.js",
    '''    if (saved.layout === "single" || saved.layout === "one-two" || saved.layout === "two-two" || saved.layout === "two-three" || saved.layout === "four-three" || saved.layout === "three-five" || saved.layout === "three-six") {
      cfgLayout.value = saved.layout;
    } else if (saved.layout === "five-three") {''',
    '''    if (saved.layout === "auto" || saved.layout === "single" || saved.layout === "one-two" || saved.layout === "two-two" || saved.layout === "two-three" || saved.layout === "four-three" || saved.layout === "three-five" || saved.layout === "three-six" || saved.layout === "four-six" || saved.layout === "four-seven" || saved.layout === "four-eight") {
      cfgLayout.value = saved.layout;
    } else if (saved.layout === "five-three") {'''
)

rep(
    "send/main.js",
    '''  restoreSendSettings();
  let customFpsTimer;''',
    '''  restoreSendSettings();
  updateAutoGridControlState();
  let customFpsTimer;'''
)

rep(
    "send/main.js",
    '''  const resizeForViewport = () => resizeDisplay == null ? void 0 : resizeDisplay();
  window.addEventListener("resize", resizeForViewport);''',
    '''  let autoGridResizeTimer;
  const resizeForViewport = () => {
    resizeDisplay == null ? void 0 : resizeDisplay();
    if (selectedFile && selectedLayout() === "auto") {
      clearTimeout(autoGridResizeTimer);
      autoGridResizeTimer = setTimeout(() => void startStream(), 140);
    }
  };
  window.addEventListener("resize", resizeForViewport);'''
)

rep(
    "send/main.js",
    '''  for (const el of [cfgSize, cfgScaling, cfgLayout, cfgOrientation]) {
    el.addEventListener("change", () => {
      saveSendSettings();
      void startStream();
    });
  }''',
    '''  for (const el of [cfgSize, cfgScaling, cfgLayout, cfgOrientation]) {
    el.addEventListener("change", () => {
      if (el === cfgLayout) updateAutoGridControlState();
      saveSendSettings();
      void startStream();
    });
  }'''
)

# Replace manual-only selection in startStream with Auto Grid search.
old = '''  const txFps = selectedFps();
  const sizeLevel = Number(cfgSize.value);
  const fitScaling = cfgScaling.value === "fit";
  const frameBytes = (_a = FRAME_BYTES_OPTIONS[Math.min(sizeLevel, FRAME_BYTES_OPTIONS.length - 1)]) != null ? _a : FRAME_BYTES_OPTIONS[0];
  const ecc = "L";
  const configuredLayout = selectedLayout();
  if (!fitsInOneStream(payload.length, frameBytes)) {
    const suggestion = smallestSufficientFrameSize(payload.length, FRAME_BYTES_OPTIONS);
    showSettingsError(
      `${formatBytes(payload.length)} needs ${sourceBlockCount(payload.length, frameBytes).toLocaleString()} blocks. ` + (suggestion ? `Choose ${formatBytes(suggestion)} or more in Size.` : "No available Size setting can carry this transfer.")
    );
    return;
  }
  const snippetValue = currentMode() === "snippet" ? snippetText.value : null;
  const plainSnippet = snippetValue !== null && new TextEncoder().encode(snippetValue).length <= frameBytes ? snippetValue : null;
  const transport = selectTransportPlan(payload.length, frameBytes);
  const staticStream = plainSnippet !== null || transport.mode === "direct";
  const layoutMode = staticStream ? "single" : configuredLayout;
  const { cols: gridCols, rows: gridRows, codes: gridCodes } = layoutGrid(layoutMode);
  const gridMargin = gridCodes === 1 ? 4 : GRID_MARGIN;'''
new = '''  const txFps = selectedFps();
  const sizeLevel = Number(cfgSize.value);
  const fitScaling = cfgScaling.value === "fit";
  const manualFrameBytes = (_a = FRAME_BYTES_OPTIONS[Math.min(sizeLevel, FRAME_BYTES_OPTIONS.length - 1)]) != null ? _a : FRAME_BYTES_OPTIONS[0];
  const ecc = "L";
  const configuredLayout = selectedLayout();
  const autoMode = configuredLayout === "auto";
  const maximumFrameBytes = autoMode ? FRAME_BYTES_OPTIONS[FRAME_BYTES_OPTIONS.length - 1] : manualFrameBytes;
  if (!autoMode && !fitsInOneStream(payload.length, manualFrameBytes)) {
    const suggestion = smallestSufficientFrameSize(payload.length, FRAME_BYTES_OPTIONS);
    showSettingsError(
      `${formatBytes(payload.length)} needs ${sourceBlockCount(payload.length, manualFrameBytes).toLocaleString()} blocks. ` + (suggestion ? `Choose ${formatBytes(suggestion)} or more in Size.` : "No available Size setting can carry this transfer.")
    );
    return;
  }
  const snippetValue = currentMode() === "snippet" ? snippetText.value : null;
  const plainSnippet = snippetValue !== null && new TextEncoder().encode(snippetValue).length <= maximumFrameBytes ? snippetValue : null;
  let frameBytes = manualFrameBytes;
  let autoGrid = null;
  let transport;
  if (autoMode && plainSnippet === null) {
    const directProbe = selectTransportPlan(payload.length, maximumFrameBytes);
    if (directProbe.mode === "direct") {
      frameBytes = maximumFrameBytes;
      transport = directProbe;
    } else {
      autoGrid = chooseAutoGrid(payload.length, txFps, fitScaling);
      frameBytes = autoGrid.maximumFrameBytes;
      transport = autoGrid.plan;
    }
  } else {
    transport = selectTransportPlan(payload.length, frameBytes);
  }
  const staticStream = plainSnippet !== null || transport.mode === "direct";
  const layoutMode = staticStream ? "single" : configuredLayout;
  const resolvedGrid = !staticStream && autoGrid
    ? { cols: autoGrid.layout.cols, rows: autoGrid.layout.rows, codes: autoGrid.codes }
    : layoutGrid(layoutMode);
  const { cols: gridCols, rows: gridRows, codes: gridCodes } = resolvedGrid;
  const gridMargin = gridCodes === 1 ? 4 : GRID_MARGIN;
  const temporalOrder = spatiallyDispersedOrder(gridCols, gridRows);
  const phaseStep = temporalPhaseStep(gridCodes);
  const temporalSourceOffset = (pageId, phase) => {
    if (gridCodes <= 1) return 0;
    const rotation = pageId * phaseStep % gridCodes;
    let index = (phase + rotation) % gridCodes;
    if (pageId & 1) index = gridCodes - 1 - index;
    return temporalOrder[index];
  };
  const describeGrid = () => {
    if (!autoGrid || staticStream) return "";
    const fallback = autoGrid.constrained ? "" : " · fallback constraints";
    return `Auto Grid · ${gridCols}×${gridRows} · ${gridCodes} QR · v${transport.qrVersion} · ${formatBytes(transport.frameBytes)}/QR · ${autoGrid.moduleScale.toFixed(2)} display px/module · ${txFps} fps · ${Math.round(autoGrid.refreshHz)} Hz display · ${autoGrid.changesPerRefresh.toFixed(2)} QR changes/refresh · dispersed rotating phases${fallback}`;
  };'''
rep("send/main.js", old, new)

# Surface Auto choice instead of clearing the sender status once geometry is initialized.
rep(
    "send/main.js",
    '''      showStreamPanels(true);
      setStatus("");
      if (false) {''',
    '''      showStreamPanels(true);
      setStatus(describeGrid());
      if (false) {'''
)
rep(
    "send/main.js",
    '''      showStreamPanels(true);
      setStatus("");
    };
    const ensurePageSource''',
    '''      showStreamPanels(true);
      setStatus(describeGrid());
    };
    const ensurePageSource'''
)

# Phase-hopped worker presentation: source QR cells are presented in a dispersed,
# rotating order. Do not advance the durable transport cursor until the whole
# page has actually been painted, because phase order is no longer ordinal order.
rep(
    "send/main.js",
    '''      if (activeTransportCursor?.key === transportKey)
        activeTransportCursor.nextOrdinal = Math.max(activeTransportCursor.nextOrdinal, ordinal + 1);
    };

    for (let i = 0; i < workerCount; ++i) {''',
    '''      // The durable cursor advances only when this entire page completes;
      // phase-hopped presentation is intentionally not ordinal order.
    };

    for (let i = 0; i < workerCount; ++i) {'''
)

rep(
    "send/main.js",
    '''        try {
          drawPageCell(currentPage, currentCellOffset);
        } catch (error) {''',
    '''        try {
          drawPageCell(currentPage, temporalSourceOffset(currentPage.pageId, currentCellOffset));
        } catch (error) {'''
)

rep(
    "send/main.js",
    '''        if (currentCellOffset < gridCodes) continue;

        closePage(currentPage);
        currentPage = null;''',
    '''        if (currentCellOffset < gridCodes) continue;

        if (activeTransportCursor?.key === transportKey)
          activeTransportCursor.nextOrdinal = Math.max(activeTransportCursor.nextOrdinal, currentPage.endOrdinal);
        closePage(currentPage);
        currentPage = null;'''
)

# Candidate self-checks.
checks = [
    ("shared/grid-layout.js", "{ id: 15, cols: 5, rows: 6 }"),
    ("index.html", '<option value="auto">Auto</option>'),
    ("send/main.js", "function chooseAutoGrid(payloadBytes, txFps, fitScaling)"),
    ("send/main.js", "AUTO_GRID_MAX_CHANGES_PER_REFRESH = 3"),
    ("send/main.js", "spatiallyDispersedOrder(gridCols, gridRows)"),
    ("send/main.js", "temporalSourceOffset(currentPage.pageId, currentCellOffset)"),
    ("send/main.js", 'if (selectedLayout() === "auto") return false;'),
    ("send/main.js", 'setStatus(describeGrid());'),
]
for path, needle in checks:
    if needle not in Path(path).read_text():
        raise SystemExit(f"missing v303 invariant {path}: {needle}")
