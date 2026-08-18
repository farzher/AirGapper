from pathlib import Path

def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing anchor in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))

# Receiver presentation: 5 Hz visible stats, still 1-second rolling window.
replace_once(
    "receive/main.js",
    'const RECEIVER_RUNTIME_BUILD = "v0.5.255";',
    'const RECEIVER_RUNTIME_BUILD = "v0.5.258";'
)
replace_once(
    "receive/main.js",
    '// Keep visible rolling status intentionally calm/readable: one DOM refresh per second.\n// The underlying event timestamps remain precise; only presentation is 1 Hz.\nconst STATS_TICK_MS = 1000;\nconst DIAGNOSTICS_TICK_MS = 1000;',
    '// Visible rolling throughput/progress repaints at 5 Hz; measurements still use the trailing 1-second window.\n// Keep the heavy developer diagnostic strings at 1 Hz so observability does not steal decode CPU.\nconst STATS_TICK_MS = 200;\nconst DIAGNOSTICS_TICK_MS = 1000;'
)

p = Path("send/main.js")
s = p.read_text()
old = '''  const paintCell = (entry) => {
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
    if (fitStaging) {
      renderFitCanvas();
    } else {
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      const totalW = staging.width;
      const totalH = staging.height;
      if (landscapeGrid()) {
        ctx.setTransform(0, canvas.height / totalW, -canvas.width / totalH, 0, canvas.width, 0);
      } else {
        ctx.setTransform(canvas.width / totalW, 0, 0, canvas.height / totalH, 0, 0);
      }
      ctx.drawImage(staging, cx, cy, cell, cell, cx, cy, cell, cell);
    }
    if (entry.ordinal !== null && activeTransportCursor?.key === transportKey) {
      activeTransportCursor.nextOrdinal = Math.max(activeTransportCursor.nextOrdinal, entry.ordinal + 1);
    }
    cellCursor = (cellCursor + 1) % gridCodes;
  };
  for (let i = 0; i < gridCodes; i++) {
    const img = queue.shift();
    if (img) paintCell(img);
  }
  if (staticStream) return;
  const interval = 1e3 / txFps;
  const subInterval = interval / gridCodes;
  let nextAt = performance.now() + interval;
  let lastTickAt = performance.now();
  let completedSweeps = 0;
  const tick = (now) => {
    if (gen !== generation || generatorFailed) return;
    requestAnimationFrame(tick);
    const sinceLastTick = now - lastTickAt;
    lastTickAt = now;
    if (sinceLastTick > 1e3) {
      if (false) {
        void fetch("/__diagnostics", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            role: "sender",
            event: "stall",
            when: (/* @__PURE__ */ new Date()).toISOString(),
            streamId: payloadId,
            stallSeconds: Number((sinceLastTick / 1e3).toFixed(1))
          })
        }).catch(() => void 0);
      }
    }
    if (now < nextAt) return;
    if (now - nextAt > interval) nextAt = now;
    while (now >= nextAt) {
      const img = queue.shift();
      pump(1);
      if (!img) {
        nextAt = now + subInterval;
        break;
      }
      paintCell(img);
      nextAt += subInterval;
      if (cellCursor === sweepOrigin) {
        completedSweeps++;
        if (txFps === 30 && completedSweeps % 15 === 0) nextAt += interval / 2;
      }
    }
  };
  requestAnimationFrame(tick);
'''
new = '''  const paintCell = (entry) => {
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
  if (staticStream) return;
  const interval = 1e3 / txFps;
  let nextAt = performance.now() + interval;
  const tick = (now) => {
    if (gen !== generation || generatorFailed) return;
    requestAnimationFrame(tick);
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
'''
if old not in s:
    raise SystemExit("sender scheduler anchor missing")
s = s.replace(old, new, 1)
p.write_text(s)

replace_once("main.js", 'const APP_BUILD = "v0.5.255";', 'const APP_BUILD = "v0.5.258";')
index = Path("index.html").read_text().replace('v0.5.255', 'v0.5.258').replace('./main.js?build=v0.5.250', './main.js?build=v0.5.258')
Path("index.html").write_text(index)
sw = Path("sw.js").read_text().replace('airgapper-static-js-v210', 'airgapper-static-js-v211', 1)
Path("sw.js").write_text(sw)
