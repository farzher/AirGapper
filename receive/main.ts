// Receiver: camera → WASM QR decode in workers → fountain decoder → file.
//
// Field lessons baked in:
// - iOS treats `frameRate: {ideal: 60}` as a suggestion and delivers 30.
//   Demand `exact` first (it works at 1280-wide), fall back to `ideal`.
// - requestVideoFrameCallback chains survive a stopped stream and resume on
//   the next one — a generation counter prevents zombie capture loops.
// - Progress must track frames COLLECTED: LT peeling back-loads its solve
//   cascade, so blocks-solved looks stalled and then teleports to done.
// - Android Chrome exposes torch / focusMode / frameRate.max through
//   getCapabilities; iOS Safari exposes none of them. shared/platform.ts owns
//   the probing, so everything here is capability-gated rather than UA-gated.

import { LTDecoder } from "../shared/fountain";
import { formatBytes } from "../shared/format";
import {
  estimateTransferProgress,
  expectedFountainOverhead,
  formatDuration,
} from "../shared/progress";
import { createDecodeWorker } from "./worker-factory";
import {
  DecodeWorkerPool,
  type SymbolBox,
  type SymbolInfo,
  type SymbolQuad,
} from "../shared/worker-pool";
import { isSnippet, snippetText } from "../shared/snippet";
import {
  fnv1a,
  parseFrame,
  streamIdentity,
  unpackFile,
  verifyFile,
  type OpticalFile,
} from "../shared/protocol";
import { statusLine } from "../shared/status-line";
import { requestScreenWakeLock } from "../shared/wake-lock";
import { applyAdvancedConstraint, probeCameraCapabilities } from "../shared/platform";

const startBtn = document.getElementById("start") as HTMLButtonElement;
const video = document.getElementById("video") as HTMLVideoElement;
const preview = document.getElementById("preview")!;
const cameraBox = document.querySelector<HTMLDivElement>(".preview")!;
const overlay = document.getElementById("detect-overlay") as HTMLCanvasElement;
const stats = document.getElementById("stats")!;
const progressEl = document.getElementById("progress")!;
const bar = document.getElementById("bar")!;
const progressStatus = document.getElementById("progress-status")!;
const progressLabel = document.getElementById("progress-label")!;
const transferSizeLabel = document.getElementById("transfer-size-label")!;
const etaLabel = document.getElementById("eta-label")!;
const result = document.getElementById("result")!;
const metricsEl = document.getElementById("metrics")!;
const speedFeedback = document.getElementById("speed-feedback")!;
const pipelineMetrics = document.getElementById("pipeline-metrics")!;
const diagnosticsEl: HTMLDetailsElement | null = null;
const workerCount = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
// Camera maximum resolution is not maximum optical throughput: a 4K video
// frame is 9× the pixels of 1280×960, and the synchronous canvas readback can
// collapse an older phone to ~2 fps. 1280 keeps V40 modules comfortably large
// while leaving enough CPU budget for capture and decode.
const requestedWidth = 1280;
const requestedFps = 60;
const metric = (id: string) => document.getElementById(id)!;

// Sliding window for the capture/decode fps metrics — the per-second rates in
// updateStats() are derived from this, so the window and the divisor can't
// drift apart.
const STATS_WINDOW_MS = 2000;
const STATS_TICK_MS = 250;
const LIVE_RATE_WINDOW_MS = 1000;
// With a 250 ms UI tick, this guarantees a dead stream reads 0 within 1 s.
const LIVE_RATE_ZERO_MS = 750;

let stream: MediaStream | null = null;
let decoder: LTDecoder | null = null;
let streamKey = "";
let reportSessionId = 0; // pairs this run with the sender's diagnostics post
let startTs = 0;
let captureGen = 0;
let done = false;
let statsTimer: ReturnType<typeof setInterval> | undefined;

const pool = new DecodeWorkerPool(
  createDecodeWorker,
  (bytes, box, info) => onDecoded(bytes, box, info),
  // A sighting is a detected-but-undecoded code: no bytes, but a position.
  // Heavily gated in noteRegion (refresh-only on matches, size-checked on
  // creation) because failed quads are often junk — but a plausible one lets
  // the crop path go decode what the full frame could not.
  (box) => noteRegion(box, performance.now(), false),
  () => trackedAttempts++,
);
const captureTimes: number[] = [];
const decodeTimes: number[] = [];
// Timestamps of frames that contributed new fountain information. Unlike the
// transfer-wide average, this window drops immediately when optical lock is
// lost, so the speed display works as aiming feedback.
const usefulFrameTimes: number[] = [];

// Run-level totals for the diagnostics report (npm run diagnostics). The
// captureTimes/decodeTimes windows above are pruned for the live fps metrics
// and cannot answer "how much, in total, did this run do".
let totalCaptures = 0;
let totalDecodes = 0;
let fullScans = 0;
let peakRegions = 0;
let capturesDropped = 0; // pool full — frame never even submitted
let cropsSubmitted = 0;
let trackedDecodes = 0; // decodes via the fork's detection-skipping fast path
let trackedAttempts = 0; // crops that TRIED the fast path — hits/attempts is
// the fork's real hit rate; zero attempts means the quad/dim plumbing broke
let cameraStartedTs = 0; // acquisition latency = first decode − camera start
let zeroRegionMs = 0; // transfer time spent with tracking fully collapsed
let degradedMs = 0; // transfer time spent below the expected code count
let minSeq = Infinity; // seq span ≈ what the sender emitted while we watched;
let maxSeq = -1; //        framesNew / span is the fraction we actually caught
// One sample per stats tick (250 ms): elapsed s, framesNew, solved blocks,
// live regions, capture fps, decode fps. The shape of a bad run — where it
// stalled, when tracking collapsed — is invisible in run totals.
const timeline: number[][] = [];
const TIMELINE_MAX_SAMPLES = 2400; // 10 min — past that the tail tells nothing new

// Per-code crop tracking. The scene is static (both devices propped), so once
// a code has been seen its next frames are decoded from a padded crop around
// its last position: one code per crop means no finder-pattern confusion
// between neighbors, far fewer pixels per decode, and the crops parallelize
// across the worker pool. A periodic full-frame scan (re)acquires anything
// the crops lose — nothing here can get permanently stuck.
interface Region extends SymbolBox {
  seen: number;
  /** True once bytes have actually decoded here. Sighting-only regions are
   *  probationary: they get crops, but they are not drawn, not counted
   *  toward the expected code total, and evicted first. */
  decoded: boolean;
  /** Last successful byte decode. Failed detector sightings keep the crop
   * alive but must not make the success outline flash. */
  decodedSeen?: number;
  /** Recent detector outcomes. Color communicates this success ratio instead
   * of assigning an arbitrary identity color to each code. */
  outcomes: boolean[];
  /** How far the code moved between its last two decodes, in capture px —
   *  a handheld receiver's crops must lead the target, not chase it. */
  drift?: number;
  /** Corner quad + module count of the last decode here — the tracked fast
   *  path in the worker rebuilds its sampling transform from these and skips
   *  detection entirely. Only ever set from real decodes. */
  quad?: SymbolQuad;
  dim?: number;
}
const regions: Region[] = [];
// Tried and reverted: a longer TTL for regions with a decode track record
// (6 s after 5 hits). It measured WORSE — a stale region squats on crop
// slots at a dead position, and by keeping regions.length looking healthy it
// suppresses the degraded rescan cadence exactly when reacquisition is
// needed. Expiring fast and rescanning hard wins.
const REGION_TTL_MS = 1500;
const FULL_SCAN_INTERVAL_MS = 1500;
// A grid sender shows several codes; when fewer regions are live than the
// stream has shown simultaneously, one of them is MISSING — glare, focus, a
// borderline density. Crops can't find it (they only look where codes were),
// so rescan the whole frame hard until it's back. The relaxed cadence would
// leave a missing code dark for 1.5 s at a time, which on a 2-code stream
// halves throughput and single-threads the fountain's systematic sweep.
const FULL_SCAN_DEGRADED_MS = 250;
// With no lock at all the receiver used to full-scan EVERY capture — sixty
// 1.2 MP tryHarder decodes per second for the whole aiming phase, the app's
// hottest loop (fullScans regularly passed 100 before the first timeline
// sample). Ten per second keeps acquisition feeling instant — ≤100 ms added
// to first lock — and cuts the aiming burn ~85%.
const ACQUISITION_SCAN_MS = 100;
// The high-water mark ages out: a sender restarted with a smaller layout
// would otherwise keep this receiver rescanning for codes that no longer
// exist until the transfer ends.
const EXPECTED_REGIONS_DECAY_MS = 10_000;
const REGION_PAD = 0.35;
// The densest sender layout is a portrait 3×4 grid. Keep one tracked region
// for every cell so full acquisition can hand all twelve off to crop decoding.
const MAX_REGIONS = 12;
let lastFullScan = 0;
let cropRotate = 0;
let expectedRegions = 0;
let expectedRegionsAt = 0;

function decodedCount(): number {
  let n = 0;
  for (const r of regions) if (r.decoded) n++;
  return n;
}

function noteRegion(box: SymbolBox, now: number, decoded = true, info?: SymbolInfo): void {
  for (const r of regions) {
    const dx = Math.abs(box.x + box.w / 2 - (r.x + r.w / 2));
    const dy = Math.abs(box.y + box.h / 2 - (r.y + r.h / 2));
    if (dx < Math.max(box.w, r.w) / 2 && dy < Math.max(box.h, r.h) / 2) {
      if (!decoded) {
        // A sighting is an eyewitness report, not a measurement: enough to
        // keep the region alive, never enough to move or resize it. zxing's
        // failed quads are routinely clipped or wildly mis-sized, and one
        // overwriting a decode-proven box aims every following crop at
        // garbage — a measured 6× throughput collapse on a 4-code grid.
        r.seen = now;
        r.outcomes.push(false);
        if (r.outcomes.length > 20) r.outcomes.shift();
        return;
      }
      // Half-life blend of per-decode displacement: steady hands decay it to
      // zero, a moving hand keeps the crop padding wide (see captureFrame).
      r.drift = 0.5 * (r.drift ?? 0) + 0.5 * Math.hypot(dx, dy);
      Object.assign(r, box, { seen: now });
      r.decoded = true;
      r.decodedSeen = now;
      r.outcomes.push(true);
      if (r.outcomes.length > 20) r.outcomes.shift();
      if (info?.quad) r.quad = info.quad;
      if (info?.modules) r.dim = info.modules;
      return;
    }
  }
  if (!decoded) {
    // A sighting may only FOUND a region when it looks like the codes this
    // stream already decodes: grid codes are same-version and same-size on
    // screen, so a quad far off a decode-proven code's size is detector
    // noise. With nothing decoded yet there is no yardstick — full scans own
    // acquisition then, and phantom regions would only starve them.
    const reference = regions.find((r) => r.decoded);
    if (!reference) return;
    const ratio = Math.max(box.w, box.h) / Math.max(reference.w, reference.h);
    if (ratio < 0.5 || ratio > 2) return;
  }
  regions.push({
    ...box,
    seen: now,
    decoded,
    decodedSeen: decoded ? now : undefined,
    outcomes: [decoded],
    quad: info?.quad,
    dim: info?.modules,
  });
  if (regions.length > MAX_REGIONS) {
    regions.sort((a, b) => Number(b.decoded) - Number(a.decoded) || b.seen - a.seen);
    regions.length = MAX_REGIONS;
  }
}

/** The stylesheet guesses 4:3 for the camera box, but cameras rarely negotiate
 *  exactly that, and any mismatch used to be swallowed by object-fit: cover
 *  silently cropping — codes the decoder could see sat outside the visible
 *  preview. Sync the box to the stream's real shape instead; with the aspect
 *  matched, contain shows every pixel the decoder gets, edge to edge. */
function syncPreviewAspect() {
  if (video.videoWidth && video.videoHeight) {
    cameraBox.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  }
}
// Fires whenever the intrinsic size changes — device rotation, or a live
// capture-width change the camera accepted.
video.addEventListener("resize", syncPreviewAspect);

// Viewfinder corner brackets around each code the decoder is tracking, fading
// out once a region stops producing decodes. Long before REGION_TTL_MS: the
// brackets answer "is it reading THIS code right now", so they should die as
// soon as the answer stops being yes, while the crop tracker keeps trying.
const INDICATOR_FADE_MS = 700;
const SIGHTING_FADE_MS = 450;
const overlayCtx = overlay.getContext("2d")!;
function captureQualityColor(region: Region): string {
  const successes = region.outcomes.reduce((sum, ok) => sum + Number(ok), 0);
  const rate = successes / region.outcomes.length;
  if (rate === 1) return "#42e8ff"; // perfect lock: safe to raise sender density/speed
  if (rate >= 0.9) return "#35d66f"; // strong lock
  if (rate >= 0.65) return "#a9c93d";
  if (rate >= 0.35) return "#ffb23e";
  return "#ff665c"; // detected, but rarely decoded
}

/** Grid-layout reading order: rows first, columns within a row. Two boxes are
 *  the same row when their vertical centers are within half a code of each
 *  other — grid codes are same-size and aligned, so this is unambiguous. */
function layoutOrder(a: Region, b: Region): number {
  const dy = a.y + a.h / 2 - (b.y + b.h / 2);
  if (Math.abs(dy) > Math.max(a.h, b.h) / 2) return dy;
  return a.x + a.w / 2 - (b.x + b.w / 2);
}

function drawOverlay(now: number) {
  const cw = overlay.clientWidth;
  const ch = overlay.clientHeight;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!cw || !ch || !vw || !vh) return;
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(cw * dpr);
  const ph = Math.round(ch * dpr);
  if (overlay.width !== pw || overlay.height !== ph) {
    overlay.width = pw;
    overlay.height = ph;
  }
  overlayCtx.clearRect(0, 0, pw, ph);
  // Regions live in capture pixels; the video sits object-fit: contain inside
  // the same box as the overlay, so one letterbox mapping places everything.
  const scale = Math.min(pw / vw, ph / vh);
  const offX = (pw - vw * scale) / 2;
  const offY = (ph - vh * scale) / 2;
  overlayCtx.lineCap = "round";
  overlayCtx.lineJoin = "round";
  // Solid glowing corners mean a successful frame. A plausible code that the
  // detector can see but cannot decode gets a short-lived dashed outline;
  // this makes distance/focus/cropping trouble visible without covering the
  // camera image or adding instructions over it.
  const ordered = [...regions].sort(layoutOrder);
  for (const r of ordered) {
    const decodedAge = now - (r.decodedSeen ?? -Infinity);
    const sightingAge = now - r.seen;
    const successful = decodedAge <= INDICATOR_FADE_MS;
    if (!successful && sightingAge > SIGHTING_FADE_MS) continue;

    const color = captureQualityColor(r);
    overlayCtx.strokeStyle = color;
    overlayCtx.shadowColor = color;
    overlayCtx.shadowBlur = successful ? 5 * dpr : 0;
    overlayCtx.lineWidth = Math.max(successful ? 2.5 : 1.5, (successful ? 2.5 : 1.5) * dpr);
    overlayCtx.setLineDash(successful ? [] : [5 * dpr, 5 * dpr]);
    // Brackets sit just outside the code so they never obscure its modules.
    const pad = 0.06 * Math.max(r.w, r.h) * scale;
    const x = offX + r.x * scale - pad;
    const y = offY + r.y * scale - pad;
    const w = r.w * scale + 2 * pad;
    const h = r.h * scale + 2 * pad;
    const len = 0.24 * Math.min(w, h);
    const age = successful ? decodedAge : sightingAge;
    const fade = successful ? INDICATOR_FADE_MS : SIGHTING_FADE_MS;
    overlayCtx.globalAlpha = successful ? 1 - 0.65 * age / fade : 0.7 * (1 - age / fade);
    overlayCtx.beginPath();
    overlayCtx.moveTo(x, y + len);
    overlayCtx.lineTo(x, y);
    overlayCtx.lineTo(x + len, y);
    overlayCtx.moveTo(x + w - len, y);
    overlayCtx.lineTo(x + w, y);
    overlayCtx.lineTo(x + w, y + len);
    overlayCtx.moveTo(x + w, y + h - len);
    overlayCtx.lineTo(x + w, y + h);
    overlayCtx.lineTo(x + w - len, y + h);
    overlayCtx.moveTo(x + len, y + h);
    overlayCtx.lineTo(x, y + h);
    overlayCtx.lineTo(x, y + h - len);
    overlayCtx.stroke();
  }
  overlayCtx.globalAlpha = 1;
  overlayCtx.shadowBlur = 0;
  overlayCtx.setLineDash([]);
}
startBtn.onclick = () => void start();
window.addEventListener("airgapper:enter-receive", () => {
  if (!stream && !startBtn.disabled) void start();
});

const { setStatus, showError } = statusLine(stats);

/** By the time a transfer ends the camera, worker pool and stats timer are all
 *  torn down and `done` is latched, so a reload is the honest way back to a
 *  live receiver — and it drops the recovered bytes from memory on the way. */
function restartButton(label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary-button";
  button.textContent = label;
  button.addEventListener("click", () => window.location.reload());
  return button;
}

/** Put the page back the way it was so a refused camera can be retried without
 *  a reload. Tapping "Block" by accident on the permission prompt is easy, and
 *  a dead page with no button is a bad answer to it. */
function offerRetry(message: string) {
  startBtn.disabled = false;
  startBtn.hidden = false;
  startBtn.style.display = "";
  startBtn.textContent = "Try camera again";
  preview.style.display = "none";
  metricsEl.style.display = "none";
  if (diagnosticsEl) diagnosticsEl.style.display = "none";
  showError(message);
}

/** Stop every hot-path resource before this in-page view is hidden. */
function stopReceiver(): void {
  captureGen++;
  document.body.classList.remove("receive-complete");
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  clearInterval(statsTimer);
  statsTimer = undefined;
  pool.resize(0);
  decoder = null;
  streamKey = "";
  reportSessionId = 0;
  startTs = 0;
  done = false;
  regions.length = 0;
  expectedRegions = 0;
  expectedRegionsAt = 0;
  lastFullScan = 0;
  cropRotate = 0;
  captureTimes.length = 0;
  decodeTimes.length = 0;
  usefulFrameTimes.length = 0;
  totalCaptures = 0;
  totalDecodes = 0;
  fullScans = 0;
  peakRegions = 0;
  capturesDropped = 0;
  cropsSubmitted = 0;
  trackedDecodes = 0;
  trackedAttempts = 0;
  cameraStartedTs = 0;
  zeroRegionMs = 0;
  degradedMs = 0;
  minSeq = Infinity;
  maxSeq = -1;
  timeline.length = 0;
  result.replaceChildren();
  preview.style.display = "none";
  progressEl.style.display = "none";
  progressEl.setAttribute("aria-valuenow", "0");
  progressStatus.style.display = "none";
  progressLabel.textContent = "0%";
  transferSizeLabel.textContent = "";
  etaLabel.textContent = "Waiting for QR";
  bar.style.width = "0";
  bar.classList.remove("error");
  metricsEl.style.display = "none";
  metric("m-cap").textContent = "— fps";
  metric("m-dec").textContent = "— fps";
  metric("m-rate").textContent = "— KB/s";
  speedFeedback.className = "speed-feedback";
  pipelineMetrics.style.display = "";
  if (diagnosticsEl) {
    diagnosticsEl.style.display = "none";
    diagnosticsEl.open = false;
    const label = diagnosticsEl.querySelector("summary");
    if (label) label.textContent = "Progress and measured KB/s";
  }
  startBtn.disabled = false;
  startBtn.style.display = "";
  startBtn.textContent = "Enable camera";
  setStatus("");
}
window.addEventListener("airgapper:leave-mode", () => {
  if (document.getElementById("receiveView")?.classList.contains("active")) stopReceiver();
});

const localCameraMessage =
  "This browser does not allow camera access from a local file. Use the installed offline PWA for receiving.";

async function start() {
  if (!navigator.mediaDevices?.getUserMedia) {
    // Mobile browsers commonly omit the API entirely for file:// origins.
    showError(
      location.protocol === "file:"
        ? localCameraMessage
        : "Camera access needs HTTPS. Open the hosted app or its installed offline PWA.",
    );
    return;
  }
  const captureWidth = requestedWidth;
  const captureFps = requestedFps;
  // Nothing on the page changes until the camera is actually running: the
  // error paths below all have to leave a usable Start button behind.
  startBtn.disabled = true;
  startBtn.textContent = "Starting…";
  const base: MediaTrackConstraints = {
    facingMode: "environment",
    width: { ideal: captureWidth },
    height: { ideal: Math.round((captureWidth * 3) / 4) },
  };
  try {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, frameRate: { exact: captureFps } },
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, frameRate: { ideal: captureFps } },
      });
    }
  } catch (err) {
    const denied = err instanceof DOMException && err.name === "NotAllowedError";
    offerRetry(
      denied
        ? location.protocol === "file:"
          ? localCameraMessage
          : "Camera permission denied — allow it, then tap Enable camera again."
        : `Camera: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  startBtn.style.display = "none";
  // "": back to the stylesheet's flex — the zone centers the camera box.
  preview.style.display = "";
  metricsEl.style.display = "block";
  progressStatus.style.display = "block";
  progressEl.style.display = "block";
  if (diagnosticsEl) diagnosticsEl.style.display = "block";
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  syncPreviewAspect();
  setStatus("");

  pool.resize(workerCount);
  void applyCameraExtras();

  cameraStartedTs = performance.now();
  captureGen++;
  scheduleFrame(captureGen);
  statsTimer = setInterval(updateStats, STATS_TICK_MS);
  await requestScreenWakeLock();
}

/** Report what the camera actually negotiated — iOS in particular will happily
 *  hand back 30 fps after accepting a request for 60. */
/** Use what this camera can actually do, probed rather than UA-sniffed.
 *  Continuous autofocus is applied silently — a lens hunting between frames is
 *  the top decode killer, and a camera that refuses is left as it was. Frame
 *  rates the current mode can't reach are grayed out. */
async function applyCameraExtras() {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  const caps = probeCameraCapabilities(track);
  if (caps.continuousFocus) {
    await applyAdvancedConstraint(track, { focusMode: "continuous" });
  }
}

type VideoRVFC = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };

function scheduleFrame(gen: number) {
  if (done || gen !== captureGen) return;
  const v = video as VideoRVFC;
  const next = () => {
    if (done || gen !== captureGen) return;
    captureFrame();
    drawOverlay(performance.now());
    scheduleFrame(gen);
  };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(next);
  else requestAnimationFrame(next);
}

const grab = document.createElement("canvas");
let frameId = 0;

// GPU-side capture: createImageBitmap(video, crop) hands each worker a
// transferable bitmap with NO main-thread pixel readback — the worker draws
// it onto an OffscreenCanvas and reads pixels on its own thread. On paper
// this moves ~60 MB/s of GPU→CPU copies off the main thread and
// parallelizes them across the pool.
//
// MEASURED 4× SLOWER on iOS (iPhone, Safari 26): 38% of captures dropped
// pool-busy (vs ~0.5%) and the tracked hit rate halved — Safari's worker-
// side OffscreenCanvas readback is far slower than the main-thread one, and
// its video→bitmap conversion yields subtly different pixels. Opt-in only
// (?capture=bitmap), kept because other engines may genuinely benefit.
const BITMAP_CAPTURE =
  new URLSearchParams(window.location.search).get("capture") === "bitmap" &&
  typeof createImageBitmap === "function" &&
  typeof OffscreenCanvas !== "undefined";

/** Fire-and-forget submit of a GPU-cropped frame. The bitmap resolves async;
 *  by then the pool may have filled or the transfer ended — close it rather
 *  than leak GPU memory. */
function submitBitmap(
  pending: Promise<ImageBitmap>,
  meta: { ox: number; oy: number; full: boolean; quad?: SymbolQuad; dim?: number },
): void {
  void pending
    .then((bitmap) => {
      const taken =
        !done && pool.submit({ id: frameId++, bitmap, ...meta }, [bitmap]);
      if (!taken) bitmap.close();
      else if (!meta.full) cropsSubmitted++;
    })
    .catch(() => undefined);
}

// The stripe-signature dup-skip that used to live here is gone: field runs
// showed screen captures defeat it (sensor noise plus refresh-phase shimmer
// shift the stripe between two captures of the SAME displayed frame — 452
// duplicate decodes leaked through in one 30 fps run), and it was the last
// thing requiring main-thread pixel access. Duplicates now cost one cheap
// tracked decode each, which the pool absorbs without noticing.

function captureFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  const now = performance.now();
  captureTimes.push(now);
  totalCaptures++;
  if (pool.busyCount === pool.size) {
    capturesDropped++;
    return; // all busy — drop it, no harm done
  }

  for (let i = regions.length - 1; i >= 0; i--) {
    if (now - regions[i]!.seen > REGION_TTL_MS) regions.splice(i, 1);
  }
  // Only decode-proven regions count toward "how many codes does this stream
  // show" — phantom sighting regions once inflated the total and locked the
  // receiver into a permanent 250 ms rescan storm. peakRegions is reported as
  // the stream's code count, so it counts proven regions for the same reason.
  const live = decodedCount();
  peakRegions = Math.max(peakRegions, live);
  if (live >= expectedRegions || now - expectedRegionsAt > EXPECTED_REGIONS_DECAY_MS) {
    expectedRegions = live;
    expectedRegionsAt = now;
  }
  const scanInterval =
    live === 0
      ? ACQUISITION_SCAN_MS
      : live < expectedRegions
        ? FULL_SCAN_DEGRADED_MS
        : FULL_SCAN_INTERVAL_MS;
  // A due full scan takes priority over crops, deliberately. The crop loop
  // below fills every free worker slot each frame, so any "only scan when a
  // slot is spare" politeness starves the rescan that reacquires a missing
  // code — tried, and it measurably worsened multi-code lock-on. Scans are
  // rare (1.5 s healthy, 250 ms degraded, 100 ms cold); crops keep the slot
  // next frame — including crops of probationary sighting regions, which now
  // run between cold scans instead of being crowded out by them.
  const fullScanDue = now - lastFullScan > scanInterval;

  if (BITMAP_CAPTURE) {
    if (fullScanDue) {
      lastFullScan = now;
      fullScans++;
      submitBitmap(createImageBitmap(video), { ox: 0, oy: 0, full: true });
      return;
    }
    // The bitmaps resolve async, so "stop when the pool refuses" becomes
    // "create no more than the free slots seen now" — submitBitmap closes
    // any bitmap that loses the race anyway.
    let free = pool.size - pool.busyCount;
    for (let i = 0; i < regions.length && free > 0; i++) {
      const r = regions[(i + cropRotate) % regions.length]!;
      const size = Math.max(r.w, r.h);
      const pad = Math.round(size * REGION_PAD + Math.min(size, 2 * (r.drift ?? 0)));
      const x = Math.max(0, Math.floor(r.x - pad));
      const y = Math.max(0, Math.floor(r.y - pad));
      const w = Math.min(vw - x, Math.ceil(r.w + 2 * pad));
      const h = Math.min(vh - y, Math.ceil(r.h + 2 * pad));
      if (w < 32 || h < 32) continue;
      free--;
      submitBitmap(createImageBitmap(video, x, y, w, h), {
        ox: x,
        oy: y,
        full: false,
        quad: r.quad,
        dim: r.dim,
      });
    }
    cropRotate++;
    return;
  }

  // ---- Readback fallback: browsers without createImageBitmap/OffscreenCanvas.
  if (grab.width !== vw || grab.height !== vh) {
    grab.width = vw;
    grab.height = vh;
  }
  const ctx = grab.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0);
  if (fullScanDue) {
    lastFullScan = now;
    fullScans++;
    const img = ctx.getImageData(0, 0, vw, vh);
    pool.submit(
      { id: frameId++, buf: img.data.buffer, w: vw, h: vh, ox: 0, oy: 0, full: true },
      [img.data.buffer],
    );
    return;
  }
  // One crop per known code, rotated so a short worker pool doesn't starve
  // the same tail region every frame. Submitting stops when the pool is full;
  // the fountain absorbs whatever gets dropped.
  for (let i = 0; i < regions.length; i++) {
    const r = regions[(i + cropRotate) % regions.length]!;
    // The pad leads a moving target: base margin plus twice the displacement
    // observed between the region's last decodes, so a handheld receiver's
    // crops keep containing the code instead of chasing where it was. Capped
    // at one code size — past that the crop approaches frame-sized anyway.
    const size = Math.max(r.w, r.h);
    const pad = Math.round(size * REGION_PAD + Math.min(size, 2 * (r.drift ?? 0)));
    const x = Math.max(0, Math.floor(r.x - pad));
    const y = Math.max(0, Math.floor(r.y - pad));
    const w = Math.min(vw - x, Math.ceil(r.w + 2 * pad));
    const h = Math.min(vh - y, Math.ceil(r.h + 2 * pad));
    if (w < 32 || h < 32) continue;
    const img = ctx.getImageData(x, y, w, h);
    // The quad + dimension arm the worker's tracked fast path (detection
    // skipped entirely, 2× at V40); absent — or stale after a miss — the
    // worker falls back to the stock decoder on the same buffer.
    const taken = pool.submit(
      { id: frameId++, buf: img.data.buffer, w, h, ox: x, oy: y, full: false, quad: r.quad, dim: r.dim },
      [img.data.buffer],
    );
    if (!taken) break;
    cropsSubmitted++;
  }
  cropRotate++;
}

function onDecoded(bytes: Uint8Array, box?: SymbolBox, info?: SymbolInfo) {
  decodeTimes.push(performance.now());
  totalDecodes++;
  if (info?.tracked) trackedDecodes++;
  if (box) noteRegion(box, performance.now(), true, info);
  const parsed = parseFrame(bytes);
  if (!parsed || done) return;
  const { header, block } = parsed;
  // streamIdentity() covers every header field that has to hold constant, not
  // just the session id — see the note on it in protocol.ts.
  const identity = streamIdentity(header);
  if (!decoder || streamKey !== identity) {
    decoder = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
    usefulFrameTimes.length = 0;
    streamKey = identity;
    reportSessionId = header.sessionId;
    startTs = performance.now();
    progressEl.style.display = "block";
    progressStatus.style.display = "block";
  }
  minSeq = Math.min(minSeq, header.seq);
  maxSeq = Math.max(maxSeq, header.seq);
  const usefulBefore = decoder.framesNew - decoder.framesRedundant;
  decoder.addFrame(header.seq, block);
  if (decoder.framesNew - decoder.framesRedundant > usefulBefore) {
    usefulFrameTimes.push(performance.now());
  }
  updateProgressEstimate();

  if (decoder.isComplete) {
    const payload = decoder.assemble()!;
    const seconds = (performance.now() - startTs) / 1000;
    const ok = fnv1a(payload) === header.payloadFnv;
    void finish(payload, ok, seconds);
  }
}

function updateProgressEstimate() {
  if (!decoder) return;
  const elapsed = Math.max(0, (performance.now() - startTs) / 1000);
  // Progress runs on frames that carried INFORMATION, not raw arrivals. On a
  // lossy multi-code run the carousel re-sweeps blocks this receiver already
  // solved; each re-sweep frame has a fresh seq, so framesNew inflates by the
  // loss rate — a 30%-catch 4-code run showed 96% on the bar with half the
  // blocks outstanding, then "finished early". framesRedundant subtracts
  // exactly those empty arrivals.
  const usefulFrames = decoder.framesNew - decoder.framesRedundant;
  const estimate = estimateTransferProgress(
    decoder.k,
    usefulFrames,
    elapsed,
    decoder.solvedCount,
  );
  const percent = estimate.fraction * 100;
  const shownPercent = percent < 10 ? percent.toFixed(1) : percent.toFixed(0);
  bar.style.width = `${percent.toFixed(1)}%`;
  progressEl.setAttribute("aria-valuenow", String(Math.floor(percent)));
  progressLabel.textContent = `${shownPercent}%`;
  const remainingBytes = Math.max(1, Math.ceil(decoder.totalLen * (1 - estimate.fraction)));
  transferSizeLabel.textContent = formatBytes(remainingBytes);
  const liveKbs = liveGoodputKbs(performance.now());
  const liveUsefulFps = liveKbs > 0
    ? liveKbs * 1024 * expectedFountainOverhead(decoder.k) / decoder.blockLen
    : 0;
  etaLabel.textContent = liveUsefulFps > 0 && usefulFrames >= 3
    ? `${formatDuration(estimate.remainingFrames / liveUsefulFps)} left`
    : "Estimating…";
}

/** One-second information goodput for live aiming feedback. The completed
 * transfer still reports verified original bytes divided by total time. */
function liveGoodputKbs(now: number): number {
  while (usefulFrameTimes.length && usefulFrameTimes[0]! <= now - LIVE_RATE_WINDOW_MS) {
    usefulFrameTimes.shift();
  }
  if (!decoder || !usefulFrameTimes.length) return 0;
  if (now - usefulFrameTimes[usefulFrameTimes.length - 1]! >= LIVE_RATE_ZERO_MS) return 0;
  const observedSeconds = Math.min(1, Math.max(0.25, (now - startTs) / 1000));
  return usefulFrameTimes.length * decoder.blockLen /
    expectedFountainOverhead(decoder.k) / 1024 / observedSeconds;
}

async function finish(container: Uint8Array, hashOk: boolean, seconds: number) {
  done = true;
  captureGen++;
  // Snapshot diagnostics before teardown, but do not report success until the
  // recovered output passes SHA-256. Goodput is unique original-file bytes
  // divided by time through verification, never projected frame capacity.
  let diagnosticsBase: Record<string, unknown> | null = null;
  if (import.meta.env.DEV && import.meta.env.VITE_DIAGNOSTICS === "1") {
    const track = stream?.getVideoTracks()[0];
    const camera = track?.getSettings();
    const seqSpan = maxSeq >= minSeq ? maxSeq - minSeq + 1 : 0;
    const parsed = (decoder?.framesNew ?? 0) + (decoder?.framesDup ?? 0);
    diagnosticsBase = {
      role: "receiver",
      when: new Date().toISOString(),
      sessionId: reportSessionId,
      acquisitionSeconds: cameraStartedTs ? Number(((startTs - cameraStartedTs) / 1000).toFixed(2)) : null,
      payloadSha256: [...container.slice(17, 49)].map((b) => b.toString(16).padStart(2, "0")).join(""),
      fountain: {
        k: decoder?.k,
        blockLen: decoder?.blockLen,
        framesNew: decoder?.framesNew,
        framesDup: decoder?.framesDup,
        framesRedundant: decoder?.framesRedundant,
        overhead: decoder ? Number((decoder.framesNew / decoder.k).toFixed(2)) : null,
        usefulOverhead: decoder ? Number(((decoder.framesNew - decoder.framesRedundant) / decoder.k).toFixed(2)) : null,
        seqSpan,
        catchRate: seqSpan ? Number((parsed / seqSpan).toFixed(3)) : null,
      },
      codes: peakRegions,
      pipeline: {
        captureMode: BITMAP_CAPTURE ? "bitmap" : "readback",
        captures: totalCaptures,
        capturesDroppedPoolBusy: capturesDropped,
        cropsSubmitted,
        fullScans,
        decodes: totalDecodes,
        trackedAttempts,
        trackedDecodes,
        zeroRegionMs,
        degradedMs,
      },
      workers: pool.size,
      requested: { width: requestedWidth, fps: requestedFps, workers: workerCount },
      camera: camera ? { width: camera.width, height: camera.height, fps: camera.frameRate, facingMode: camera.facingMode ?? null } : null,
      cameraCapabilities: track ? probeCameraCapabilities(track) : null,
      device: { cores: navigator.hardwareConcurrency ?? null, ua: navigator.userAgent },
      timelineKey: "seconds, framesNew, solvedBlocks, decodedRegions, trackedRegions, captureFps, decodeFps, fullScansCumulative",
      timeline,
    };
  }
  let diagnosticsSent = false;
  const sendDiagnostics = (ok: boolean, finalSeconds: number, uniqueBytes: number) => {
    if (!diagnosticsBase || diagnosticsSent) return;
    diagnosticsSent = true;
    void fetch("/__diagnostics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...diagnosticsBase,
        ok,
        sha256Verified: ok,
        seconds: Number(finalSeconds.toFixed(2)),
        payloadBytes: uniqueBytes,
        goodputKBs: ok ? Number((uniqueBytes / 1024 / Math.max(0.01, finalSeconds)).toFixed(1)) : 0,
      }),
    }).catch(() => undefined);
  };
  // Tear the whole capture pipeline down: the camera, the stats timer, and the
  // decode pool. Each worker holds its own ~940 KB zxing WASM instance, which
  // is worth reclaiming on a phone the moment the last frame is in.
  stream?.getTracks().forEach((t) => t.stop());
  clearInterval(statsTimer);
  statsTimer = undefined;
  pool.resize(0);
  preview.style.display = "none";
  // The metrics stay, frozen at their last tick — but "Live" is no longer
  // true, so the panel relabels itself as the record of the run it now is.
  const diagnosticsLabel = diagnosticsEl?.querySelector("summary");
  if (diagnosticsLabel) diagnosticsLabel.textContent = "Transfer summary";
  bar.style.width = "100%";
  progressEl.setAttribute("aria-valuenow", "100");
  transferSizeLabel.textContent = "";
  etaLabel.textContent = `${formatDuration(seconds)} total`;
  try {
    if (!hashOk) throw new Error("The optical stream checksum did not match.");
    const file = await unpackFile(container);
    if (!(await verifyFile(file))) throw new Error("The recovered file failed SHA-256 verification.");
    seconds = (performance.now() - startTs) / 1000;
    document.body.classList.add("receive-complete");
    // Restore the root scroller so mobile browsers can use their normal
    // pull-to-refresh gesture on the completed screen.
    document.body.classList.remove("receive-mode");
    transferSizeLabel.textContent = "";
    etaLabel.textContent = `${formatBytes(file.bytes.length)} · ${formatDuration(seconds)}`;
    pipelineMetrics.style.display = "none";
    sendDiagnostics(true, seconds, file.bytes.length);

    // The container carries its own media type, so the receiver never has to be
    // told in advance whether a file or a text snippet is coming. The displayed
    // rate is complete, unique original-file goodput through SHA verification.
    const rate = (file.bytes.length / 1024 / seconds).toFixed(1);
    metric("m-rate").textContent = `${rate} KB/s`;
    speedFeedback.className = "speed-feedback speed-good";
    if (isSnippet(file)) {
      progressLabel.textContent = "100%";
      setStatus("");
      showSnippet(snippetText(file));
      return;
    }

    progressLabel.textContent = "100%";
    setStatus("");
    const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.type }));
    const download = document.createElement("a");
    download.className = "download";
    download.href = url;
    download.download = file.name;
    download.textContent = `Save ${file.name}`;
    result.replaceChildren();
    if (file.type.startsWith("image/")) {
      const image = document.createElement("img");
      image.className = "received";
      image.alt = `Received file preview: ${file.name}`;
      image.src = url;
      result.append(image);
    } else if (file.type.startsWith("video/") || file.type.startsWith("audio/")) {
      const player = document.createElement(file.type.startsWith("video/") ? "video" : "audio");
      player.className = "received";
      player.controls = true;
      player.preload = "metadata";
      player.setAttribute("aria-label", `Received file: ${file.name}`);
      // Inline, and never autoplay — the user taps play (which is also the
      // gesture that lets it start with sound).
      if (player instanceof HTMLVideoElement) player.playsInline = true;
      const src = await servableMediaUrl(file, url);
      if (src !== url) {
        // AVFoundation has been seen bypassing service workers for media
        // loads; if the cache path 404s, fall back to the blob rather than
        // leaving a dead player.
        player.addEventListener("error", () => { player.src = url; }, { once: true });
      }
      player.src = src;
      result.append(player);
    }
    const actions = document.createElement("div");
    actions.className = "note-actions";
    actions.append(download);
    result.append(actions);
  } catch (error) {
    sendDiagnostics(false, (performance.now() - startTs) / 1000, 0);
    // Everything is already torn down by this point, so the only way back to a
    // live receiver is a reload. Offer it: a failed checksum used to leave the
    // page dead with nothing but an error string on it.
    bar.classList.add("error");
    etaLabel.textContent = "Transfer failed";
    speedFeedback.className = "speed-feedback speed-low";
    showError(error instanceof Error ? error.message : String(error));
    const heading = document.createElement("div");
    heading.className = "failed";
    heading.textContent = "Transfer failed";
    const detail = document.createElement("p");
    detail.className = "received-note";
    detail.textContent =
      "Nothing usable came out of that stream. Restart the sender, then scan it again — " +
      "a partial transfer costs nothing but the time.";
    result.replaceChildren(heading, detail, restartButton("Try again"));
  }
}

/** A playable URL for received media. iOS Safari will not reliably play media
 *  handed to <video>/<audio> as a blob: URL — WebKit's media loader wants real
 *  HTTP semantics, Range requests included (a lesson inherited from the
 *  baseline receiver's range-shim worker). The bytes go into the Cache API and
 *  come back out through the service worker's range-aware route at a real URL
 *  (see runtimeCaching in vite.config.ts). The blob URL stands in when no
 *  worker controls the page: first ever visit, or the standalone file. */
async function servableMediaUrl(file: OpticalFile, blobUrl: string): Promise<string> {
  try {
    if (!navigator.serviceWorker?.controller) return blobUrl;
    // Resolved against the page (one directory deep), landing on the site
    // root — where the worker's route matches under any deploy subpath.
    const target = new URL("../received-media/current", window.location.href).href;
    const cache = await caches.open("received-media");
    await cache.put(
      target,
      new Response(new Blob([file.bytes as BlobPart]), {
        headers: {
          "Content-Type": file.type,
          "Content-Length": String(file.bytes.length),
        },
      }),
    );
    // The query defeats the media element's memory of this URL from an
    // earlier transfer; the worker matches with ignoreSearch.
    return `${target}?v=${Date.now()}`;
  } catch {
    return blobUrl;
  }
}

/** Nothing is persisted: the text lives here until the page is closed. */
function showSnippet(text: string) {
  const body = document.createElement("p");
  body.className = "received-note";
  body.textContent = text;

  const actions = document.createElement("div");
  actions.className = "note-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "text-button";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy"; }, 1500);
    } catch {
      copy.textContent = "Copy failed";
    }
  });
  actions.append(copy);

  result.replaceChildren(body, actions);
}

function updateStats() {
  if (done) return;
  const now = performance.now();
  const prune = (a: number[]) => {
    while (a.length > 0 && a[0]! < now - STATS_WINDOW_MS) a.shift();
  };
  prune(captureTimes);
  prune(decodeTimes);
  const perSecond = (a: number[]) => a.length / (STATS_WINDOW_MS / 1000);
  metric("m-cap").textContent = `${perSecond(captureTimes).toFixed(0)} fps`;
  metric("m-dec").textContent = `${perSecond(decodeTimes).toFixed(1)} fps`;
  if (!decoder) return;
  const elapsed = (now - startTs) / 1000;
  // Diagnostics accounting, gated on a running transfer so camera-pointing
  // time doesn't pollute it. Tick granularity matches this timer. Decode-
  // proven regions are the signal, matching the scheduler: a probationary
  // sighting region must not mask a missing code (degradedMs) or hide a full
  // tracking collapse (zeroRegionMs). The timeline carries BOTH counts so
  // phantom churn stays visible next to the real one.
  const liveNow = decodedCount();
  if (liveNow === 0) zeroRegionMs += STATS_TICK_MS;
  if (liveNow < expectedRegions) degradedMs += STATS_TICK_MS;
  if (timeline.length < TIMELINE_MAX_SAMPLES) {
    timeline.push([
      Number(elapsed.toFixed(1)),
      decoder.framesNew,
      decoder.solvedCount,
      liveNow,
      regions.length,
      Number(perSecond(captureTimes).toFixed(1)),
      Number(perSecond(decodeTimes).toFixed(1)),
      fullScans,
    ]);
  }
  updateProgressEstimate();
  const liveRate = liveGoodputKbs(now);
  metric("m-rate").textContent = `${liveRate.toFixed(1)} KB/s`;
  const qualityClass = liveRate < 5
    ? "speed-low"
    : liveRate < 25
      ? "speed-mid"
      : liveRate < 75
        ? "speed-good"
        : "speed-high";
  speedFeedback.className = `speed-feedback ${qualityClass}`;

}
