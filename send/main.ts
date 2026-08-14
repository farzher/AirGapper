// Sender: turn a file into an endless fountain-coded QR stream.
//
// Tuning notes from the experiments this PoC is distilled from:
// - Frame payload sets the QR version; denser wins on goodput as long as the
//   receiver can still decode it. 1465 bytes ≈ V27 is a safe middle ground
//   for arbitrary monitors; 2953 (V40) is the ceiling and works phone-to-
//   phone at close range.
// - The mask pattern is pinned (any declared mask is valid to a decoder);
//   this skips the spec's 8-way mask evaluation and speeds generation ~4×.
// - Displays need each frame shown for ≥2 refresh cycles or captures catch
//   the transition; 24 fps on a 60 Hz screen is comfortable.
// - Error correction stays at L by default: the fountain layer already
//   handles erasures, and a frame is either decoded whole or discarded.

import QRCode from "qrcode";
import { rasterizeQr } from "../shared/qr-raster";
import { formatBytes } from "../shared/format";
import {
  fitsInOneStream,
  selectTransportPlan,
  smallestSufficientFrameSize,
  sourceBlockCount,
} from "../shared/frame-capacity";
import { scheduledEsi, TransportEncoder } from "../shared/fountain";
import { MAX_SNIPPET_BYTES, MAX_SNIPPET_LABEL, packSnippet } from "../shared/snippet";
import {
  MAX_FILE_BYTES,
  MAX_FILE_LABEL,
  fnv1a,
  packFile,
  packFrame,
  type FrameHeader,
  type PackedOpticalFile,
} from "../shared/protocol";
import { statusLine } from "../shared/status-line";
import { releaseScreenWakeLock, requestScreenWakeLock } from "../shared/wake-lock";
import { makeZip } from "../shared/zip";
import { FRAME_BYTES_OPTIONS } from "../shared/send-settings";
import { GRID_MARGIN_MODULES, gridLayoutId } from "../shared/grid-layout";

const HEADER_MARGIN = 0;
const GRID_MARGIN = GRID_MARGIN_MODULES;
const LOOKAHEAD = 3;
// The desktop default carries twelve independent standard QRs. Phones default
// to one large code; neither choice changes the wire format.
const DEFAULT_GRID_CODES = 12;
const SEND_SETTINGS_KEY = "airgapper:send-settings:v1";

type LayoutMode = "single" | "one-two" | "two-two" | "two-three" | "four-three" | "three-five";
type GridOrientation = "auto" | "portrait" | "landscape";

function selectedLayout(): LayoutMode {
  const mode = cfgLayout.value;
  return mode === "single" || mode === "one-two" || mode === "two-two" || mode === "two-three" ||
    mode === "three-five" ? mode : "four-three";
}

function selectedOrientation(): GridOrientation {
  const orientation = cfgOrientation.value;
  return orientation === "portrait" || orientation === "landscape" ? orientation : "auto";
}

function landscapeGrid(): boolean {
  const orientation = selectedOrientation();
  return orientation === "landscape" || (orientation === "auto" && window.innerWidth > window.innerHeight);
}

function layoutGrid(mode = selectedLayout()): { cols: number; rows: number; codes: number } {
  switch (mode) {
    case "single": return { cols: 1, rows: 1, codes: 1 };
    case "one-two": return { cols: 1, rows: 2, codes: 2 };
    case "two-two": return { cols: 2, rows: 2, codes: 4 };
    case "two-three": return { cols: 2, rows: 3, codes: 6 };
    case "three-five": return { cols: 3, rows: 5, codes: 15 };
    default: return { cols: 3, rows: 4, codes: DEFAULT_GRID_CODES };
  }
}

const canvas = document.getElementById("qr") as HTMLCanvasElement;
const stage = document.getElementById("stage") as HTMLDivElement;
const stageError = document.getElementById("stage-error")!;
const sendStart = document.querySelector<HTMLElement>(".send-start");
const specs = document.getElementById("specs")!;
const cfgFile = document.getElementById("cfg-file") as HTMLInputElement;
const filePickerLabel = document.getElementById("file-picker-label")!;
const filePickerButton = document.getElementById("file-picker-button")!;
const selectionSummary = document.getElementById("selection-summary")!;
const sendControls = document.getElementById("send-controls")!;
const stageBottom = document.getElementById("stage-bottom")!;
const snippetText = document.getElementById("snippet-text") as HTMLTextAreaElement;
const snippetLabel = document.getElementById("snippet-label")!;
const sendSnippetBtn = document.getElementById("send-snippet") as HTMLButtonElement;
const paneFile = document.getElementById("pane-file")!;
const paneSnippet = document.getElementById("pane-snippet")!;
const receiverLinkQr = document.getElementById("receiver-link-qr") as HTMLCanvasElement;
const receiverLinkQrLarge = document.getElementById("receiver-link-qr-large") as HTMLCanvasElement;

/** A quiet, static handoff code lets a phone join as the receiver before the
 * transfer starts. It deliberately points to HTTPS even in the standalone
 * file, because mobile browsers generally deny camera access from file://. */
function renderReceiverLink(): void {
  const receiverUrl = receiverLinkQr.dataset.receiverUrl;
  if (!receiverUrl) return;
  const qr = QRCode.create(receiverUrl, { errorCorrectionLevel: "L" });
  const render = (target: HTMLCanvasElement, targetCssSize: number, margin: number, moduleCssScale?: number): number => {
    const raster = rasterizeQr(qr.modules.size, qr.modules.data, margin);
    const dpr = window.devicePixelRatio || 1;
    const scale = moduleCssScale === undefined
      ? Math.max(1, Math.round((targetCssSize * dpr) / raster.size))
      : moduleCssScale;
    const source = document.createElement("canvas");
    source.width = source.height = raster.size;
    source.getContext("2d")!.putImageData(
      new ImageData(new Uint8ClampedArray(raster.pixels.buffer), raster.size, raster.size),
      0,
      0,
    );
    target.width = target.height = raster.size * scale;
    const cssSize = moduleCssScale === undefined ? target.width / dpr : raster.size * moduleCssScale;
    target.style.width = target.style.height = `${cssSize}px`;
    target.style.imageRendering = "pixelated";
    const ctx = target.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source, 0, 0, target.width, target.height);
    return cssSize;
  };
  const headerSize = render(receiverLinkQr, 48, HEADER_MARGIN, 1);
  const headerButton = receiverLinkQr.parentElement as HTMLButtonElement;
  headerButton.style.width = headerButton.style.height = `${headerSize}px`;
  render(receiverLinkQrLarge, 240, 4);
}
renderReceiverLink();

function showStreamPanels(visible: boolean): void {
  sendControls.hidden = !visible;
}

const cfgFps = document.getElementById("cfg-fps") as HTMLSelectElement;
const cfgFpsCustom = document.getElementById("cfg-fps-custom") as HTMLInputElement;
const speedControl = cfgFps.closest(".speed-control")!;
const cfgSize = document.getElementById("cfg-size") as HTMLSelectElement;
const cfgScaling = document.getElementById("cfg-scaling") as HTMLSelectElement;
const cfgLayout = document.getElementById("cfg-layout") as HTMLSelectElement;
const cfgOrientation = document.getElementById("cfg-orientation") as HTMLSelectElement;

function selectedFps(): number {
  const value = cfgFps.value === "custom" ? Number(cfgFpsCustom.value) : Number(cfgFps.value);
  return Number.isFinite(value) ? Math.max(1, Math.min(480, Math.round(value))) : 15;
}

function selectFps(fps: number): void {
  const preset = Array.from(cfgFps.options).find((option) => Number(option.value) === fps);
  cfgFps.value = preset?.value ?? "custom";
  cfgFpsCustom.value = String(fps);
  cfgFpsCustom.hidden = cfgFps.value !== "custom";
  speedControl.classList.toggle("has-custom", !cfgFpsCustom.hidden);
}

function monitorDisplayRefreshRate(): void {
  const intervals: number[] = [];
  let previous = 0;
  const monitorStarted = performance.now();
  let windowStarted = monitorStarted;
  let displayOption: HTMLOptionElement | null = null;
  const sample = (now: number) => {
    if (previous) {
      const interval = now - previous;
      if (interval > 1 && interval < 40) intervals.push(interval);
    }
    previous = now;
    if (now - windowStarted >= 750 && intervals.length) {
      const sorted = intervals.slice().sort((a, b) => a - b);
      const measuredRate = 1000 / sorted[Math.floor(sorted.length / 2)]!;
      const commonRates = [75, 90, 100, 120, 144, 165, 180, 200, 240, 280, 300, 360, 480];
      const nearestCommon = commonRates.reduce((nearest, rate) => Math.abs(rate - measuredRate) < Math.abs(nearest - measuredRate) ? rate : nearest);
      const refreshRate = Math.abs(nearestCommon - measuredRate) / nearestCommon <= 0.03 ? nearestCommon : Math.round(measuredRate);
      if (refreshRate > 60) {
        const previousValue = displayOption?.value;
        const wasSelected = cfgFps.value === previousValue;
        if (!displayOption) {
          displayOption = new Option();
          cfgFps.insertBefore(displayOption, cfgFps.options[cfgFps.options.length - 1] ?? null);
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
    if (now - monitorStarted < 5000) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}

let selectedFile: {
  name: string;
  size: number;
  payload: Uint8Array;
  compression: "none" | "gzip";
  transmittedSize: number;
  files: { name: string; size: number }[];
} | null = null;
let generation = 0; // bumped on every restart; stale loops see it and die
let resizeDisplay: (() => void) | null = null;

const specsLine = statusLine(specs);
const setStatus = specsLine.setStatus;

/**
 * Errors also hide the stage — a stale QR stream pulsing away under a
 * rejection message reads as "still working".
 *
 * Callers decide whether the pick survives. A file rejected on size is gone;
 * a stream that can't start at the current bytes/frame is not, because turning
 * that setting back up is the fix.
 */
function showError(message: string): void {
  releaseScreenWakeLock();
  setStageFullscreen(false);
  stage.hidden = true;
  stageError.hidden = true;
  if (sendStart) sendStart.hidden = false;
  showStreamPanels(false);
  specsLine.showError(message);
}

/** A valid selection with incompatible stream settings stays editable. Hide
 * only the stale QR, not the controls needed to fix the configuration. */
function showSettingsError(message: string): void {
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

let selectedMode: "file" | "snippet" = "file";
function currentMode(): "file" | "snippet" {
  return selectedMode;
}

function selectMode(mode: "file" | "snippet"): void {
  selectedMode = mode;
}

/** The picker reads as state — which file is armed — and the button offers
 *  the next action: pick when idle, stop when streaming. A rejected pick
 *  keeps the idle wording: the status line already names what went wrong,
 *  and nothing is streaming. */
function updateFilePicker(): void {
  const armed = currentMode() === "file" && selectedFile !== null;
  paneFile.classList.toggle("has-file", armed);
  filePickerButton.textContent = armed ? "Stop transfer" : "Drop files here";
  filePickerLabel.textContent = armed ? "Select different files" : "or select files";
  selectionSummary.hidden = !armed;
  if (armed && selectedFile) {
    const names = document.createElement("span");
    const total = document.createElement("span");
    names.textContent = selectedFile.files.length > 1
      ? `${selectedFile.files.length} files`
      : selectedFile.files[0]!.name;
    names.title = names.textContent;
    const originalTotal = selectedFile.files.reduce((sum, file) => sum + file.size, 0);
    total.textContent = selectedFile.compression === "gzip"
      ? `${formatBytes(originalTotal)} · ${formatBytes(selectedFile.transmittedSize)} gzip`
      : formatBytes(originalTotal);
    selectionSummary.replaceChildren(names, total);
  } else selectionSummary.replaceChildren();
}

/** Tear the stream down and disarm the picker. The input is cleared so the
 *  same file can be picked again (change would not fire otherwise) and so a
 *  mode switch does not silently resurrect the stopped stream. */
function discardSelectedFile(): void {
  selectedFile?.payload.fill(0);
  selectedFile = null;
  resizeDisplay = null;
  canvas.width = canvas.height = 16;
}

function stopTransfer(): void {
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

/** Tap the code to fill the screen with it — a bigger physical code lets the
 *  receiver sit farther back or decode denser frames.
 *
 *  Fullscreen is a page STATE (body.qr-full — see style.css), never a fixed
 *  overlay and never a separate element: Safari 26 latches its chrome tint
 *  onto fixed layers, and an overlay element that merely loses a class is
 *  still there for the heuristic to track. A flow layout that reflows on
 *  exit leaves nothing behind. Tap again (or Esc) to shrink back. */
let scrollBeforeFullscreen = 0;
let cursorIdleTimer: ReturnType<typeof setTimeout> | undefined;
const CURSOR_IDLE_MS = 1200;

function armFullscreenCursor(): void {
  clearTimeout(cursorIdleTimer);
  document.body.classList.remove("qr-cursor-hidden");
  if (!document.body.classList.contains("qr-full")) return;
  cursorIdleTimer = setTimeout(() => {
    if (document.body.classList.contains("qr-full")) document.body.classList.add("qr-cursor-hidden");
  }, CURSOR_IDLE_MS);
}

window.addEventListener("mousemove", armFullscreenCursor, { passive: true });

function setStageFullscreen(on: boolean): void {
  if (on === document.body.classList.contains("qr-full")) return;
  if (on) scrollBeforeFullscreen = window.scrollY;
  document.body.classList.toggle("qr-full", on);
  if (on) armFullscreenCursor();
  else {
    clearTimeout(cursorIdleTimer);
    document.body.classList.remove("qr-cursor-hidden");
  }
  if (!on && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  resizeDisplay?.();
  // Entering: the stage IS the page now, start at its top. Leaving: put the
  // user back on the exact spot they expanded from.
  window.scrollTo(0, on ? 0 : scrollBeforeFullscreen);
}

canvas.addEventListener("click", () => {
  const entering = !document.body.classList.contains("qr-full");
  setStageFullscreen(entering);
  if (entering) void document.documentElement.requestFullscreen?.().catch(() => undefined);
});
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) setStageFullscreen(false);
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setStageFullscreen(false);
});

/** Switching what we're sending kills any stream in flight and clears the stage. */
function applyMode(): void {
  generation++;
  releaseScreenWakeLock();
  discardSelectedFile();
  setStageFullscreen(false);
  stage.hidden = true;
  stageError.hidden = true;
  if (sendStart) sendStart.hidden = false;
  showStreamPanels(false);

  // The single-page sender keeps file and text entry side by side. Selecting
  // either one simply chooses the payload type for the stream.
  paneFile.hidden = false;
  paneSnippet.hidden = false;
  setStatus("");
  updateFilePicker();
}

/**
 * The one path from "user picked something" to a running stream.
 *
 * Kills any stream in flight, then packs the payload; a selection that lands
 * mid-pack (the generation guard) or fails to pack (throw → showError) leaves
 * the page idle rather than streaming something stale. Every way of choosing a
 * payload goes through here so the guard can't be subtly wrong in one copy.
 */
async function startSelection(
  status: string,
  prepare: () => Promise<{ name: string; size: number; packed: PackedOpticalFile; files: { name: string; size: number }[] }>,
): Promise<void> {
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
      files,
    };
    updateFilePicker();
    await startStream(true);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

async function selectFiles(fileList: FileList | readonly File[]): Promise<void> {
  const files = Array.from(fileList);
  if (!files.length) return;
  selectMode("file");
  snippetText.value = "";
  const total = files.reduce((sum, file) => sum + file.size, 0);
  await startSelection(`Preparing ${files.length === 1 ? files[0]!.name : `${files.length} files`}…`, async () => {
    const empty = files.find((file) => file.size === 0);
    if (empty) throw new Error(`${empty.name} is empty — there is nothing to send.`);
    if (total > MAX_FILE_BYTES) {
      throw new Error(`The selection is ${formatBytes(total)}, over the ${MAX_FILE_LABEL} limit.`);
    }
    if (files.length === 1) {
      const file = files[0]!;
      const bytes = new Uint8Array(await file.arrayBuffer());
      return { name: file.name, size: file.size, packed: await packFile(file.name, file.type, bytes), files: [{ name: file.name, size: file.size }] };
    }
    const entries = await Promise.all(files.map(async (file) => ({
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })));
    const archive = makeZip(entries);
    return {
      name: `${files.length}-files.zip`,
      size: total,
      // Our ZIP entries are stored, not deflated, so unlike an uploaded ZIP
      // the archive can still benefit substantially from container gzip.
      packed: await packFile(`${files.length}-files.zip`, "application/vnd.airgapper.files+zip", archive, true),
      files: files.map(({ name, size }) => ({ name, size })),
    };
  });
  updateFilePicker();
}

async function selectSnippet(): Promise<void> {
  selectMode("snippet");
  await startSelection("preparing text snippet…", async () => {
    const packed = await packSnippet(snippetText.value);
    return { name: "Text snippet", size: packed.originalSize, packed, files: [{ name: "Text snippet", size: packed.originalSize }] };
  });
}

function restoreSendSettings(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(SEND_SETTINGS_KEY) ?? "null") as {
      fps?: unknown;
      sizeLevel?: unknown;
      scaling?: unknown;
      layout?: unknown;
      orientation?: unknown;
    } | null;
    if (!saved) return;
    if (typeof saved.fps === "number" && Number.isInteger(saved.fps) && saved.fps >= 1 && saved.fps <= 480) {
      selectFps(saved.fps);
    }
    if (typeof saved.sizeLevel === "number" && Number.isInteger(saved.sizeLevel) && saved.sizeLevel >= 0 && saved.sizeLevel < FRAME_BYTES_OPTIONS.length) {
      cfgSize.value = String(saved.sizeLevel);
    }
    if (saved.scaling === "integer" || saved.scaling === "fit") cfgScaling.value = saved.scaling;
    if (saved.layout === "single" || saved.layout === "one-two" || saved.layout === "two-two" || saved.layout === "two-three" || saved.layout === "four-three" || saved.layout === "three-five") {
      cfgLayout.value = saved.layout;
    } else if (saved.layout === "five-three") {
      // Migrate the old standalone landscape option to shape + orientation.
      cfgLayout.value = "three-five";
      cfgOrientation.value = "landscape";
    }
    if (saved.orientation === "auto" || saved.orientation === "portrait" || saved.orientation === "landscape") {
      cfgOrientation.value = saved.orientation;
    }
  } catch {
    // Storage can be disabled, especially for local files. Defaults still work.
  }
}

function saveSendSettings(): void {
  try {
    localStorage.setItem(SEND_SETTINGS_KEY, JSON.stringify({
      fps: selectedFps(),
      sizeLevel: Number(cfgSize.value),
      scaling: cfgScaling.value,
      layout: cfgLayout.value,
      orientation: selectedOrientation(),
    }));
  } catch {
    // A blocked or full store must never prevent a transfer.
  }
}

async function main() {
  // Both bounds come from MAX_SNIPPET_BYTES so they can't drift apart. maxLength
  // counts UTF-16 units and the real check counts UTF-8 bytes, which are never
  // fewer — so this is a loose guard and packSnippet() remains authoritative.
  snippetText.maxLength = MAX_SNIPPET_BYTES;
  snippetLabel.textContent = `Text to send · up to ${MAX_SNIPPET_LABEL}`;

  cfgFile.addEventListener("change", () => void selectFiles(cfgFile.files ?? []));
  for (const eventName of ["dragenter", "dragover"]) {
    paneFile.addEventListener(eventName, (event) => { event.preventDefault(); paneFile.classList.add("dragging"); });
  }
  for (const eventName of ["dragleave", "drop"]) {
    paneFile.addEventListener(eventName, () => paneFile.classList.remove("dragging"));
  }
  paneFile.addEventListener("drop", (event) => {
    event.preventDefault();
    if (event.dataTransfer?.files.length) void selectFiles(event.dataTransfer.files);
  });
  // While a file is armed the picker label must NOT open the file dialog:
  // preventDefault cancels the label→input forwarding, and only the button
  // (or a keyboard activation of the hidden input, whose click bubbles up
  // through the label) stops the stream.
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
  let customFpsTimer: ReturnType<typeof setTimeout> | undefined;
  cfgFps.addEventListener("change", () => {
    clearTimeout(customFpsTimer);
    cfgFpsCustom.hidden = cfgFps.value !== "custom";
    speedControl.classList.toggle("has-custom", !cfgFpsCustom.hidden);
    if (!cfgFpsCustom.hidden) cfgFpsCustom.focus();
  });
  const resizeForViewport = () => resizeDisplay?.();
  window.addEventListener("resize", resizeForViewport);
  window.visualViewport?.addEventListener("resize", resizeForViewport);
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

/** Only on a fresh pick — a settings change restarts the stream too, and
 *  yanking the page down every time you nudge tx fps is worse than useless. */
function scrollStageIntoView() {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  requestAnimationFrame(() => {
    stage.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  });
}

async function startStream(revealStage = false) {
  const gen = ++generation;
  resizeDisplay = null;
  canvas.style.display = "";
  stageError.hidden = true;
  // Stale until this stream's first frame locks its version and refills them.
  showStreamPanels(false);
  if (!selectedFile) {
    releaseScreenWakeLock();
    setStatus("");
    return;
  }
  await requestScreenWakeLock();
  const { name, size: fileSize, payload, compression, transmittedSize } = selectedFile;
  if (gen !== generation) return; // superseded while fetching
  const txFps = selectedFps();
  const sizeLevel = Number(cfgSize.value);
  const fitScaling = cfgScaling.value === "fit";
  const frameBytes = FRAME_BYTES_OPTIONS[Math.min(sizeLevel, FRAME_BYTES_OPTIONS.length - 1)] ?? FRAME_BYTES_OPTIONS[0]!;
  const ecc = "L" as const;
  const configuredLayout = selectedLayout();
  // Keep selectedFile on this path — raising bytes/frame back up is the fix,
  // and dropping the pick would hide that.
  if (!fitsInOneStream(payload.length, frameBytes)) {
    const suggestion = smallestSufficientFrameSize(payload.length, FRAME_BYTES_OPTIONS);
    showSettingsError(
      `${formatBytes(payload.length)} needs ${sourceBlockCount(payload.length, frameBytes).toLocaleString()} blocks. ` +
      (suggestion
        ? `Choose ${formatBytes(suggestion)} or more in Size.`
        : "No available Size setting can carry this transfer."),
    );
    return;
  }

  // Short snippets use their plain UTF-8 text as the QR payload, so any normal
  // QR reader can read them. Files retain the verified AirGapper container,
  // even when they fit in one static code. Longer text keeps fountain framing.
  const snippetValue = currentMode() === "snippet" ? snippetText.value : null;
  const plainSnippet = snippetValue !== null && new TextEncoder().encode(snippetValue).length <= frameBytes
    ? snippetValue
    : null;
  const transport = selectTransportPlan(payload.length, frameBytes);
  const staticStream = plainSnippet !== null || transport.mode === "direct";
  const layoutMode: LayoutMode = staticStream ? "single" : configuredLayout;
  const { cols: gridCols, rows: gridRows, codes: gridCodes } = layoutGrid(layoutMode);
  const blockLen = transport.blockLen;
  const payloadId = fnv1a(payload);
  const encoder = new TransportEncoder(payload, blockLen, payloadId);
  const header: Omit<FrameHeader, "seq" | "slotIndex"> = {
    mode: encoder.mode,
    layoutId: gridLayoutId(gridCols, gridRows),
    k: encoder.k,
    blockLen,
    totalLen: payload.length,
    payloadId,
  };

  let version: number | undefined; // locked after the first frame
  let modules = 0;
  let scale = 1;
  const staging = document.createElement("canvas");
  const queue: ImageData[] = [];
  // Last painted code per grid position: resizing a canvas clears it (even to
  // the same dimensions), so a mid-stream resize repaints from here instead of
  // leaving blank cells until the stagger rotation reaches them again.
  const cells: (ImageData | null)[] = new Array<ImageData | null>(gridCodes).fill(null);
  let symbolOrdinal = 0;
  stage.hidden = false;
  if (sendStart) sendStart.hidden = true;
  showStreamPanels(true);

  const sizeCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    // One shared quiet margin separates adjacent symbols; the same margin is
    // retained around the outside of the grid.
    const stride = modules + GRID_MARGIN;
    const totalW = modules * gridCols + GRID_MARGIN * (gridCols + 1);
    const totalH = modules * gridRows + GRID_MARGIN * (gridRows + 1);
    const landscape = landscapeGrid();
    const displayW = landscape ? totalH : totalW;
    const displayH = landscape ? totalW : totalH;
    let budgetW: number;
    let budgetH: number;
    if (document.body.classList.contains("qr-full")) {
      // Tap-to-fullscreen: the whole viewport. The display-size slider and
      // page chrome are deliberately ignored — the point of the mode is "as
      // big as this device goes" — and a non-square grid gets both edges,
      // so a 1×2 stack can run the full height of a portrait phone screen.
      budgetW = window.innerWidth;
      budgetH = window.innerHeight - stageBottom.offsetHeight;
    } else {
      const rect = stage.getBoundingClientRect();
      const stageStyle = getComputedStyle(stage);
      budgetW = rect.width - Number.parseFloat(stageStyle.paddingLeft) - Number.parseFloat(stageStyle.paddingRight);
      budgetH = rect.height - stageBottom.offsetHeight - Number.parseFloat(stageStyle.paddingTop) - Number.parseFloat(stageStyle.paddingBottom);
    }
    const availableScale = Math.min((budgetW * dpr) / displayW, (budgetH * dpr) / displayH);
    // Integer scaling must never force scale 1 into a viewport where it does
    // not fit. In that exceptional case use the exact fractional fit: a
    // slightly softened QR is preferable to clipping finder patterns.
    scale = fitScaling || availableScale < 1
      ? Math.max(Number.EPSILON, availableScale)
      : Math.floor(availableScale);
    staging.width = totalW;
    staging.height = totalH;
    canvas.width = Math.max(1, Math.round(displayW * scale));
    canvas.height = Math.max(1, Math.round(displayH * scale));
    // Present the backing raster at exactly its device-pixel size. Integer
    // mode leaves the sub-module remainder unused to keep every edge sharp;
    // Fit screen deliberately spends it by allowing fractional modules.
    const cssNativeW = (displayW * scale) / dpr;
    const cssNativeH = (displayH * scale) / dpr;
    canvas.style.width = `${cssNativeW}px`;
    canvas.style.height = `${cssNativeH}px`;
    canvas.style.imageRendering = "pixelated";
    // Both canvases were just cleared by the dimension writes — repaint every
    // cell the stream has shown so far, so a resize never blanks the grid.
    const stagingCtx = staging.getContext("2d")!;
    cells.forEach((img, i) => {
      if (img) stagingCtx.putImageData(img, (i % gridCols) * stride, Math.floor(i / gridCols) * stride);
    });
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    if (landscape) {
      // Rotate the logical grid as one image. Its layout and slot IDs stay
      // unchanged; the receiver's homography accounts for the quarter-turn.
      ctx.setTransform(0, canvas.height / totalW, -canvas.width / totalH, 0, canvas.width, 0);
    } else {
      ctx.setTransform(canvas.width / totalW, 0, 0, canvas.height / totalH, 0, 0);
    }
    ctx.drawImage(staging, 0, 0);
  };

  const makeCode = (): ReturnType<typeof QRCode.create> => {
    if (plainSnippet !== null) {
      return QRCode.create(plainSnippet, {
        errorCorrectionLevel: ecc,
        version,
        maskPattern: 4,
      });
    }
    const slotIndex = symbolOrdinal % gridCodes;
    const seq = scheduledEsi(encoder.k, symbolOrdinal, slotIndex, gridCodes);
    const bytes = packFrame(
      { ...header, seq, slotIndex },
      encoder.encode(seq),
    );
    symbolOrdinal++;
    // Every code carries the same byte length at the same ECC with the same
    // pinned mask, so once the first one locks the version every later
    // QRCode.create lands on identical geometry — required for tiling.
    return QRCode.create([{ data: bytes, mode: "byte" } as unknown as QRCode.QRCodeSegment], {
      errorCorrectionLevel: ecc,
      version,
      maskPattern: 4,
    });
  };

  const makeCell = (): ImageData => {
    const qr = makeCode();
    if (version === undefined) {
      version = qr.version;
      modules = qr.modules.size;
      sizeCanvas();
      resizeDisplay = sizeCanvas;
      // WebView can report its pre-layout stage size during the same task that
      // reveals it. Re-read after layout and after its visual viewport settles.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (gen === generation) sizeCanvas();
      }));
      setTimeout(() => {
        if (gen === generation) sizeCanvas();
      }, 250);
      // Scroll only now: before sizeCanvas() the canvas is still 16×16, so the
      // scroll target would be the wrong height.
      if (revealStage) scrollStageIntoView();
      showStreamPanels(true);
      setStatus("");
      // npm run diagnostics: announce this stream's settings so the server
      // log can pair them with the receiver's end-of-run report — the
      // receiver only ever learns k and blockLen from the wire, never the
      // knobs that produced them. Correlate the two by streamId. The DEV
      // guard is load-bearing: import.meta.env.DEV is statically false in
      // every build, so no static site or standalone file ships this.
      if (import.meta.env.DEV && import.meta.env.VITE_DIAGNOSTICS === "1") {
        void fetch("/__diagnostics", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            role: "sender",
            when: new Date().toISOString(),
            streamId: payloadId,
            payload: {
              name,
              fileBytes: fileSize,
              containerBytes: payload.length,
              transmittedBytes: transmittedSize,
              compression,
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
              gridMargin: GRID_MARGIN,
              scaling: fitScaling ? "fit" : "integer",
            },
            qr: {
              version,
              modules,
              encodedBytes: transport.frameBytes,
              ceilingBytes: frameBytes,
              overheadPercent: Number((transport.overheadFraction * 100).toFixed(2)),
            },
            fountain: {
              mode: encoder.mode,
              k: encoder.k,
              blockLen,
              paddingBytes: transport.paddingBytes,
              paddingPercent: Number((transport.paddingFraction * 100).toFixed(3)),
            },
            ua: navigator.userAgent,
          }),
        }).catch(() => undefined);
      }
    }
    const raster = rasterizeQr(qr.modules.size, qr.modules.data, GRID_MARGIN);
    return new ImageData(new Uint8ClampedArray(raster.pixels.buffer), raster.size, raster.size);
  };

  /**
   * Refill the lookahead, generating at most `max` frames per call.
   *
   * Called once up front to fill the queue, then once per tick() — the only
   * thing that drains it. Self-scheduling on `setTimeout(pump, 0)` instead cost
   * ~250 wake-ups a second doing nothing once the queue was full. Capping at
   * one frame per tick keeps the amortisation that gave us: a rAF callback
   * never pays for more than the single frame it just consumed.
   */
  let generatorFailed = false;
  const lookahead = staticStream ? 1 : LOOKAHEAD * gridCodes;
  const pump = (max = lookahead) => {
    if (generatorFailed || gen !== generation) return;
    try {
      for (let n = 0; n < max && queue.length < lookahead; n++) queue.push(makeCell());
    } catch (err) {
      // e.g. frame bytes over capacity for the chosen ECC level
      generatorFailed = true;
      showError(err instanceof Error ? err.message : String(err));
    }
  };
  pump();

  let cellCursor = 0;
  const paintCell = (img: ImageData): void => {
    const cell = modules + 2 * GRID_MARGIN;
    const stride = modules + GRID_MARGIN;
    const cx = (cellCursor % gridCols) * stride;
    const cy = Math.floor(cellCursor / gridCols) * stride;
    cells[cellCursor] = img;
    staging.getContext("2d")!.putImageData(img, cx, cy);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    const totalW = staging.width;
    const totalH = staging.height;
    if (landscapeGrid()) {
      ctx.setTransform(0, canvas.height / totalW, -canvas.width / totalH, 0, canvas.width, 0);
    } else {
      ctx.setTransform(canvas.width / totalW, 0, 0, canvas.height / totalH, 0, 0);
    }
    if (fitScaling) {
      // Fractional module scaling can put cell boundaries between device
      // pixels. Repaint the complete grid so partial blits cannot leave seams.
      ctx.drawImage(staging, 0, 0);
    } else {
      ctx.drawImage(staging, cx, cy, cell, cell, cx, cy, cell, cell);
    }
    cellCursor = (cellCursor + 1) % gridCodes;
  };

  // Fill the complete grid in this task. On a fresh stream or settings restart,
  // leaving this to the stagger loop would expose empty cells for most of the
  // first sweep. Only subsequent updates should be staggered.
  for (let i = 0; i < gridCodes; i++) {
    const img = queue.shift();
    if (img) paintCell(img);
  }
  if (staticStream) return;

  // Staggered flips: every cell refreshes at txFps, but cell j flips at phase
  // j/N of the frame interval instead of all N flipping together. A camera
  // exposure that straddles a flip therefore catches at most ONE code mid-
  // transition — the other N−1 sit stable under it. With simultaneous flips
  // that same exposure lost all N at once. Each flip repaints only its own
  // cell rectangle; cells align to cell×scale boundaries, so the partial blit
  // is pixel-exact. (Sub-ticks land on rAF frames, so at high fps × codes
  // several cells can still flip in one refresh — the stagger degrades toward
  // the old behavior, never below it. A grid of one IS the old behavior.)
  const interval = 1000 / txFps;
  const subInterval = interval / gridCodes;
  let nextAt = performance.now() + interval;
  let lastTickAt = performance.now();
  let completedSweeps = 0;
  const tick = (now: number) => {
    // generatorFailed means no frame will ever be produced again, so stop the
    // rAF loop rather than spinning on an empty queue until a settings change.
    if (gen !== generation || generatorFailed) return;
    requestAnimationFrame(tick);
    // Keep stalls in development diagnostics without interrupting the sender
    // with a warning: the cadence reset below resumes cleanly on its own.
    const sinceLastTick = now - lastTickAt;
    lastTickAt = now;
    if (sinceLastTick > 1000) {
      if (import.meta.env.DEV && import.meta.env.VITE_DIAGNOSTICS === "1") {
        void fetch("/__diagnostics", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            role: "sender",
            event: "stall",
            when: new Date().toISOString(),
            streamId: payloadId,
            stallSeconds: Number((sinceLastTick / 1000).toFixed(1)),
          }),
        }).catch(() => undefined);
      }
    }
    if (now < nextAt) return;
    // A long stall (hidden tab, GC pause) leaves a backlog no camera ever saw
    // — restart the cadence instead of bursting it out.
    if (now - nextAt > interval) nextAt = now;
    // Flip EVERY cell that has come due, not one per callback: txFps × codes
    // can exceed the display's refresh rate, so a single vsync may owe
    // several flips. Cells that land on the same vsync paint together — that
    // is the display's floor, not a scheduling choice — but deferring them
    // (one flip per rAF) silently capped per-code fps at refresh ÷ codes and
    // slowed every multi-code grid down. Bounded: the reset above keeps the
    // debt under one frame interval, so this bursts at most gridCodes flips.
    while (now >= nextAt) {
      const img = queue.shift();
      pump(1);
      if (!img) {
        nextAt = now + subInterval;
        break;
      }
      paintCell(img);
      nextAt += subInterval;
      if (cellCursor === 0) {
        completedSweeps++;
        // A 30 fps sender and 30 fps camera can remain phase-locked: every
        // exposure then intersects (or avoids) the same display transition,
        // producing the observed waves of total misses despite an unchanged
        // view. Occasionally hold one frame half an interval longer. This
        // shifts the optical phase without introducing a dangerously short
        // one-refresh QR, and costs only about 3% throughput at 30 fps.
        if (txFps === 30 && completedSweeps % 15 === 0) nextAt += interval / 2;
      }
    }
  };
  requestAnimationFrame(tick);
}

window.addEventListener("airgapper:leave-mode", () => {
  if (!document.getElementById("sendView")?.classList.contains("active")) return;
  stopTransfer();
});
window.addEventListener("pagehide", stopTransfer);
window.addEventListener("airgapper:pause-mode", () => {
  if (!document.getElementById("sendView")?.classList.contains("active")) return;
  // Hidden tabs stop receiving animation frames, so the stream naturally
  // freezes on its current session without generating more QR work.
  releaseScreenWakeLock();
});
window.addEventListener("airgapper:resume-mode", () => {
  if (!document.getElementById("sendView")?.classList.contains("active") || !selectedFile) return;
  void requestScreenWakeLock();
});

void main();
