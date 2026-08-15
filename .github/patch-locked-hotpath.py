from pathlib import Path

p = Path('receive/main.js')
s = p.read_text()

old = '''  const gridNeedsDiscovery = visibleGridSlots.some((region) => !region.decoded || region.slotState === "LOST");
  const trackingUnhealthy = regions.some((region) => region.gridSlot === void 0 && region.decoded && region.consecutiveMisses >= 4);
  gridLattice.noteMissing(gridNeedsDiscovery, now);
  const needsRecoveryScan = live === 0 || live < expectedRegions || trackingUnhealthy || gridNeedsDiscovery;
  const scanInterval = live === 0 ? ACQUISITION_SCAN_MS : FULL_SCAN_DEGRADED_MS;
  const captureHasTrackedWork = gridLattice.active ? visibleGridSlots.some((region) => region.quad && region.dim && isGridDecodeCandidate(region) && validTrackedQuad(region, vw, vh)) : regions.some((region) => region.decoded && region.quad && region.dim && validTrackedQuad(region, vw, vh));
  const fullScanDue = captureNextScan ? !captureHasTrackedWork : needsRecoveryScan && now - lastFullScan > scanInterval;'''
new = '''  // Once a framed packet declares the layout, the lattice is authoritative.
  // A single QR miss is a local decode problem, not a reason to wake the
  // expensive generic finder. Only abandon the hot tracked path when every
  // geometrically possible cell has gone cold together.
  const lockedGeometryCandidates = gridLattice.locked && lastGridSnapshot ? visibleGridSlots.filter((region) =>
    region.quad && region.dim && isGridDecodeCandidate(region) && validTrackedQuad(region, vw, vh)
  ) : [];
  const lockedGeometryTrusted = lockedGeometryCandidates.length > 0;
  const recentLockedHits = lockedGeometryCandidates.reduce((count, region) =>
    count + Number(now - (region.decodedSeen ?? -Infinity) < 900), 0
  );
  const allLockedCandidatesCold = lockedGeometryTrusted && recentLockedHits === 0 &&
    lockedGeometryCandidates.every((region) => region.consecutiveMisses >= 5);
  const gridNeedsDiscovery = lockedGeometryTrusted
    ? allLockedCandidatesCold
    : visibleGridSlots.some((region) => !region.decoded || region.slotState === "LOST");
  const trackingUnhealthy = regions.some((region) => region.gridSlot === void 0 && region.decoded && region.consecutiveMisses >= 4);
  gridLattice.noteMissing(gridNeedsDiscovery, now);
  const needsRecoveryScan = lockedGeometryTrusted
    ? allLockedCandidatesCold || trackingUnhealthy
    : live === 0 || live < expectedRegions || trackingUnhealthy || gridNeedsDiscovery;
  const scanInterval = live === 0 ? ACQUISITION_SCAN_MS : FULL_SCAN_DEGRADED_MS;
  const captureHasTrackedWork = gridLattice.active ? lockedGeometryCandidates.length > 0 : regions.some((region) => region.decoded && region.quad && region.dim && validTrackedQuad(region, vw, vh));
  const fullScanDue = captureNextScan ? !captureHasTrackedWork : needsRecoveryScan && now - lastFullScan > scanInterval;'''
if s.count(old) != 1:
    raise SystemExit('locked discovery block mismatch')
s = s.replace(old, new, 1)

old = '''  if (fullScanDue) {
    lastFullScan = now;
    fullScans++;
    const img = source.image ? new ImageData(new Uint8ClampedArray(source.image.data), vw, vh) : (ctx.drawImage(video, 0, 0), ctx.getImageData(0, 0, vw, vh));
    inspectStaticQrOptics(source, img);
    captureSubmittedScan(img, 0, 0, true);
    const id = frameId++;
    if (submitReceiverJob(
      { id, buf: img.data.buffer, w: vw, h: vh, ox: 0, oy: 0, full: true },
      [img.data.buffer],
      "FULL FRAME",
      trace,
      source.sequence
    )) {
      if (pendingScanCapture && pendingScanCapture.id === void 0) pendingScanCapture.id = id;
    } else if ((pendingScanCapture == null ? void 0 : pendingScanCapture.id) === void 0) {
      cancelScanCapture();
    }
    if (trace) trace.stateAfter = gridLattice.state;
    activeBenchmarkFrame = void 0;
    return;
  }'''
new = '''  if (fullScanDue) {
    lastFullScan = now;
    fullScans++;
    let scanX = 0, scanY = 0, scanW = vw, scanH = vh;
    // During a still-trusted lock, even recovery is bounded to the only place
    // the declared grid can exist. Give it generous motion headroom, but never
    // pay a generic finder to inspect unrelated camera pixels.
    if (!captureNextScan && lockedGeometryTrusted) {
      const points = lockedGeometryCandidates.flatMap((region) => [
        region.quad.topLeft,
        region.quad.topRight,
        region.quad.bottomRight,
        region.quad.bottomLeft
      ]);
      const typicalEdge = Math.max(...lockedGeometryCandidates.map((region) => Math.max(region.w, region.h)));
      const pad = Math.max(24, Math.round(typicalEdge * 0.7));
      const quantum = 16;
      scanX = Math.max(0, Math.floor((Math.min(...points.map((point) => point.x)) - pad) / quantum) * quantum);
      scanY = Math.max(0, Math.floor((Math.min(...points.map((point) => point.y)) - pad) / quantum) * quantum);
      const scanRight = Math.min(vw, Math.ceil((Math.max(...points.map((point) => point.x)) + pad) / quantum) * quantum);
      const scanBottom = Math.min(vh, Math.ceil((Math.max(...points.map((point) => point.y)) + pad) / quantum) * quantum);
      scanW = Math.max(32, scanRight - scanX);
      scanH = Math.max(32, scanBottom - scanY);
    }
    const img = scanX || scanY || scanW !== vw || scanH !== vh
      ? readBoundedVideoCrop(source, scanX, scanY, scanW, scanH)
      : source.image
        ? new ImageData(new Uint8ClampedArray(source.image.data), vw, vh)
        : (ctx.drawImage(video, 0, 0), ctx.getImageData(0, 0, vw, vh));
    inspectStaticQrOptics(source, img, scanX, scanY);
    captureSubmittedScan(img, scanX, scanY, true);
    const id = frameId++;
    if (submitReceiverJob(
      { id, buf: img.data.buffer, w: scanW, h: scanH, ox: scanX, oy: scanY, full: true },
      [img.data.buffer],
      "FULL FRAME",
      trace,
      source.sequence
    )) {
      if (pendingScanCapture && pendingScanCapture.id === void 0) pendingScanCapture.id = id;
    } else if ((pendingScanCapture == null ? void 0 : pendingScanCapture.id) === void 0) {
      cancelScanCapture();
    }
    if (trace) trace.stateAfter = gridLattice.state;
    activeBenchmarkFrame = void 0;
    return;
  }'''
if s.count(old) != 1:
    raise SystemExit('full scan block mismatch')
s = s.replace(old, new, 1)

old = '  const healthyTrackedGrid = !captureNextScan && !gridNeedsDiscovery && !trackingUnhealthy;'
new = '  const healthyTrackedGrid = !captureNextScan && lockedGeometryTrusted && !allLockedCandidatesCold && !trackingUnhealthy;'
if s.count(old) != 1:
    raise SystemExit('lane healthy block mismatch')
s = s.replace(old, new, 1)

old = '        const pad = Math.max(10, Math.round(typicalEdge * (0.14 + Math.min(0.18, worstMisses * 0.04))));'
new = '        const pad = Math.max(8, Math.round(typicalEdge * (0.08 + Math.min(0.16, worstMisses * 0.03))));'
if s.count(old) != 1:
    raise SystemExit('lane crop padding mismatch')
s = s.replace(old, new, 1)

old = '    const pad = Math.max(12, Math.round(typicalEdge * (0.18 + Math.min(0.28, worstMisses * 0.06))));'
new = '    const pad = Math.max(10, Math.round(typicalEdge * (0.1 + Math.min(0.22, worstMisses * 0.04))));'
if s.count(old) != 1:
    raise SystemExit('shared crop padding mismatch')
s = s.replace(old, new, 1)

old = '      const healthyGrid = !captureNextScan && !gridNeedsDiscovery && !trackingUnhealthy;'
new = '      const healthyGrid = !captureNextScan && lockedGeometryTrusted && !allLockedCandidatesCold && !trackingUnhealthy;'
if s.count(old) != 1:
    raise SystemExit('shared healthy block mismatch')
s = s.replace(old, new, 1)

p.write_text(s)

p = Path('index.html')
s = p.read_text()
old = '<span class="brand">AirGapper <span class="app-version">v0.5.40</span></span>'
new = '<span class="brand">AirGapper <span class="app-version">v0.5.41</span></span>'
if s.count(old) != 1:
    raise SystemExit('version mismatch')
p.write_text(s.replace(old, new, 1))
