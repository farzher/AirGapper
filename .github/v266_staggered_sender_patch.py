from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing anchor in {path}: {old[:160]!r}")
    p.write_text(s.replace(old, new, 1))

p = Path("send/main.js")
s = p.read_text()

s = s.replace('const SEND_RUNTIME_BUILD = "v0.5.260";', 'const SEND_RUNTIME_BUILD = "v0.5.266";', 1)

old = '''let activeTransportEncoder = null;
let activeTransportCursor = null;
let activeSendRendererCleanup = null;
function stopSendRenderer() {
  const cleanup = activeSendRendererCleanup;
  activeSendRendererCleanup = null;
  cleanup?.();
}
'''
new = '''let activeTransportEncoder = null;
let activeTransportCursor = null;
let activeSendRendererCleanup = null;
let activeSendFpsSetter = null;
function stopSendRenderer() {
  const cleanup = activeSendRendererCleanup;
  activeSendRendererCleanup = null;
  activeSendFpsSetter = null;
  cleanup?.();
}
function applyLiveSenderFps() {
  if (!activeSendFpsSetter) return false;
  activeSendFpsSetter(selectedFps());
  return true;
}
'''
if old not in s: raise SystemExit("renderer state anchor missing")
s = s.replace(old, new, 1)

# Display-refresh option changes must not tear down a running sender.
old = '''            saveSendSettings();
            void startStream();
'''
new = '''            saveSendSettings();
            if (!applyLiveSenderFps()) void startStream();
'''
if old not in s: raise SystemExit("display fps restart anchor missing")
s = s.replace(old, new, 1)

old = '''  cfgFps.addEventListener("change", () => {
    clearTimeout(customFpsTimer);
    cfgFpsCustom.hidden = cfgFps.value !== "custom";
    speedControl.classList.toggle("has-custom", !cfgFpsCustom.hidden);
    if (!cfgFpsCustom.hidden) cfgFpsCustom.focus();
  });
'''
new = '''  cfgFps.addEventListener("change", () => {
    clearTimeout(customFpsTimer);
    cfgFpsCustom.hidden = cfgFps.value !== "custom";
    speedControl.classList.toggle("has-custom", !cfgFpsCustom.hidden);
    if (!cfgFpsCustom.hidden) cfgFpsCustom.focus();
    saveSendSettings();
    if (selectedFile && !applyLiveSenderFps()) void startStream();
  });
'''
if old not in s: raise SystemExit("cfgFps listener anchor missing")
s = s.replace(old, new, 1)

old = '''  for (const el of [cfgFps, cfgSize, cfgScaling, cfgLayout, cfgOrientation]) {
'''
new = '''  // FPS is a live scheduler parameter. Size/layout/scaling/orientation still
  // rebuild geometry/transport as needed, but a speed change must never blank
  // the already-visible QR wall or cold-start the render workers.
  for (const el of [cfgSize, cfgScaling, cfgLayout, cfgOrientation]) {
'''
if old not in s: raise SystemExit("settings restart loop anchor missing")
s = s.replace(old, new, 1)

old = '''    customFpsTimer = setTimeout(() => {
      saveSendSettings();
      void startStream();
    }, 100);
'''
new = '''    customFpsTimer = setTimeout(() => {
      saveSendSettings();
      if (selectedFile && !applyLiveSenderFps()) void startStream();
    }, 100);
'''
if old not in s: raise SystemExit("custom fps restart anchor missing")
s = s.replace(old, new, 1)

# Preserve the logical wall across viewport-only resizes. Unconditionally
# assigning canvas dimensions clears it to transparent/white even when nothing
# about the QR geometry changed.
old = '''    staging.width = totalW;
    staging.height = totalH;
    canvas.width = Math.max(1, Math.round(displayW * scale));
    canvas.height = Math.max(1, Math.round(displayH * scale));
'''
new = '''    if (staging.width !== totalW || staging.height !== totalH) {
      staging.width = totalW;
      staging.height = totalH;
    }
    const canvasW = Math.max(1, Math.round(displayW * scale));
    const canvasH = Math.max(1, Math.round(displayH * scale));
    if (canvas.width !== canvasW || canvas.height !== canvasH) {
      canvas.width = canvasW;
      canvas.height = canvasH;
    }
'''
if old not in s: raise SystemExit("sizeCanvas clear anchor missing")
s = s.replace(old, new, 1)

old = '''    if (fitStaging) {
      fitStaging.width = totalW * FIT_SUPERSAMPLE;
      fitStaging.height = totalH * FIT_SUPERSAMPLE;
'''
new = '''    if (fitStaging) {
      const fitW = totalW * FIT_SUPERSAMPLE;
      const fitH = totalH * FIT_SUPERSAMPLE;
      if (fitStaging.width !== fitW || fitStaging.height !== fitH) {
        fitStaging.width = fitW;
        fitStaging.height = fitH;
      }
'''
if old not in s: raise SystemExit("fit staging clear anchor missing")
s = s.replace(old, new, 1)

# Parallel sender state: retain one page while its cells are revealed.
old = '''    let nextPageId = 0;
    let nextPresentPageId = 0;
    let nextGenerateOrdinal = symbolOrdinal;

    const closePage = (page) => page?.bitmap?.close?.();
    activeSendRendererCleanup = () => {
      clearTimeout(dispatchTimer);
      dispatchTimer = 0;
      for (const worker of workers) worker.terminate();
      for (const page of readyPages.values()) closePage(page);
      readyPages.clear();
      pageMeta.clear();
    };
'''
new = '''    let nextPageId = 0;
    let nextPresentPageId = 0;
    let nextGenerateOrdinal = symbolOrdinal;
    let currentPage = null;
    let currentCellOffset = 0;
    let seededWall = false;

    const closePage = (page) => page?.bitmap?.close?.();
    activeSendRendererCleanup = () => {
      clearTimeout(dispatchTimer);
      dispatchTimer = 0;
      for (const worker of workers) worker.terminate();
      for (const page of readyPages.values()) closePage(page);
      closePage(currentPage);
      currentPage = null;
      readyPages.clear();
      pageMeta.clear();
    };
'''
if old not in s: raise SystemExit("parallel state anchor missing")
s = s.replace(old, new, 1)

# Replace page source/draw implementation. The first complete page seeds the
# wall atomically. Later pages are kept alive and their QR module rectangles are
# copied independently into the persistent logical wall.
start = s.find('    const drawPage = (page) => {')
end = s.find('\n\n    for (let i = 0; i < workerCount; ++i) {', start)
if start < 0 or end < 0: raise SystemExit("drawPage block bounds missing")
new_block = r'''    const ensurePageSource = (page, totalW, totalH) => {
      if (page.bitmap) return page.bitmap;
      if (page.sourceCanvas) return page.sourceCanvas;
      if (!page.pixels) return null;
      const source = document.createElement("canvas");
      source.width = totalW;
      source.height = totalH;
      source.getContext("2d").putImageData(
        new ImageData(new Uint8ClampedArray(page.pixels), totalW, totalH), 0, 0
      );
      page.sourceCanvas = source;
      return source;
    };
    const validatePage = (page) => {
      initializeGeometry(page);
      const totalW = modules * gridCols + gridMargin * (gridCols + 1);
      const totalH = modules * gridRows + gridMargin * (gridRows + 1);
      if (page.width !== totalW || page.height !== totalH)
        throw new Error(`Sender page geometry mismatch ${page.width}×${page.height}`);
      const source = ensurePageSource(page, totalW, totalH);
      if (!source) throw new Error("Sender worker returned no page pixels");
      return { source, totalW, totalH };
    };
    const drawPage = (page) => {
      const { source, totalW, totalH } = validatePage(page);
      const stagingCtx = staging.getContext("2d");
      stagingCtx.setTransform(1, 0, 0, 1, 0, 0);
      stagingCtx.globalCompositeOperation = "copy";
      stagingCtx.imageSmoothingEnabled = false;
      stagingCtx.drawImage(source, 0, 0, totalW, totalH);
      stagingCtx.globalCompositeOperation = "source-over";
      if (fitStaging) {
        const fitCtx = fitStaging.getContext("2d");
        fitCtx.setTransform(1, 0, 0, 1, 0, 0);
        fitCtx.globalCompositeOperation = "copy";
        fitCtx.imageSmoothingEnabled = false;
        fitCtx.drawImage(staging, 0, 0, totalW, totalH, 0, 0, fitStaging.width, fitStaging.height);
        fitCtx.globalCompositeOperation = "source-over";
        renderFitCanvas();
      } else {
        const ctx = canvas.getContext("2d");
        ctx.globalCompositeOperation = "copy";
        ctx.imageSmoothingEnabled = false;
        if (landscapeGrid())
          ctx.setTransform(0, canvas.height / totalW, -canvas.width / totalH, 0, canvas.width, 0);
        else
          ctx.setTransform(canvas.width / totalW, 0, 0, canvas.height / totalH, 0, 0);
        ctx.drawImage(staging, 0, 0);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "source-over";
      }
      if (activeTransportCursor?.key === transportKey)
        activeTransportCursor.nextOrdinal = Math.max(activeTransportCursor.nextOrdinal, page.endOrdinal);
    };
    const drawPageCell = (page, offset) => {
      const { source, totalW, totalH } = validatePage(page);
      const ordinal = page.startOrdinal + offset;
      const slotIndex = ordinal % gridCodes;
      const stride = modules + gridMargin;
      const ox = slotIndex % gridCols * stride + gridMargin;
      const oy = Math.floor(slotIndex / gridCols) * stride + gridMargin;

      // Keep a persistent module-resolution wall. This is what makes cell-phase
      // presentation cheap: a QR update touches only its own module square, not
      // a full 4:7 wall rescale/repaint.
      const stagingCtx = staging.getContext("2d");
      stagingCtx.setTransform(1, 0, 0, 1, 0, 0);
      stagingCtx.globalCompositeOperation = "copy";
      stagingCtx.imageSmoothingEnabled = false;
      stagingCtx.drawImage(source, ox, oy, modules, modules, ox, oy, modules, modules);
      stagingCtx.globalCompositeOperation = "source-over";

      const landscape = landscapeGrid();
      const targetW = landscape ? canvas.height : canvas.width;
      const targetH = landscape ? canvas.width : canvas.height;
      const ctx = canvas.getContext("2d");
      ctx.globalCompositeOperation = "copy";
      if (landscape)
        ctx.setTransform(0, 1, -1, 0, canvas.width, 0);
      else
        ctx.setTransform(1, 0, 0, 1, 0, 0);

      if (fitStaging) {
        const fitCtx = fitStaging.getContext("2d");
        fitCtx.setTransform(1, 0, 0, 1, 0, 0);
        fitCtx.globalCompositeOperation = "copy";
        fitCtx.imageSmoothingEnabled = false;
        fitCtx.drawImage(
          source,
          ox, oy, modules, modules,
          ox * FIT_SUPERSAMPLE, oy * FIT_SUPERSAMPLE,
          modules * FIT_SUPERSAMPLE, modules * FIT_SUPERSAMPLE
        );
        fitCtx.globalCompositeOperation = "source-over";

        // Include one logical white-border pixel so high-quality downsampling
        // sees the same edge neighborhood as a whole-wall draw. The expensive
        // operation is now proportional to one QR region, never the full wall.
        const rx = Math.max(0, ox - 1);
        const ry = Math.max(0, oy - 1);
        const rr = Math.min(totalW, ox + modules + 1);
        const rb = Math.min(totalH, oy + modules + 1);
        const rw = rr - rx;
        const rh = rb - ry;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(
          fitStaging,
          rx * FIT_SUPERSAMPLE, ry * FIT_SUPERSAMPLE,
          rw * FIT_SUPERSAMPLE, rh * FIT_SUPERSAMPLE,
          rx * targetW / totalW, ry * targetH / totalH,
          rw * targetW / totalW, rh * targetH / totalH
        );
      } else {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(
          staging,
          ox, oy, modules, modules,
          ox * targetW / totalW, oy * targetH / totalH,
          modules * targetW / totalW, modules * targetH / totalH
        );
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "source-over";

      if (activeTransportCursor?.key === transportKey)
        activeTransportCursor.nextOrdinal = Math.max(activeTransportCursor.nextOrdinal, ordinal + 1);
    };'''
s = s[:start] + new_block + s[end:]

# Replace atomic page scheduler with phase-staggered cell presentation. One page
# still arrives as one transferable bitmap; only already-rendered regions are
# exposed at different times.
old_start = s.find('    const interval = 1e3 / txFps;\n    let nextAt = 0;\n    const tickParallel = (now) => {')
old_end_marker = '    requestAnimationFrame(tickParallel);\n    return;\n'
old_end = s.find(old_end_marker, old_start)
if old_start < 0 or old_end < 0: raise SystemExit("parallel scheduler bounds missing")
old_end += len(old_end_marker)
new_sched = r'''    let pageInterval = 1e3 / txFps;
    let cellInterval = pageInterval / gridCodes;
    let nextCellAt = 0;
    activeSendFpsSetter = (fps) => {
      pageInterval = 1e3 / Math.max(1, fps);
      cellInterval = pageInterval / gridCodes;
      // Speed changes are live: keep the current sweep and warm workers. If the
      // new rate is faster, pull the next phase forward; never blank/restart.
      if (nextCellAt)
        nextCellAt = Math.min(nextCellAt, performance.now() + cellInterval);
    };
    const takeReadyPage = () => {
      const page = readyPages.get(nextPresentPageId);
      if (!page) return null;
      readyPages.delete(nextPresentPageId);
      pageMeta.delete(nextPresentPageId);
      return page;
    };
    const tickParallel = (now) => {
      if (gen !== generation || failed) return;
      requestAnimationFrame(tickParallel);

      // Seed the wall with one complete frame so startup never reveals a white
      // checkerboard one QR at a time. Every following page transitions in
      // phases over exactly one sender frame period.
      if (!seededWall) {
        const page = takeReadyPage();
        if (!page) return;
        try {
          drawPage(page);
        } catch (error) {
          closePage(page);
          fail(error);
          return;
        }
        closePage(page);
        nextPresentPageId++;
        seededWall = true;
        nextCellAt = now + cellInterval;
        scheduleDispatch();
        return;
      }

      if (!currentPage) {
        currentPage = takeReadyPage();
        currentCellOffset = 0;
        if (!currentPage) {
          // Encoding fell behind. Do not burst a whole stale page when it catches
          // up; restart the phase clock when a fresh page is actually available.
          nextCellAt = 0;
          return;
        }
        if (!nextCellAt) nextCellAt = now;
      }

      let painted = 0;
      while (currentPage && now + 0.25 >= nextCellAt && painted < gridCodes) {
        try {
          drawPageCell(currentPage, currentCellOffset);
        } catch (error) {
          closePage(currentPage);
          currentPage = null;
          fail(error);
          return;
        }
        currentCellOffset++;
        painted++;
        nextCellAt += cellInterval;
        if (currentCellOffset < gridCodes) continue;

        closePage(currentPage);
        currentPage = null;
        currentCellOffset = 0;
        nextPresentPageId++;
        scheduleDispatch();
        if (now + 0.25 < nextCellAt) break;
        currentPage = takeReadyPage();
        if (!currentPage) {
          nextCellAt = 0;
          break;
        }
      }
    };
    requestAnimationFrame(tickParallel);
    return;
'''
s = s[:old_start] + new_sched + s[old_end:]

# Static streams do not animate, but changing the visible FPS control still
# should not rebuild/flash them.
old = '''  paintPage();
  if (staticStream) return;
'''
new = '''  paintPage();
  if (staticStream) {
    activeSendFpsSetter = () => {};
    return;
  }
'''
if old not in s: raise SystemExit("static return anchor missing")
s = s.replace(old, new, 1)

# Fallback animated scheduler also accepts live speed updates. It remains the
# compatibility path for browsers without module workers.
old = '''  const interval = 1e3 / txFps;
  let nextAt = performance.now() + interval;
'''
new = '''  let interval = 1e3 / txFps;
  let nextAt = performance.now() + interval;
  activeSendFpsSetter = (fps) => {
    interval = 1e3 / Math.max(1, fps);
    nextAt = Math.min(nextAt, performance.now() + interval);
  };
'''
if old not in s: raise SystemExit("fallback interval anchor missing")
s = s.replace(old, new, 1)

p.write_text(s)

replace_once("main.js", 'const APP_BUILD = "v0.5.263";', 'const APP_BUILD = "v0.5.266";')
idx = Path("index.html")
s = idx.read_text()
if 'v0.5.263' not in s: raise SystemExit("index version missing")
idx.write_text(s.replace('v0.5.263', 'v0.5.266'))
replace_once("sw.js", 'airgapper-static-js-v214', 'airgapper-static-js-v215')
