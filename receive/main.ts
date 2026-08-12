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
  completedGoodputKbs,
  estimateTransferProgress,
  expectedFountainOverhead,
  formatDuration,
} from "../shared/progress";
import { createDecodeWorker } from "./worker-factory";
import {
  DecodeWorkerPool,
  type DecodeCompletion,
  type SymbolBox,
  type SymbolInfo,
  type SymbolQuad,
} from "../shared/worker-pool";
import { PlainQrPolicy } from "../shared/plain-qr-policy";
import { isSnippet, snippetText } from "../shared/snippet";
import {
  FRAME_CRC_LEN,
  HEADER_LEN,
  fnv1a,
  parseFrame,
  streamIdentity,
  unpackFile,
  verifyFile,
} from "../shared/protocol";
import { statusLine } from "../shared/status-line";
import { releaseScreenWakeLock, requestScreenWakeLock } from "../shared/wake-lock";
import { applyAdvancedConstraint, probeCameraCapabilities } from "../shared/platform";
import {
  copyTextOnAndroid,
  isAndroidApp,
  recoverAndroidCamera,
  reportAndroidCameraHealthy,
  saveFileOnAndroid,
} from "../shared/android";
import { readStoredZip, type ZipEntry } from "../shared/zip";

const startBtn = document.getElementById("start") as HTMLButtonElement;
const cameraResolution = document.getElementById("camera-resolution") as HTMLSelectElement;
const cameraFps = document.getElementById("camera-fps") as HTMLSelectElement;
const decodeWorkers = document.getElementById("decode-workers") as HTMLSelectElement;
const cameraActual = document.getElementById("camera-actual")!;
const captureScanBtn = document.getElementById("capture-scan") as HTMLButtonElement;
const scanDialog = document.getElementById("scan-dialog") as HTMLDialogElement;
const closeScanBtn = document.getElementById("close-scan") as HTMLButtonElement;
const scanDialogStatus = document.getElementById("scan-dialog-status")!;
const scanSightingLegend = document.getElementById("scan-sighting-legend")!;
const scanCapture = document.getElementById("scan-capture") as HTMLCanvasElement;
const video = document.getElementById("video") as HTMLVideoElement;
const preview = document.getElementById("preview")!;
const cameraBox = document.querySelector<HTMLDivElement>(".preview")!;
const overlay = document.getElementById("detect-overlay") as HTMLCanvasElement;
const showDetectionOverlay = !isAndroidApp();
overlay.hidden = !showDetectionOverlay;
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
const hardwareThreadCount = Math.max(1, navigator.hardwareConcurrency || 2);
// Leave cores for camera delivery, compositing, and the main thread. More than
// four independent WASM instances has only increased contention on phones.
const autoWorkerCount = Math.max(1, Math.min(4, hardwareThreadCount - 2));
const autoWorkerOption = decodeWorkers.querySelector<HTMLOptionElement>('option[value="auto"]')!;
autoWorkerOption.textContent = `Auto (${autoWorkerCount})`;
for (let count = 1; count <= hardwareThreadCount; count++) {
  decodeWorkers.add(new Option(String(count), String(count)));
}
function selectedWorkerCount(): number {
  return decodeWorkers.value === "auto"
    ? autoWorkerCount
    : Math.max(1, Math.min(hardwareThreadCount, Number(decodeWorkers.value) || autoWorkerCount));
}
// Camera maximum resolution is not maximum optical throughput: a 4K video
// frame is 9× the pixels of 1280×960, and the synchronous canvas readback can
// collapse an older phone to ~2 fps. 1280 keeps V40 modules comfortably large
// while leaving enough CPU budget for capture and decode.
const CAMERA_SETTINGS_KEY = "airgapper:camera-settings:v1";
const CAMERA_RESOLUTIONS = {
  "640x480": { width: 640, height: 480 },
  "960x720": { width: 960, height: 720 },
  "1280x960": { width: 1280, height: 960 },
  "1920x1080": { width: 1920, height: 1080 },
} as const;
type CameraResolution = keyof typeof CAMERA_RESOLUTIONS;

function restoreCameraSettings(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(CAMERA_SETTINGS_KEY) ?? "null") as {
      resolution?: unknown;
      fps?: unknown;
      workers?: unknown;
    } | null;
    if (!saved) return;
    if (typeof saved.resolution === "string" && saved.resolution in CAMERA_RESOLUTIONS) {
      cameraResolution.value = saved.resolution;
    }
    if (saved.fps === "auto" || saved.fps === "30" || saved.fps === "60") cameraFps.value = saved.fps;
    const savedWorkers = Number(saved.workers);
    if (saved.workers === "auto" || (Number.isInteger(savedWorkers) && savedWorkers >= 1 && savedWorkers <= hardwareThreadCount)) {
      decodeWorkers.value = String(saved.workers);
    }
  } catch {
    // Camera defaults still work when storage is unavailable or corrupt.
  }
}

function saveCameraSettings(): void {
  try {
    localStorage.setItem(CAMERA_SETTINGS_KEY, JSON.stringify({
      resolution: cameraResolution.value,
      fps: cameraFps.value,
      workers: decodeWorkers.value,
    }));
  } catch {
    // A blocked store must never prevent camera use.
  }
}

restoreCameraSettings();
let requestedWidth = CAMERA_RESOLUTIONS[cameraResolution.value as CameraResolution].width;
let requestedHeight = CAMERA_RESOLUTIONS[cameraResolution.value as CameraResolution].height;
let requestedFps = cameraFps.value === "auto" ? undefined : Number(cameraFps.value);
function showRequestedCameraSettings(): void {
  const fps = requestedFps === undefined ? "auto fps" : `${requestedFps} fps`;
  cameraActual.textContent = `${requestedWidth}×${requestedHeight} · ${fps}`;
  // Size the reserved viewfinder from the selected capture shape immediately;
  // metadata will replace this with the negotiated camera shape once available.
  cameraBox.style.aspectRatio = `${requestedWidth} / ${requestedHeight}`;
}
showRequestedCameraSettings();
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
const plainQrDecoder = new TextDecoder("utf-8", { fatal: true });
const plainQrPolicy = new PlainQrPolicy();

const pool = new DecodeWorkerPool(
  createDecodeWorker,
  (bytes, box, info) => onDecoded(bytes, box, info),
  // A sighting is a detected-but-undecoded code: no bytes, but a position.
  // Heavily gated in noteRegion (refresh-only on matches, size-checked on
  // creation) because failed quads are often junk — but a plausible one lets
  // the crop path go decode what the full frame could not.
  (box) => noteRegion(box, performance.now(), false),
  () => trackedAttempts++,
  (id, completion) => noteDecodeCompleted(id, completion),
);
const captureTimes: number[] = [];
// Distinct sender symbols acquired, not successful attempts. A 10 fps
// single-code sender can therefore never misleadingly read as 30 QR/s merely
// because the camera decoded the same displayed symbol three times.
const qrReadTimes: number[] = [];
const poolBusyTimes: number[] = [];
const scanCompletionTimes: number[] = [];
// Timestamps of frames that contributed new fountain information. Unlike the
// transfer-wide average, this window drops immediately when optical lock is
// lost, so the speed display works as aiming feedback.
const usefulFrameTimes: number[] = [];

// Run-level totals for the diagnostics report (npm run diagnostics). The
// The live timestamp windows above are pruned for the UI rates and cannot
// answer "how much, in total, did this run do".
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
let cameraHealthyReported = false;
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
  id: number;
  seen: number;
  /** True once bytes have actually decoded here. Sighting-only regions are
   *  probationary: they get crops, but they are not drawn, not counted
   *  toward the expected code total, and evicted first. */
  decoded: boolean;
  /** Last successful byte decode. Detector sightings are tracked separately:
   * they may draw feedback, but cannot make a stale decode-proven region live. */
  decodedSeen?: number;
  sightedSeen?: number;
  /** Distinct sender symbols seen recently. Keeping the sequence itself makes
   * late worker replies harmless: an older frame can fill a gap instead of
   * being discarded merely because a newer worker finished first. */
  sequenceSamples: { seq: number; at: number }[];
  seqStep?: number;
  qualityLevel: number;
  /** How far the code moved between its last two decodes, in capture px —
   *  a handheld receiver's crops must lead the target, not chase it. */
  drift?: number;
  /** Corner quad + module count of the last decode here — the tracked fast
   *  path in the worker rebuilds its sampling transform from these and skips
   *  detection entirely. Only ever set from real decodes. */
  quad?: SymbolQuad;
  dim?: number;
  crc32?: boolean;
  consecutiveMisses: number;
}
const regions: Region[] = [];
let nextRegionId = 1;
// Retain one trustworthy size after active regions expire. During a bad
// camera/display phase, full acquisition may detect a QR but fail its bytes;
// this yardstick lets that sighting seed a crop instead of leaving the receiver
// stuck with no regions and throwing the useful position away.
let lastDecodedRegionSize = 0;
// Crop replies retain the exact anchor they attempted, so a miss can
// invalidate stale tracked geometry without clobbering a newer worker's hit.
type CropAttempt = { region: Region; quad?: SymbolQuad };
const cropAttempts = new Map<number, CropAttempt[]>();
function regionInflightCount(region: Region): number {
  let count = 0;
  for (const attempts of cropAttempts.values()) {
    if (attempts.some((attempt) => attempt.region === region)) count++;
  }
  return count;
}

// Bounded pipeline evidence for diagnostics builds. These distinguish an idle
// scheduler from decoder misses without turning every camera frame into a log.
let schedulerNoJobs = 0;
let cropMisses = 0;
let fullDetectorMisses = 0;
let fullSightings = 0;
let trackedMissFallbacks = 0;
let decodeExceptions = 0;
let regionExpiries = 0;
let regionCreations = 0;
let trackingInvalidations = 0;
let completedJobs = 0;
let workerLatencyTotalMs = 0;
let workerLatencyMaxMs = 0;
let lastDistinctArrivalAt = 0;
let maxSequenceGapMs = 0;
const pipelineEvents: [number, string, number][] = [];
const PIPELINE_EVENT_LIMIT = 80;

function notePipelineEvent(kind: string, value = 0): void {
  if (pipelineEvents.length >= PIPELINE_EVENT_LIMIT) return;
  pipelineEvents.push([
    Number(((performance.now() - cameraStartedTs) / 1000).toFixed(2)),
    kind,
    value,
  ]);
}

const QUALITY_WINDOW_MS = 3000;

function pruneSequenceSamples(region: Region, now: number): void {
  while (region.sequenceSamples.length && region.sequenceSamples[0]!.at < now - QUALITY_WINDOW_MS) {
    region.sequenceSamples.shift();
  }
}

function noteSequence(region: Region, seq: number, now: number): void {
  // Sequence numbers are global across the grid, so one cell normally advances
  // by the number of cells. The high-water count is stable through a temporary
  // lost region and is 1 for the common single-code sender.
  const step = Math.max(1, expectedRegions);
  if (region.seqStep !== step) {
    region.seqStep = step;
    region.sequenceSamples.length = 0;
    region.qualityLevel = 0;
  }
  pruneSequenceSamples(region, now);
  // Camera frames are pipelined through several workers and can complete out of
  // order. Retain every distinct sequence in the window so a late completion
  // fills the gap that it actually fills. Re-reading one displayed symbol is
  // neutral: it proves the image still decodes, but not that another sender
  // frame was caught.
  if (!region.sequenceSamples.some((sample) => sample.seq === seq)) {
    region.sequenceSamples.push({ seq, at: now });
    region.sequenceSamples.sort((a, b) => a.at - b.at);
  }
}

function noteDecodeCompleted(id: number, completion: DecodeCompletion): void {
  scanCompletionTimes.push(performance.now());
  completedJobs++;
  workerLatencyTotalMs += completion.latencyMs;
  workerLatencyMaxMs = Math.max(workerLatencyMaxMs, completion.latencyMs);
  if (completion.error) {
    decodeExceptions++;
    notePipelineEvent("decode-exception", decodeExceptions);
  }
  if (completion.full) {
    fullSightings += completion.sightingCount;
    if (completion.symbolCount === 0 && completion.sightingCount === 0) fullDetectorMisses++;
  } else if (completion.symbolCount === 0) {
    cropMisses++;
  }
  if (completion.trackedAttempted && !completion.trackedHit && completion.fallbackAttempted) {
    trackedMissFallbacks++;
  }

  finishScanCapture(id, completion);
  const attempts = cropAttempts.get(id);
  cropAttempts.delete(id);
  if (!attempts || completion.symbolCount > 0) return;
  // A tracked miss says this camera frame was unreadable; it does not prove the
  // remembered location is wrong. Keep geometry available for later frames and
  // use the miss count only to trigger aggressive full-frame reacquisition.
  for (const attempt of attempts) {
    if (attempt.region.quad === attempt.quad) attempt.region.consecutiveMisses++;
  }
}

// Tried and reverted: a longer TTL for regions with a decode track record
// (6 s after 5 hits). It measured WORSE — a stale region squats on crop
// slots at a dead position, and by keeping regions.length looking healthy it
// suppresses the degraded rescan cadence exactly when reacquisition is
// needed. Expiring fast and rescanning hard wins.
const REGION_TTL_MS = 5000;
// A probationary detector sighting has no decodedSeen timestamp; keeping it
// through several cold full scans gives its cheap crop path time to recover.
const SIGHTING_REGION_TTL_MS = 3000;
// Tracking only revisits known positions, so it cannot discover a larger grid.
// Keep acquisition sparse enough not to disrupt preview, but frequent enough
// that one early decode cannot masquerade as the complete layout.
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
// Keep one tracked region for every cell in the densest 3×5 layout.
const MAX_REGIONS = 15;
const REGION_PAD = 0.35;
let cropRotate = 0;
let lastFullScan = 0;
let expectedRegions = 0;
let expectedRegionsAt = 0;

function decodedCount(): number {
  let n = 0;
  for (const r of regions) if (r.decoded) n++;
  return n;
}

function regionAt(box: SymbolBox): Region | undefined {
  return regions.find((r) => {
    const dx = Math.abs(box.x + box.w / 2 - (r.x + r.w / 2));
    const dy = Math.abs(box.y + box.h / 2 - (r.y + r.h / 2));
    return dx < Math.max(box.w, r.w) / 2 && dy < Math.max(box.h, r.h) / 2;
  });
}

function noteRegion(box: SymbolBox, now: number, decoded = true, info?: SymbolInfo): void {
  for (const r of regions) {
    const dx = Math.abs(box.x + box.w / 2 - (r.x + r.w / 2));
    const dy = Math.abs(box.y + box.h / 2 - (r.y + r.h / 2));
    if (dx < Math.max(box.w, r.w) / 2 && dy < Math.max(box.h, r.h) / 2) {
      if (!decoded) {
        // A sighting is an eyewitness report, not a successful track. It may
        // keep a probationary crop alive, but must not keep a decode-proven
        // region counted as healthy forever. Otherwise repeated error results
        // suppress cold full-frame reacquisition during the exact stall they
        // are reporting.
        r.sightedSeen = now;
        if (!r.decoded) r.seen = now;
        return;
      }
      // Half-life blend of per-decode displacement: steady hands decay it to
      // zero, a moving hand keeps the crop padding wide (see captureFrame).
      r.drift = 0.5 * (r.drift ?? 0) + 0.5 * Math.hypot(dx, dy);
      Object.assign(r, box, { seen: now });
      r.decoded = true;
      r.decodedSeen = now;
      r.sightedSeen = now;
      lastDecodedRegionSize = Math.max(box.w, box.h);
      if (info?.quad) r.quad = info.quad;
      if (info?.modules) r.dim = info.modules;
      if (info?.crc32 !== undefined) r.crc32 = info.crc32;
      r.consecutiveMisses = 0;
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
    const referenceSize = reference ? Math.max(reference.w, reference.h) : lastDecodedRegionSize;
    if (!referenceSize) return;
    const ratio = Math.max(box.w, box.h) / referenceSize;
    if (ratio < 0.5 || ratio > 2) return;
    // Error-result quads wobble and split while a display transition is in
    // flight. Never draw more probationary regions than the number of codes
    // currently missing from the layout high-water mark; for a single sender
    // this turns the detector's several guesses back into one error outline.
    const missing = Math.max(1, expectedRegions - decodedCount());
    const probationary = regions.filter((r) => !r.decoded);
    if (probationary.length >= missing) {
      const existing = probationary.reduce((a, b) => a.seen > b.seen ? a : b);
      existing.seen = now;
      existing.sightedSeen = now;
      return;
    }
  }
  if (decoded) lastDecodedRegionSize = Math.max(box.w, box.h);
  regions.push({
    ...box,
    id: nextRegionId++,
    seen: now,
    decoded,
    decodedSeen: decoded ? now : undefined,
    sightedSeen: now,
    sequenceSamples: [],
    qualityLevel: 0,
    quad: info?.quad,
    dim: info?.modules,
    crc32: info?.crc32,
    consecutiveMisses: 0,
  });
  regionCreations++;
  notePipelineEvent(decoded ? "region-decoded-created" : "region-sighting-created", regions.length);
  if (regions.length > MAX_REGIONS) {
    regions.sort((a, b) => Number(b.decoded) - Number(a.decoded) || b.seen - a.seen);
    regions.length = MAX_REGIONS;
  }
}

/** The selected resolution reserves the initial camera box. Cameras can still
 *  negotiate a different shape, so metadata replaces that estimate with the
 *  stream's real dimensions. With the aspect matched, contain shows every
 *  capture pixel edge to edge. */
function syncPreviewAspect() {
  if (video.videoWidth && video.videoHeight) {
    cameraBox.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  }
}
// Fires whenever the intrinsic size changes — device rotation, or a live
// capture-width change the camera accepted.
video.addEventListener("resize", syncPreviewAspect);
video.addEventListener("loadedmetadata", syncPreviewAspect);
window.addEventListener("resize", syncPreviewAspect);

// Viewfinder corner brackets around each code the decoder is tracking, fading
// out once a region stops producing decodes. Long before REGION_TTL_MS: the
// brackets answer "is it reading THIS code right now", so they should die as
// soon as the answer stops being yes, while the crop tracker keeps trying.
const INDICATOR_FADE_MS = 700;
const SIGHTING_FADE_MS = 450;
const MAX_QR_MODULES = 177;
const BLUE_MIN_PIXELS_PER_MODULE = 4.5;
const overlayCtx = overlay.getContext("2d")!;

function captureQualityRate(region: Region, now: number): number {
  pruneSequenceSamples(region, now);
  if (region.sequenceSamples.length < 2) return 0;
  const sequences = region.sequenceSamples.map((sample) => sample.seq);
  const span = Math.max(...sequences) - Math.min(...sequences);
  const opportunities = Math.max(1, Math.round(span / Math.max(1, region.seqStep ?? 1)) + 1);
  // One prior miss makes a newly found code earn confidence instead of turning
  // blue from two lucky frames. Its influence naturally vanishes during a
  // sustained run, unlike the old fixed 20-result history.
  return Math.min(1, region.sequenceSamples.length / (opportunities + 1));
}

function hasDensityHeadroom(region: Region): boolean {
  if (!region.quad || !region.dim || region.dim >= MAX_QR_MODULES) return false;
  const corners = [
    region.quad.topLeft,
    region.quad.topRight,
    region.quad.bottomRight,
    region.quad.bottomLeft,
  ];
  let shortestEdge = Infinity;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    shortestEdge = Math.min(shortestEdge, Math.hypot(a.x - b.x, a.y - b.y));
  }
  return shortestEdge / region.dim >= BLUE_MIN_PIXELS_PER_MODULE;
}

function captureQualityColor(region: Region, rate: number): string {
  const headroom = hasDensityHeadroom(region);
  // Separate enter/leave thresholds keep an established indication from
  // flickering on one miss while still allowing a serious gap to fall quickly.
  let level = 0;
  if ((rate >= 0.95 || (region.qualityLevel === 4 && rate >= 0.9)) && headroom) level = 4;
  else if (rate >= 0.9 || (region.qualityLevel >= 3 && rate >= 0.84)) level = 3;
  else if (rate >= 0.75 || (region.qualityLevel >= 2 && rate >= 0.68)) level = 2;
  else if (rate >= 0.4 || (region.qualityLevel >= 1 && rate >= 0.33)) level = 1;
  region.qualityLevel = level;
  return ["#ff665c", "#ffb23e", "#a9c93d", "#35d66f", "#42e8ff"][level]!;
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
    const sightingAge = now - (r.sightedSeen ?? r.seen);
    const successful = decodedAge <= INDICATOR_FADE_MS;
    if (!successful && sightingAge > SIGHTING_FADE_MS) continue;

    const quality = captureQualityRate(r, now);
    const color = captureQualityColor(r, quality);
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
const changeCameraSettings = () => {
  const selected = CAMERA_RESOLUTIONS[cameraResolution.value as CameraResolution];
  requestedWidth = selected.width;
  requestedHeight = selected.height;
  requestedFps = cameraFps.value === "auto" ? undefined : Number(cameraFps.value);
  showRequestedCameraSettings();
  saveCameraSettings();
  if (stream && !done) {
    stopReceiver();
    void start();
  }
};
cameraResolution.addEventListener("change", changeCameraSettings);
cameraFps.addEventListener("change", changeCameraSettings);
decodeWorkers.addEventListener("change", changeCameraSettings);
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
  preview.style.display = "";
  preview.classList.remove("camera-loading");
  metricsEl.style.display = "block";
  progressStatus.style.display = "block";
  progressEl.style.display = "block";
  if (diagnosticsEl) diagnosticsEl.style.display = "none";
  showError(message);
}

/** Stop every hot-path resource before this in-page view is hidden. */
function stopReceiver(): void {
  captureGen++;
  releaseScreenWakeLock();
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
  lastDecodedRegionSize = 0;
  expectedRegions = 0;
  expectedRegionsAt = 0;
  lastFullScan = 0;
  captureTimes.length = 0;
  qrReadTimes.length = 0;
  poolBusyTimes.length = 0;
  scanCompletionTimes.length = 0;
  cropAttempts.clear();
  cropRotate = 0;
  schedulerNoJobs = 0;
  cropMisses = 0;
  fullDetectorMisses = 0;
  fullSightings = 0;
  trackedMissFallbacks = 0;
  decodeExceptions = 0;
  regionExpiries = 0;
  regionCreations = 0;
  trackingInvalidations = 0;
  completedJobs = 0;
  workerLatencyTotalMs = 0;
  workerLatencyMaxMs = 0;
  lastDistinctArrivalAt = 0;
  maxSequenceGapMs = 0;
  pipelineEvents.length = 0;
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
  cameraHealthyReported = false;
  zeroRegionMs = 0;
  degradedMs = 0;
  minSeq = Infinity;
  maxSeq = -1;
  timeline.length = 0;
  plainQrPolicy.reset();
  result.replaceChildren();
  preview.style.display = "none";
  preview.classList.remove("camera-loading");
  cameraActual.textContent = "";
  pendingScanCapture = null;
  captureNextScan = false;
  captureScanBtn.textContent = "Capture";
  captureScanBtn.disabled = false;
  if (scanDialog.open) scanDialog.close();
  scanCapture.width = 0;
  scanCapture.height = 0;
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
  metric("m-dec").textContent = "— QR/s";
  metric("m-limit").textContent = "";
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
  startBtn.hidden = false;
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
  // Materialize the complete receiver layout before camera permission or
  // startup can delay it. Camera readiness should only replace the viewfinder,
  // never determine the size or visibility of the controls below it.
  preview.style.display = "";
  preview.classList.add("camera-loading");
  metricsEl.style.display = "block";
  progressStatus.style.display = "block";
  progressEl.style.display = "block";
  showRequestedCameraSettings();
  if (!navigator.mediaDevices?.getUserMedia) {
    // Mobile browsers commonly omit the API entirely for file:// origins.
    offerRetry(
      location.protocol === "file:"
        ? localCameraMessage
        : "Camera access needs HTTPS. Open the hosted app or its installed offline PWA.",
    );
    return;
  }
  const captureWidth = requestedWidth;
  const captureHeight = requestedHeight;
  const captureFps = requestedFps;
  startBtn.disabled = true;
  startBtn.style.display = "none";
  const base: MediaTrackConstraints = {
    facingMode: "environment",
    width: { ideal: captureWidth },
    height: { ideal: captureHeight },
  };
  try {
    if (isAndroidApp() || captureFps === undefined) {
      // Use exactly one request in the APK: some old Android camera providers
      // wedge after either a rejected request or a live applyConstraints call.
      // `ideal` asks for browser-equivalent throughput without making the
      // selected fps fatal. Auto omits the frame-rate constraint entirely.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: captureFps === undefined ? base : { ...base, frameRate: { ideal: captureFps } },
      });
    } else {
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
  if (diagnosticsEl) diagnosticsEl.style.display = "block";
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  preview.classList.remove("camera-loading");
  const activeCamera = stream.getVideoTracks()[0]?.getSettings();
  const activeSize = activeCamera?.width && activeCamera.height
    ? `${activeCamera.width}×${activeCamera.height}`
    : "Camera active";
  cameraActual.textContent = activeCamera?.frameRate
    ? `${activeSize} · ${Math.round(activeCamera.frameRate)} fps`
    : activeSize;
  syncPreviewAspect();
  setStatus("");

  pool.resize(selectedWorkerCount());
  void applyCameraExtras();

  cameraStartedTs = performance.now();
  captureGen++;
  const startedGen = captureGen;
  scheduleFrame(startedGen);
  if (isAndroidApp()) {
    // Permission revocation fixes this phone because Android kills the stale
    // camera client. If a granted stream delivers no frame at all, recycle the
    // app process once to get the same camera-service cleanup automatically.
    setTimeout(() => {
      if (!done && startedGen === captureGen && totalCaptures === 0) recoverAndroidCamera();
    }, 5000);
  }
  statsTimer = setInterval(updateStats, STATS_TICK_MS);
  await requestScreenWakeLock();
}

/** Use what this camera can actually do, probed rather than UA-sniffed.
 *  Continuous autofocus is applied silently — except in the APK, where old
 *  camera providers can break the live stream on any applyConstraints call. */
async function applyCameraExtras() {
  const track = stream?.getVideoTracks()[0];
  if (!track || isAndroidApp()) return;
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
    if (showDetectionOverlay) drawOverlay(performance.now());
    scheduleFrame(gen);
  };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(next);
  else requestAnimationFrame(next);
}

const grab = document.createElement("canvas");
let frameId = 0;
let captureNextScan = false;
let pendingScanCapture: {
  id?: number;
  image: ImageData;
  ox: number;
  oy: number;
  full: boolean;
  tracks: SymbolQuad[];
} | null = null;
captureScanBtn.addEventListener("click", () => {
  if (captureNextScan || pendingScanCapture) return;
  captureNextScan = true;
  captureScanBtn.textContent = "Capturing…";
  captureScanBtn.disabled = true;
});
closeScanBtn.addEventListener("click", () => scanDialog.close());
scanDialog.addEventListener("click", (event) => {
  if (event.target === scanDialog) scanDialog.close();
});

function trackedQuadBounds(quad: SymbolQuad): { left: number; top: number; right: number; bottom: number } | null {
  const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
  return {
    left: Math.min(...points.map((point) => point.x)),
    top: Math.min(...points.map((point) => point.y)),
    right: Math.max(...points.map((point) => point.x)),
    bottom: Math.max(...points.map((point) => point.y)),
  };
}

function validTrackedQuad(region: Region, vw: number, vh: number): boolean {
  if (!region.quad) return false;
  const bounds = trackedQuadBounds(region.quad);
  if (!bounds) return false;
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const regionSize = Math.max(region.w, region.h);
  const quadSize = Math.max(width, height);
  return width >= 24 && height >= 24 &&
    Math.max(width / height, height / width) <= 2.5 &&
    bounds.right > 0 && bounds.bottom > 0 && bounds.left < vw && bounds.top < vh &&
    quadSize >= regionSize * 0.4 && quadSize <= regionSize * 2.5;
}

function invalidateTrackedQuad(region: Region): void {
  region.quad = undefined;
  region.dim = undefined;
  region.consecutiveMisses = 0;
  trackingInvalidations++;
  notePipelineEvent("tracking-invalidated", trackingInvalidations);
}

function captureSubmittedScan(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  ox: number,
  oy: number,
  full: boolean,
  tracks: SymbolQuad[] = [],
): void {
  if (!captureNextScan) return;
  captureNextScan = false;
  pendingScanCapture = { image: ctx.getImageData(0, 0, w, h), ox, oy, full, tracks };
}

function cancelScanCapture(): void {
  pendingScanCapture = null;
  captureNextScan = false;
  captureScanBtn.textContent = "Capture";
  captureScanBtn.disabled = false;
}

function finishScanCapture(id: number, completion: DecodeCompletion): void {
  const capture = pendingScanCapture;
  if (!capture || capture.id !== id) return;
  cancelScanCapture();
  scanCapture.width = capture.image.width;
  scanCapture.height = capture.image.height;
  const ctx = scanCapture.getContext("2d")!;
  ctx.putImageData(capture.image, 0, 0);
  const drawQuad = (quad: SymbolQuad, color: string, width: number) => {
    const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
    ctx.beginPath();
    points.forEach((point, index) => {
      const x = point.x - capture.ox;
      const y = point.y - capture.oy;
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  for (const quad of capture.tracks) drawQuad(quad, "#248cff", 3);
  for (const symbol of completion.symbols) if (symbol.quad) drawQuad(symbol.quad, "#20c969", 5);
  ctx.strokeStyle = "#f2a51a";
  ctx.lineWidth = 4;
  for (const box of completion.sightings) ctx.strokeRect(box.x - capture.ox, box.y - capture.oy, box.w, box.h);
  const tracked = !capture.full;
  const mode = capture.full ? "Full-frame scan" : `${capture.tracks.length || 1} tracked region${capture.tracks.length === 1 ? "" : "s"}`;
  scanDialogStatus.textContent = completion.error
    ? `${mode} · ${capture.image.width}×${capture.image.height} · ${completion.error}`
    : tracked
      ? `${mode} · ${capture.image.width}×${capture.image.height} · ${completion.symbolCount} decoded${completion.fallbackAttempted ? ` · fallback searched${completion.sightingCount ? ` · ${completion.sightingCount} found` : ""}` : ""}`
      : `${mode} · ${capture.image.width}×${capture.image.height} · ${completion.symbolCount} decoded · ${completion.sightingCount} found`;
  scanSightingLegend.hidden = tracked && !completion.fallbackAttempted;
  scanDialog.showModal();
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
  if (!cameraHealthyReported && isAndroidApp()) {
    cameraHealthyReported = true;
    reportAndroidCameraHealthy();
  }
  captureTimes.push(now);
  totalCaptures++;
  if (pool.busyCount === pool.size) {
    capturesDropped++;
    poolBusyTimes.push(now);
    return;
  }

  for (let i = regions.length - 1; i >= 0; i--) {
    const region = regions[i]!;
    const ttl = region.decoded ? REGION_TTL_MS : SIGHTING_REGION_TTL_MS;
    if (now - region.seen > ttl) {
      regions.splice(i, 1);
      regionExpiries++;
      notePipelineEvent(region.decoded ? "region-decoded-expired" : "region-sighting-expired", regions.length);
    }
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
  const trackingUnhealthy = regions.some((region) => region.decoded && region.consecutiveMisses >= 4);
  const scanInterval =
    live === 0
      ? ACQUISITION_SCAN_MS
      : live < expectedRegions || trackingUnhealthy
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
  if (!fullScanDue && regions.length === 0) {
    schedulerNoJobs++;
    return;
  }

  // Read back only the bounded work selected above. Full-frame RGBA is used
  // for sparse acquisition; healthy tracks copy QR-sized crops only.
  if (grab.width !== vw || grab.height !== vh) {
    grab.width = vw;
    grab.height = vh;
  }
  const ctx = grab.getContext("2d", { willReadFrequently: true })!;
  if (fullScanDue) {
    lastFullScan = now;
    fullScans++;
    ctx.drawImage(video, 0, 0);
    captureSubmittedScan(ctx, vw, vh, 0, 0, true);
    const img = ctx.getImageData(0, 0, vw, vh);
    const id = frameId++;
    if (pool.submit(
      { id, buf: img.data.buffer, w: vw, h: vh, ox: 0, oy: 0, full: true },
      [img.data.buffer],
    )) {
      if (pendingScanCapture && pendingScanCapture.id === undefined) pendingScanCapture.id = id;
    } else if (pendingScanCapture?.id === undefined) {
      cancelScanCapture();
    }
    return;
  }
  for (const region of regions) {
    if (region.decoded && region.quad && !validTrackedQuad(region, vw, vh)) invalidateTrackedQuad(region);
  }
  const batchRegions = regions.filter((region) =>
    region.decoded && region.quad && region.dim && validTrackedQuad(region, vw, vh));
  const batchTracks = batchRegions.map((region) => ({
    id: region.id, quad: region.quad!, dim: region.dim!, crc32: Boolean(region.crc32),
  }));
  if (batchTracks.length > 1) {
    // One readback and one worker message per camera frame. Four independent
    // getImageData calls were stalling camera delivery even though the decode
    // workers were mostly idle.
    const points = batchTracks.flatMap((track) => [
      track.quad.topLeft, track.quad.topRight, track.quad.bottomRight, track.quad.bottomLeft,
    ]);
    const minX = Math.min(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxX = Math.max(...points.map((point) => point.x));
    const maxY = Math.max(...points.map((point) => point.y));
    const pad = Math.max(8, Math.round(Math.max(maxX - minX, maxY - minY) * 0.04));
    const x = Math.max(0, Math.floor(minX - pad));
    const y = Math.max(0, Math.floor(minY - pad));
    const w = Math.min(vw - x, Math.ceil(maxX + pad) - x);
    const h = Math.min(vh - y, Math.ceil(maxY + pad) - y);
    if (w >= 32 && h >= 32) {
      ctx.drawImage(video, x, y, w, h, 0, 0, w, h);
      captureSubmittedScan(ctx, w, h, x, y, false, batchTracks.map((track) => track.quad));
      const img = ctx.getImageData(0, 0, w, h);
      const id = frameId++;
      if (pool.submit(
        { id, buf: img.data.buffer, w, h, ox: x, oy: y, full: false, tracks: batchTracks },
        [img.data.buffer],
      )) {
        cropAttempts.set(id, batchRegions.map((region) => ({ region, quad: region.quad })));
        if (pendingScanCapture && pendingScanCapture.id === undefined) pendingScanCapture.id = id;
        cropsSubmitted += batchTracks.length;
      } else {
        if (pendingScanCapture?.id === undefined) cancelScanCapture();
        poolBusyTimes.push(now);
      }
    }
    cropRotate++;
    return;
  }

  // Pipeline successive camera frames across the workers. The old one-job
  // limit made a single QR use only one worker, so its decode latency directly
  // capped throughput even while the rest of the pool sat idle. Due full scans
  // take priority above; between them, divide all capacity fairly across tracks.
  const trackedCapacity = Math.max(1, pool.size);
  const perRegionCapacity = Math.max(1, Math.floor(trackedCapacity / Math.max(1, regions.length)));
  let submitted = false;
  for (let i = 0; i < regions.length; i++) {
    const r = regions[(i + cropRotate) % regions.length]!;
    if (regionInflightCount(r) >= perRegionCapacity) continue;
    // The quad is the geometry actually passed to tracked decoding, so crop
    // around it—not the independently updated axis-aligned region box. A stale
    // box could otherwise clip half the QR while the search quad sat outside.
    const quadBounds = r.quad ? trackedQuadBounds(r.quad) : null;
    const left = quadBounds?.left ?? r.x;
    const top = quadBounds?.top ?? r.y;
    const right = quadBounds?.right ?? r.x + r.w;
    const bottom = quadBounds?.bottom ?? r.y + r.h;
    const size = Math.max(right - left, bottom - top);
    const pad = Math.round(size * REGION_PAD + Math.min(size, 2 * (r.drift ?? 0)));
    const x = Math.max(0, Math.floor(left - pad));
    const y = Math.max(0, Math.floor(top - pad));
    const w = Math.min(vw - x, Math.ceil(right + pad) - x);
    const h = Math.min(vh - y, Math.ceil(bottom + pad) - y);
    if (w < 32 || h < 32) continue;
    ctx.drawImage(video, x, y, w, h, 0, 0, w, h);
    captureSubmittedScan(ctx, w, h, x, y, false, r.quad ? [r.quad] : []);
    const img = ctx.getImageData(0, 0, w, h);
    const id = frameId++;
    cropAttempts.set(id, [{ region: r, quad: r.quad }]);
    if (!pool.submit(
      { id, buf: img.data.buffer, w, h, ox: x, oy: y, full: false, quad: r.quad, dim: r.dim },
      [img.data.buffer],
    )) {
      cropAttempts.delete(id);
      if (pendingScanCapture?.id === undefined) cancelScanCapture();
      poolBusyTimes.push(performance.now());
      break;
    }
    if (pendingScanCapture && pendingScanCapture.id === undefined) pendingScanCapture.id = id;
    cropsSubmitted++;
    submitted = true;
  }
  // Being blocked by per-track limits is scanner saturation too.
  if (!submitted && regions.length > 0) poolBusyTimes.push(now);
  cropRotate++;
}

function onDecoded(bytes: Uint8Array, box?: SymbolBox, info?: SymbolInfo) {
  totalDecodes++;
  if (info?.tracked) trackedDecodes++;
  const decodedAt = performance.now();
  const parsed = parseFrame(bytes);
  const hasFrameCRC = Boolean(parsed && bytes.length === HEADER_LEN + parsed.header.blockLen + FRAME_CRC_LEN);
  if (box) noteRegion(box, decodedAt, true, { ...info, crc32: info?.crc32 ?? hasFrameCRC });
  if (done) return;
  if (!parsed) {
    // Once a fountain decoder exists, unrelated normal QRs can never replace
    // or complete that transfer. Only framed symbols are considered until the
    // verified file finishes or the receiver is explicitly reset.
    if (decoder) return;
    try {
      const text = plainQrDecoder.decode(bytes);
      const settled = plainQrPolicy.addPlain(text, info?.scanId ?? -1);
      if (settled) finishPlainQr(settled);
    } catch {
      // Non-text binary QR content is not a plain snippet or AirGapper frame.
    }
    return;
  }
  // A real AirGapper frame always wins. Plain QR candidates are delayed so a
  // spurious text decode from a dense fountain grid cannot finish the receive
  // path before zxing acquires one of the actual file frames.
  plainQrPolicy.noteFramed();
  const { header, block } = parsed;
  if (box) {
    const region = regionAt(box);
    if (region) noteSequence(region, header.seq, decodedAt);
  }
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
  const framesNewBefore = decoder.framesNew;
  const usefulBefore = decoder.framesNew - decoder.framesRedundant;
  decoder.addFrame(header.seq, block);
  const receivedAt = performance.now();
  if (decoder.framesNew > framesNewBefore) {
    qrReadTimes.push(receivedAt);
    if (lastDistinctArrivalAt) maxSequenceGapMs = Math.max(maxSequenceGapMs, receivedAt - lastDistinctArrivalAt);
    lastDistinctArrivalAt = receivedAt;
  }
  if (decoder.framesNew - decoder.framesRedundant > usefulBefore) {
    usefulFrameTimes.push(receivedAt);
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

/** Plain text is the complete standard QR payload. It deliberately has no
 * AirGapper container or SHA-256; files never take this path. */
function finishPlainQr(text: string): void {
  done = true;
  releaseScreenWakeLock();
  captureGen++;
  stream?.getTracks().forEach((track) => track.stop());
  clearInterval(statsTimer);
  statsTimer = undefined;
  pool.resize(0);
  preview.style.display = "none";
  metricsEl.style.display = "none";
  document.body.classList.add("receive-complete");
  document.body.classList.remove("receive-mode");
  setStatus("");
  showSnippet(text);
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
  releaseScreenWakeLock();
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
      payloadSha256: [...container.slice(9, 41)].map((b) => b.toString(16).padStart(2, "0")).join(""),
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
        captureMode: "bounded-rgba-crops",
        captures: totalCaptures,
        capturesDroppedPoolBusy: capturesDropped,
        cropsSubmitted,
        fullScans,
        decodes: totalDecodes,
        trackedAttempts,
        trackedDecodes,
        trackedMissFallbacks,
        schedulerNoJobs,
        cropMisses,
        fullDetectorMisses,
        fullSightings,
        decodeExceptions,
        regionCreations,
        regionExpiries,
        trackingInvalidations,
        zeroRegionMs,
        degradedMs,
        maxSequenceGapMs: Number(maxSequenceGapMs.toFixed(1)),
        workerJobs: completedJobs,
        workerLatencyMeanMs: completedJobs ? Number((workerLatencyTotalMs / completedJobs).toFixed(1)) : 0,
        workerLatencyMaxMs: Number(workerLatencyMaxMs.toFixed(1)),
        events: pipelineEvents,
      },
      workers: pool.size,
      requested: {
        width: requestedWidth,
        height: requestedHeight,
        fps: requestedFps ?? "auto",
        workers: selectedWorkerCount(),
        workerSetting: decodeWorkers.value,
      },
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
        goodputKBs: ok ? Number(completedGoodputKbs(uniqueBytes, finalSeconds).toFixed(1)) : 0,
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
    const rate = completedGoodputKbs(file.bytes.length, seconds);
    metric("m-rate").textContent = `${rate.toFixed(1)} KB/s`;
    speedFeedback.className = `speed-feedback ${speedQualityClass(rate)}`;
    progressLabel.textContent = "✓ Complete";
    etaLabel.textContent = `${formatBytes(file.bytes.length)} in ${formatDuration(seconds)}`;
    if (isSnippet(file)) {
      setStatus("");
      showSnippet(snippetText(file));
      return;
    }

    setStatus("");
    result.replaceChildren();
    if (file.type === "application/vnd.airgapper.files+zip") {
      const entries = readStoredZip(file.bytes);
      for (const entry of entries) await appendReceivedFile(entry, result);
      const archiveActions = document.createElement("div");
      archiveActions.className = "note-actions archive-actions";
      archiveActions.append(downloadLink(file.name, "application/zip", file.bytes, `Save ZIP · ${file.name}`));
      result.append(archiveActions);
    } else {
      await appendReceivedFile({ name: file.name, bytes: file.bytes }, result, file.type);
    }
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

const MIME_BY_EXTENSION: Record<string, string> = {
  apng: "image/apng", gif: "image/gif", jpeg: "image/jpeg", jpg: "image/jpeg",
  png: "image/png", svg: "image/svg+xml", webp: "image/webp",
  mp3: "audio/mpeg", m4a: "audio/mp4", oga: "audio/ogg", ogg: "audio/ogg", wav: "audio/wav",
  m4v: "video/mp4", mov: "video/quicktime", mp4: "video/mp4", ogv: "video/ogg", webm: "video/webm",
  css: "text/css", csv: "text/csv", html: "text/html", json: "application/json",
  md: "text/markdown", pdf: "application/pdf", txt: "text/plain", zip: "application/zip",
};

function inferredType(name: string): string {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function downloadLink(name: string, type: string, bytes: Uint8Array, label = `Save ${name}`): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "download";
  link.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  link.download = name;
  link.textContent = label;
  link.addEventListener("click", (event) => {
    if (!saveFileOnAndroid(name, type, bytes)) return;
    event.preventDefault();
  });
  return link;
}

async function appendReceivedFile(
  entry: ZipEntry,
  parent: HTMLElement,
  declaredType?: string,
): Promise<void> {
  const type = declaredType || inferredType(entry.name);
  const container = document.createElement("section");
  container.className = "received-file";
  const url = URL.createObjectURL(new Blob([entry.bytes as BlobPart], { type }));
  if (type.startsWith("image/")) {
    const image = document.createElement("img");
    image.className = "received";
    image.alt = `Received file preview: ${entry.name}`;
    image.src = url;
    container.append(image);
  } else if (type.startsWith("video/") || type.startsWith("audio/")) {
    const player = document.createElement(type.startsWith("video/") ? "video" : "audio");
    player.className = "received";
    player.controls = true;
    player.preload = "metadata";
    player.setAttribute("aria-label", `Received file: ${entry.name}`);
    if (player instanceof HTMLVideoElement) player.playsInline = true;
    const src = await servableMediaUrl(entry.bytes, type, url);
    if (src !== url) player.addEventListener("error", () => { player.src = url; }, { once: true });
    player.src = src;
    container.append(player);
  }
  const downloadRow = document.createElement("div");
  downloadRow.className = "received-file-download";
  const link = downloadLink(entry.name, type, entry.bytes, entry.name);
  link.title = entry.name;
  const fileSize = document.createElement("span");
  fileSize.textContent = formatBytes(entry.bytes.length);
  downloadRow.append(link, fileSize);
  container.append(downloadRow);
  parent.append(container);
}

/** A playable URL for received media. iOS Safari will not reliably play media
 *  handed to <video>/<audio> as a blob: URL — WebKit's media loader wants real
 *  HTTP semantics, Range requests included (a lesson inherited from the
 *  baseline receiver's range-shim worker). The bytes go into the Cache API and
 *  come back out through the service worker's range-aware route at a real URL
 *  (see runtimeCaching in vite.config.ts). The blob URL stands in when no
 *  worker controls the page: first ever visit, or the standalone file. */
async function servableMediaUrl(bytes: Uint8Array, type: string, blobUrl: string): Promise<string> {
  try {
    if (!navigator.serviceWorker?.controller) return blobUrl;
    // Resolved against the page (one directory deep), landing on the site
    // root — where the worker's route matches under any deploy subpath. Each
    // received file gets its own path so several media players can coexist.
    const target = new URL(`../received-media/${Date.now()}-${Math.random().toString(36).slice(2)}`, window.location.href).href;
    const cache = await caches.open("received-media");
    await cache.put(
      target,
      new Response(new Blob([bytes as BlobPart]), {
        headers: {
          "Content-Type": type,
          "Content-Length": String(bytes.length),
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

const SNIPPET_LINK = /(?:https?:\/\/|www\.)[^\s<>]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gi;
const TRAILING_LINK_PUNCTUATION = /[.,;:!?\])}]+$/;

/** Add only text nodes and narrowly validated anchors; received text is never
 * interpreted as HTML. This keeps links useful without making snippets an
 * injection path. */
function appendLinkifiedText(parent: HTMLElement, text: string): void {
  SNIPPET_LINK.lastIndex = 0;
  let cursor = 0;
  for (let match = SNIPPET_LINK.exec(text); match; match = SNIPPET_LINK.exec(text)) {
    const candidate = match[0].replace(TRAILING_LINK_PUNCTUATION, "");
    if (!candidate) continue;
    parent.append(document.createTextNode(text.slice(cursor, match.index)));
    const isEmail = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(candidate);
    const href = isEmail
      ? `mailto:${candidate}`
      : candidate.toLowerCase().startsWith("www.") ? `https://${candidate}` : candidate;
    try {
      const url = new URL(href);
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) throw new Error("unsupported link");
      const link = document.createElement("a");
      link.href = url.href;
      link.textContent = candidate;
      link.className = "snippet-link";
      if (url.protocol !== "mailto:") {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      parent.append(link);
    } catch {
      parent.append(document.createTextNode(candidate));
    }
    cursor = match.index + candidate.length;
  }
  parent.append(document.createTextNode(text.slice(cursor)));
}

/** Nothing is persisted: the text lives here until the page is closed. */
function showSnippet(text: string) {
  const body = document.createElement("p");
  body.className = "received-note";
  appendLinkifiedText(body, text);

  const actions = document.createElement("div");
  actions.className = "note-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "download";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    try {
      if (!copyTextOnAndroid(text)) await navigator.clipboard.writeText(text);
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy"; }, 1500);
    } catch {
      copy.textContent = "Copy failed";
    }
  });
  actions.append(copy);

  result.replaceChildren(body, actions);
}

function speedQualityClass(rate: number): string {
  return rate < 5
    ? "speed-low"
    : rate < 25
      ? "speed-mid"
      : rate < 75
        ? "speed-good"
        : "speed-high";
}

function updateStats() {
  if (done) return;
  const now = performance.now();
  const prune = (a: number[]) => {
    while (a.length > 0 && a[0]! < now - STATS_WINDOW_MS) a.shift();
  };
  prune(captureTimes);
  prune(qrReadTimes);
  prune(poolBusyTimes);
  prune(scanCompletionTimes);
  const perSecond = (a: number[]) => a.length / (STATS_WINDOW_MS / 1000);
  const cameraRate = perSecond(captureTimes);
  const scanRate = perSecond(scanCompletionTimes);
  const qrRate = perSecond(qrReadTimes);
  metric("m-cap").textContent = `${cameraRate.toFixed(0)} fps`;
  metric("m-dec").textContent = `${qrRate.toFixed(1)} QR/s`;
  const busyRate = poolBusyTimes.length / Math.max(1, captureTimes.length);
  const stalled = cameraStartedTs > 0 && now - cameraStartedTs > STATS_WINDOW_MS &&
    scanRate === 0 && pool.busyCount > 0;
  const saturated = busyRate >= 0.15;
  const limit = metric("m-limit");
  limit.textContent = stalled
    ? "Scanner stalled"
    : saturated
      ? `Decoder ${Math.min(100, Math.round(busyRate * 100))}%`
      : "";
  limit.classList.toggle("scanner-bound", stalled || saturated);
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
      Number(perSecond(qrReadTimes).toFixed(1)),
      fullScans,
    ]);
  }
  updateProgressEstimate();
  const liveRate = liveGoodputKbs(now);
  metric("m-rate").textContent = `${liveRate.toFixed(1)} KB/s`;
  speedFeedback.className = `speed-feedback ${speedQualityClass(liveRate)}`;

}
