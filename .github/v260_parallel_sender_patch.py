from pathlib import Path

def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing anchor in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))

Path("send/render-worker.js").write_text(r'''import QRCode from "../vendor/qrcode.js";

const WHITE = 0xffffffff;
const BLACK = 0xff000000;

self.onmessage = (event) => {
  const job = event.data;
  if (!job || job.type !== "render-page") return;
  try {
    let version = job.version;
    let modules = 0;
    let width = 0;
    let height = 0;
    let pixels = null;
    for (const frame of job.frames) {
      const qr = QRCode.create([{ data: new Uint8Array(frame.buffer), mode: "byte" }], {
        errorCorrectionLevel: "L",
        version,
        maskPattern: 4
      });
      if (version === undefined) version = qr.version;
      if (!modules) {
        modules = qr.modules.size;
        width = modules * job.cols + job.margin * (job.cols + 1);
        height = modules * job.rows + job.margin * (job.rows + 1);
        pixels = new Uint32Array(width * height);
        pixels.fill(WHITE);
      } else if (modules !== qr.modules.size) {
        throw new Error("QR version changed inside sender page");
      }
      const stride = modules + job.margin;
      const ox = frame.slotIndex % job.cols * stride + job.margin;
      const oy = Math.floor(frame.slotIndex / job.cols) * stride + job.margin;
      const data = qr.modules.data;
      for (let y = 0; y < modules; ++y) {
        const dst = (oy + y) * width + ox;
        const src = y * modules;
        for (let x = 0; x < modules; ++x)
          if (data[src + x]) pixels[dst + x] = BLACK;
      }
    }
    if (!pixels) throw new Error("Empty sender page");
    const common = { type: "rendered-page", pageId: job.pageId, version, modules, width, height };
    if (typeof OffscreenCanvas === "function" && typeof ImageData === "function") {
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext("2d").putImageData(
        new ImageData(new Uint8ClampedArray(pixels.buffer), width, height), 0, 0
      );
      const bitmap = canvas.transferToImageBitmap();
      self.postMessage({ ...common, bitmap }, [bitmap]);
    } else {
      self.postMessage({ ...common, pixels: pixels.buffer }, [pixels.buffer]);
    }
  } catch (error) {
    self.postMessage({
      type: "render-error",
      pageId: job?.pageId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};
''')

replace_once(
    "send/main.js",
    'const SEND_SETTINGS_KEY = "airgapper:send-settings:v1";',
    'const SEND_SETTINGS_KEY = "airgapper:send-settings:v1";\nconst SEND_RUNTIME_BUILD = "v0.5.260";'
)
replace_once(
    "send/main.js",
    'let activeTransportEncoder = null;\nlet activeTransportCursor = null;\nconst specsLine = statusLine(specs);',
    '''let activeTransportEncoder = null;
let activeTransportCursor = null;
let activeSendRendererCleanup = null;
function stopSendRenderer() {
  const cleanup = activeSendRendererCleanup;
  activeSendRendererCleanup = null;
  cleanup?.();
}
const specsLine = statusLine(specs);'''
)
replace_once(
    "send/main.js",
    'function discardSelectedFile() {\n  activeTransportEncoder == null ? void 0 : activeTransportEncoder.free();',
    'function discardSelectedFile() {\n  stopSendRenderer();\n  activeTransportEncoder == null ? void 0 : activeTransportEncoder.free();'
)
replace_once(
    "send/main.js",
    '  const gen = ++generation;\n  activeTransportEncoder == null ? void 0 : activeTransportEncoder.free();',
    '  const gen = ++generation;\n  stopSendRenderer();\n  activeTransportEncoder == null ? void 0 : activeTransportEncoder.free();'
)

p = Path("send/main.js")
s = p.read_text()
anchor = '  let generatorFailed = false;\n'
if anchor not in s:
    raise SystemExit("sender generator anchor missing")
parallel = r'''  // Animated walls generate a complete QR page off the UI thread. At 4:7/30
  // fps this moves 840 QR encodes/s away from the compositor/main thread. The
  // main thread still owns transport encoding so the large source payload is
  // not copied into every worker; workers receive only one page (~80 KiB) of
  // framed QR bytes and return a transferable ImageBitmap.
  if (!staticStream && typeof Worker === "function") {
    const hc = Math.max(1, navigator.hardwareConcurrency || 4);
    const workerCount = Math.max(1, Math.min(8, hc - 2 || 1));
    const maxPagesAhead = Math.max(3, Math.min(10, workerCount + 2));
    const workers = [];
    const readyPages = new Map();
    const pageMeta = new Map();
    let dispatchTimer = 0;
    let failed = false;
    let nextPageId = 0;
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
    const fail = (error) => {
      if (failed || gen !== generation) return;
      failed = true;
      stopSendRenderer();
      showError(error instanceof Error ? error.message : String(error));
    };
    const buildFrames = (startOrdinal) => {
      const frames = [];
      const transfer = [];
      for (let offset = 0; offset < gridCodes; ++offset) {
        const ordinal = startOrdinal + offset;
        const slotIndex = ordinal % gridCodes;
        const seq = scheduledEsi(encoder.k, ordinal);
        const bytes = packFrame({ ...header, seq, slotIndex }, encoder.encode(seq));
        const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer
          : bytes.slice().buffer;
        frames.push({ slotIndex, buffer });
        transfer.push(buffer);
      }
      return { frames, transfer };
    };
    const dispatchOne = (worker) => {
      if (failed || gen !== generation || worker.busy || nextPageId - nextPresentPageId >= maxPagesAhead)
        return false;
      const pageId = nextPageId++;
      const startOrdinal = nextGenerateOrdinal;
      nextGenerateOrdinal += gridCodes;
      pageMeta.set(pageId, { startOrdinal, endOrdinal: startOrdinal + gridCodes });
      try {
        const { frames, transfer } = buildFrames(startOrdinal);
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
        fail(error);
        return false;
      }
    };
    const scheduleDispatch = () => {
      if (dispatchTimer || failed || gen !== generation) return;
      dispatchTimer = setTimeout(() => {
        dispatchTimer = 0;
        const worker = workers.find((candidate) => !candidate.busy);
        if (worker && dispatchOne(worker)) scheduleDispatch();
      }, 0);
    };
    const initializeGeometry = (page) => {
      if (version !== undefined) {
        if (modules !== page.modules) throw new Error("Sender QR geometry changed");
        return;
      }
      version = page.version;
      modules = page.modules;
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
    const drawPage = (page) => {
      initializeGeometry(page);
      const totalW = modules * gridCols + gridMargin * (gridCols + 1);
      const totalH = modules * gridRows + gridMargin * (gridRows + 1);
      if (page.width !== totalW || page.height !== totalH)
        throw new Error(`Sender page geometry mismatch ${page.width}×${page.height}`);
      let source = page.bitmap;
      if (!source && page.pixels) {
        staging.width = totalW;
        staging.height = totalH;
        staging.getContext("2d").putImageData(
          new ImageData(new Uint8ClampedArray(page.pixels), totalW, totalH), 0, 0
        );
        source = staging;
      }
      if (!source) throw new Error("Sender worker returned no page pixels");
      if (fitStaging) {
        const fitCtx = fitStaging.getContext("2d");
        fitCtx.setTransform(1, 0, 0, 1, 0, 0);
        fitCtx.globalCompositeOperation = "copy";
        fitCtx.imageSmoothingEnabled = false;
        fitCtx.drawImage(source, 0, 0, totalW, totalH, 0, 0, fitStaging.width, fitStaging.height);
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
        ctx.drawImage(source, 0, 0);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "source-over";
      }
      page.bitmap?.close?.();
      if (activeTransportCursor?.key === transportKey)
        activeTransportCursor.nextOrdinal = Math.max(activeTransportCursor.nextOrdinal, page.endOrdinal);
    };

    for (let i = 0; i < workerCount; ++i) {
      const worker = new Worker(new URL(`./render-worker.js?build=${SEND_RUNTIME_BUILD}`, import.meta.url), { type: "module" });
      worker.busy = false;
      worker.onmessage = (event) => {
        worker.busy = false;
        const page = event.data;
        if (gen !== generation || failed) {
          closePage(page);
          return;
        }
        if (page?.type === "render-error") {
          fail(new Error(page.error || "Sender QR worker failed"));
          return;
        }
        const meta = pageMeta.get(page?.pageId);
        if (!meta || page?.type !== "rendered-page") {
          closePage(page);
          fail(new Error("Sender QR worker returned an invalid page"));
          return;
        }
        readyPages.set(page.pageId, { ...page, ...meta });
        scheduleDispatch();
      };
      worker.onerror = (event) => fail(new Error(event.message || "Sender QR worker failed"));
      workers.push(worker);
    }
    scheduleDispatch();

    const interval = 1e3 / txFps;
    let nextAt = 0;
    const tickParallel = (now) => {
      if (gen !== generation || failed) return;
      requestAnimationFrame(tickParallel);
      const page = readyPages.get(nextPresentPageId);
      if (!page) return;
      if (!nextAt) nextAt = now;
      if (now + 0.25 < nextAt) return;
      readyPages.delete(nextPresentPageId);
      pageMeta.delete(nextPresentPageId);
      try {
        drawPage(page);
      } catch (error) {
        closePage(page);
        fail(error);
        return;
      }
      nextPresentPageId++;
      nextAt = (now - nextAt > interval ? now : nextAt) + interval;
      scheduleDispatch();
    };
    requestAnimationFrame(tickParallel);
    return;
  }

'''
s = s.replace(anchor, parallel + anchor, 1)
p.write_text(s)

replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.259";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.260";')
replace_once("main.js", 'const APP_BUILD = "v0.5.259";', 'const APP_BUILD = "v0.5.260";')
index = Path("index.html").read_text().replace('v0.5.259', 'v0.5.260')
Path("index.html").write_text(index)
sw = Path("sw.js").read_text().replace('airgapper-static-js-v212', 'airgapper-static-js-v213', 1)
if '"./send/render-worker.js"' not in sw:
    sw = sw.replace('    "./send/main.js",\n', '    "./send/main.js",\n    "./send/render-worker.js",\n', 1)
Path("sw.js").write_text(sw)
