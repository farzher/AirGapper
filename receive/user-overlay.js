import { GridLattice } from "./grid-lattice.js";
import { DecodeWorkerPool } from "../shared/worker-pool.js";

const MISS_FADE_MS = 420;
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

function targetMissingSlots(message) {
  if (message?.full || !Array.isArray(message?.tracks) || !snapshot?.slots?.length) return [];
  const expected = new Map(snapshot.slots.map((slot) => [slot.index, slot]));
  const slots = new Set();
  for (const track of message.tracks) {
    const slot = trackSlot(track);
    if (slot === null) continue;
    const known = expected.get(slot);
    if (known && !known.decoded) slots.add(slot);
  }
  return [...slots];
}

function activityFor(slot) {
  let value = slotActivity.get(slot);
  if (!value) {
    value = { missAt: -Infinity };
    slotActivity.set(slot, value);
  }
  return value;
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
    activity.missAt = successes.has(slot) ? -Infinity : at;
  }
}

function wrapWorkerPool() {
  const originalSubmitAtSlot = DecodeWorkerPool.prototype.submitAtSlot;
  DecodeWorkerPool.prototype.submitAtSlot = function (workerSlot, message, transfer) {
    const slots = targetMissingSlots(message);
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

function pathQuad(quad, scale, offX, offY) {
  const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = offX + point.x * scale;
    const y = offY + point.y * scale;
    if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  });
  ctx.closePath();
}

function outerQuad(value) {
  const cols = Number(value?.layout?.cols);
  const rows = Number(value?.layout?.rows);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return null;
  const quad = {
    topLeft: value.slots?.[0]?.quad?.topLeft,
    topRight: value.slots?.[cols - 1]?.quad?.topRight,
    bottomLeft: value.slots?.[(rows - 1) * cols]?.quad?.bottomLeft,
    bottomRight: value.slots?.[rows * cols - 1]?.quad?.bottomRight
  };
  return validQuad(quad) ? quad : null;
}

function drawHud(at) {
  if (!ctx || !preview || !video || !document.body.classList.contains("receive-mode") || document.hidden) return;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
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

  const ppm = pixelsPerModule(value);
  if (ppm > 0) {
    const label = `${ppm.toFixed(1)} px/module`;
    const font = Math.max(10, 10.5 * dpr);
    ctx.font = `600 ${font}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.lineWidth = Math.max(2, 2 * dpr);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.62)";
    ctx.fillStyle = "rgba(245, 249, 252, 0.78)";
    ctx.strokeText(label, 10 * dpr, 18 * dpr);
    ctx.fillText(label, 10 * dpr, 18 * dpr);
  }

  if (value.distributedFit) {
    const wall = outerQuad(value);
    if (wall) {
      ctx.save();
      ctx.strokeStyle = "rgba(184, 132, 255, 0.34)";
      ctx.lineWidth = Math.max(1, dpr);
      ctx.setLineDash([]);
      pathQuad(wall, scale, offX, offY);
      ctx.stroke();
      ctx.restore();
    }
  }

  const activeSlots = new Set();
  for (const job of jobs.values()) for (const slot of job.slots) activeSlots.add(slot);

  for (const slot of value.slots) {
    if (!activeSlots.has(slot.index)) continue;
    if (!validQuad(slot.quad)) continue;
    ctx.save();
    pathQuad(slot.quad, scale, offX, offY);
    ctx.fillStyle = "rgba(70, 211, 255, 0.08)";
    ctx.strokeStyle = "rgba(88, 220, 255, 0.58)";
    ctx.lineWidth = Math.max(1.25, 1.25 * dpr);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  for (const slot of value.slots) {
    const missAt = slotActivity.get(slot.index)?.missAt ?? -Infinity;
    const missAge = at - missAt;
    if (missAge < 0 || missAge >= MISS_FADE_MS || !validQuad(slot.quad)) continue;
    const t = 1 - missAge / MISS_FADE_MS;
    ctx.save();
    pathQuad(slot.quad, scale, offX, offY);
    ctx.fillStyle = `rgba(255, 166, 66, ${0.03 + 0.11 * t})`;
    ctx.strokeStyle = `rgba(255, 174, 73, ${0.12 + 0.62 * t})`;
    ctx.lineWidth = Math.max(1.25, (1.1 + 0.7 * t) * dpr);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
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
