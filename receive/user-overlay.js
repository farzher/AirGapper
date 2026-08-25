import { GridLattice } from "./grid-lattice.js";
import { DecodeWorkerPool } from "../shared/worker-pool.js";

const PROBE_FLASH_MS = 180;
const MISS_FADE_MS = 520;
const HIT_FADE_MS = 620;
const JOB_TTL_MS = 4000;
const DRAW_INTERVAL_MS = 50;

let lattice;
let snapshot;
const jobs = new Map();
const slotActivity = new Map();

function now() {
  return performance.now();
}

function rememberLattice(value) {
  lattice = value;
}

function wrapLattice() {
  const originalTransition = GridLattice.prototype.transition;
  GridLattice.prototype.transition = function (...args) {
    rememberLattice(this);
    return originalTransition.apply(this, args);
  };

  const originalSnapshot = GridLattice.prototype.snapshot;
  GridLattice.prototype.snapshot = function (...args) {
    rememberLattice(this);
    const value = originalSnapshot.apply(this, args);
    snapshot = value || null;
    return value;
  };

  for (const name of ["reset", "reacquire"]) {
    const original = GridLattice.prototype[name];
    GridLattice.prototype[name] = function (...args) {
      rememberLattice(this);
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

function targetSlots(message) {
  if (message?.full || !Array.isArray(message?.tracks)) return [];
  const slots = new Set();
  for (const track of message.tracks) {
    const slot = trackSlot(track);
    if (slot !== null) slots.add(slot);
  }
  return [...slots];
}

function activityFor(slot) {
  let value = slotActivity.get(slot);
  if (!value) {
    value = { probeAt: -Infinity, missAt: -Infinity, hitAt: -Infinity };
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
    if (successes.has(slot)) activity.hitAt = at;
    else activity.missAt = at;
  }
}

function wrapWorkerPool() {
  const originalSubmitAtSlot = DecodeWorkerPool.prototype.submitAtSlot;
  DecodeWorkerPool.prototype.submitAtSlot = function (workerSlot, message, transfer) {
    const slots = targetSlots(message);
    const id = Number(message?.id);
    const accepted = originalSubmitAtSlot.call(this, workerSlot, message, transfer);
    if (accepted && Number.isInteger(id) && id >= 0 && slots.length) {
      const at = now();
      jobs.set(id, { slots, at });
      for (const slot of slots) activityFor(slot).probeAt = at;
    }
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

function drawCorners(x, y, w, h, length) {
  ctx.beginPath();
  ctx.moveTo(x, y + length); ctx.lineTo(x, y); ctx.lineTo(x + length, y);
  ctx.moveTo(x + w - length, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + length);
  ctx.moveTo(x + w, y + h - length); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - length, y + h);
  ctx.moveTo(x + length, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - length);
  ctx.stroke();
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
  const topLeft = value.slots?.[0]?.quad?.topLeft;
  const topRight = value.slots?.[cols - 1]?.quad?.topRight;
  const bottomLeft = value.slots?.[(rows - 1) * cols]?.quad?.bottomLeft;
  const bottomRight = value.slots?.[rows * cols - 1]?.quad?.bottomRight;
  const quad = { topLeft, topRight, bottomRight, bottomLeft };
  return validQuad(quad) ? quad : null;
}

function stateColor(state) {
  if (state === "TRACK") return "#6fffa8";
  if (state === "GRID_LOCK") return "#70e7ff";
  if (state === "PARTIAL_LOSS") return "#ffca64";
  if (state === "REACQUIRE") return "#ff7c9c";
  return "#d6dbe4";
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
  const state = lattice?.state || "SEARCH";
  const ppm = value ? pixelsPerModule(value) : 0;
  const label = `${state}${ppm > 0 ? ` · ${ppm.toFixed(1)} px/module` : ""}`;
  const font = Math.max(11, 12 * dpr);
  ctx.font = `650 ${font}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const padX = 8 * dpr;
  const padY = 5 * dpr;
  const badgeW = ctx.measureText(label).width + padX * 2;
  const badgeH = font + padY * 2;
  const badgeX = 8 * dpr;
  const badgeY = 8 * dpr;
  ctx.fillStyle = "rgba(5, 10, 16, 0.68)";
  ctx.fillRect(badgeX, badgeY, badgeW, badgeH);
  ctx.fillStyle = stateColor(state);
  ctx.fillText(label, badgeX + padX, badgeY + padY + font * 0.82);

  if (!value?.slots?.length) return;
  const scale = Math.min(width / vw, height / vh);
  const offX = (width - vw * scale) / 2;
  const offY = (height - vh * scale) / 2;

  const wall = outerQuad(value);
  if (wall) {
    ctx.save();
    ctx.strokeStyle = "rgba(183, 126, 255, 0.68)";
    ctx.lineWidth = Math.max(1.2, 1.35 * dpr);
    ctx.setLineDash([6 * dpr, 5 * dpr]);
    pathQuad(wall, scale, offX, offY);
    ctx.stroke();
    ctx.restore();
  }

  for (const slot of value.slots) {
    const box = slot.box;
    if (!box || ![box.x, box.y, box.w, box.h].every(Number.isFinite)) continue;
    const x = offX + box.x * scale;
    const y = offY + box.y * scale;
    const w = box.w * scale;
    const h = box.h * scale;
    const minSide = Math.min(w, h);
    const activity = slotActivity.get(slot.index);
    const probeAge = at - (activity?.probeAt ?? -Infinity);
    const missAge = at - (activity?.missAt ?? -Infinity);
    const hitAge = at - (activity?.hitAt ?? -Infinity);

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(214, 229, 241, 0.28)";
    ctx.lineWidth = Math.max(1, dpr);
    drawCorners(x, y, w, h, minSide * 0.13);

    if (probeAge >= 0 && probeAge < PROBE_FLASH_MS) {
      const t = 1 - probeAge / PROBE_FLASH_MS;
      ctx.strokeStyle = `rgba(115, 222, 255, ${0.28 + 0.72 * t})`;
      ctx.lineWidth = Math.max(2, (1.8 + t) * dpr);
      drawCorners(x, y, w, h, minSide * 0.22);
    }
    if (missAge >= 0 && missAge < MISS_FADE_MS && missAge <= probeAge + MISS_FADE_MS) {
      const t = 1 - missAge / MISS_FADE_MS;
      ctx.strokeStyle = `rgba(255, 172, 74, ${0.15 + 0.65 * t})`;
      ctx.lineWidth = Math.max(1.5, (1.5 + 0.7 * t) * dpr);
      drawCorners(x, y, w, h, minSide * 0.18);
    }
    if (hitAge >= 0 && hitAge < HIT_FADE_MS) {
      const t = 1 - hitAge / HIT_FADE_MS;
      const pop = (2 + 3 * t) * dpr;
      ctx.strokeStyle = `rgba(94, 255, 155, ${0.24 + 0.76 * t})`;
      ctx.lineWidth = Math.max(2, (2 + t) * dpr);
      drawCorners(x - pop, y - pop, w + pop * 2, h + pop * 2, minSide * 0.22);
    }
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
