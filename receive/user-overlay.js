const SUCCESS_FRAMES = 18;
const SIGHTING_FRAMES = 30;
const MISS_FRAMES = 24;

const COLORS = Object.freeze({
  hot: [0, 239, 255],
  direct: [66, 165, 255],
  sparse: [53, 214, 111],
  fallback: [255, 178, 62],
  robust: [255, 115, 92],
  acquire: [180, 134, 255]
});

const STATE_COLORS = Object.freeze({
  SEARCH: "#b486ff",
  GRID_LOCK: "#00efff",
  TRACK: "#35d66f",
  PARTIAL_LOSS: "#ffb23e",
  REACQUIRE: "#ff735c",
  DORMANT: "#9aa0a6"
});

const preview = document.querySelector("#preview .preview");
const video = document.getElementById("video");
const legacyOverlay = document.getElementById("detect-overlay");
const devActions = document.querySelector(".receiver-dev-actions");

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

const status = document.createElement("div");
status.id = "user-scan-status";
status.setAttribute("aria-hidden", "true");
Object.assign(status.style, {
  position: "absolute",
  left: "10px",
  top: "10px",
  zIndex: "4",
  pointerEvents: "none",
  padding: "5px 8px",
  borderRadius: "7px",
  borderLeft: "3px solid #b486ff",
  background: "rgba(12, 14, 18, 0.68)",
  color: "#fff",
  font: "700 11px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace",
  letterSpacing: ".01em",
  whiteSpace: "nowrap",
  boxShadow: "0 1px 5px rgba(0,0,0,.22)"
});

if (preview && getComputedStyle(preview).position === "static") preview.style.position = "relative";
preview?.append(canvas, status);
const ctx = canvas.getContext("2d");

// Fixed-size, overwrite-in-place state. Even at hundreds of QR/s there is no
// growing event queue: each physical slot owns one current visual event.
const activity = new Array(128);
let geometry;
let geometryUsable = false;
let drawQueued = false;
let receiverState = "SEARCH";
let pixelsPerModule = 0;
let lastStatusText = "";

function normalMode() {
  return !devActions || devActions.hidden;
}

function validQuad(quad) {
  return Boolean(quad) && [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft]
    .every((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y));
}

function quadPixelsPerModule(quad, modules) {
  if (!validQuad(quad) || !(modules > 0)) return 0;
  const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  let shortest = Infinity;
  for (let index = 0; index < 4; index++) {
    const point = points[index];
    const next = points[(index + 1) % 4];
    shortest = Math.min(shortest, Math.hypot(point.x - next.x, point.y - next.y));
  }
  return Number.isFinite(shortest) ? shortest / modules : 0;
}

function snapshotPixelsPerModule(snapshot) {
  const slots = snapshot?.slots;
  const modules = Number(snapshot?.modules);
  if (!Array.isArray(slots) || !slots.length || !(modules > 0)) return 0;
  const step = Math.max(1, Math.ceil(slots.length / 6));
  let sum = 0;
  let count = 0;
  for (let index = 0; index < slots.length && count < 6; index += step) {
    const value = quadPixelsPerModule(slots[index]?.quad, modules);
    if (!(value > 0)) continue;
    sum += value;
    count++;
  }
  if (!count) {
    for (const slot of slots) {
      const value = quadPixelsPerModule(slot?.quad, modules);
      if (!(value > 0)) continue;
      sum = value;
      count = 1;
      break;
    }
  }
  return count ? sum / count : 0;
}

function updateStatus() {
  const ppm = pixelsPerModule > 0 ? `${pixelsPerModule.toFixed(1)} px/module` : "— px/module";
  const text = `${receiverState} · ${ppm}`;
  if (text !== lastStatusText) {
    status.textContent = text;
    lastStatusText = text;
  }
  status.style.borderLeftColor = STATE_COLORS[receiverState] || "#b486ff";
}

function presentation() {
  const mapped = globalThis.__airgapperOverlayPresentation?.();
  if (mapped?.width > 0 && mapped?.height > 0 && typeof mapped.mapPoint === "function") return mapped;
  const width = Number(video?.videoWidth) || 0;
  const height = Number(video?.videoHeight) || 0;
  return width > 0 && height > 0
    ? { width, height, mapPoint(point) { return point; } }
    : null;
}

function mapQuad(quad, view) {
  if (!validQuad(quad) || !view) return null;
  const mapped = {
    topLeft: view.mapPoint(quad.topLeft),
    topRight: view.mapPoint(quad.topRight),
    bottomRight: view.mapPoint(quad.bottomRight),
    bottomLeft: view.mapPoint(quad.bottomLeft)
  };
  return validQuad(mapped) ? mapped : null;
}

// The wall outline follows the same logical outer QR corners the lattice uses.
// It exists only while runtime says the retained distributed pose is usable.
function wallQuad(snapshot) {
  const cols = Number(snapshot?.layout?.cols);
  const rows = Number(snapshot?.layout?.rows);
  const slots = snapshot?.slots;
  if (!Number.isInteger(cols) || cols < 1 || !Number.isInteger(rows) || rows < 1 ||
      !Array.isArray(slots) || slots.length < cols * rows) return null;

  const byIndex = new Map(slots.map((slot) => [Number(slot?.index), slot?.quad]));
  const topLeft = byIndex.get(0);
  const topRight = byIndex.get(cols - 1);
  const bottomRight = byIndex.get(cols * rows - 1);
  const bottomLeft = byIndex.get((rows - 1) * cols);
  if (![topLeft, topRight, bottomRight, bottomLeft].every(validQuad)) return null;

  return {
    topLeft: topLeft.topLeft,
    topRight: topRight.topRight,
    bottomRight: bottomRight.bottomRight,
    bottomLeft: bottomLeft.bottomLeft
  };
}

function quadPath(quad, scale, offX, offY) {
  const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = offX + point.x * scale;
    const y = offY + point.y * scale;
    if (index) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  });
  ctx.closePath();
}

function cornerOutline(quad, scale, offX, offY, color, width) {
  const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft].map((point) => ({
    x: offX + point.x * scale,
    y: offY + point.y * scale
  }));
  const fraction = 0.23;

  ctx.save();
  ctx.beginPath();
  points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  ctx.closePath();
  // Keep the visible stroke inside the exact predicted QR polygon.
  ctx.clip();
  ctx.beginPath();
  for (let index = 0; index < 4; index++) {
    const point = points[index];
    const previous = points[(index + 3) % 4];
    const next = points[(index + 1) % 4];
    ctx.moveTo(
      point.x + (previous.x - point.x) * fraction,
      point.y + (previous.y - point.y) * fraction
    );
    ctx.lineTo(point.x, point.y);
    ctx.lineTo(
      point.x + (next.x - point.x) * fraction,
      point.y + (next.y - point.y) * fraction
    );
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.restore();
}

function normalizePath(path) {
  const value = String(path || "hot").toLowerCase();
  if (COLORS[value]) return value;
  if (value.includes("fallback")) return "fallback";
  if (value.includes("robust")) return "robust";
  if (value.includes("sparse")) return "sparse";
  if (value.includes("direct")) return "direct";
  if (value.includes("acquire")) return "acquire";
  return "hot";
}

function scheduleDraw() {
  if (drawQueued || !normalMode()) return;
  drawQueued = true;
  requestAnimationFrame(draw);
}

function draw() {
  drawQueued = false;
  if (!ctx || !normalMode() || document.hidden) return;

  const view = presentation();
  const clientWidth = canvas.clientWidth;
  const clientHeight = canvas.clientHeight;
  if (!view || !clientWidth || !clientHeight) return;

  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(clientWidth * dpr);
  const height = Math.round(clientHeight * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const scale = Math.min(width / view.width, height / view.height);
  const offX = (width - view.width * scale) * 0.5;
  const offY = (height - view.height * scale) * 0.5;

  // Persistent state: outline only, and only while the retained distributed
  // wall pose is still usable by the receiver.
  if (geometryUsable && geometry?.distributedFit) {
    const wall = mapQuad(wallQuad(geometry), view);
    if (wall) {
      quadPath(wall, scale, offX, offY);
      ctx.strokeStyle = "rgba(184, 132, 255, 0.78)";
      ctx.lineWidth = Math.max(1.25, 1.45 * dpr);
      ctx.lineJoin = "round";
      ctx.stroke();
    }
  }

  let animate = false;
  for (const item of activity) {
    if (!item?.frames) continue;
    const quad = mapQuad(item.quad, view);
    if (!quad) {
      item.frames = 0;
      continue;
    }

    const fade = item.frames / item.maxFrames;
    if (item.kind === "success") {
      const color = COLORS[item.path] || COLORS.hot;
      quadPath(quad, scale, offX, offY);
      ctx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${0.10 + 0.18 * fade})`;
      ctx.fill();
    } else {
      const finderSeen = item.kind === "sighting";
      const color = finderSeen ? [255, 180, 45] : [255, 56, 72];
      const alpha = (finderSeen ? 0.24 : 0.20) + (finderSeen ? 0.50 : 0.44) * fade;
      cornerOutline(
        quad,
        scale,
        offX,
        offY,
        `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`,
        Math.max(1, 1.2 * dpr)
      );
    }

    item.frames--;
    if (item.frames > 0) animate = true;
  }

  // No permanent animation/polling loop. Continue only while an event is
  // visibly fading; otherwise the canvas sleeps until the runtime sends data.
  if (animate) scheduleDraw();
}

function mark(slot, quad, kind, path, frames) {
  const index = Number(slot);
  if (!Number.isInteger(index) || index < 0 || index >= activity.length || !validQuad(quad)) return;
  activity[index] = {
    quad,
    kind,
    path: normalizePath(path),
    frames,
    maxFrames: frames
  };
  scheduleDraw();
}

function sightingNear(quad, sightings) {
  if (!validQuad(quad) || !Array.isArray(sightings) || !sightings.length) return false;
  const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  const left = Math.min(...points.map((point) => point.x));
  const right = Math.max(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const bottom = Math.max(...points.map((point) => point.y));
  const pad = Math.max(12, Math.max(right - left, bottom - top) * 0.55);
  return sightings.some((box) => {
    const x = Number(box?.x) + Number(box?.w) * 0.5;
    const y = Number(box?.y) + Number(box?.h) * 0.5;
    return Number.isFinite(x) && Number.isFinite(y) &&
      x >= left - pad && x <= right + pad && y >= top - pad && y <= bottom + pad;
  });
}

globalThis.__airgapperUserOverlay = {
  success(slot, quad, path = "hot") {
    if (!normalMode()) return;
    mark(slot, quad, "success", path, SUCCESS_FRAMES);
  },

  recovery(targets, symbols, sightings) {
    if (!normalMode() || !Array.isArray(targets)) return;
    const successes = new Set((symbols || [])
      .map((symbol) => Number(symbol?.header?.slotIndex))
      .filter(Number.isInteger));

    for (const target of targets) {
      const slot = Number(target?.slot);
      if (!Number.isInteger(slot) || successes.has(slot) || !validQuad(target?.quad)) continue;
      const finderSeen = sightingNear(target.quad, sightings);
      mark(
        slot,
        target.quad,
        finderSeen ? "sighting" : "miss",
        "hot",
        finderSeen ? SIGHTING_FRAMES : MISS_FRAMES
      );
    }
  },

  geometry(snapshot, usable) {
    geometry = snapshot || undefined;
    geometryUsable = Boolean(usable && snapshot?.distributedFit);
    pixelsPerModule = snapshotPixelsPerModule(snapshot);
    updateStatus();
    scheduleDraw();
  },

  latticeState(state) {
    receiverState = String(state || "SEARCH");
    if (receiverState === "SEARCH" || receiverState === "REACQUIRE" || receiverState === "DORMANT") {
      geometryUsable = false;
      pixelsPerModule = 0;
      activity.fill(undefined);
    }
    updateStatus();
    scheduleDraw();
  },

  reset() {
    geometry = undefined;
    geometryUsable = false;
    receiverState = "SEARCH";
    pixelsPerModule = 0;
    activity.fill(undefined);
    updateStatus();
    scheduleDraw();
  }
};

function syncOverlayMode() {
  const developer = !normalMode();
  if (legacyOverlay) legacyOverlay.style.display = developer ? "" : "none";
  canvas.style.display = developer ? "none" : "";
  status.style.display = developer ? "none" : "";
  if (!developer) {
    updateStatus();
    scheduleDraw();
  }
}

if (devActions) {
  new MutationObserver(syncOverlayMode).observe(devActions, {
    attributes: true,
    attributeFilter: ["hidden"]
  });
}
video?.addEventListener("resize", scheduleDraw);
window.addEventListener("resize", scheduleDraw);
globalThis.screen?.orientation?.addEventListener?.("change", scheduleDraw);
window.addEventListener("orientationchange", scheduleDraw);
updateStatus();
syncOverlayMode();
