import { GridLattice } from "./grid-lattice.js";
import { DecodeWorkerPool } from "../shared/worker-pool.js";

const PROBE_FADE_MS = Object.freeze({ success: 420, sighting: 720, miss: 560 });
const JOB_TTL_MS = 4000;
const DRAW_INTERVAL_MS = 50;

let snapshot;
const jobs = new Map();
const slotActivity = new Map();

function now() {
  return performance.now();
}

function wrapLattice() {
  const originalSnapshot = GridLattice.prototype.snapshot;
  GridLattice.prototype.snapshot = function (...args) {
    const value = originalSnapshot.apply(this, args);
    snapshot = value || null;
    return value;
  };

  for (const name of ["reset", "reacquire"]) {
    const original = GridLattice.prototype[name];
    GridLattice.prototype[name] = function (...args) {
      const value = original.apply(this, args);
      snapshot = null;
      slotActivity.clear();
      jobs.clear();
      return value;
    };
  }
}

function quadCenter(quad) {
  if (!quad?.topLeft || !quad?.topRight || !quad?.bottomRight || !quad?.bottomLeft) return null;
  return {
    x: (quad.topLeft.x + quad.topRight.x + quad.bottomRight.x + quad.bottomLeft.x) / 4,
    y: (quad.topLeft.y + quad.topRight.y + quad.bottomRight.y + quad.bottomLeft.y) / 4
  };
}

function trackSlot(track) {
  for (const value of [track?.gridSlot, track?.slotIndex, track?.slot, track?.index]) {
    const slot = Number(value);
    if (Number.isInteger(slot) && slot >= 0 && slot < 128) return slot;
  }
  const center = quadCenter(track?.quad);
  if (!center || !snapshot?.slots?.length) return null;
  let best = null;
  for (const slot of snapshot.slots) {
    const candidate = quadCenter(slot.quad);
    if (!candidate) continue;
    const scale = Math.max(1, Math.hypot(slot.box?.w || 0, slot.box?.h || 0));
    const distance = Math.hypot(candidate.x - center.x, candidate.y - center.y) / scale;
    if (!best || distance < best.distance) best = { index: slot.index, distance };
  }
  return best && best.distance < 0.75 ? best.index : null;
}

function targetProbeSlots(message) {
  // The user overlay shows dedicated local-recovery probes only. Ordinary
  // tracked misses are often rolling-shutter/frame-phase failures and must not
  // be presented as evidence that a geometry probe failed.
  if (!message?.full || message?.acquisitionMode !== "recovery" ||
      !Array.isArray(message?.tracks) || !snapshot?.slots?.length) return [];
  const expected = new Set(snapshot.slots.map((slot) => slot.index));
  const slots = new Set();
  for (const track of message.tracks) {
    const slot = trackSlot(track);
    if (slot !== null && expected.has(slot)) slots.add(slot);
  }
  return [...slots];
}

function activityFor(slot) {
  let value = slotActivity.get(slot);
  if (!value) {
    value = { at: -Infinity, kind: "miss" };
    slotActivity.set(slot, value);
  }
  return value;
}

function sightingNearSlot(slot, sightings) {
  const target = snapshot?.slots?.find((item) => item.index === slot);
  const q = target?.quad;
  if (!validQuad(q) || !Array.isArray(sightings) || !sightings.length) return false;
  const xs = [q.topLeft.x, q.topRight.x, q.bottomRight.x, q.bottomLeft.x];
  const ys = [q.topLeft.y, q.topRight.y, q.bottomRight.y, q.bottomLeft.y];
  const left = Math.min(...xs), right = Math.max(...xs);
  const top = Math.min(...ys), bottom = Math.max(...ys);
  const pad = Math.max(12, Math.max(right - left, bottom - top) * 0.55);
  return sightings.some((box) => {
    const x = Number(box?.x) + Number(box?.w) * 0.5;
    const y = Number(box?.y) + Number(box?.h) * 0.5;
    return Number.isFinite(x) && Number.isFinite(y) &&
      x >= left - pad && x <= right + pad && y >= top - pad && y <= bottom + pad;
  });
}

function packedSuccessSlots(message) {
  const slots = new Set();
  for (const symbol of message?.symbols || []) {
    const slot = Number(symbol?.header?.slotIndex);
    if (Number.isInteger(slot) && slot >= 0) slots.add(slot);
  }
  const meta = message?.__airgapperPackedSymbolMeta;
  const count = Math.trunc(Number(message?.__airgapperPackedSymbolCount) || 0);
  if (meta instanceof ArrayBuffer && count > 0 && meta.byteLength >= count * 88) {
    const words = new Uint32Array(meta);
    for (let index = 0; index < count; index++) {
      const slot = words[index * 22 + 4] >>> 16;
      if (slot < 128) slots.add(slot);
    }
  }
  return slots;
}

function noteCompletion(message) {
  const id = Number(message?.id);
  if (!Number.isInteger(id) || id < 0 || message?.preflight) return;
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  const at = now();
  const successes = packedSuccessSlots(message);
  for (const slot of job.slots) {
    const activity = activityFor(slot);
    activity.at = at;
    activity.kind = successes.has(slot)
      ? "success"
      : sightingNearSlot(slot, message?.sightings) ? "sighting" : "miss";
  }
}

function wrapWorkerPool() {
  const originalSubmitAtSlot = DecodeWorkerPool.prototype.submitAtSlot;
  DecodeWorkerPool.prototype.submitAtSlot = function (workerSlot, message, transfer) {
    const slots = targetProbeSlots(message);
    const id = Number(message?.id);
    const accepted = originalSubmitAtSlot.call(this, workerSlot, message, transfer);
    if (accepted && Number.isInteger(id) && id >= 0 && slots.length) jobs.set(id, { slots, at: now() });
    return accepted;
  };

  const originalConfigureWorker = DecodeWorkerPool.prototype.configureWorker;
  DecodeWorkerPool.prototype.configureWorker = function (slot, worker) {
    originalConfigureWorker.call(this, slot, worker);
    const handler = worker.onmessage;
    worker.onmessage = function (event) {
      noteCompletion(event.data);
      return handler.call(this, event);
    };
  };
}

wrapLattice();
wrapWorkerPool();

const preview = document.querySelector("#preview .preview");
const video = document.getElementById("video");
const canvas = document.createElement("canvas");
canvas.id = "user-detect-overlay";
canvas.setAttribute("aria-hidden", "true");
Object.assign(canvas.style, {
  position: "absolute",
  inset: "0",
  width: "100%",
  height: "100%",
  pointerEvents: "none",
  zIndex: "3"
});
if (preview && getComputedStyle(preview).position === "static") preview.style.position = "relative";
preview?.append(canvas);
const ctx = canvas.getContext("2d");

function validQuad(quad) {
  return quad && [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft]
    .every((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y));
}

function median(values) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

function pixelsPerModule(value) {
  const modules = Number(value?.modules);
  if (!(modules > 0)) return 0;
  const sizes = [];
  for (const slot of value.slots || []) {
    const q = slot.quad;
    if (!validQuad(q)) continue;
    const edges = [
      Math.hypot(q.topRight.x - q.topLeft.x, q.topRight.y - q.topLeft.y),
      Math.hypot(q.bottomRight.x - q.bottomLeft.x, q.bottomRight.y - q.bottomLeft.y),
      Math.hypot(q.bottomLeft.x - q.topLeft.x, q.bottomLeft.y - q.topLeft.y),
      Math.hypot(q.bottomRight.x - q.topRight.x, q.bottomRight.y - q.topRight.y)
    ];
    sizes.push(edges.reduce((sum, edge) => sum + edge, 0) / edges.length / modules);
  }
  return median(sizes);
}

function fallbackPresentation() {
  const width = Number(video?.videoWidth) || 0;
  const height = Number(video?.videoHeight) || 0;
  return width > 0 && height > 0
    ? { width, height, mapPoint(point) { return { x: point.x, y: point.y }; } }
    : null;
}

function presentation() {
  return globalThis.__airgapperOverlayPresentation?.() || fallbackPresentation();
}

function mapQuad(quad, view) {
  if (!validQuad(quad) || !view?.mapPoint) return null;
  const mapped = {
    topLeft: view.mapPoint(quad.topLeft),
    topRight: view.mapPoint(quad.topRight),
    bottomRight: view.mapPoint(quad.bottomRight),
    bottomLeft: view.mapPoint(quad.bottomLeft)
  };
  return validQuad(mapped) ? mapped : null;
}

function canvasPoints(quad, scale, offX, offY) {
  return [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft].map((point) => ({
    x: offX + point.x * scale,
    y: offY + point.y * scale
  }));
}

function pathPoints(points) {
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index) ctx.lineTo(point.x, point.y);
    else ctx.moveTo(point.x, point.y);
  });
  ctx.closePath();
}

function fillMappedQuad(quad, scale, offX, offY, fillStyle) {
  const points = canvasPoints(quad, scale, offX, offY);
  pathPoints(points);
  ctx.fillStyle = fillStyle;
  ctx.fill();
}

function strokeExactCornerOutline(quad, scale, offX, offY, strokeStyle, lineWidth) {
  const points = canvasPoints(quad, scale, offX, offY);
  const fraction = 0.23;
  ctx.save();
  // Clip the centered stroke to the QR polygon so the visible outline never
  // grows outside the actual predicted QR boundary.
  pathPoints(points);
  ctx.clip();
  ctx.beginPath();
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    const previous = points[(index + points.length - 1) % points.length];
    const next = points[(index + 1) % points.length];
    const from = {
      x: point.x + (previous.x - point.x) * fraction,
      y: point.y + (previous.y - point.y) * fraction
    };
    const to = {
      x: point.x + (next.x - point.x) * fraction,
      y: point.y + (next.y - point.y) * fraction
    };
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(point.x, point.y);
    ctx.lineTo(to.x, to.y);
  }
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.restore();
}

function outerQuad(value, view) {
  const points = [];
  for (const slot of value?.slots || []) {
    const mapped = mapQuad(slot?.quad, view);
    if (!mapped) continue;
    points.push(mapped.topLeft, mapped.topRight, mapped.bottomRight, mapped.bottomLeft);
  }
  if (points.length < 4) return null;
  const by = (score, preferMin) => points.reduce((best, point) => {
    if (!best) return point;
    return (preferMin ? score(point) < score(best) : score(point) > score(best)) ? point : best;
  }, null);
  const quad = {
    topLeft: by((p) => p.x + p.y, true),
    topRight: by((p) => p.x - p.y, false),
    bottomRight: by((p) => p.x + p.y, false),
    bottomLeft: by((p) => p.x - p.y, true)
  };
  return validQuad(quad) ? quad : null;
}

function drawPixelsPerModule(ppm, width, dpr) {
  if (!(ppm > 0)) return;
  const label = `${ppm.toFixed(1)} px/module`;
  const font = 11.5 * dpr;
  const padX = 7 * dpr;
  const padY = 4.5 * dpr;
  const margin = 8 * dpr;
  ctx.font = `600 ${font}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const badgeW = ctx.measureText(label).width + padX * 2;
  const badgeH = font + padY * 2;
  const x = width - margin - badgeW;
  const y = margin;
  ctx.fillStyle = "rgba(7, 10, 14, 0.68)";
  ctx.fillRect(x, y, badgeW, badgeH);
  ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + padX, y + badgeH / 2 + 0.25 * dpr);
  ctx.textBaseline = "alphabetic";
}

function drawHud(at) {
  if (!ctx || !preview || !video || !document.body.classList.contains("receive-mode") || document.hidden) return;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const view = presentation();
  const vw = Number(view?.width) || 0;
  const vh = Number(view?.height) || 0;
  if (!cw || !ch || !vw || !vh) return;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(cw * dpr);
  const height = Math.round(ch * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);

  for (const [id, job] of jobs) if (at - job.at > JOB_TTL_MS) jobs.delete(id);

  const value = snapshot;
  if (!value?.slots?.length) return;
  const scale = Math.min(width / vw, height / vh);
  const offX = (width - vw * scale) / 2;
  const offY = (height - vh * scale) / 2;

  drawPixelsPerModule(pixelsPerModule(value), width, dpr);

  if (value.distributedFit) {
    const wall = outerQuad(value, view);
    if (wall) {
      ctx.save();
      const points = canvasPoints(wall, scale, offX, offY);
      pathPoints(points);
      ctx.fillStyle = "rgba(184, 132, 255, 0.045)";
      ctx.strokeStyle = "rgba(184, 132, 255, 0.68)";
      ctx.lineWidth = Math.max(1.5, 1.55 * dpr);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  for (const slot of value.slots) {
    const activity = slotActivity.get(slot.index);
    const kind = activity?.kind || "miss";
    const fade = PROBE_FADE_MS[kind] || PROBE_FADE_MS.miss;
    const age = at - (activity?.at ?? -Infinity);
    const mapped = mapQuad(slot.quad, view);
    if (age < 0 || age >= fade || !mapped) continue;
    const t = 1 - age / fade;

    if (kind === "success") {
      // Success is unmistakable but quiet: the exact QR polygon briefly fills
      // with translucent green instead of growing an outline around it.
      ctx.save();
      fillMappedQuad(mapped, scale, offX, offY, `rgba(38, 211, 111, ${0.07 + 0.19 * t})`);
      ctx.restore();
      continue;
    }

    const amber = kind === "sighting";
    const color = amber ? [255, 180, 45] : [255, 56, 72];
    const alpha = amber ? 0.20 + 0.58 * t : 0.18 + 0.50 * t;
    strokeExactCornerOutline(
      mapped,
      scale,
      offX,
      offY,
      `rgba(${color.join(",")}, ${alpha})`,
      Math.max(1, (1.05 + 0.55 * t) * dpr)
    );
  }
}

let lastDrawAt = -Infinity;
function frame(at) {
  if (at - lastDrawAt >= DRAW_INTERVAL_MS) {
    lastDrawAt = at;
    drawHud(at);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
