import QRCode from "../vendor/qrcode.js";
import { rasterizeQr } from "../shared/qr-raster.js";
import { formatBytes } from "../shared/format.js";
import {
  fitsInOneStream,
  selectTransportPlan,
  smallestSufficientFrameSize,
  sourceBlockCount
} from "../shared/frame-capacity.js";
import { scheduledEsi, TransportEncoder } from "../shared/transport.js";
import { prepareRaptorQ } from "../shared/raptorq.js";
import { MAX_SNIPPET_BYTES, MAX_SNIPPET_LABEL, packSnippet } from "../shared/snippet.js";
import {
  MAX_FILE_BYTES,
  MAX_FILE_LABEL,
  fnv1a,
  packFile,
  packFrame
} from "../shared/protocol.js";
import { statusLine } from "../shared/status-line.js";
import { releaseScreenWakeLock, requestScreenWakeLock } from "../shared/wake-lock.js";
import { makeZip } from "../shared/zip.js";
import { FRAME_BYTES_OPTIONS } from "../shared/send-settings.js";
import { GRID_MARGIN_MODULES, gridLayoutId } from "../shared/grid-layout.js";
const HEADER_MARGIN = 0;
const GRID_MARGIN = GRID_MARGIN_MODULES;
const LOOKAHEAD = 3;
const FIT_SUPERSAMPLE = 4;
const DEFAULT_GRID_CODES = 12;
const SEND_SETTINGS_KEY = "airgapper:send-settings:v1";
function selectedLayout() {
  const mode = cfgLayout.value;
  return mode === "single" || mode === "one-two" || mode === "two-two" || mode === "two-three" || mode === "three-five" || mode === "three-six" ? mode : "four-three";
}
function selectedOrientation() {
  const orientation = cfgOrientation.value;
  return orientation === "portrait" || orientation === "landscape" ? orientation : "auto";
}
function landscapeGrid() {
  const orientation = selectedOrientation();
  return orientation === "landscape" || orientation === "auto" && window.innerWidth > window.innerHeight;
}
function layoutGrid(mode = selectedLayout()) {
  switch (mode) {
    case "single":
      return { cols: 1, rows: 1, codes: 1 };
    case "one-two":
      return { cols: 1, rows: 2, codes: 2 };
    case "two-two":
      return { cols: 2, rows: 2, codes: 4 };
    case "two-three":
      return { cols: 2, rows: 3, codes: 6 };
    case "three-five":
      return { cols: 3, rows: 5, codes: 15 };
    case "three-six":
      return { cols: 3, rows: 6, codes: 18 };
    default:
      return { cols: 3, rows: 4, codes: DEFAULT_GRID_CODES };
  }
}
const canvas = document.getElementById("qr");
const CURSOR_IDLE_MS = 1000;
let cursorIdleTimer;
function wakeCanvasCursor() {
  clearTimeout(cursorIdleTimer);
  canvas.classList.remove("cursor-idle");
  cursorIdleTimer = setTimeout(() => {
    if (canvas.matches(":hover")) canvas.classList.add("cursor-idle");
  }, CURSOR_IDLE_MS);
}
canvas.addEventListener("mouseenter", wakeCanvasCursor);
canvas.addEventListener("mousemove", wakeCanvasCursor);
canvas.addEventListener("mouseleave", () => {
  clearTimeout(cursorIdleTimer);
  canvas.classList.remove("cursor-idle");
});
const stage = document.getElementById("stage");
const stageError = document.getElementById("stage-error");
const sendStart = document.querySelector(".send-start");
const specs = document.getElementById("specs");
const cfgFile = document.getElementById("cfg-file");
const filePickerLabel = document.getElementById("file-picker-label");
const filePickerButton = document.getElementById("file-picker-button");
const selectionSummary = document.getElementById("selection-summary");
const sendControls = document.getElementById("send-controls");
const stageBottom = document.getElementById("stage-bottom");
const snippetText = document.getElementById("snippet-text");
const snippetLabel = document.getElementById("snippet-label");
const sendSnippetBtn = document.getElementById("send-snippet");
const paneFile = document.getElementById("pane-file");
const paneSnippet = document.getElementById("pane-snippet");
const receiverLinkQr = document.getElementById("receiver-link-qr");
const receiverLinkQrLarge = document.getElementById("receiver-link-qr-large");
function renderReceiverLink() {
  const receiverUrl = receiverLinkQr.dataset.receiverUrl;
  if (!receiverUrl) return;
  const qr = QRCode.create(receiverUrl, { errorCorrectionLevel: "L" });
  const render = (target, targetCssSize, margin, moduleCssScale) => {
    const raster = rasterizeQr(qr.modules.size, qr.modules.data, margin);
    const dpr = window.devicePixelRatio || 1;
    const scale = moduleCssScale === void 0 ? Math.max(1, Math.round(targetCssSize * dpr / raster.size)) : moduleCssScale;
    const source = document.createElement("canvas");
    source.width = source.height = raster.size;
    source.getContext("2d").putImageData(
      new ImageData(new Uint8ClampedArray(raster.pixels.buffer), raster.size, raster.size),
      0,
      0
    );
    target.width = target.height = raster.size * scale;
    const cssSize = moduleCssScale === void 0 ? target.width / dpr : raster.size * moduleCssScale;
    target.style.width = target.style.height = `${cssSize}px`;
    target.style.imageRendering = "pixelated";
    const ctx = target.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source, 0, 0, target.width, target.height);
    return cssSize;
  };
  const headerSize = render(receiverLinkQr, 48, HEADER_MARGIN, 1);
  const headerButton = receiverLinkQr.parentElement;
  headerButton.style.width = headerButton.style.height = `${headerSize}px`;
  render(receiverLinkQrLarge, 240, 4);
}
renderReceiverLink();
function showStreamPanels(visible) {
  sendControls.hidden = !visible;
}
const cfgFps = document.getElementById("cfg-fps");
const cfgFpsCustom = document.getElementById("cfg-fps-custom");
const speedControl = cfgFps.closest(".speed-control");
const cfgSize = document.getElementById("cfg-size");
const cfgScaling = document.getElementById("cfg-scaling");
const cfgLayout = document.getElementById("cfg-layout");
const cfgOrientation = document.getElementById("cfg-orientation");
function selectedFps() {
  const value = cfgFps.value === "custom" ? Number(cfgFpsCustom.value) : Number(cfgFps.value);
  return Number.isFinite(value) ? Math.max(1, Math.min(480, Math.round(value))) : 15;
}
function selectFps(fps) {
  var _a;
  const preset = Array.from(cfgFps.options).find((option) => Number(option.value) === fps);
  cfgFps.value = (_a = preset == null ? void 0 : preset.value) != null ? _a : "custom";
  cfgFpsCustom.value = String(fps);
  cfgFpsCustom.hidden = cfgFps.value !== "custom";
  speedControl.classList.toggle("has-custom", !cfgFpsCustom.hidden);
}
function monitorDisplayRefreshRate() {
  const intervals = [];
  let previous = 0;
  const monitorStarted = performance.now();
  let windowStarted = monitorStarted;
  let displayOption = null;
  const sample = (now) => {
    var _a;
    if (previous) {
      const interval = now - previous;
      if (interval > 1 && interval < 40) intervals.push(interval);
    }
    previous = now;
    if (now - windowStarted >= 750 && intervals.length) {
      const sorted = intervals.slice().sort((a, b) => a - b);
      const measuredRate = 1e3 / sorted[Math.floor(sorted.length / 2)];
      const commonRates = [75, 90, 100, 120, 144, 165, 180, 200, 240, 280, 300, 360, 480];
      const nearestCommon = commonRates.reduce((nearest, rate) => Math.abs(rate - measuredRate) < Math.abs(nearest - measuredRate) ? rate : nearest);
      const refreshRate = Math.abs(nearestCommon - measuredRate) / nearestCommon <= 0.03 ? nearestCommon : Math.round(measuredRate);
      if (refreshRate > 60) {
        const previousValue = displayOption == null ? void 0 : displayOption.value;
        const wasSelected = cfgFps.value === previousValue;
        if (!displayOption) {
          displayOption = new Option();
          cfgFps.insertBefore(displayOption, (_a = cfgFps.options[cfgFps.options.length - 1]) != null ? _a : null);
        }
        displayOption.value = String(refreshRate);
        displayOption.textContent = `${refreshRate} fps (display refresh)`;
        if (wasSelected) {
          cfgFps.value = displayOption.value;
          if (previousValue !== displayOption.value) {
            saveSendSettings();
            void startStream();
          }
        }
      }
      intervals.length = 0;
      windowStarted = now;
    }
    if (now - monitorStarted < 5e3) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}
let selectedFile = null;
let generation = 0;
let resizeDisplay = null;
let activeTransportEncoder = null;
let activeTransportCursor = null;
const specsLine = statusLine(specs);
const setStatus = specsLine.setStatus;
function showError(message) {
  releaseScreenWakeLock();
  setStageFullscreen(false);
  stage.hidden = true;
  stageError.hidden = true;
  if (sendStart) sendStart.hidden = false;
  showStreamPanels(false);
  specsLine.showError(message);
}
function showSettingsError(message) {
  releaseScreenWakeLock();
  setStageFullscreen(false);
  stage.hidden = false;
  canvas.style.display = "none";
  stageError.textContent = message;
  stageError.hidden = false;
  if (sendStart) sendStart.hidden = true;
  showStreamPanels(true);
  setStatus("");
}
let selectedMode = "file";
function currentMode() {
  return selectedMode;
}
function selectMode(mode) {
  selectedMode = mode;
}
function updateFilePicker() {
  const armed = currentMode() === "file" && selectedFile !== null;
  paneFile.classList.toggle("has-file", armed);
  filePickerButton.textContent = armed ? "Stop transfer" : "Drop files here";
  filePickerLabel.textContent = armed ? "Select different files" : "or select files";
  selectionSummary.hidden = !armed;
  if (armed && selectedFile) {
    const names = document.createElement("span");
    const total = document.createElement("span");
    names.textContent = selectedFile.files.length > 1 ? `${selectedFile.files.length} files` : selectedFile.files[0].name;
    names.title = names.textContent;
    const originalTotal = selectedFile.files.reduce((sum, file) => sum + file.size, 0);
    total.textContent = selectedFile.compression === "gzip" ? `${formatBytes(originalTotal)} · ${formatBytes(selectedFile.transmittedSize)} gzip` : formatBytes(originalTotal);
    selectionSummary.replaceChildren(names, total);
  } else selectionSummary.replaceChildren();
}
function discardSelectedFile() {
  activeTransportEncoder == null ? void 0 : activeTransportEncoder.free();
  activeTransportEncoder = null;
  activeTransportCursor = null;
  selectedFile == null ? void 0 : selectedFile.payload.fill(0);
  selectedFile = null;
  resizeDisplay = null;
  canvas.width = canvas.height = 16;
}
function stopTransfer() {
  generation++;
  releaseScreenWakeLock();
  discardSelectedFile();
  snippetText.value = "";
  setStageFullscreen(false);
  stage.hidden = true;
  stageError.hidden = true;
  if (sendStart) sendStart.hidden = false;
  showStreamPanels(false);
  cfgFile.value = "";
  updateFilePicker();
  setStatus("");
}
let scrollBeforeFullscreen = 0;
function setStageFullscreen(on) {
  if (on === document.body.classList.contains("qr-full")) return;
  if (on) scrollBeforeFullscreen = window.scrollY;
  document.body.classList.toggle("qr-full", on);
  if (!on && document.fullscreenElement) void document.exitFullscreen().catch(() => void 0);
  resizeDisplay == null ? void 0 : resizeDisplay();
  window.scrollTo(0, on ? 0 : scrollBeforeFullscreen);
}
canvas.addEventListener("click", () => {
  var _a, _b;
  const entering = !document.body.classList.contains("qr-full");
  setStageFullscreen(entering);
  if (entering) void ((_b = (_a = document.documentElement).requestFullscreen) == null ? void 0 : _b.call(_a).catch(() => void 0));
});
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) setStageFullscreen(false);
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setStageFullscreen(false);
});
function applyMode() {
  generation++;
  releaseScreenWakeLock();
  discardSelectedFile();
  setStageFullscreen(false);
  stage.hidden = true;
  stageError.hidden = true;
  if (sendStart) sendStart.hidden = false;
  showStreamPanels(false);
  paneFile.hidden = false;
  paneSnippet.hidden = false;
  setStatus("");
  updateFilePicker();
}
async function startSelection(status, prepare) {
  const selectionGeneration = ++generation;
  discardSelectedFile();
  stage.hidden = true;
  setStatus(status);
  try {
    const { name, size, packed, files } = await prepare();
    if (selectionGeneration !== generation) {
      packed.container.fill(0);
      return;
    }
    selectedFile = {
      name,
      size,
      payload: packed.container,
      compression: packed.compression,
      transmittedSize: packed.transmittedSize,
      files
    };
    updateFilePicker();
    await startStream(true);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}
async function selectFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  selectMode("file");
  snippetText.value = "";
  const total = files.reduce((sum, file) => sum + file.size, 0);
  await startSelection(`Preparing ${files.length === 1 ? files[0].name : `${files.length} files`}…`, async () => {
    const empty = files.find((file) => file.size === 0);
    if (empty) throw new Error(`${empty.name} is empty — there is nothing to send.`);
    if (total > MAX_FILE_BYTES) {
      throw new Error(`The selection is ${formatBytes(total)}, over the ${MAX_FILE_LABEL} limit.`);
    }
    if (files.length === 1) {
      const file = files[0];
      const bytes = new Uint8Array(await file.arrayBuffer());
      return { name: file.name, size: file.size, packed: await packFile(file.name, file.type, bytes), files: [{ name: file.name, size: file.size }] };
    }
    const entries = await Promise.all(files.map(async (file) => ({
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer())
    })));
    const archive = makeZip(entries);
    return {
      name: `${files.length}-files.zip`,
      size: total,
      // Our ZIP entries are stored, not deflated, so unlike an uploaded ZIP
      // the archive can still benefit substantially from container gzip.
      packed: await packFile(`${files.length}-files.zip`, "application/vnd.airgapper.files+zip", archive, true),
      files: files.map(({ name, size }) => ({ name, size }))
    };
  });
  updateFilePicker();
}
async function selectSnippet() {
  selectMode("snippet");
  await startSelection("preparing text snippet…", async () => {
    const packed = await packSnippet(snippetText.value);
    return { name: "Text snippet", size: packed.originalSize, packed, files: [{ name: "Text snippet", size: packed.originalSize }] };
  });
}
function restoreSendSettings() {
  var _a;
  try {
    const saved = JSON.parse((_a = localStorage.getItem(SEND_SETTINGS_KEY)) != null ? _a : "null");
    if (!saved) return;
    if (typeof saved.fps === "number" && Number.isInteger(saved.fps) && saved.fps >= 1 && saved.fps <= 480) {
      selectFps(saved.fps);
    }
    if (typeof saved.sizeLevel === "number" && Number.isInteger(saved.sizeLevel) && saved.sizeLevel >= 0 && saved.sizeLevel < FRAME_BYTES_OPTIONS.length) {
      cfgSize.value = String(saved.sizeLevel);
    }
    if (saved.scaling === "integer" || saved.scaling === "fit") cfgScaling.value = saved.scaling;
    if (saved.layout === "single" || saved.layout === "one-two" || saved.layout === "two-two" || saved.layout === "two-three" || saved.layout === "four-three" || saved.layout === "three-five" || saved.layout === "three-six") {
      cfgLayout.value = saved.layout;
    } else if (saved.layout === "five-three") {
      cfgLayout.value = "three-five";
      cfgOrientation.value = "landscape";
    }
    if (saved.orientation === "auto" || saved.orientation === "portrait" || saved.orientation === "landscape") {
      cfgOrientation.value = saved.orientation;
    }
  } catch {
  }
}
function saveSendSettings() {
  try {
    localStorage.setItem(SEND_SETTINGS_KEY, JSON.stringify({
      fps: selectedFps(),
      sizeLevel: Number(cfgSize.value),
      scaling: cfgScaling.value,
      layout: cfgLayout.value,
      orientation: selectedOrientation()
    }));
  } catch {
  }
}
async function main() {
  var _a;
  snippetText.maxLength = MAX_SNIPPET_BYTES;
  snippetLabel.textContent = `Text to send · up to ${MAX_SNIPPET_LABEL}`;
  cfgFile.addEventListener("change", () => {
    var _a2;
    return void selectFiles((_a2 = cfgFile.files) != null ? _a2 : []);
  });
  for (const eventName of ["dragenter", "dragover"]) {
    paneFile.addEventListener(eventName, (event) => {
      event.preventDefault();
      paneFile.classList.add("dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    paneFile.addEventListener(eventName, () => paneFile.classList.remove("dragging"));
  }
  paneFile.addEventListener("drop", (event) => {
    var _a2;
    event.preventDefault();
    if ((_a2 = event.dataTransfer) == null ? void 0 : _a2.files.length) void selectFiles(event.dataTransfer.files);
  });
  paneFile.addEventListener("click", (event) => {
    if (!paneFile.classList.contains("has-file")) return;
    event.preventDefault();
    const target = event.target instanceof Element ? event.target : null;
    if (target && (target.closest(".file-picker-button") || target === cfgFile)) stopTransfer();
  });
  sendSnippetBtn.addEventListener("click", () => void selectSnippet());
  applyMode();
  Array.from(FRAME_BYTES_OPTIONS.entries()).reverse().forEach(([level, bytes], index) => cfgSize.add(new Option(formatBytes(bytes), String(level), false, index === 0)));
  restoreSendSettings();
  let customFpsTimer;
  cfgFps.addEventListener("change", () => {
    clearTimeout(customFpsTimer);
    cfgFpsCustom.hidden = cfgFps.value !== "custom";
    speedControl.classList.toggle("has-custom", !cfgFpsCustom.hidden);
    if (!cfgFpsCustom.hidden) cfgFpsCustom.focus();
  });
  const resizeForViewport = () => resizeDisplay == null ? void 0 : resizeDisplay();
  window.addEventListener("resize", resizeForViewport);
  (_a = window.visualViewport) == null ? void 0 : _a.addEventListener("resize", resizeForViewport);
  for (const el of [cfgFps, cfgSize, cfgScaling, cfgLayout, cfgOrientation]) {
    el.addEventListener("change", () => {
      saveSendSettings();
      void startStream();
    });
  }
  cfgFpsCustom.addEventListener("input", () => {
    clearTimeout(customFpsTimer);
    if (!cfgFpsCustom.value) return;
    customFpsTimer = setTimeout(() => {
      saveSendSettings();
      void startStream();
    }, 100);
  });
  monitorDisplayRefreshRate();
}
function scrollStageIntoView() {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  requestAnimationFrame(() => {
    stage.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  });
}
async function startStream(revealStage = false) {
  var _a;
  const gen = ++generation;
  activeTransportEncoder == null ? void 0 : activeTransportEncoder.free();
  activeTransportEncoder = null;
  resizeDisplay = null;
  canvas.style.display = "";
  stageError.hidden = true;
  showStreamPanels(false);
  if (!selectedFile) {
    releaseScreenWakeLock();
    setStatus("");
    return;
  }
  await requestScreenWakeLock();
  const { name, size: fileSize, payload, compression, transmittedSize } = selectedFile;
  if (gen !== generation) return;
  const txFps = selectedFps();
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
  const gridMargin = gridCodes === 1 ? 4 : GRID_MARGIN;
  const blockLen = transport.blockLen;
  const payloadId = fnv1a(payload);
  if (transport.mode === "raptorq") {
    await prepareRaptorQ();
    if (gen !== generation) return;
  }
  const encoder = new TransportEncoder(payload, blockLen, payloadId, transport.mode);
  activeTransportEncoder = encoder;
  // FPS, layout, orientation and visual scaling do not change the erasure
  // code. Continue at the next symbol that was actually painted. A transport
  // Size change changes blockLen/K/mode, so its key differs and correctly
  // starts a fresh coding stream at ESI 0.
  const transportKey = `${payloadId}:${encoder.mode}:${encoder.k}:${blockLen}:${payload.length}`;
  let symbolOrdinal = activeTransportCursor?.key === transportKey ? activeTransportCursor.nextOrdinal : 0;
  activeTransportCursor = { key: transportKey, nextOrdinal: symbolOrdinal };
  const header = {
    mode: encoder.mode,
    layoutId: gridLayoutId(gridCols, gridRows),
    k: encoder.k,
    blockLen,
    totalLen: payload.length,
    payloadId
  };
  let version;
  let modules = 0;
  let scale = 1;
  const staging = document.createElement("canvas");
  const fitStaging = fitScaling ? document.createElement("canvas") : null;
  const fitFiltered = fitScaling ? document.createElement("canvas") : null;
  const queue = [];
  const cells = new Array(gridCodes).fill(null);
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
    ctx.globalCompositeOperation = "source-over";
  };
  stage.hidden = false;
  if (sendStart) sendStart.hidden = true;
  showStreamPanels(true);
  const sizeCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    const stride = modules + gridMargin;
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
    staging.width = totalW;
    staging.height = totalH;
    canvas.width = Math.max(1, Math.round(displayW * scale));
    canvas.height = Math.max(1, Math.round(displayH * scale));
    const cssNativeW = displayW * scale / dpr;
    const cssNativeH = displayH * scale / dpr;
    canvas.style.width = `${cssNativeW}px`;
    canvas.style.height = `${cssNativeH}px`;
    canvas.style.imageRendering = fitScaling ? "auto" : "pixelated";
    const stagingCtx = staging.getContext("2d");
    cells.forEach((img, i) => {
      if (img) stagingCtx.putImageData(img, i % gridCols * stride, Math.floor(i / gridCols) * stride);
    });
    if (fitStaging) {
      fitStaging.width = totalW * FIT_SUPERSAMPLE;
      fitStaging.height = totalH * FIT_SUPERSAMPLE;
      const fitCtx = fitStaging.getContext("2d");
      fitCtx.imageSmoothingEnabled = false;
      fitCtx.drawImage(staging, 0, 0, fitStaging.width, fitStaging.height);
      renderFitCanvas();
    } else {
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      if (landscape) {
        ctx.setTransform(0, canvas.height / totalW, -canvas.width / totalH, 0, canvas.width, 0);
      } else {
        ctx.setTransform(canvas.width / totalW, 0, 0, canvas.height / totalH, 0, 0);
      }
      ctx.drawImage(staging, 0, 0);
    }
  };
  const makeCode = () => {
    if (plainSnippet !== null) {
      return {
        qr: QRCode.create(plainSnippet, {
          errorCorrectionLevel: ecc,
          version,
          maskPattern: 4
        }),
        ordinal: null
      };
    }
    const ordinal = symbolOrdinal++;
    const slotIndex = ordinal % gridCodes;
    const seq = scheduledEsi(encoder.k, ordinal);
    const bytes = packFrame(
      { ...header, seq, slotIndex },
      encoder.encode(seq)
    );
    return {
      qr: QRCode.create([{ data: bytes, mode: "byte" }], {
        errorCorrectionLevel: ecc,
        version,
        maskPattern: 4
      }),
      ordinal
    };
  };
  const makeCell = () => {
    const { qr, ordinal } = makeCode();
    if (version === void 0) {
      version = qr.version;
      modules = qr.modules.size;
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
      if (false) {
        void fetch("/__diagnostics", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            role: "sender",
            when: (/* @__PURE__ */ new Date()).toISOString(),
            streamId: payloadId,
            payload: {
              name,
              fileBytes: fileSize,
              containerBytes: payload.length,
              transmittedBytes: transmittedSize,
              compression
            },
            settings: {
              txFps,
              frameBytes,
              ecc,
              gridCodes,
              layout: `${gridCols}×${gridRows}`,
              layoutMode,
              orientation: selectedOrientation(),
              landscape: landscapeGrid(),
              static: staticStream,
              sizeLevel,
              gridMargin,
              scaling: fitScaling ? "fit" : "integer"
            },
            qr: {
              version,
              modules,
              encodedBytes: transport.frameBytes,
              ceilingBytes: frameBytes,
              overheadPercent: Number((transport.overheadFraction * 100).toFixed(2))
            },
            transport: {
              mode: encoder.mode,
              k: encoder.k,
              blockLen,
              paddingBytes: transport.paddingBytes,
              paddingPercent: Number((transport.paddingFraction * 100).toFixed(3))
            },
            ua: navigator.userAgent
          })
        }).catch(() => void 0);
      }
    }
    const raster = rasterizeQr(qr.modules.size, qr.modules.data, gridMargin);
    return {
      image: new ImageData(new Uint8ClampedArray(raster.pixels.buffer), raster.size, raster.size),
      ordinal
    };
  };
  let generatorFailed = false;
  const lookahead = staticStream ? 1 : LOOKAHEAD * gridCodes;
  const pump = (max = lookahead) => {
    if (generatorFailed || gen !== generation) return;
    try {
      for (let n = 0; n < max && queue.length < lookahead; n++) queue.push(makeCell());
    } catch (err) {
      generatorFailed = true;
      showError(err instanceof Error ? err.message : String(err));
    }
  };
  let cellCursor = activeTransportCursor?.key === transportKey ? activeTransportCursor.nextOrdinal % gridCodes : 0;
  const sweepOrigin = cellCursor;
  pump();
  const paintCell = (entry) => {
    const img = entry.image;
    const cell = modules + 2 * gridMargin;
    const stride = modules + gridMargin;
    const cx = cellCursor % gridCols * stride;
    const cy = Math.floor(cellCursor / gridCols) * stride;
    cells[cellCursor] = img;
    staging.getContext("2d").putImageData(img, cx, cy);
    if (fitStaging) {
      const fitCtx = fitStaging.getContext("2d");
      fitCtx.imageSmoothingEnabled = false;
      fitCtx.drawImage(
        staging,
        cx, cy, cell, cell,
        cx * FIT_SUPERSAMPLE, cy * FIT_SUPERSAMPLE,
        cell * FIT_SUPERSAMPLE, cell * FIT_SUPERSAMPLE
      );
    }
    if (fitStaging) {
      renderFitCanvas();
    } else {
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      const totalW = staging.width;
      const totalH = staging.height;
      if (landscapeGrid()) {
        ctx.setTransform(0, canvas.height / totalW, -canvas.width / totalH, 0, canvas.width, 0);
      } else {
        ctx.setTransform(canvas.width / totalW, 0, 0, canvas.height / totalH, 0, 0);
      }
      ctx.drawImage(staging, cx, cy, cell, cell, cx, cy, cell, cell);
    }
    if (entry.ordinal !== null && activeTransportCursor?.key === transportKey) {
      activeTransportCursor.nextOrdinal = Math.max(activeTransportCursor.nextOrdinal, entry.ordinal + 1);
    }
    cellCursor = (cellCursor + 1) % gridCodes;
  };
  for (let i = 0; i < gridCodes; i++) {
    const img = queue.shift();
    if (img) paintCell(img);
  }
  if (staticStream) return;
  const interval = 1e3 / txFps;
  const subInterval = interval / gridCodes;
  let nextAt = performance.now() + interval;
  let lastTickAt = performance.now();
  let completedSweeps = 0;
  const tick = (now) => {
    if (gen !== generation || generatorFailed) return;
    requestAnimationFrame(tick);
    const sinceLastTick = now - lastTickAt;
    lastTickAt = now;
    if (sinceLastTick > 1e3) {
      if (false) {
        void fetch("/__diagnostics", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            role: "sender",
            event: "stall",
            when: (/* @__PURE__ */ new Date()).toISOString(),
            streamId: payloadId,
            stallSeconds: Number((sinceLastTick / 1e3).toFixed(1))
          })
        }).catch(() => void 0);
      }
    }
    if (now < nextAt) return;
    if (now - nextAt > interval) nextAt = now;
    while (now >= nextAt) {
      const img = queue.shift();
      pump(1);
      if (!img) {
        nextAt = now + subInterval;
        break;
      }
      paintCell(img);
      nextAt += subInterval;
      if (cellCursor === sweepOrigin) {
        completedSweeps++;
        if (txFps === 30 && completedSweeps % 15 === 0) nextAt += interval / 2;
      }
    }
  };
  requestAnimationFrame(tick);
}
window.addEventListener("airgapper:leave-mode", () => {
  var _a;
  if (!((_a = document.getElementById("sendView")) == null ? void 0 : _a.classList.contains("active"))) return;
  stopTransfer();
});
window.addEventListener("pagehide", stopTransfer);
window.addEventListener("airgapper:pause-mode", () => {
  var _a;
  if (!((_a = document.getElementById("sendView")) == null ? void 0 : _a.classList.contains("active"))) return;
  releaseScreenWakeLock();
});
window.addEventListener("airgapper:resume-mode", () => {
  var _a;
  if (!((_a = document.getElementById("sendView")) == null ? void 0 : _a.classList.contains("active")) || !selectedFile) return;
  void requestScreenWakeLock();
});
void main();
