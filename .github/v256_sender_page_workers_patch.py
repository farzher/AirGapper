from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:80]!r}")
    p.write_text(text.replace(old, new, 1))


worker = r'''import QRCode from "../vendor/qrcode.js";

const WHITE = 0xffffffff;
const BLACK = 0xff000000;

self.onmessage = (event) => {
  const job = event.data;
  if (!job || job.type !== "render-page") return;
  const startedAt = performance.now();
  try {
    let version = job.version;
    let modules = 0;
    let width = 0;
    let height = 0;
    let pixels;
    let encodeMs = 0;
    const strideFor = () => modules + job.margin;

    for (const frame of job.frames) {
      const encodeStarted = performance.now();
      const qr = QRCode.create([{ data: new Uint8Array(frame.buffer), mode: "byte" }], {
        errorCorrectionLevel: "L",
        version,
        maskPattern: 4
      });
      encodeMs += performance.now() - encodeStarted;
      if (version === undefined) version = qr.version;
      if (!modules) {
        modules = qr.modules.size;
        width = modules * job.cols + job.margin * (job.cols + 1);
        height = modules * job.rows + job.margin * (job.rows + 1);
        pixels = new Uint32Array(width * height);
        pixels.fill(WHITE);
      } else if (qr.modules.size !== modules) {
        throw new Error("QR version changed inside one sender page");
      }
      const slot = frame.slotIndex;
      const ox = slot % job.cols * strideFor() + job.margin;
      const oy = Math.floor(slot / job.cols) * strideFor() + job.margin;
      const data = qr.modules.data;
      for (let y = 0; y < modules; ++y) {
        const dst = (oy + y) * width + ox;
        const src = y * modules;
        for (let x = 0; x < modules; ++x)
          if (data[src + x]) pixels[dst + x] = BLACK;
      }
    }

    if (!pixels) throw new Error("Sender page contained no QR frames");
    const result = {
      type: "rendered-page",
      pageId: job.pageId,
      version,
      modules,
      width,
      height,
      encodeMs,
      renderMs: performance.now() - startedAt
    };
    if (typeof OffscreenCanvas === "function" && typeof ImageData === "function") {
      const page = new OffscreenCanvas(width, height);
      page.getContext("2d").putImageData(
        new ImageData(new Uint8ClampedArray(pixels.buffer), width, height),
        0,
        0
      );
      const bitmap = page.transferToImageBitmap();
      self.postMessage({ ...result, bitmap }, [bitmap]);
    } else {
      self.postMessage({ ...result, pixels: pixels.buffer }, [pixels.buffer]);
    }
  } catch (error) {
    self.postMessage({
      type: "render-error",
      pageId: job.pageId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};
'''
Path("send/render-worker.js").write_text(worker)

send_path = Path("send/main.js")
send = send_path.read_text()
send = send.replace('const LOOKAHEAD = 3;\n', '', 1)
send = send.replace(
    'const SEND_SETTINGS_KEY = "airgapper:send-settings:v1";\n',
    'const SEND_SETTINGS_KEY = "airgapper:send-settings:v1";\nconst SEND_RUNTIME_BUILD = "v0.5.256";\n',
    1,
)
send = send.replace(
    'let activeTransportCursor = null;\nconst specsLine = statusLine(specs);',
    '''let activeTransportCursor = null;\nlet activeSendRendererCleanup = null;\nfunction stopSendRenderer() {\n  const cleanup = activeSendRendererCleanup;\n  activeSendRendererCleanup = null;\n  cleanup?.();\n}\nconst specsLine = statusLine(specs);''',
    1,
)
send = send.replace(
    'function discardSelectedFile() {\n  activeTransportEncoder == null ? void 0 : activeTransportEncoder.free();',
    'function discardSelectedFile() {\n  stopSendRenderer();\n  activeTransportEncoder == null ? void 0 : activeTransportEncoder.free();',
    1,
)
send = send.replace(
    '  if (saved.scaling === "integer" || saved.scaling === "fit") cfgScaling.value = saved.scaling;\n    if (saved.layout === "single" || saved.layout === "one-two" || saved.layout === "two-two" || saved.layout === "two-three" || saved.layout === "four-three" || saved.layout === "three-five" || saved.layout === "three-six") {',
    '  if (saved.scaling === "integer" || saved.scaling === "fit") cfgScaling.value = saved.scaling;\n    if (saved.layout === "single" || saved.layout === "one-two" || saved.layout === "two-two" || saved.layout === "two-three" || saved.layout === "four-three" || saved.layout === "three-five" || saved.layout === "three-six" || saved.layout === "four-six" || saved.layout === "four-seven" || saved.layout === "four-eight") {',
    1,
)
send = send.replace(
    'async function startStream(revealStage = false) {\n  var _a;\n  const gen = ++generation;\n  activeTransportEncoder == null ? void 0 : activeTransportEncoder.free();',
    'async function startStream(revealStage = false) {\n  var _a;\n  const gen = ++generation;\n  stopSendRenderer();\n  activeTransportEncoder == null ? void 0 : activeTransportEncoder.free();',
    1,
)

start = send.index('  let version;\n', send.index('async function startStream'))
end_marker = '  requestAnimationFrame(tick);\n'
end = send.index(end_marker, start) + len(end_marker)
replacement = r'''  let version;
  let modules = 0;
  let scale = 1;
  let stagingHasPage = false;
  const staging = document.createElement("canvas");
  const fitStaging = fitScaling ? document.createElement("canvas") : null;
  const fitFiltered = fitScaling ? document.createElement("canvas") : null;

  const renderFitCanvas = () => {
    if (!fitStaging || !fitFiltered || !fitStaging.width || !fitStaging.height) return;
    const landscape = landscapeGrid();
    const targetW = landscape ? canvas.height : canvas.width;
    const targetH = landscape ? canvas.width : canvas.height;
    const sourceW = fitStaging.width;
    const sourceH = fitStaging.height;
    const midW = Math.min(sourceW, Math.max(targetW, Math.round(targetW * 2)));
    const midH = Math.min(sourceH, Math.max(targetH, Math.round(targetH * 2)));
    let filtered = fitStaging;
    if (midW !== sourceW || midH !== sourceH) {
      if (fitFiltered.width !== midW || fitFiltered.height !== midH) {
        fitFiltered.width = midW;
        fitFiltered.height = midH;
      }
      const filterCtx = fitFiltered.getContext("2d");
      filterCtx.setTransform(1, 0, 0, 1, 0, 0);
      filterCtx.globalCompositeOperation = "copy";
      filterCtx.imageSmoothingEnabled = true;
      filterCtx.imageSmoothingQuality = "high";
      filterCtx.drawImage(fitStaging, 0, 0, sourceW, sourceH, 0, 0, midW, midH);
      filterCtx.globalCompositeOperation = "source-over";
      filtered = fitFiltered;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "copy";
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (landscape) {
      ctx.setTransform(0, 1, -1, 0, canvas.width, 0);
      ctx.drawImage(filtered, 0, 0, filtered.width, filtered.height, 0, 0, canvas.height, canvas.width);
    } else {
      ctx.drawImage(filtered, 0, 0, filtered.width, filtered.height, 0, 0, canvas.width, canvas.height);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  };

  const drawStagingToDisplay = () => {
    if (!stagingHasPage || !staging.width || !staging.height) return;
    if (fitStaging) {
      const targetW = staging.width * FIT_SUPERSAMPLE;
      const targetH = staging.height * FIT_SUPERSAMPLE;
      if (fitStaging.width !== targetW || fitStaging.height !== targetH) {
        fitStaging.width = targetW;
        fitStaging.height = targetH;
      }
      const fitCtx = fitStaging.getContext("2d");
      fitCtx.setTransform(1, 0, 0, 1, 0, 0);
      fitCtx.globalCompositeOperation = "copy";
      fitCtx.imageSmoothingEnabled = false;
      fitCtx.drawImage(staging, 0, 0, fitStaging.width, fitStaging.height);
      fitCtx.globalCompositeOperation = "source-over";
      renderFitCanvas();
      return;
    }
    const ctx = canvas.getContext("2d");
    const totalW = staging.width;
    const totalH = staging.height;
    ctx.globalCompositeOperation = "copy";
    ctx.imageSmoothingEnabled = false;
    if (landscapeGrid()) {
      ctx.setTransform(0, canvas.height / totalW, -canvas.width / totalH, 0, canvas.width, 0);
    } else {
      ctx.setTransform(canvas.width / totalW, 0, 0, canvas.height / totalH, 0, 0);
    }
    ctx.drawImage(staging, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  };

  stage.hidden = false;
  if (sendStart) sendStart.hidden = true;
  showStreamPanels(true);

  const sizeCanvas = () => {
    if (!modules) return;
    const dpr = window.devicePixelRatio || 1;
    const totalW = modules * gridCols + gridMargin * (gridCols + 1);
    const totalH = modules * gridRows + gridMargin * (gridRows + 1);
    const landscape = landscapeGrid();
    const displayW = landscape ? totalH : totalW;
    const displayH = landscape ? totalW : totalH;
    let budgetW;
    let budgetH;
    if (document.body.classList.contains("qr-full")) {
      budgetW = window.innerWidth;
      budgetH = window.innerHeight - stageBottom.offsetHeight;
    } else {
      const rect = stage.getBoundingClientRect();
      const stageStyle = getComputedStyle(stage);
      budgetW = rect.width - Number.parseFloat(stageStyle.paddingLeft) - Number.parseFloat(stageStyle.paddingRight);
      budgetH = rect.height - stageBottom.offsetHeight - Number.parseFloat(stageStyle.paddingTop) - Number.parseFloat(stageStyle.paddingBottom);
    }
    const availableScale = Math.min(budgetW * dpr / displayW, budgetH * dpr / displayH);
    scale = fitScaling || availableScale < 1 ? Math.max(Number.EPSILON, availableScale) : Math.floor(availableScale);
    if (staging.width !== totalW || staging.height !== totalH) {
      staging.width = totalW;
      staging.height = totalH;
      stagingHasPage = false;
    }
    canvas.width = Math.max(1, Math.round(displayW * scale));
    canvas.height = Math.max(1, Math.round(displayH * scale));
    canvas.style.width = `${displayW * scale / dpr}px`;
    canvas.style.height = `${displayH * scale / dpr}px`;
    canvas.style.imageRendering = fitScaling ? "auto" : "pixelated";
    drawStagingToDisplay();
  };

  let pageGeometryReady = false;
  const initializePageGeometry = (pageVersion, pageModules) => {
    if (pageGeometryReady) return;
    version = pageVersion;
    modules = pageModules;
    pageGeometryReady = true;
    sizeCanvas();
    resizeDisplay = sizeCanvas;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (gen === generation) sizeCanvas();
    }));
    setTimeout(() => {
      if (gen === generation) sizeCanvas();
    }, 250);
    if (revealStage) scrollStageIntoView();
    showStreamPanels(true);
    setStatus("");
  };

  const framedBytes = (ordinal) => {
    const slotIndex = ordinal % gridCodes;
    const seq = scheduledEsi(encoder.k, ordinal);
    return {
      ordinal,
      slotIndex,
      bytes: packFrame({ ...header, seq, slotIndex }, encoder.encode(seq))
    };
  };

  if (staticStream) {
    let qr;
    let ordinal = null;
    if (plainSnippet !== null) {
      qr = QRCode.create(plainSnippet, { errorCorrectionLevel: ecc, version, maskPattern: 4 });
    } else {
      const frame = framedBytes(symbolOrdinal++);
      ordinal = frame.ordinal;
      qr = QRCode.create([{ data: frame.bytes, mode: "byte" }], {
        errorCorrectionLevel: ecc,
        version,
        maskPattern: 4
      });
    }
    initializePageGeometry(qr.version, qr.modules.size);
    const raster = rasterizeQr(qr.modules.size, qr.modules.data, gridMargin);
    staging.getContext("2d").putImageData(
      new ImageData(new Uint8ClampedArray(raster.pixels.buffer), raster.size, raster.size),
      0,
      0
    );
    stagingHasPage = true;
    drawStagingToDisplay();
    if (ordinal !== null && activeTransportCursor?.key === transportKey)
      activeTransportCursor.nextOrdinal = Math.max(activeTransportCursor.nextOrdinal, ordinal + 1);
    return;
  }

  const workerCount = Math.max(1, Math.min(8, Math.max(1, (navigator.hardwareConcurrency || 4) - 2)));
  const maxPagesAhead = Math.max(3, Math.min(8, workerCount + 2));
  const workers = [];
  const readyPages = new Map();
  const pageMeta = new Map();
  let fillTimer = 0;
  let generatorFailed = false;
  let nextPageId = 0;
  let nextPresentPageId = 0;
  let nextGenerateOrdinal = symbolOrdinal;

  const closePage = (page) => page?.bitmap?.close?.();
  activeSendRendererCleanup = () => {
    clearTimeout(fillTimer);
    fillTimer = 0;
    for (const worker of workers) worker.terminate();
    for (const page of readyPages.values()) closePage(page);
    readyPages.clear();
    pageMeta.clear();
  };

  const failGenerator = (error) => {
    if (generatorFailed || gen !== generation) return;
    generatorFailed = true;
    stopSendRenderer();
    showError(error instanceof Error ? error.message : String(error));
  };

  const buildPageFrames = (startOrdinal) => {
    const frames = [];
    const transfer = [];
    for (let offset = 0; offset < gridCodes; ++offset) {
      const frame = framedBytes(startOrdinal + offset);
      const bytes = frame.bytes;
      const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer
        : bytes.slice().buffer;
      frames.push({ slotIndex: frame.slotIndex, buffer });
      transfer.push(buffer);
    }
    return { frames, transfer };
  };

  const dispatchPage = (worker) => {
    if (worker.busy || generatorFailed || gen !== generation || nextPageId - nextPresentPageId >= maxPagesAhead)
      return false;
    const pageId = nextPageId++;
    const startOrdinal = nextGenerateOrdinal;
    nextGenerateOrdinal += gridCodes;
    const meta = { startOrdinal, endOrdinal: startOrdinal + gridCodes };
    pageMeta.set(pageId, meta);
    try {
      const { frames, transfer } = buildPageFrames(startOrdinal);
      worker.busy = true;
      worker.postMessage({
        type: "render-page",
        pageId,
        frames,
        cols: gridCols,
        rows: gridRows,
        margin: gridMargin,
        version
      }, transfer);
      return true;
    } catch (error) {
      pageMeta.delete(pageId);
      failGenerator(error);
      return false;
    }
  };

  const scheduleFill = () => {
    if (fillTimer || generatorFailed || gen !== generation) return;
    fillTimer = setTimeout(() => {
      fillTimer = 0;
      const worker = workers.find((candidate) => !candidate.busy);
      if (worker && dispatchPage(worker)) scheduleFill();
    }, 0);
  };

  for (let index = 0; index < workerCount; ++index) {
    const worker = new Worker(new URL(`./render-worker.js?build=${SEND_RUNTIME_BUILD}`, import.meta.url), { type: "module" });
    worker.busy = false;
    worker.onmessage = (event) => {
      const page = event.data;
      worker.busy = false;
      if (gen !== generation || generatorFailed) {
        closePage(page);
        return;
      }
      if (page?.type === "render-error") {
        failGenerator(new Error(page.error || "QR render worker failed"));
        return;
      }
      const meta = pageMeta.get(page.pageId);
      if (!meta || page?.type !== "rendered-page") {
        closePage(page);
        failGenerator(new Error("QR render worker returned an invalid page"));
        return;
      }
      readyPages.set(page.pageId, { ...page, ...meta });
      scheduleFill();
    };
    worker.onerror = (event) => failGenerator(new Error(event.message || "QR render worker failed"));
    workers.push(worker);
  }

  const presentPage = (page) => {
    initializePageGeometry(page.version, page.modules);
    if (page.width !== staging.width || page.height !== staging.height)
      throw new Error(`Rendered sender page size changed (${page.width}×${page.height})`);
    const stagingCtx = staging.getContext("2d");
    stagingCtx.setTransform(1, 0, 0, 1, 0, 0);
    stagingCtx.globalCompositeOperation = "copy";
    if (page.bitmap) {
      stagingCtx.drawImage(page.bitmap, 0, 0);
      page.bitmap.close?.();
    } else if (page.pixels) {
      stagingCtx.putImageData(
        new ImageData(new Uint8ClampedArray(page.pixels), page.width, page.height),
        0,
        0
      );
    } else {
      throw new Error("QR render worker returned no pixels");
    }
    stagingCtx.globalCompositeOperation = "source-over";
    stagingHasPage = true;
    drawStagingToDisplay();
    if (activeTransportCursor?.key === transportKey)
      activeTransportCursor.nextOrdinal = Math.max(activeTransportCursor.nextOrdinal, page.endOrdinal);
  };

  scheduleFill();
  const interval = 1e3 / txFps;
  let nextAt = 0;
  const tick = (now) => {
    if (gen !== generation || generatorFailed) return;
    requestAnimationFrame(tick);
    const page = readyPages.get(nextPresentPageId);
    if (!page) return;
    if (!nextAt) nextAt = now;
    if (now + 0.25 < nextAt) return;
    try {
      readyPages.delete(nextPresentPageId);
      pageMeta.delete(nextPresentPageId);
      presentPage(page);
      nextPresentPageId++;
      nextAt = (now - nextAt > interval ? now : nextAt) + interval;
      scheduleFill();
    } catch (error) {
      closePage(page);
      failGenerator(error);
    }
  };
  requestAnimationFrame(tick);
'''
send = send[:start] + replacement + send[end:]
send_path.write_text(send)

replace_once(
    "receive/main.js",
    'const RECEIVER_RUNTIME_BUILD = "v0.5.255";',
    'const RECEIVER_RUNTIME_BUILD = "v0.5.256";',
)
replace_once(
    "receive/main.js",
    '// Keep visible rolling status intentionally calm/readable: one DOM refresh per second.\n// The underlying event timestamps remain precise; only presentation is 1 Hz.\nconst STATS_TICK_MS = 1000;\nconst DIAGNOSTICS_TICK_MS = 1000;',
    '// Visible throughput/progress refreshes at 5 Hz; the rolling measurement window remains one second.\n// Keep the large developer diagnostic strings at 1 Hz so observability does not steal decode CPU.\nconst STATS_TICK_MS = 200;\nconst DIAGNOSTICS_TICK_MS = 1000;',
)
replace_once("main.js", 'const APP_BUILD = "v0.5.255";', 'const APP_BUILD = "v0.5.256";')

index = Path("index.html").read_text()
index = index.replace('v0.5.255', 'v0.5.256')
index = index.replace('./main.js?build=v0.5.250', './main.js?build=v0.5.256')
Path("index.html").write_text(index)

sw = Path("sw.js").read_text()
sw = sw.replace('airgapper-static-js-v210', 'airgapper-static-js-v211', 1)
sw = sw.replace('    "./send/main.js",\n', '    "./send/main.js",\n    "./send/render-worker.js",\n', 1)
Path("sw.js").write_text(sw)
