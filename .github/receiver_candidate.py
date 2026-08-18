from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing expected text in {path}: {old[:180]!r}")
    p.write_text(text.replace(old, new, 1))


def replace_between(path, start, end, replacement):
    p = Path(path)
    text = p.read_text()
    a = text.find(start)
    if a < 0:
        raise SystemExit(f"missing start marker in {path}: {start!r}")
    b = text.find(end, a)
    if b < 0:
        raise SystemExit(f"missing end marker in {path}: {end!r}")
    p.write_text(text[:a] + replacement + text[b:])


# Preserve the actual successful decoder path on each symbol. Guided already
# exposes per-physical-slot masks, so this is true per-QR telemetry rather than
# guessing from whole-job latency.
replace_once(
    "receive/worker.js",
    '''    decodedSlotsMask = (decodedSlotsMask | slotBit) >>> 0;\n    const quad = {''',
    '''    decodedSlotsMask = (decodedSlotsMask | slotBit) >>> 0;\n    const decodePath = metrics.fallbackSuccessMask & slotBit\n      ? "fallback"\n      : metrics.sparseSuccessMask & slotBit\n        ? "sparse"\n        : "hot";\n    const quad = {'''
)
replace_once(
    "receive/worker.js",
    '''      tracked: true,\n      geometryMeasured: status === NATIVE_TRACK_OK,\n      header: packet.header''',
    '''      tracked: true,\n      geometryMeasured: status === NATIVE_TRACK_OK,\n      decodePath,\n      header: packet.header'''
)
replace_once(
    "receive/worker.js",
    '''      tracked: true,\n      crc32: mapped.input.crc32,\n      verifiedPayload: mapped.input.crc32,\n      header''',
    '''      tracked: true,\n      decodePath: "native",\n      crc32: mapped.input.crc32,\n      verifiedPayload: mapped.input.crc32,\n      header'''
)
# Dense robust scout / robust-first success.
replace_once(
    "receive/worker.js",
    '''            modules: result.modules,\n            tracked: false,\n            header: packet.header\n          });\n        }\n      } finally {\n        decoded.delete();\n      }\n      mapOutputToDisplay();\n      ctx.postMessage({\n        id,\n        symbols,\n        sightings,\n        full: false,\n        trackedAttempted: false,''',
    '''            modules: result.modules,\n            tracked: false,\n            decodePath: "robust",\n            header: packet.header\n          });\n        }\n      } finally {\n        decoded.delete();\n      }\n      mapOutputToDisplay();\n      ctx.postMessage({\n        id,\n        symbols,\n        sightings,\n        full: false,\n        trackedAttempted: false,'''
)
# Native tracked recovery that had to fall through to a generic robust read.
replace_once(
    "receive/worker.js",
    '''            modules: result.modules,\n            tracked: false,\n            header: packet.header\n          });\n        }\n      } finally {\n        decoded.delete();\n      }\n      mapOutputToDisplay();\n      ctx.postMessage({\n        id,\n        symbols,\n        sightings,\n        full: false,\n        trackedAttempted: true,''',
    '''            modules: result.modules,\n            tracked: false,\n            decodePath: "fallback",\n            header: packet.header\n          });\n        }\n      } finally {\n        decoded.delete();\n      }\n      mapOutputToDisplay();\n      ctx.postMessage({\n        id,\n        symbols,\n        sightings,\n        full: false,\n        trackedAttempted: true,'''
)
# Legacy single tracked read is still a cheap tracked/native success.
replace_once(
    "receive/worker.js",
    '''            quad: shifted(trackedPosition, ox, oy),\n            modules: r.modules,\n            tracked: true\n          });''',
    '''            quad: shifted(trackedPosition, ox, oy),\n            modules: r.modules,\n            tracked: true,\n            decodePath: "native"\n          });'''
)
# Final generic decoder is acquisition when full, otherwise tracked fallback.
replace_once(
    "receive/worker.js",
    '''                quad: shifted(r.position, ox, oy),\n                modules: r.modules,\n                tracked: false\n              });''',
    '''                quad: shifted(r.position, ox, oy),\n                modules: r.modules,\n                tracked: false,\n                decodePath: full ? "acquire" : "fallback"\n              });'''
)

# Carry the path metadata through the worker pool into the existing decode event.
replace_once(
    "shared/worker-pool.js",
    '''            geometryMeasured: symbol.geometryMeasured !== false,\n            crc32: symbol.crc32,''',
    '''            geometryMeasured: symbol.geometryMeasured !== false,\n            decodePath: symbol.decodePath,\n            crc32: symbol.crc32,'''
)

# Remember the last successful path for the physical slot. This is intentionally
# tied to a CRC-valid decode, never to a submitted job or speculative attempt.
replace_once(
    "receive/main.js",
    '''  if (decodedRegion) noteSequence(decodedRegion, header.seq, info?.scanId === void 0 ? decodedAt : scanCapturedAt.get(info.scanId) ?? decodedAt);''',
    '''  if (decodedRegion && info?.decodePath) {\n    decodedRegion.decodePath = info.decodePath;\n    decodedRegion.decodePathAt = decodedAt;\n  }\n  if (decodedRegion) noteSequence(decodedRegion, header.seq, info?.scanId === void 0 ? decodedAt : scanCapturedAt.get(info.scanId) ?? decodedAt);'''
)

# Replace hue=generic-quality with orthogonal visual channels:
# hue=successful decode path; glow=recent success; dash=geometry trust;
# opacity=health. The known wall remains as a faint constellation between hits.
overlay = r'''const INDICATOR_FADE_MS = 700;
const SIGHTING_FADE_MS = 450;
const OVERLAY_PATH_COLORS = {
  hot: "#00efff",
  native: "#42a5ff",
  sparse: "#35d66f",
  fallback: "#ffb23e",
  robust: "#ff735c",
  acquire: "#b486ff"
};
const OVERLAY_PATH_LABELS = {
  hot: "H",
  native: "N",
  sparse: "S",
  fallback: "F",
  robust: "R",
  acquire: "A"
};
const OVERLAY_GHOST_COLOR = "#b8d3e6";
const OVERLAY_LOCAL_COLOR = OVERLAY_PATH_COLORS.acquire;
const overlayCtx = overlay.getContext("2d");
function captureQualityRate(region, now) {
  pruneSequenceSamples(region, now);
  return region.decodeAttempts ? region.decodeConfidence : region.sequenceSamples.length > 0 ? 0.5 : 0;
}
function overlayPathColor(region) {
  return OVERLAY_PATH_COLORS[region.decodePath] ?? OVERLAY_PATH_COLORS.hot;
}
function overlayPathLabel(region) {
  return OVERLAY_PATH_LABELS[region.decodePath] ?? "·";
}
function layoutOrder(a, b) {
  const dy = a.y + a.h / 2 - (b.y + b.h / 2);
  if (Math.abs(dy) > Math.max(a.h, b.h) / 2) return dy;
  return a.x + a.w / 2 - (b.x + b.w / 2);
}
function drawOverlayCorners(x, y, w, h, len) {
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
function drawOverlayDevBadge(region, x, y, w, h, dpr) {
  if (region.gridSlot === void 0 || Math.min(w, h) < 46 * dpr) return;
  const slot = Number(region.gridSlot);
  const attempts = Number.isInteger(slot) && slot >= 0 && slot < SLOT_METRIC_COUNT ? slotAttemptCounts[slot] : 0;
  const hits = Number.isInteger(slot) && slot >= 0 && slot < SLOT_METRIC_COUNT ? slotHitCounts[slot] : 0;
  const weak = Number.isInteger(slot) && slot >= 0 && slot < SLOT_METRIC_COUNT && slotAdaptiveWeak[slot] ? "!" : "";
  const rate = attempts ? `${Math.round(hits / attempts * 100)}%` : "—";
  const ppm = region.pixelsPerModule > 0 ? `${region.pixelsPerModule.toFixed(1)}px/m` : "—";
  const line1 = `${slot + 1} ${overlayPathLabel(region)}${weak} ${rate}`;
  const line2 = ppm;
  const font1 = 9.5 * dpr;
  const font2 = 8 * dpr;
  const padX = 4 * dpr;
  const padY = 3 * dpr;
  overlayCtx.shadowBlur = 0;
  overlayCtx.setLineDash([]);
  overlayCtx.font = `600 ${font1}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const width1 = overlayCtx.measureText(line1).width;
  overlayCtx.font = `500 ${font2}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const width2 = overlayCtx.measureText(line2).width;
  const badgeW = Math.max(width1, width2) + padX * 2;
  const badgeH = font1 + font2 + padY * 3;
  const bx = x + 4 * dpr;
  const by = y + 4 * dpr;
  overlayCtx.globalAlpha = 0.72;
  overlayCtx.fillStyle = "#071018";
  overlayCtx.fillRect(bx, by, badgeW, badgeH);
  overlayCtx.globalAlpha = 0.98;
  overlayCtx.font = `600 ${font1}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  overlayCtx.fillStyle = overlayPathColor(region);
  overlayCtx.fillText(line1, bx + padX, by + padY + font1 * 0.86);
  overlayCtx.font = `500 ${font2}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  overlayCtx.fillStyle = "#e8f2f8";
  overlayCtx.fillText(line2, bx + padX, by + padY * 2 + font1 + font2 * 0.82);
}
function drawOverlayDevLegend(dpr) {
  const legend = "H hot   S sparse   F fallback   R robust   A acquire   N native";
  const font = 9 * dpr;
  const padX = 6 * dpr;
  const padY = 4 * dpr;
  overlayCtx.font = `600 ${font}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const width = overlayCtx.measureText(legend).width + padX * 2;
  const height = font + padY * 2;
  overlayCtx.globalAlpha = 0.68;
  overlayCtx.fillStyle = "#071018";
  overlayCtx.fillRect(7 * dpr, 7 * dpr, width, height);
  overlayCtx.globalAlpha = 0.95;
  overlayCtx.fillStyle = "#eef8ff";
  overlayCtx.fillText(legend, 7 * dpr + padX, 7 * dpr + padY + font * 0.84);
}
let lastOverlayDrawAt = -Infinity;
function drawOverlay(now) {
  if (now - lastOverlayDrawAt < 50) return;
  lastOverlayDrawAt = now;
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
  const scale = Math.min(pw / vw, ph / vh);
  const offX = (pw - vw * scale) / 2;
  const offY = (ph - vh * scale) / 2;
  const distributedFit = Boolean(lastGridSnapshot?.distributedFit);
  const developerOverlay = !receiverDevActions.hidden;
  overlayCtx.lineCap = "round";
  overlayCtx.lineJoin = "round";
  const ordered = [...regions].sort(layoutOrder);
  for (const r of ordered) {
    const gridRegion = r.gridSlot !== void 0;
    if (gridRegion && r.slotState === "OFFSCREEN") continue;
    const decodedAge = now - (r.decodedSeen ?? -Infinity);
    const sightingAge = now - (r.sightedSeen ?? r.seen);
    const successful = decodedAge <= INDICATOR_FADE_MS;
    if (!gridRegion && !successful && sightingAge > SIGHTING_FADE_MS) continue;
    const quality = Math.max(0, Math.min(1, captureQualityRate(r, now)));
    const pad = 0.055 * Math.max(r.w, r.h) * scale;
    const x = offX + r.x * scale - pad;
    const y = offY + r.y * scale - pad;
    const w = r.w * scale + 2 * pad;
    const h = r.h * scale + 2 * pad;
    const minSide = Math.min(w, h);
    const localGeometry = gridRegion && !distributedFit;
    const weak = r.slotState === "LOW_QUALITY" || r.slotState === "LOST";

    // Stable constellation: known slots do not disappear merely because a page
    // did not decode in the last 700 ms. Dash means the whole-wall transform is
    // still locally/provisionally constrained; opacity carries health.
    overlayCtx.shadowBlur = 0;
    overlayCtx.strokeStyle = localGeometry || !gridRegion ? OVERLAY_LOCAL_COLOR : OVERLAY_GHOST_COLOR;
    overlayCtx.lineWidth = Math.max(1, 1.15 * dpr);
    overlayCtx.setLineDash(localGeometry || !gridRegion ? [3 * dpr, 4 * dpr] : []);
    overlayCtx.globalAlpha = gridRegion
      ? localGeometry
        ? 0.24
        : weak
          ? 0.07
          : 0.10 + 0.12 * Math.sqrt(quality)
      : Math.max(0, 0.38 * (1 - sightingAge / SIGHTING_FADE_MS));
    drawOverlayCorners(x, y, w, h, 0.18 * minSide);

    if (successful) {
      // Every CRC-valid QR gives a small luminous pop. Color says *how it was
      // decoded*, not merely whether it was good, so amber/orange immediately
      // exposes expensive recovery while cyan/green shows the fast wall.
      const t = Math.max(0, Math.min(1, decodedAge / INDICATOR_FADE_MS));
      const pulse = 1 - t;
      const pop = (1.5 + 2.5 * pulse) * dpr;
      const color = overlayPathColor(r);
      overlayCtx.strokeStyle = color;
      overlayCtx.shadowColor = color;
      overlayCtx.shadowBlur = (3 + 7 * pulse) * dpr;
      overlayCtx.lineWidth = Math.max(2, (2 + 0.8 * pulse) * dpr);
      overlayCtx.setLineDash([]);
      overlayCtx.globalAlpha = 0.30 + 0.70 * pulse;
      drawOverlayCorners(x - pop, y - pop, w + pop * 2, h + pop * 2, (0.20 + 0.07 * pulse) * minSide);
    }

    if (developerOverlay && gridRegion) drawOverlayDevBadge(r, x, y, w, h, dpr);
  }

  // Optimizer measurements are deliberately separate from normal path state.
  const optimizerFadeMs = Math.max(INDICATOR_FADE_MS, 650);
  for (let i = optimizerOverlayHits.length - 1; i >= 0; i--) {
    const hit = optimizerOverlayHits[i];
    const age = now - hit.at;
    if (age > optimizerFadeMs) {
      optimizerOverlayHits.splice(i, 1);
      continue;
    }
    const r = hit.box;
    const pad = 0.06 * Math.max(r.w, r.h) * scale;
    const x = offX + r.x * scale - pad;
    const y = offY + r.y * scale - pad;
    const w = r.w * scale + 2 * pad;
    const h = r.h * scale + 2 * pad;
    overlayCtx.globalAlpha = 1 - 0.65 * age / optimizerFadeMs;
    overlayCtx.strokeStyle = OVERLAY_PATH_COLORS.sparse;
    overlayCtx.shadowColor = OVERLAY_PATH_COLORS.sparse;
    overlayCtx.shadowBlur = 5 * dpr;
    overlayCtx.lineWidth = Math.max(2.5, 2.5 * dpr);
    overlayCtx.setLineDash([]);
    drawOverlayCorners(x, y, w, h, 0.24 * Math.min(w, h));
  }
  if (developerOverlay) drawOverlayDevLegend(dpr);
  overlayCtx.globalAlpha = 1;
  overlayCtx.shadowBlur = 0;
  overlayCtx.setLineDash([]);
}
'''
replace_between("receive/main.js", "const INDICATOR_FADE_MS = 700;", "function focusGeometry() {", overlay)

# Version/cache bust. Sender protocol/rendering is unchanged.
replace_once("main.js", 'const APP_BUILD = "v0.5.275";', 'const APP_BUILD = "v0.5.276";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.275";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.276";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.275";', 'const SEND_RUNTIME_BUILD = "v0.5.276";')
replace_once("index.html", 'v0.5.275</span>', 'v0.5.276</span>')
replace_once("index.html", './main.js?build=v0.5.275', './main.js?build=v0.5.276')
replace_once("sw.js", 'airgapper-static-js-v223', 'airgapper-static-js-v224')
