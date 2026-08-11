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
import { gridDims, rasterizeQr } from "../shared/qr-raster";
import { formatBytes } from "../shared/format";
import {
  blockLength,
  fitsInOneStream,
  minimumFrameBytes,
  sourceBlockCount,
} from "../shared/frame-capacity";
import { LTEncoder } from "../shared/fountain";
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
import { requestScreenWakeLock } from "../shared/wake-lock";
import { makeZip } from "../shared/zip";
import { FRAME_BYTES_OPTIONS } from "../shared/send-settings";

// Zero quiet zones are intentional for the current compact-layout test.
const HEADER_MARGIN = 0;
const GRID_MARGIN = 0;
const LOOKAHEAD = 3;
// Every density uses the same portrait 3×4 frame. The Size control changes
// only the bytes (and therefore QR version) in each of the twelve cells, so
// optical comparisons keep the camera-filling layout constant.
const GRID_CODES = 12;

const canvas = document.getElementById("qr") as HTMLCanvasElement;
const stage = document.getElementById("stage") as HTMLDivElement;
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

/** A quiet, static handoff code lets a phone join as the receiver before the
 * transfer starts. It deliberately points to HTTPS even in the standalone
 * file, because mobile browsers generally deny camera access from file://. */
function renderReceiverLink(): void {
  const receiverUrl = receiverLinkQr.dataset.receiverUrl;
  if (!receiverUrl) return;
  const qr = QRCode.create(receiverUrl, { errorCorrectionLevel: "L" });
  const raster = rasterizeQr(qr.modules.size, qr.modules.data, HEADER_MARGIN);
  // Keep every module an integer number of physical display pixels. Size the
  // handoff code like a small logo while choosing the nearest whole-module
  // size, avoiding gray edges from browser resampling.
  const dpr = window.devicePixelRatio || 1;
  const targetCssSize = 40;
  const scale = Math.max(1, Math.round((targetCssSize * dpr) / raster.size));
  const source = document.createElement("canvas");
  source.width = source.height = raster.size;
  source.getContext("2d")!.putImageData(
    new ImageData(new Uint8ClampedArray(raster.pixels.buffer), raster.size, raster.size),
    0,
    0,
  );
  receiverLinkQr.width = receiverLinkQr.height = raster.size * scale;
  receiverLinkQr.style.width = receiverLinkQr.style.height = `${receiverLinkQr.width / dpr}px`;
  receiverLinkQr.style.imageRendering = "pixelated";
  const ctx = receiverLinkQr.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0, receiverLinkQr.width, receiverLinkQr.height);
}
renderReceiverLink();

function showStreamPanels(visible: boolean): void {
  sendControls.hidden = !visible;
}

const cfgFps = document.getElementById("cfg-fps") as HTMLInputElement;
const cfgSize = document.getElementById("cfg-size") as HTMLInputElement;
const fpsValue = document.getElementById("fps-value")!;
const sizeValue = document.getElementById("size-value")!;

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
  setStageFullscreen(false);
  stage.hidden = true;
  if (sendStart) sendStart.hidden = false;
  showStreamPanels(false);
  specsLine.showError(message);
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
function stopTransfer(): void {
  generation++;
  selectedFile = null;
  setStageFullscreen(false);
  stage.hidden = true;
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
  selectedFile = null;
  setStageFullscreen(false);
  stage.hidden = true;
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
  selectedFile = null;
  stage.hidden = true;
  setStatus(status);
  try {
    const { name, size, packed, files } = await prepare();
    if (selectionGeneration !== generation) return;
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
      packed: await packFile(`${files.length}-files.zip`, "application/zip", archive, true),
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
  window.addEventListener("resize", () => resizeDisplay?.());
  const updateControlLabels = () => {
    fpsValue.textContent = `${cfgFps.value} fps`;
    const level = Number(cfgSize.value);
    const bytes = FRAME_BYTES_OPTIONS[Math.min(level, FRAME_BYTES_OPTIONS.length - 1)] ?? FRAME_BYTES_OPTIONS[0]!;
    sizeValue.textContent = `${formatBytes(bytes)} · ${GRID_CODES} QRs`;
  };
  for (const el of [cfgFps, cfgSize]) {
    el.addEventListener("input", updateControlLabels);
    el.addEventListener("change", () => void startStream());
  }
  updateControlLabels();
  await requestScreenWakeLock();
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
  // Stale until this stream's first frame locks its version and refills them.
  showStreamPanels(false);
  if (!selectedFile) {
    setStatus("");
    return;
  }
  const { name, size: fileSize, payload, compression, transmittedSize } = selectedFile;
  if (gen !== generation) return; // superseded while fetching
  const txFps = Number(cfgFps.value);
  const sizeLevel = Number(cfgSize.value);
  const frameBytes = FRAME_BYTES_OPTIONS[Math.min(sizeLevel, FRAME_BYTES_OPTIONS.length - 1)] ?? FRAME_BYTES_OPTIONS[0]!;
  const ecc = "L" as const;
  // Fill one standard QR from 500 B through its 2,953 B maximum, then add
  // parallel maximum-density symbols. Each remains an ordinary independent
  // fountain frame, so this does not change the wire protocol.
  const gridCodes = GRID_CODES;
  const { cols: gridCols, rows: gridRows } = gridDims(gridCodes);

  const sessionId = (Math.floor(Math.random() * 0xffff) + 1) & 0xffff;
  const blockLen = blockLength(frameBytes);
  // Keep selectedFile on this path — raising bytes/frame back up is the fix,
  // and dropping the pick would hide that.
  if (!fitsInOneStream(payload.length, frameBytes)) {
    // Name a setting that is actually in the dropdown, not the bare minimum.
    const suggestion = minimumFrameBytes(payload.length);
    showError(
      `${formatBytes(payload.length)} needs ${sourceBlockCount(payload.length, frameBytes).toLocaleString()} blocks. ` +
      `This transfer needs at least ${suggestion} bytes per frame and cannot be displayed safely.`,
    );
    return;
  }
  const encoder = new LTEncoder(payload, blockLen, sessionId);
  const header: FrameHeader = {
    sessionId,
    seq: 0,
    k: encoder.k,
    blockLen,
    totalLen: payload.length,
    payloadFnv: fnv1a(payload),
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
  let nextSeq = 0;
  stage.hidden = false;
  if (sendStart) sendStart.hidden = true;
  showStreamPanels(true);

  const sizeCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    // Symbols currently tile edge-to-edge for compact-layout testing.
    const stride = modules + GRID_MARGIN;
    const totalW = modules * gridCols + GRID_MARGIN * (gridCols + 1);
    const totalH = modules * gridRows + GRID_MARGIN * (gridRows + 1);
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
    scale = Math.max(1, Math.floor(Math.min((budgetW * dpr) / totalW, (budgetH * dpr) / totalH)));
    staging.width = totalW;
    staging.height = totalH;
    canvas.width = totalW * scale;
    canvas.height = totalH * scale;
    // Present the backing raster at exactly its device-pixel size. Do not
    // stretch it to consume the last few CSS pixels in the budget: fractional
    // resampling turns black/white module boundaries gray. The unused strip is
    // always smaller than one module-scale step on the limiting axis.
    const cssNativeW = (totalW * scale) / dpr;
    const cssNativeH = (totalH * scale) / dpr;
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
    ctx.drawImage(staging, 0, 0, canvas.width, canvas.height);
  };

  const makeCode = (): ReturnType<typeof QRCode.create> => {
    const bytes = packFrame({ ...header, seq: nextSeq }, encoder.encode(nextSeq));
    nextSeq++;
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
      // Scroll only now: before sizeCanvas() the canvas is still 16×16, so the
      // scroll target would be the wrong height.
      if (revealStage) scrollStageIntoView();
      showStreamPanels(true);
      setStatus("");
      // npm run diagnostics: announce this stream's settings so the server
      // log can pair them with the receiver's end-of-run report — the
      // receiver only ever learns k and blockLen from the wire, never the
      // knobs that produced them. Correlate the two by sessionId. The DEV
      // guard is load-bearing: import.meta.env.DEV is statically false in
      // every build, so no static site or standalone file ships this.
      if (import.meta.env.DEV && import.meta.env.VITE_DIAGNOSTICS === "1") {
        void fetch("/__diagnostics", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            role: "sender",
            when: new Date().toISOString(),
            sessionId,
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
              sizeLevel,
            },
            qr: { version, modules },
            fountain: { k: encoder.k, blockLen },
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
  const lookahead = LOOKAHEAD * gridCodes;
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
  let cellCursor = 0;
  let nextAt = performance.now();
  let lastTickAt = performance.now();
  const tick = (now: number) => {
    // generatorFailed means no frame will ever be produced again, so stop the
    // rAF loop rather than spinning on an empty queue until a settings change.
    if (gen !== generation || generatorFailed) return;
    requestAnimationFrame(tick);
    // Stall watchdog. Browsers throttle rAF hard in occluded or unfocused
    // windows (Firefox especially) — the stream freezes on whatever frame was
    // up, usually mid-flip and unreadable, and the receiver burns seconds in
    // full-scan reacquisition that LOOKS like a receiver failure. Diagnosed
    // from a field run: 6 s of decodeFps 0 at captureFps 60, then instant
    // recovery when the sender window came back. Nothing can un-throttle the
    // window; what we can do is tell the user exactly what happened.
    const sinceLastTick = now - lastTickAt;
    lastTickAt = now;
    if (sinceLastTick > 1000) {
      setStatus(
        `Stream froze for ${(sinceLastTick / 1000).toFixed(1)} s — this window was hidden or ` +
          `in the background. Keep it visible and focused; the receiver loses lock when it pauses.`,
      );
      if (import.meta.env.DEV && import.meta.env.VITE_DIAGNOSTICS === "1") {
        void fetch("/__diagnostics", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            role: "sender",
            event: "stall",
            when: new Date().toISOString(),
            sessionId,
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
      const cell = modules + 2 * GRID_MARGIN;
      const stride = modules + GRID_MARGIN;
      const cx = (cellCursor % gridCols) * stride;
      const cy = Math.floor(cellCursor / gridCols) * stride;
      cells[cellCursor] = img;
      staging.getContext("2d")!.putImageData(img, cx, cy);
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(staging, cx, cy, cell, cell, cx * scale, cy * scale, cell * scale, cell * scale);
      cellCursor = (cellCursor + 1) % gridCodes;
      nextAt += subInterval;
    }
  };
  requestAnimationFrame(tick);
}

window.addEventListener("airgapper:leave-mode", () => {
  if (!document.getElementById("sendView")?.classList.contains("active")) return;
  stopTransfer();
});

void main();
