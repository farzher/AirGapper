from pathlib import Path


def replace(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing pattern in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new))

# Sender build + exact viewport/gap behavior.
replace("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.309";', 'const SEND_RUNTIME_BUILD = "v0.5.310";')

replace("send/main.js", '''function senderDisplayBudgetCss() {
  if (document.body.classList.contains("qr-full")) {
    return {
      width: Math.max(1, window.innerWidth),
      height: Math.max(1, window.innerHeight - stageBottom.offsetHeight)
    };
  }
  if (!stage.hidden) {
    const rect = stage.getBoundingClientRect();
    const style = getComputedStyle(stage);
    return {
      width: Math.max(1, rect.width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)),
      height: Math.max(1, rect.height - stageBottom.offsetHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom))
    };
  }
  // Before the first wall is visible there is no measurable stage box yet.
  // The fullscreen/resize pass will immediately re-evaluate Auto with the real box.
  return { width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight) };
}''', '''function senderDisplayBudgetCss() {
  if (document.body.classList.contains("qr-full")) {
    // Fullscreen has no sender controls. Use the literal viewport; do not let a
    // hidden element's stale box participate in Auto geometry.
    return {
      width: Math.max(1, window.innerWidth),
      height: Math.max(1, window.innerHeight)
    };
  }
  if (!stage.hidden) {
    const rect = stage.getBoundingClientRect();
    const style = getComputedStyle(stage);
    return {
      width: Math.max(1, rect.width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)),
      height: Math.max(1, rect.height - stageBottom.offsetHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom))
    };
  }
  // Match the CSS stage before it is measurable. startStream normally makes
  // Auto's stage/controls measurable before selection, but this conservative
  // fallback must never pretend the non-fullscreen wall owns the whole viewport.
  return {
    width: Math.max(1, Math.min(1400, window.innerWidth - 24)),
    height: Math.max(1, window.innerHeight - 180)
  };
}''')

replace("send/main.js", '''function setStageFullscreen(on) {
  if (on === document.body.classList.contains("qr-full")) return;
  if (on) scrollBeforeFullscreen = window.scrollY;
  document.body.classList.toggle("qr-full", on);
  if (!on && document.fullscreenElement) void document.exitFullscreen().catch(() => void 0);
  resizeDisplay == null ? void 0 : resizeDisplay();
  window.scrollTo(0, on ? 0 : scrollBeforeFullscreen);
}''', '''function setStageFullscreen(on) {
  if (on === document.body.classList.contains("qr-full")) return;
  if (on) scrollBeforeFullscreen = window.scrollY;
  document.body.classList.toggle("qr-full", on);
  if (!on && document.fullscreenElement) void document.exitFullscreen().catch(() => void 0);
  resizeDisplay == null ? void 0 : resizeDisplay();
  // Auto is a viewport solver, not just a canvas scaler. Entering/exiting
  // fullscreen changes the candidate set, so recompute QR version + layout.
  if (selectedFile && isAutoLayout()) {
    clearTimeout(autoGridRefreshTimer);
    autoGridRefreshTimer = setTimeout(() => void startStream(), 140);
  }
  window.scrollTo(0, on ? 0 : scrollBeforeFullscreen);
}''')

replace("send/main.js", '''  let autoGridResizeTimer;
  const resizeForViewport = () => {
    resizeDisplay == null ? void 0 : resizeDisplay();
    if (selectedFile && isAutoLayout()) {
      clearTimeout(autoGridResizeTimer);
      autoGridResizeTimer = setTimeout(() => void startStream(), 140);
    }
  };''', '''  const resizeForViewport = () => {
    resizeDisplay == null ? void 0 : resizeDisplay();
    if (selectedFile && isAutoLayout()) {
      clearTimeout(autoGridRefreshTimer);
      autoGridRefreshTimer = setTimeout(() => void startStream(), 140);
    }
  };''')

replace("send/main.js", '''  const plainSnippet = snippetValue !== null && new TextEncoder().encode(snippetValue).length <= maximumFrameBytes ? snippetValue : null;
  let frameBytes = manualFrameBytes;
  let autoGrid = null;
  let transport;
  if (autoMode && plainSnippet === null) {''', '''  const plainSnippet = snippetValue !== null && new TextEncoder().encode(snippetValue).length <= maximumFrameBytes ? snippetValue : null;
  let frameBytes = manualFrameBytes;
  let autoGrid = null;
  let transport;
  if (autoMode) {
    // Auto must solve against the box that will actually contain the QR wall.
    // Previously the first solve happened while #stage was display:none, so it
    // used the full viewport, then the visible controls made the chosen wall no
    // longer fit and Pixel Perfect silently fell below 1x.
    stage.hidden = false;
    if (sendStart) sendStart.hidden = true;
    showStreamPanels(true);
  }
  if (autoMode && plainSnippet === null) {''')

replace("send/main.js", '''    const availableScale = Math.min(budgetW * dpr / displayW, budgetH * dpr / displayH);
    scale = fitScaling || availableScale < 1 ? Math.max(Number.EPSILON, availableScale) : Math.floor(availableScale);''', '''    const availableScale = Math.min(budgetW * dpr / displayW, budgetH * dpr / displayH);
    if (fitScaling) {
      scale = Math.max(Number.EPSILON, availableScale);
    } else if (autoMode) {
      // Pixel Perfect Auto may change layout/QR version, but it may NEVER
      // resample modules or the one-source-pixel shared gap fractionally.
      scale = Math.max(1, Math.floor(availableScale));
    } else {
      scale = availableScale < 1 ? Math.max(Number.EPSILON, availableScale) : Math.floor(availableScale);
    }''')

# Do not let CSS perform a second hidden rescale after JS chose exact device pixels.
replace("shared/style.css", '#qr { cursor: pointer; }', '#qr { cursor: pointer; max-width: none; max-height: none; flex: none; }')

# App/cache build bump.
replace("main.js", 'const APP_BUILD = "v0.5.309";', 'const APP_BUILD = "v0.5.310";')
replace("index.html", 'v0.5.309', 'v0.5.310')
replace("sw.js", 'airgapper-static-js-v257', 'airgapper-static-js-v258')
