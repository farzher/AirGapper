from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:180]!r}")
    p.write_text(text.replace(old, new, 1))

send = "send/main.js"
replace_once(send, 'const SEND_RUNTIME_BUILD = "v0.5.344";', 'const SEND_RUNTIME_BUILD = "v0.5.345";')

replace_once(send,
'''  const dpr = window.devicePixelRatio || 1;
  const landscape = landscapeGrid();
  const budgetCss = senderDisplayBudgetCss();
  const budgetW = Math.max(1, budgetCss.width * dpr);
  const budgetH = Math.max(1, budgetCss.height * dpr);
''',
'''  const landscape = landscapeGrid();
  const budgetCss = senderDisplayBudgetCss();
  // Pixel Perfect is defined in final CSS/display pixels, not in an oversized
  // DPR backing store that Chrome must shrink again. Keep the Auto solver in
  // exactly the same coordinate space as the element that reaches the screen.
  const budgetW = Math.max(1, budgetCss.width);
  const budgetH = Math.max(1, budgetCss.height);
''')
replace_once(send,
'''      const displayModulePx = moduleScale / dpr;
''',
'''      const displayModulePx = moduleScale;
''')

replace_once(send,
'''    const dpr = window.devicePixelRatio || 1;
    const stride = modules + gridMargin;
''',
'''    const dpr = window.devicePixelRatio || 1;
    const stride = modules + gridMargin;
''')
replace_once(send,
'''    const availableScale = Math.min(budgetW * dpr / displayW, budgetH * dpr / displayH);
    if (fitScaling) {
      scale = Math.max(Number.EPSILON, availableScale);
    } else if (autoMode) {
      // Pixel Perfect Auto may change layout/QR version, but it may NEVER
      // resample modules or the one-source-pixel shared gap fractionally.
      scale = Math.max(1, Math.floor(availableScale));
    } else {
      scale = availableScale < 1 ? Math.max(Number.EPSILON, availableScale) : Math.floor(availableScale);
    }
''',
'''    const cssAvailableScale = Math.min(budgetW / displayW, budgetH / displayH);
    if (fitScaling) {
      // Fit is intentionally filtered/resampled and may use a DPR-sized backing
      // store for quality. Pixel Perfect below never does.
      scale = Math.max(Number.EPSILON, cssAvailableScale * dpr);
    } else if (autoMode) {
      // Hard invariant: one QR source module becomes an integer number of final
      // canvas/CSS pixels. There is no second CSS resize after this raster.
      scale = Math.max(1, Math.floor(cssAvailableScale));
    } else {
      scale = cssAvailableScale < 1 ? Math.max(Number.EPSILON, cssAvailableScale) : Math.floor(cssAvailableScale);
    }
''')
replace_once(send,
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
''',
'''    const cssNativeW = fitScaling ? displayW * scale / dpr : canvasW;
    const cssNativeH = fitScaling ? displayH * scale / dpr : canvasH;
    canvas.style.width = `${cssNativeW}px`;
    canvas.style.height = `${cssNativeH}px`;
    canvas.style.imageRendering = fitScaling ? "auto" : "pixelated";
    // Pixel Perfect's intrinsic bitmap and CSS box are now the SAME integer
    // size. Chrome no longer gets a fractional DPR downscale opportunity that
    // can synthesize gray module edges. Keep only origin snapping as a final
    // guard against flex centering landing the bitmap between device pixels.
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
''')

replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.344";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.345";')
replace_once("main.js", 'const APP_BUILD = "v0.5.344";', 'const APP_BUILD = "v0.5.345";')
replace_once("index.html", '<span class="brand">AirGapper <span class="app-version">v0.5.344</span></span>', '<span class="brand">AirGapper <span class="app-version">v0.5.345</span></span>')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v292";', 'const CACHE = "airgapper-static-js-v293";')

print("v0.5.345 candidate applied")
