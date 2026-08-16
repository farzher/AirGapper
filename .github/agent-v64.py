from pathlib import Path
import re


def read(path):
    return Path(path).read_text()

def write(path, text):
    Path(path).write_text(text)

def repl_once(path, old, new):
    text = read(path)
    n = text.count(old)
    if n != 1:
        raise SystemExit(f"{path}: expected one match, got {n}: {old[:120]!r}")
    write(path, text.replace(old, new, 1))

# --- receive/main.js: remove wrong-hypothesis audit baggage -----------------
main = read("receive/main.js")
main = main.replace("let lastSamplerDiagnostics = [];\n", "")
for line in [
    "  alignmentFitAttempts: 0,\n",
    "  alignmentFitSuccesses: 0,\n",
    "  pixelAuditTracks: 0,\n",
    "  pixelAuditCrcFast: 0,\n",
    "  pixelAuditMisses: 0,\n",
    "  pixelAuditAnchorMisses: 0,\n",
    "  pixelAuditFrameMisses: 0,\n",
    "  pixelAuditBitstreamFailures: 0,\n",
    "  pixelAuditCrcFailures: 0,\n",
]:
    main = main.replace(line, "")
main = main.replace("  lastSamplerDiagnostics = [];\n", "")
main = main.replace("    hotPathAudit.alignmentFitAttempts += completion.nativeMetrics.alignmentFitAttempts ?? 0;\n", "")
main = main.replace("    hotPathAudit.alignmentFitSuccesses += completion.nativeMetrics.alignmentFitSuccesses ?? 0;\n", "")
main = re.sub(r"  if \(auditThisCompletion && completion\.pixelAudit\) \{.*?\n  \}\n(?=  if \(auditThisCompletion && !auditMode\?\.full)", "", main, count=1, flags=re.S)

# A Strict post-lock run never performs a generic scan. The former
# strictHotPathLockSeen timing let one already-decoded frame be classified as a
# reacquire. Treat the actual lattice lock as authoritative at submission time.
main = main.replace(
    '  if (message.strictHotPath && !strictHotPathLockSeen && !message.full) {',
    '  if (message.strictHotPath && !gridLattice.locked && !message.full) {'
)
main = main.replace(
    '    acquisition: Boolean(message.full && !gridLattice.active),\n    reacquire: Boolean(message.full && gridLattice.state === "REACQUIRE"),',
    '    acquisition: Boolean(message.full && !gridLattice.locked),\n    reacquire: Boolean(message.full && gridLattice.locked),'
)

# --- direct VideoFrame mapping ----------------------------------------------
old_clone = '''function cloneVideoFrame(source, forceRgba = false) {
  let frame = source.videoFrame;
  if (!frame) {
    try {
      frame = source.videoFrame = new VideoFrame(video);
    } catch {
      return null;
    }
  }
  const visible = frame.visibleRect;
  const rotation = Number(frame.rotation ?? 0) % 360;
  const displaySafe = Boolean(
    visible &&
    visible.x === 0 && visible.y === 0 &&
    visible.width === source.width && visible.height === source.height &&
    frame.displayWidth === source.width && frame.displayHeight === source.height &&
    rotation === 0 && !frame.flip
  );
  lastVideoFrameInfo = `${frame.codedWidth || "—"}×${frame.codedHeight || "—"} coded · ${visible ? `${visible.x},${visible.y} ${visible.width}×${visible.height}` : "—"} visible · ${frame.displayWidth || "—"}×${frame.displayHeight || "—"} display · ${frame.format || "—"} · ${displaySafe ? "direct" : "canvas coordinate fallback"}`;
  if (!displaySafe) {
    // copyTo(rect) addresses VideoFrame pixels, while all AirGapper geometry is
    // expressed in the rendered <video> coordinate system. A scaled/cropped/
    // rotated frame therefore cannot safely share our display-space quads.
    directFrameDisabled = true;
    return null;
  }
  try {
    return { frame: frame.clone(), pixelFormat: forceRgba ? "video-rgba" : DIRECT_LUMA_FORMATS.has(frame.format) ? "y8" : "video-rgba" };
  } catch {
    return null;
  }
}
function cloneDirectDecodeFrame(source) {
  if (directFrameDisabled || optimizerPipelineActive || source.image || captureNextScan || opticalSampleDue(source) || typeof VideoFrame !== "function") return null;
  return cloneVideoFrame(source, false);
}
function cloneDirectFullScanFrame(source) {
  if (directFrameDisabled || optimizerPipelineActive || source.image || captureNextScan || typeof VideoFrame !== "function") return null;
  return cloneVideoFrame(source, true);
}
'''
new_clone = '''function cloneVideoFrame(source, forceRgba = false) {
  let frame = source.videoFrame;
  if (!frame) {
    try {
      frame = source.videoFrame = new VideoFrame(video);
    } catch {
      return null;
    }
  }
  const visible = frame.visibleRect;
  const rotation = Number(frame.rotation ?? 0) % 360;
  const scaleX = visible && source.width ? visible.width / source.width : 0;
  const scaleY = visible && source.height ? visible.height / source.height : 0;
  const coordinateMapSafe = Boolean(
    visible && source.width > 0 && source.height > 0 &&
    frame.displayWidth === source.width && frame.displayHeight === source.height &&
    Number.isFinite(scaleX) && scaleX > 0 && Number.isFinite(scaleY) && scaleY > 0 &&
    rotation === 0 && !frame.flip
  );
  const sameGrid = coordinateMapSafe && visible.x === 0 && visible.y === 0 && scaleX === 1 && scaleY === 1;
  const mapLabel = !coordinateMapSafe ? "canvas fallback" : sameGrid ? "direct" : `direct map ${scaleX.toFixed(2)}×${scaleY.toFixed(2)}`;
  lastVideoFrameInfo = `${frame.codedWidth || "—"}×${frame.codedHeight || "—"} coded · ${visible ? `${visible.x},${visible.y} ${visible.width}×${visible.height}` : "—"} visible · ${frame.displayWidth || "—"}×${frame.displayHeight || "—"} display · ${frame.format || "—"} · ${mapLabel}`;
  if (!coordinateMapSafe) return null;
  try {
    return {
      frame: frame.clone(),
      pixelFormat: forceRgba ? "video-rgba" : DIRECT_LUMA_FORMATS.has(frame.format) ? "y8" : "video-rgba",
      visibleX: visible.x,
      visibleY: visible.y,
      scaleX,
      scaleY,
      sameGrid
    };
  } catch {
    return null;
  }
}
function mappedDirectTrackedFrame(source, x, y, w, h, tracks) {
  const direct = cloneDirectDecodeFrame(source);
  if (!direct) return null;
  const pixelXf = direct.visibleX + x * direct.scaleX;
  const pixelYf = direct.visibleY + y * direct.scaleY;
  const pixelRf = direct.visibleX + (x + w) * direct.scaleX;
  const pixelBf = direct.visibleY + (y + h) * direct.scaleY;
  const pixelX = Math.round(pixelXf), pixelY = Math.round(pixelYf);
  const pixelRight = Math.round(pixelRf), pixelBottom = Math.round(pixelBf);
  if ([pixelXf - pixelX, pixelYf - pixelY, pixelRf - pixelRight, pixelBf - pixelBottom].some((delta) => Math.abs(delta) > 1e-4)) {
    direct.frame.close();
    return null;
  }
  const mapPoint = (point) => ({
    x: direct.visibleX + point.x * direct.scaleX,
    y: direct.visibleY + point.y * direct.scaleY
  });
  const mappedTracks = tracks.map((track) => ({
    ...track,
    quad: {
      topLeft: mapPoint(track.quad.topLeft),
      topRight: mapPoint(track.quad.topRight),
      bottomRight: mapPoint(track.quad.bottomRight),
      bottomLeft: mapPoint(track.quad.bottomLeft)
    }
  }));
  return {
    ...direct,
    cropX: pixelX,
    cropY: pixelY,
    w: pixelRight - pixelX,
    h: pixelBottom - pixelY,
    ox: pixelX,
    oy: pixelY,
    tracks: mappedTracks,
    outputMap: {
      offsetX: direct.visibleX,
      offsetY: direct.visibleY,
      scaleX: direct.scaleX,
      scaleY: direct.scaleY
    }
  };
}
function cloneDirectDecodeFrame(source) {
  if (directFrameDisabled || optimizerPipelineActive || source.image || captureNextScan || opticalSampleDue(source) || typeof VideoFrame !== "function") return null;
  return cloneVideoFrame(source, false);
}
function cloneDirectFullScanFrame(source) {
  if (directFrameDisabled || optimizerPipelineActive || source.image || captureNextScan || typeof VideoFrame !== "function") return null;
  const direct = cloneVideoFrame(source, true);
  if (!direct || !direct.sameGrid) {
    direct?.frame.close();
    return null;
  }
  return direct;
}
'''
if old_clone not in main:
    raise SystemExit("main.js: cloneVideoFrame block not found")
main = main.replace(old_clone, new_clone, 1)

# Pending spatial lanes must map display-space geometry to VideoFrame pixels too.
main = re.sub(
    r'''function queuePendingGridLane\(groupIndex, source, geometry\) \{\n  const direct = cloneDirectDecodeFrame\(source\);\n  if \(!direct\) return false;\n  discardPendingGridLane\(groupIndex\);\n  pendingGridLanes\[groupIndex\] = \{ \.\.\.geometry, direct \};\n  return true;\n\}''',
    '''function queuePendingGridLane(groupIndex, source, geometry) {\n  const direct = mappedDirectTrackedFrame(source, geometry.x, geometry.y, geometry.w, geometry.h, geometry.tracks);\n  if (!direct) return false;\n  discardPendingGridLane(groupIndex);\n  pendingGridLanes[groupIndex] = { ...geometry, direct };\n  return true;\n}''',
    main,
    count=1
)

# Drain a mapped direct job using pixel-space crop/track geometry. Worker maps
# successful quads back to display space before the main thread sees them.
main = re.sub(
    r'''const message = \{\n    id,\n    videoFrame: pending\.direct\.frame,\n    cropX: pending\.x,\n    cropY: pending\.y,\n    w: pending\.w,\n    h: pending\.h,\n    ox: pending\.x,\n    oy: pending\.y,\n    full: false,\n    tracks: pending\.tracks,\n    pixelFormat: pending\.direct\.pixelFormat,\n    strictHotPath: pending\.strictHotPath,\n    diagnoseSampler: pending\.diagnoseSampler\n  \};''',
    '''const message = {\n    id,\n    videoFrame: pending.direct.frame,\n    cropX: pending.direct.cropX,\n    cropY: pending.direct.cropY,\n    w: pending.direct.w,\n    h: pending.direct.h,\n    ox: pending.direct.ox,\n    oy: pending.direct.oy,\n    full: false,\n    tracks: pending.direct.tracks,\n    pixelFormat: pending.direct.pixelFormat,\n    outputMap: pending.direct.outputMap,\n    strictHotPath: pending.strictHotPath\n  };''',
    main,
    count=1
)

# Immediate spatial lane direct path.
main = main.replace(
    '      const direct = cloneDirectDecodeFrame(source);\n      if (!direct) {',
    '      const direct = mappedDirectTrackedFrame(source, x, y, w, h, group.tracks);\n      if (!direct) {',
    1
)
main = main.replace(
    '        ? { id, videoFrame: direct.frame, cropX: x, cropY: y, w, h, ox: x, oy: y, full: false, tracks: group.tracks, pixelFormat: direct.pixelFormat, strictHotPath: strictHotPathActive(), diagnoseSampler: !receiverDevActions.hidden }',
    '        ? { id, videoFrame: direct.frame, cropX: direct.cropX, cropY: direct.cropY, w: direct.w, h: direct.h, ox: direct.ox, oy: direct.oy, full: false, tracks: direct.tracks, pixelFormat: direct.pixelFormat, outputMap: direct.outputMap, strictHotPath: strictHotPathActive() }',
    1
)

# Shared tracked-batch direct path.
main = main.replace(
    '      const sharedDirect = healthyGrid ? cloneDirectDecodeFrame(source) : null;',
    '      const sharedDirect = healthyGrid ? mappedDirectTrackedFrame(source, x, y, w, h, batchTracks) : null;',
    1
)
main = main.replace(
    '          ? { id: id2, videoFrame: sharedDirect.frame, cropX: x, cropY: y, w, h, ox: x, oy: y, full: false, tracks: batchTracks, pixelFormat: sharedDirect.pixelFormat, strictHotPath: strictHotPathActive(), diagnoseSampler: !receiverDevActions.hidden }',
    '          ? { id: id2, videoFrame: sharedDirect.frame, cropX: sharedDirect.cropX, cropY: sharedDirect.cropY, w: sharedDirect.w, h: sharedDirect.h, ox: sharedDirect.ox, oy: sharedDirect.oy, full: false, tracks: sharedDirect.tracks, pixelFormat: sharedDirect.pixelFormat, outputMap: sharedDirect.outputMap, strictHotPath: strictHotPathActive() }',
    1
)

# Strip live diagnoseSampler flags; the matrix oracle was a temporary debug aid.
main = main.replace(', diagnoseSampler: !receiverDevActions.hidden', '')

# Diagnostics: keep the useful fast-path numbers, remove disproven rescue/A-B noise.
main = re.sub(r'''  const samplerLine = lastSamplerDiagnostics\.length\n    \? lastSamplerDiagnostics\.map\(\(item\) => item\.error\n      \? `s\$\{item\.slot \?\? "\?"\} error \$\{item\.error\}`\n      : `s\$\{item\.slot\} \$\{item\.classification\} · cache \$\{item\.cached\.mismatches\}/\$\{item\.cached\.total\} · lattice \$\{item\.current\.mismatches\}/\$\{item\.current\.total\} · fresh \$\{item\.fresh\.mismatches\}/\$\{item\.fresh\.total\}`\n    \)\.join\(" \| "\)\n    : "no matrix-oracle recovery event";\n''', '', main, count=1)
main = re.sub(
    r'''Sampler HybridBinarizer · plain-grid CRC \$\{hotPathAudit\.anchorBypassSuccesses\}/\$\{hotPathAudit\.anchorBypassAttempts\} · alignment-fit CRC \$\{hotPathAudit\.alignmentFitSuccesses\}/\$\{hotPathAudit\.alignmentFitAttempts\}\nPixel path \$\{lastDirectPixelPath\.toUpperCase\(\)\} · A/B Y8-miss → isolated RGBA CRC \$\{hotPathAudit\.pixelAuditCrcFast\}/\$\{hotPathAudit\.pixelAuditTracks\} · misses \$\{hotPathAudit\.pixelAuditMisses\} \(anchor \$\{hotPathAudit\.pixelAuditAnchorMisses\} · frame \$\{hotPathAudit\.pixelAuditFrameMisses\} · bits \$\{hotPathAudit\.pixelAuditBitstreamFailures\} · CRC \$\{hotPathAudit\.pixelAuditCrcFailures\}\)\nGeneric full \$\{hotPathAudit\.fullScanSuccesses\}/\$\{hotPathAudit\.fullScanJobs\} · acquisition \$\{hotPathAudit\.acquisitionFullScans\} · reacquire \$\{hotPathAudit\.reacquireFullScans\}\nSampler \$\{samplerLine\}''',
    '''Sampler HybridBinarizer + SampleGrid · CRC ${hotPathAudit.anchorBypassSuccesses}/${hotPathAudit.anchorBypassAttempts}\nPixel path ${lastDirectPixelPath.toUpperCase()}\nGeneric full ${hotPathAudit.fullScanSuccesses}/${hotPathAudit.fullScanJobs} · acquisition ${hotPathAudit.acquisitionFullScans} · reacquire ${hotPathAudit.reacquireFullScans}''',
    main,
    count=1
)

write("receive/main.js", main)

# --- worker.js: one production pixel path, coordinate output mapping ---------
worker = read("receive/worker.js")
worker = worker.replace('let directPixelMode = "y8";\nlet directPixelAuditAttempts = 0;\nlet directPixelRgbaWins = 0;\nconst DIRECT_PIXEL_AUDIT_LIMIT = 3;\n', '')
worker = re.sub(r'''function decodeNativeAuditRGBA\(zx, ptr, width, height, ox, oy, tracks, stride = width \* 4\) \{.*?\n\}\nlet qrGeneratorPromise;''', 'let qrGeneratorPromise;', worker, count=1, flags=re.S)
worker = worker.replace(
    '  const { id, buf, videoFrame, cropX = 0, cropY = 0, w = 0, h = 0, ox = 0, oy = 0, full = true, quad, dim, tracks, isolated = false, oracle = false, oracleSeeds = [], sentAt, pixelFormat = "rgba", yOffset: messageYOffset = 0, yStride: messageYStride = 0, payloadBytes = 0, strictHotPath = false, diagnoseSampler = false } = e.data;',
    '  const { id, buf, videoFrame, cropX = 0, cropY = 0, w = 0, h = 0, ox = 0, oy = 0, full = true, quad, dim, tracks, isolated = false, oracle = false, oracleSeeds = [], sentAt, pixelFormat = "rgba", yOffset: messageYOffset = 0, yStride: messageYStride = 0, payloadBytes = 0, strictHotPath = false, outputMap } = e.data;'
)
worker = worker.replace(
    '      const sourceHasDirectY = pixelFormat === "y8";\n      const selectedRgba = sourceHasDirectY && directPixelMode === "rgba" && !full && Boolean(tracks?.length);\n      const copyAsRgba = pixelFormat !== "y8" || selectedRgba;',
    '      const copyAsRgba = pixelFormat !== "y8";'
)
worker = worker.replace(
    '      // Keep a direct Y-plane frame alive until the native attempt finishes.\n      // Recovery/diagnostics may need an RGBA copy of this exact same frame.\n      if (copyAsRgba || full || !(tracks?.length)) {\n        ownedVideoFrame.close();\n        ownedVideoFrame = null;\n      }',
    '      // Only LIVE local recovery needs the original Y frame after the native attempt.\n      if (copyAsRgba || full || !(tracks?.length) || !robustTrackedRecovery) {\n        ownedVideoFrame.close();\n        ownedVideoFrame = null;\n      }'
)

# Remove the isolated same-frame RGBA A/B experiment completely.
worker = re.sub(
    r'''      let pixelAudit = null;\n      let rgbaRecoveryPtr = 0;\n      let rgbaRecoveryStride = 0;\n\n      // Same-frame representation A/B\..*?\n      const robustFallback = robustTrackedRecovery && nativeSymbols\.length === 0;''',
    '      const robustFallback = robustTrackedRecovery && nativeSymbols.length === 0;',
    worker,
    count=1,
    flags=re.S
)
worker = worker.replace('          pixelAudit,\n', '')
worker = worker.replace('        pixelAudit,\n', '')

# Remap native/local-recovery output from VideoFrame pixel coordinates back to
# the display coordinate system used by GridLattice and the overlay.
insert_before = '    let trackedHit = false;\n'
map_code = '''    if (outputMap && Number.isFinite(outputMap.scaleX) && outputMap.scaleX > 0 && Number.isFinite(outputMap.scaleY) && outputMap.scaleY > 0) {
      const mapPoint = (point) => ({
        x: (point.x - outputMap.offsetX) / outputMap.scaleX,
        y: (point.y - outputMap.offsetY) / outputMap.scaleY
      });
      const mapQuad = (q) => validQuad(q) ? {
        topLeft: mapPoint(q.topLeft),
        topRight: mapPoint(q.topRight),
        bottomRight: mapPoint(q.bottomRight),
        bottomLeft: mapPoint(q.bottomLeft)
      } : null;
      for (const symbol of symbols) {
        const q = mapQuad(symbol.quad);
        if (!q) continue;
        symbol.quad = q;
        symbol.box = boundsOf(q, 0, 0);
      }
      for (const box of sightings) {
        box.x = (box.x - outputMap.offsetX) / outputMap.scaleX;
        box.y = (box.y - outputMap.offsetY) / outputMap.scaleY;
        box.w /= outputMap.scaleX;
        box.h /= outputMap.scaleY;
      }
    }
'''
# Need mapping before every tracked early return, not just generic tail. Add a helper once and invoke.
helper_anchor = '    const symbols = [];\n    const sightings = [];\n    const samplerDiagnostics = [];\n'
helper = '''    const symbols = [];
    const sightings = [];
    const samplerDiagnostics = [];
    const mapOutputToDisplay = () => {
      if (!outputMap || !Number.isFinite(outputMap.scaleX) || outputMap.scaleX <= 0 || !Number.isFinite(outputMap.scaleY) || outputMap.scaleY <= 0) return;
      const mapPoint = (point) => ({
        x: (point.x - outputMap.offsetX) / outputMap.scaleX,
        y: (point.y - outputMap.offsetY) / outputMap.scaleY
      });
      for (const symbol of symbols) {
        if (!validQuad(symbol.quad)) continue;
        symbol.quad = {
          topLeft: mapPoint(symbol.quad.topLeft),
          topRight: mapPoint(symbol.quad.topRight),
          bottomRight: mapPoint(symbol.quad.bottomRight),
          bottomLeft: mapPoint(symbol.quad.bottomLeft)
        };
        symbol.box = boundsOf(symbol.quad, 0, 0);
      }
      for (const box of sightings) {
        box.x = (box.x - outputMap.offsetX) / outputMap.scaleX;
        box.y = (box.y - outputMap.offsetY) / outputMap.scaleY;
        box.w /= outputMap.scaleX;
        box.h /= outputMap.scaleY;
      }
    };
'''
if helper_anchor not in worker:
    raise SystemExit("worker.js: symbol helper anchor missing")
worker = worker.replace(helper_anchor, helper, 1)
# Every normal tracked reply must map first.
worker = worker.replace('        const reply = {\n          id,', '        mapOutputToDisplay();\n        const reply = {\n          id,', 1)
worker = worker.replace('      ctx.postMessage({\n        id,\n        symbols,\n        sightings,\n        full: false,', '      mapOutputToDisplay();\n      ctx.postMessage({\n        id,\n        symbols,\n        sightings,\n        full: false,', 1)
# Generic final reply is normally canvas/full, but mapping it is harmless for any mapped legacy job.
worker = worker.replace('    ownedVideoFrame?.close();\n    ownedVideoFrame = null;\n    ctx.postMessage({', '    ownedVideoFrame?.close();\n    ownedVideoFrame = null;\n    mapOutputToDisplay();\n    ctx.postMessage({', 1)

write("receive/worker.js", worker)

# worker-pool no longer transports temporary A/B/oracle live diagnostics.
pool = read("shared/worker-pool.js")
pool = pool.replace('          pixelAudit: message.pixelAudit,\n', '')
pool = pool.replace('          samplerDiagnostics: message.samplerDiagnostics ?? [],\n', '')
write("shared/worker-pool.js", pool)

# --- native persistent decoder: delete the disproven alignment-fit rescue ----
cpp = read("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
cpp = re.sub(r'''\n\t\t// A four-corner homography is not enough for a large QR viewed through a\n.*?\n\t\t};\n\n\t\t// First attempt is always the last CRC-confirmed geometry\.''', '\n\t\t// First attempt is always the last CRC-confirmed geometry.', cpp, count=1, flags=re.S)
cpp = cpp.replace(
    '''\t\tif (track.crc32Payload) {\n\t\t\tpacket = fastDecode();\n\t\t\tif (!packet.empty())\n\t\t\t\t++measured.anchorBypassSuccesses;\n\t\t\telse\n\t\t\t\tpacket = alignmentFit(track.dx, track.dy);\n\t\t}\n''',
    '''\t\tif (track.crc32Payload) {\n\t\t\tpacket = fastDecode();\n\t\t\tif (!packet.empty())\n\t\t\t\t++measured.anchorBypassSuccesses;\n\t\t}\n'''
)
cpp = cpp.replace(
    '''\t\t\t\t\tif (sampleGrid(track.dx, track.dy))\n\t\t\t\t\t\tpacket = fastDecode();\n\t\t\t\t\tif (packet.empty())\n\t\t\t\t\t\tpacket = alignmentFit(track.dx, track.dy);\n''',
    '''\t\t\t\t\tif (sampleGrid(track.dx, track.dy))\n\t\t\t\t\t\tpacket = fastDecode();\n'''
)
write("vendor/decimen-codec/source/wrapper/decimen_codec.cpp", cpp)

# Version/cache.
repl_once("index.html", "v0.5.63", "v0.5.64")
repl_once("sw.js", 'airgapper-static-js-v26', 'airgapper-static-js-v27')
