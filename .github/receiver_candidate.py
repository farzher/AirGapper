from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:180]!r}")
    p.write_text(text.replace(old, new, 1))

# ---------------------------------------------------------------------------
# Sender: label Auto density naturally and make Pixel Perfect survive mobile
# fullscreen/compositor geometry without fractional device-pixel placement.
# ---------------------------------------------------------------------------
send = "send/main.js"
replace_once(send, 'const SEND_RUNTIME_BUILD = "v0.5.343";', 'const SEND_RUNTIME_BUILD = "v0.5.344";')

replace_once(send,
'''function senderDisplayBudgetCss() {
  if (document.body.classList.contains("qr-full")) {
    // Fullscreen has no sender controls. Use the literal viewport; do not let a
    // hidden element's stale box participate in Auto geometry.
    return {
      width: Math.max(1, window.innerWidth),
      height: Math.max(1, window.innerHeight)
    };
  }
''',
'''function senderDisplayBudgetCss() {
  if (document.body.classList.contains("qr-full")) {
    // On mobile the layout viewport is integer-rounded while visualViewport can
    // retain the fractional CSS size implied by a fractional devicePixelRatio.
    // Solving against innerWidth/innerHeight can therefore create a bitmap that
    // Chrome has to resample when true fullscreen settles.
    const viewport = window.visualViewport;
    return {
      width: Math.max(1, Number(viewport?.width) || window.innerWidth),
      height: Math.max(1, Number(viewport?.height) || window.innerHeight)
    };
  }
''')

replace_once(send,
'''function setStageFullscreen(on) {
  if (on === document.body.classList.contains("qr-full")) return;
''',
'''function settleFullscreenSenderGeometry() {
  // requestFullscreen() changes the Android visual viewport asynchronously.
  // Wait until the fullscreen layout has actually committed before the Auto
  // solver chooses a wall for that viewport.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    resizeDisplay?.();
    if (selectedFile && isAutoLayout()) {
      clearTimeout(autoGridRefreshTimer);
      autoGridRefreshTimer = setTimeout(() => void startStream(), 0);
    }
  }));
}
function setStageFullscreen(on) {
  if (on === document.body.classList.contains("qr-full")) return;
''')

replace_once(send,
'''document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) setStageFullscreen(false);
});
''',
'''document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) {
    setStageFullscreen(false);
    return;
  }
  if (document.body.classList.contains("qr-full")) settleFullscreenSenderGeometry();
});
''')

replace_once(send,
'''    const cssNativeW = displayW * scale / dpr;
    const cssNativeH = displayH * scale / dpr;
    canvas.style.width = `${cssNativeW}px`;
    canvas.style.height = `${cssNativeH}px`;
    canvas.style.imageRendering = fitScaling ? "auto" : "pixelated";
    const stagingCtx = staging.getContext("2d");
''',
'''    const cssNativeW = displayW * scale / dpr;
    const cssNativeH = displayH * scale / dpr;
    canvas.style.width = `${cssNativeW}px`;
    canvas.style.height = `${cssNativeH}px`;
    canvas.style.imageRendering = fitScaling ? "auto" : "pixelated";
    // The backing bitmap is already an exact integer device-pixel raster. The
    // last place it can become gray is compositor placement: flex centering a
    // fractional-DPR canvas can put its top-left between device pixels. Snap the
    // actual laid-out origin back onto the DPR grid without changing its layout
    // size. Healthy DPR=1 desktop rendering remains unchanged.
    canvas.style.position = "";
    canvas.style.left = "";
    canvas.style.top = "";
    if (!fitScaling) {
      void canvas.offsetWidth;
      const rect = canvas.getBoundingClientRect();
      const dx = (Math.round(rect.left * dpr) - rect.left * dpr) / dpr;
      const dy = (Math.round(rect.top * dpr) - rect.top * dpr) / dpr;
      if (Math.abs(dx) > 1e-7 || Math.abs(dy) > 1e-7) {
        canvas.style.position = "relative";
        canvas.style.left = `${dx}px`;
        canvas.style.top = `${dy}px`;
      }
    }
    const stagingCtx = staging.getContext("2d");
''')

# Rename all user-facing Auto density phrasing in JS diagnostics/tooltips.
p = Path(send)
text = p.read_text()
text = text.replace('`${autoGridTargetModulePx()}px Auto uses this Size when it fits and steps down only when needed`',
                    '`Auto ${autoGridTargetModulePx()}px uses this Size when it fits and steps down only when needed`')
text = text.replace('`${densityTarget}px Auto cannot fit ${formatBytes(requestedMaximumFrameBytes)} or any smaller Size at ${densityTarget} on-screen px/module in this viewport.`',
                    '`Auto ${densityTarget}px cannot fit ${formatBytes(requestedMaximumFrameBytes)} or any smaller Size at ${densityTarget} on-screen px/module in this viewport.`')
text = text.replace('`${autoGrid.targetModulePx}px Auto · ${gridCols}×${gridRows}',
                    '`Auto ${autoGrid.targetModulePx}px · ${gridCols}×${gridRows}')
p.write_text(text)

# ---------------------------------------------------------------------------
# Markup labels.
# ---------------------------------------------------------------------------
html = "index.html"
p = Path(html)
text = p.read_text()
text = text.replace('1px Auto</option><option value="auto-2" selected>2px Auto</option><option value="auto-3">3px Auto</option><option value="auto-4">4px Auto',
                    'Auto 1px</option><option value="auto-2" selected>Auto 2px</option><option value="auto-3">Auto 3px</option><option value="auto-4">Auto 4px', 1)
text = text.replace('<span class="brand">AirGapper <span class="app-version">v0.5.343</span></span>',
                    '<span class="brand">AirGapper <span class="app-version">v0.5.344</span></span>', 1)
p.write_text(text)

# Version/cache bump. Receiver behavior is unchanged.
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.343";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.344";')
replace_once("main.js", 'const APP_BUILD = "v0.5.343";', 'const APP_BUILD = "v0.5.344";')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v291";', 'const CACHE = "airgapper-static-js-v292";')

print("v0.5.344 candidate applied")
