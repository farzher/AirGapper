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
// Sender FPS is always the user's requested presentation rate. Auto Grid may
// choose QR count/size, but never silently changes the requested FPS.
const AUTO_GRID_FRAGMENTATION_BONUS = 0.18;
const AUTO_GRID_MAX_CODES = 128;
// This is intentionally relaxed for the >32-slot experiment. At 360 Hz and
// 30 sender fps it permits roughly 96 independently changing QR slots.
const AUTO_GRID_MAX_CHANGES_PER_REFRESH = 8;
const AUTO_GRID_LAYOUTS = (() => {
  const layouts = [];
  for (let cols = 1; cols <= 32; cols++) {
    for (let rows = cols; rows <= 32; rows++) {
      const codes = cols * rows;
      if (codes < 1 || codes > AUTO_GRID_MAX_CODES) continue;
      layouts.push({ id: cols * 64 + rows, cols, rows });
    }
  }
  return layouts;
})();
let measuredDisplayHz = 60;
let autoGridRefreshTimer;
const SEND_RUNTIME_BUILD = "v0.5.344";
function selectedLayout() {
  const mode = cfgLayout.value;
  return mode === "auto" || mode === "auto-1" || mode === "auto-2" || mode === "auto-3" || mode === "auto-4" || mode === "single" || mode === "one-two" || mode === "two-two" || mode === "two-three" || mode === "three-five" || mode === "three-six" || mode === "four-six" || mode === "four-seven" || mode === "four-eight" ? mode : "four-three";
}
function isAutoLayout(mode = selectedLayout()) {
  return mode === "auto" || mode === "auto-1" || mode === "auto-2" || mode === "auto-3" || mode === "auto-4";
}
function autoGridTargetModulePx(mode = selectedLayout()) {
  if (mode === "auto") return 2;
  const match = /^auto-([1-4])$/.exec(mode);
  return match ? Number(match[1]) : 0;
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
    case "four-six":
      return { cols: 4, rows: 6, codes: 24 };
    case "four-seven":
      return { cols: 4, rows: 7, codes: 28 };
    case "four-eight":
      return { cols: 4, rows: 8, codes: 32 };
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
const sendSettingsToggle = document.getElementById("send-settings-toggle");
const sendSettingsPanel = document.getElementById("send-settings-panel");
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
function setSenderSettingsOpen(open) {
  if (!sendSettingsPanel || !sendSettingsToggle) return;
  sendSettingsPanel.hidden = !open;
  sendSettingsToggle.setAttribute("aria-expanded", open ? "true" : "false");
}
function showStreamPanels(visible) {
  sendControls.hidden = !visible;
  if (!visible) setSenderSettingsOpen(false);
}
sendSettingsToggle?.addEventListener("click", () => {
  setSenderSettingsOpen(sendSettingsPanel?.hidden !== false);
});
document.addEventListener("pointerdown", (event) => {
  if (sendSettingsPanel?.hidden === false && sendControls && !sendControls.contains(event.target)) {
    setSenderSettingsOpen(false);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setSenderSettingsOpen(false);
});
const cfgFps = document.getElementById("cfg-fps");
const cfgFpsCustom = document.getElementById("cfg-fps-custom");
const speedControl = cfgFps.closest(".speed-control");
const cfgSize = document.getElementById("cfg-size");
const cfgScaling = document.getElementById("cfg-scaling");
const cfgLayout = document.getElementById("cfg-layout");
const cfgUpdatePattern = document.getElementById("cfg-update-pattern");
const cfgOrientation = document.getElementById("cfg-orientation");
function selectedFps() {
  const value = cfgFps.value === "custom" ? Number(cfgFpsCustom.value) : Number(cfgFps.value);
  return Number.isFinite(value) ? Math.max(1, Math.min(480, Math.round(value))) : 30;
}
function selectedUpdatePattern() {
  const value = cfgUpdatePattern?.value;
  return value === "synchronous" || value === "fixed" || value === "fixed-columns" || value === "dispersed" ? value : "dispersed";
}
function selectFps(fps) {
  var _a;
  const preset = Array.from(cfgFps.options).find((option) => Number(option.value) === fps);
  cfgFps.value = (_a = preset == null ? void 0 : preset.value) != null ? _a : "custom";
  cfgFpsCustom.value = String(fps);
  cfgFpsCustom.hidden = cfgFps.value !== "custom";
  speedControl.classList.toggle("has-custom", !cfgFpsCustom.hidden);
}
function updateAutoGridControlState() {
  const automatic = isAutoLayout();
  // Size remains a real user control in Auto. It is the preferred QR payload
  // ceiling; Auto only steps down when that size cannot preserve the requested
  // module density in the current viewport.
  cfgSize.disabled = false;
  cfgSize.title = automatic
    ? `Auto ${autoGridTargetModulePx()}px uses this Size when it fits and steps down only when needed`
    : "";
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
function gridRasterExtent(modules, cols, rows, margin = GRID_MARGIN) {
  // Each QR raster owns a margin on both sides, while adjacent cells overlap
  // one margin to create exactly one shared gap. This is the same extent used
  // by both Auto selection and the renderer so the gap can never be double-counted.
  return {
    width: modules * cols + margin * (cols + 1),
    height: modules * rows + margin * (rows + 1)
  };
}
function senderDisplayBudgetCss() {
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
}
function chooseAutoGrid(
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
    if (!fitsInOneStream(payloadBytes, maximumFrameBytes, true)) continue;
    const plan = selectTransportPlan(payloadBytes, maximumFrameBytes, true);
    if (plan.mode === "direct") continue;
    for (const layout of AUTO_GRID_LAYOUTS) {
      const codes = layout.cols * layout.rows;
      if (codes < 1 || codes > AUTO_GRID_MAX_CODES) continue;
      const margin = GRID_MARGIN;
      const extent = gridRasterExtent(plan.qrModules, layout.cols, layout.rows, margin);
      const totalW = extent.width;
      const totalH = extent.height;
      const displayW = landscape ? totalH : totalW;
      const displayH = landscape ? totalW : totalH;
      const availableScale = Math.min(budgetW / displayW, budgetH / displayH);
      const moduleScale = fitScaling ? availableScale : Math.floor(availableScale);
      if (!(moduleScale > 0)) continue;
      const displayModulePx = moduleScale / dpr;
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
        displayModulePx,
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
  const densityCandidates = candidates.filter((candidate) => candidate.displayModulePx + 1e-9 >= densityTarget);
  if (!densityCandidates.length) {
    throw new Error(
      `Auto ${densityTarget}px cannot fit ${formatBytes(requestedMaximumFrameBytes)} or any smaller Size at ${densityTarget} on-screen px/module in this viewport.`
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
    const fragmentation = Math.max(0, Math.min(1, (candidate.codes - 8) / (AUTO_GRID_MAX_CODES - 8)));
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
      const previousMeasuredHz = measuredDisplayHz;
      measuredDisplayHz = Math.max(30, refreshRate);
      if (selectedFile && isAutoLayout() && Math.abs(previousMeasuredHz - measuredDisplayHz) >= 1) {
        clearTimeout(autoGridRefreshTimer);
        autoGridRefreshTimer = setTimeout(() => void startStream(), 120);
      }
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
            if (!applyLiveSenderFps()) void startStream();
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
let activeSendRendererCleanup = null;
let activeSendFpsSetter = null;
let activeSendClockRebase = null;
function stopSendRenderer() {
  const cleanup = activeSendRendererCleanup;
  activeSendRendererCleanup = null;
  activeSendFpsSetter = null;
  activeSendClockRebase = null;
  cleanup?.();
}
function applyLiveSenderFps() {
  if (isAutoLayout()) return false;
  if (!activeSendFpsSetter) return false;
  activeSendFpsSetter(selectedFps());
  return true;
}
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
  stopSendRenderer();
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
function settleFullscreenSenderGeometry() {
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
}
canvas.addEventListener("click", () => {
  var _a, _b;
  const entering = !document.body.classList.contains("qr-full");
  setStageFullscreen(entering);
  if (entering) void ((_b = (_a = document.documentElement).requestFullscreen) == null ? void 0 : _b.call(_a).catch(() => void 0));
});
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) {
    setStageFullscreen(false);
    return;
  }
  if (document.body.classList.contains("qr-full")) settleFullscreenSenderGeometry();
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
    if (saved.updatePattern === "synchronous" || saved.updatePattern === "fixed" || saved.updatePattern === "fixed-columns" || saved.updatePattern === "dispersed") cfgUpdatePattern.value = saved.updatePattern;
    if (saved.layout === "auto") {
      // v0.5.307 Auto used a 2 px/module floor. Preserve that behavior when
      // migrating saved settings into the explicit Auto density family.
      cfgLayout.value = "auto-2";
    } else if (saved.layout === "auto-1" || saved.layout === "auto-2" || saved.layout === "auto-3" || saved.layout === "auto-4" || saved.layout === "single" || saved.layout === "one-two" || saved.layout === "two-two" || saved.layout === "two-three" || saved.layout === "four-three" || saved.layout === "three-five" || saved.layout === "three-six" || saved.layout === "four-six" || saved.layout === "four-seven" || saved.layout === "four-eight") {
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
      updatePattern: selectedUpdatePattern(),
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
  updateAutoGridControlState();
  let customFpsTimer;
  cfgFps.addEventListener("change", () => {
    clearTimeout(customFpsTimer);
    cfgFpsCustom.hidden = cfgFps.value !== "custom";
    speedControl.classList.toggle("has-custom", !cfgFpsCustom.hidden);
    if (!cfgFpsCustom.hidden) cfgFpsCustom.focus();
    saveSendSettings();
    if (selectedFile && !applyLiveSenderFps()) void startStream();
  });
  const resizeForViewport = () => {
    resizeDisplay == null ? void 0 : resizeDisplay();
    if (selectedFile && isAutoLayout()) {
      clearTimeout(autoGridRefreshTimer);
      autoGridRefreshTimer = setTimeout(() => void startStream(), 140);
    }
  };
  window.addEventListener("resize", resizeForViewport);
  (_a = window.visualViewport) == null ? void 0 : _a.addEventListener("resize", resizeForViewport);
  // FPS is a live scheduler parameter. Size/layout/scaling/orientation still
  // rebuild geometry/transport as needed, but a speed change must never blank
  // the already-visible QR wall or cold-start the render workers.
  for (const el of [cfgSize, cfgScaling, cfgLayout, cfgUpdatePattern, cfgOrientation]) {
    el.addEventListener("change", () => {
      if (el === cfgLayout) updateAutoGridControlState();
      saveSendSettings();
      void startStream();
    });
  }
  cfgFpsCustom.addEventListener("input", () => {
    clearTimeout(customFpsTimer);
    if (!cfgFpsCustom.value) return;
    customFpsTimer = setTimeout(() => {
      saveSendSettings();
      if (selectedFile && !applyLiveSenderFps()) void startStream();
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
  stopSendRenderer();
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
  const manualFrameBytes = (_a = FRAME_BYTES_OPTIONS[Math.min(sizeLevel, FRAME_BYTES_OPTIONS.length - 1)]) != null ? _a : FRAME_BYTES_OPTIONS[0];
  const ecc = "L";
  const configuredLayout = selectedLayout();
  const autoMode = isAutoLayout(configuredLayout);
  // Size is meaningful in both manual and Auto layouts. Auto may step down
  // from this value to preserve its module-density target, but never above it.
  const maximumFrameBytes = manualFrameBytes;
  if (!fitsInOneStream(payload.length, manualFrameBytes, autoMode)) {
    const suggestion = smallestSufficientFrameSize(payload.length, FRAME_BYTES_OPTIONS, autoMode);
    showSettingsError(
      `${formatBytes(payload.length)} needs ${sourceBlockCount(payload.length, manualFrameBytes, autoMode).toLocaleString()} blocks. ` + (suggestion ? `Choose ${formatBytes(suggestion)} or more in Size.` : "No available Size setting can carry this transfer.")
    );
    return;
  }
  const snippetValue = currentMode() === "snippet" ? snippetText.value : null;
  const plainSnippet = snippetValue !== null && new TextEncoder().encode(snippetValue).length <= maximumFrameBytes ? snippetValue : null;
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
  if (autoMode && plainSnippet === null) {
    const directProbe = selectTransportPlan(payload.length, maximumFrameBytes, true);
    if (directProbe.mode === "direct") {
      frameBytes = maximumFrameBytes;
      transport = directProbe;
    } else {
      autoGrid = chooseAutoGrid(
        payload.length,
        txFps,
        fitScaling,
        autoGridTargetModulePx(configuredLayout),
        maximumFrameBytes
      );
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
  const updatePattern = selectedUpdatePattern();
  const synchronousUpdates = updatePattern === "synchronous";
  const temporalOrder = spatiallyDispersedOrder(gridCols, gridRows);
  const phaseStep = temporalPhaseStep(gridCodes);
  const temporalSourceOffset = (pageId, phase) => {
    if (gridCodes <= 1 || updatePattern === "fixed" || updatePattern === "synchronous") return phase;
    if (updatePattern === "fixed-columns") {
      // Transpose the existing row-major fixed schedule without changing packet
      // assignment, page cadence, or aggregate rate: top-to-bottom through one
      // logical column, then advance to the next column.
      const row = phase % gridRows;
      const col = Math.floor(phase / gridRows);
      return row * gridCols + col;
    }
    const rotation = pageId * phaseStep % gridCodes;
    let index = (phase + rotation) % gridCodes;
    if (pageId & 1) index = gridCodes - 1 - index;
    return temporalOrder[index];
  };
  const updatePatternLabel = updatePattern === "synchronous" ? "synchronous wall" : updatePattern === "fixed" ? "fixed rows" : updatePattern === "fixed-columns" ? "fixed columns" : "dispersed rotating phases";
  const describeGrid = () => {
    if (staticStream) return "";
    if (!autoGrid) return `Update ${updatePatternLabel}`;
    const fallback = autoGrid.constrained ? "" : " · refresh fallback";
    const sizeFallback = autoGrid.sizeFallback
      ? ` · Size ${formatBytes(autoGrid.requestedMaximumFrameBytes)}→${formatBytes(autoGrid.maximumFrameBytes)}`
      : "";
    return `Auto ${autoGrid.targetModulePx}px · ${gridCols}×${gridRows} · ${gridCodes} QR · v${transport.qrVersion} · ${formatBytes(transport.frameBytes)}/QR · ${autoGrid.displayModulePx.toFixed(2)} on-screen px/module · ${Math.round(autoGrid.screenFill * 100)}% screen · ${txFps} fps · ${Math.round(autoGrid.refreshHz)} Hz display · ${autoGrid.changesPerRefresh.toFixed(2)} QR changes/refresh · ${updatePatternLabel}${sizeFallback}${fallback}`;
  };
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
  const extendedGrid = Boolean(autoGrid && gridCodes > 1);
  const header = {
    mode: encoder.mode,
    layoutId: extendedGrid ? 0 : gridLayoutId(gridCols, gridRows),
    extendedGrid,
    gridCols,
    gridRows,
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
    const extent = gridRasterExtent(modules, gridCols, gridRows, gridMargin);
    const totalW = extent.width;
    const totalH = extent.height;
    const landscape = landscapeGrid();
    const displayW = landscape ? totalH : totalW;
    const displayH = landscape ? totalW : totalH;
    const budget = senderDisplayBudgetCss();
    const budgetW = budget.width;
    const budgetH = budget.height;
    const availableScale = Math.min(budgetW * dpr / displayW, budgetH * dpr / displayH);
    if (fitScaling) {
      scale = Math.max(Number.EPSILON, availableScale);
    } else if (autoMode) {
      // Pixel Perfect Auto may change layout/QR version, but it may NEVER
      // resample modules or the one-source-pixel shared gap fractionally.
      scale = Math.max(1, Math.floor(availableScale));
    } else {
      scale = availableScale < 1 ? Math.max(Number.EPSILON, availableScale) : Math.floor(availableScale);
    }
    if (staging.width !== totalW || staging.height !== totalH) {
      staging.width = totalW;
      staging.height = totalH;
    }
    const canvasW = Math.max(1, Math.round(displayW * scale));
    const canvasH = Math.max(1, Math.round(displayH * scale));
    if (canvas.width !== canvasW || canvas.height !== canvasH) {
      canvas.width = canvasW;
      canvas.height = canvasH;
    }
    const cssNativeW = displayW * scale / dpr;
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
    cells.forEach((img, i) => {
      if (img) stagingCtx.putImageData(img, i % gridCols * stride, Math.floor(i / gridCols) * stride);
    });
    if (fitStaging) {
      const fitW = totalW * FIT_SUPERSAMPLE;
      const fitH = totalH * FIT_SUPERSAMPLE;
      if (fitStaging.width !== fitW || fitStaging.height !== fitH) {
        fitStaging.width = fitW;
        fitStaging.height = fitH;
      }
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
  // Animated walls generate a complete QR page off the UI thread. At 4:7/30
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
    const ensurePageSource = (page, totalW, totalH) => {
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
      stagingCtx.globalCompositeOperation = "source-over";
      stagingCtx.imageSmoothingEnabled = false;
      stagingCtx.drawImage(source, ox, oy, modules, modules, ox, oy, modules, modules);
      stagingCtx.globalCompositeOperation = "source-over";

      const landscape = landscapeGrid();
      const targetW = landscape ? canvas.height : canvas.width;
      const targetH = landscape ? canvas.width : canvas.height;
      const ctx = canvas.getContext("2d");
      ctx.globalCompositeOperation = "source-over";
      if (landscape)
        ctx.setTransform(0, 1, -1, 0, canvas.width, 0);
      else
        ctx.setTransform(1, 0, 0, 1, 0, 0);

      if (fitStaging) {
        const fitCtx = fitStaging.getContext("2d");
        fitCtx.setTransform(1, 0, 0, 1, 0, 0);
        fitCtx.globalCompositeOperation = "source-over";
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

      // The durable cursor advances only when this entire page completes;
      // phase-hopped presentation is intentionally not ordinal order.
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

    let pageInterval = 1e3 / txFps;
    let cellInterval = synchronousUpdates ? pageInterval : pageInterval / gridCodes;
    let nextCellAt = 0;
    activeSendFpsSetter = (fps) => {
      pageInterval = 1e3 / Math.max(1, fps);
      cellInterval = synchronousUpdates ? pageInterval : pageInterval / gridCodes;
      // Speed changes are live: keep the current sweep and warm workers. If the
      // new rate is faster, pull the next phase forward; never blank/restart.
      if (nextCellAt)
        nextCellAt = Math.min(nextCellAt, performance.now() + cellInterval);
    };
    activeSendClockRebase = () => {
      // Background tabs suspend rAF. Resume from the next real presentation
      // opportunity; time spent hidden is not sender debt to be repaid.
      nextCellAt = 0;
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

      // visibilitychange explicitly rebases this clock on tab restore. Also
      // fence genuinely large scheduler stalls, but do not confuse an FPS above
      // the display refresh rate with suspension: ordinary rAF lateness may
      // still catch up exactly as before.
      if (!nextCellAt || now - nextCellAt > 250)
        nextCellAt = now + cellInterval;

      if (synchronousUpdates) {
        if (now + 0.25 < nextCellAt) return;
        try {
          // Commit one already-rendered wall in one compositor-facing paint.
          // The physical display scanout may still create one rolling-shutter
          // transition stripe, but JS never creates many independent QR seams.
          drawPage(currentPage);
        } catch (error) {
          closePage(currentPage);
          currentPage = null;
          fail(error);
          return;
        }
        closePage(currentPage);
        currentPage = null;
        currentCellOffset = 0;
        nextPresentPageId++;
        scheduleDispatch();
        nextCellAt += pageInterval;
        // Never repay missed wall frames as a burst of whole-screen changes.
        if (now - nextCellAt > pageInterval) nextCellAt = now + pageInterval;
        return;
      }

      let painted = 0;
      while (currentPage && now + 0.25 >= nextCellAt && painted < gridCodes) {
        try {
          drawPageCell(currentPage, temporalSourceOffset(currentPage.pageId, currentCellOffset));
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

        if (activeTransportCursor?.key === transportKey)
          activeTransportCursor.nextOrdinal = Math.max(activeTransportCursor.nextOrdinal, currentPage.endOrdinal);
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
  }

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
    if (entry.ordinal !== null && activeTransportCursor?.key === transportKey)
      activeTransportCursor.nextOrdinal = Math.max(activeTransportCursor.nextOrdinal, entry.ordinal + 1);
    cellCursor = (cellCursor + 1) % gridCodes;
  };
  const presentPage = () => {
    if (fitStaging) {
      renderFitCanvas();
      return;
    }
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    const totalW = staging.width;
    const totalH = staging.height;
    if (landscapeGrid())
      ctx.setTransform(0, canvas.height / totalW, -canvas.width / totalH, 0, canvas.width, 0);
    else
      ctx.setTransform(canvas.width / totalW, 0, 0, canvas.height / totalH, 0, 0);
    // One compositor-facing draw per sender page. The old scheduler redrew
    // the whole Fit wall once per QR cell (28x/page in 4:7), burning the main
    // thread on resampling instead of generating new QR pages.
    ctx.drawImage(staging, 0, 0);
  };
  const paintPage = () => {
    if (queue.length < gridCodes) return false;
    for (let i = 0; i < gridCodes; ++i) paintCell(queue.shift());
    presentPage();
    return true;
  };
  paintPage();
  if (staticStream) {
    activeSendFpsSetter = () => {};
    return;
  }
  let interval = 1e3 / txFps;
  let nextAt = performance.now() + interval;
  activeSendFpsSetter = (fps) => {
    interval = 1e3 / Math.max(1, fps);
    nextAt = Math.min(nextAt, performance.now() + interval);
  };
  activeSendClockRebase = () => { nextAt = 0; };
  const tick = (now) => {
    if (gen !== generation || generatorFailed) return;
    requestAnimationFrame(tick);
    if (!nextAt || now - nextAt > 250) nextAt = now + interval;
    if (now < nextAt) return;
    if (now - nextAt > interval) nextAt = now;
    if (!paintPage()) {
      // QR generation, not rendering, is the limiting stage. Refill as much as
      // possible now and present on the next animation callback rather than
      // partially updating the visible wall.
      pump(gridCodes);
      nextAt = now;
      return;
    }
    pump(gridCodes);
    nextAt += interval;
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
  activeSendClockRebase?.();
  void requestScreenWakeLock();
});
void main();
