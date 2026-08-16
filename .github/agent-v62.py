from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))

# Strict state must reflect the actual checkbox even if the browser restored it.
replace_once(
    "receive/main.js",
    "let strictHotPathEnabled = false;",
    "let strictHotPathEnabled = strictHotPathToggle.checked;",
)

# A Strict transition is a clean decoder-mode boundary. Recreate workers so a
# pre-Strict Y8/RGBA decision and native tracking state cannot leak into the new audit.
replace_once(
    "receive/main.js",
    '''strictHotPathToggle.addEventListener("change", () => {
  strictHotPathEnabled = strictHotPathToggle.checked;
  strictHotPathLockSeen = false;
  hotPathAuditGeneration++;
  resetHotPathAudit();
});''',
    '''strictHotPathToggle.addEventListener("change", () => {
  strictHotPathEnabled = strictHotPathToggle.checked;
  hotPathAuditGeneration++;
  hotPathJobMode.clear();
  resetHotPathAudit();
  lastDirectPixelPath = "—";
  minimumAcceptedScanId = frameId;
  clearPendingGridLanes();
  cropAttempts.clear();
  // Plain/sighting regions are acquisition hints, never persistent Strict tracks.
  for (let i = regions.length - 1; i >= 0; i--) {
    if (regions[i].gridSlot === void 0) regions.splice(i, 1);
  }
  strictHotPathLockSeen = Boolean(gridLattice.locked);
  // Worker-local native geometry and direct pixel-mode adaptation are session state.
  // Recreate workers at this mode boundary so the audit starts from a known state.
  pool.resize(0);
  if (stream && !done) pool.resize(selectedWorkerCount());
});''',
)

# Every job carries the actual mode. Full acquisition is separately allowed by
# the worker, so missing strictHotPath is never used as an implicit permission.
replace_once(
    "receive/main.js",
    '''function submitReceiverJob(message, transfer, kind, trace, sourceSequence, trackedRegions = [], fixedAttempts = 0, sourceOpticsEpoch, preferredWorker) {
  const auditMode = { generation: hotPathAuditGeneration, strict: Boolean(message.strictHotPath) };''',
    '''function submitReceiverJob(message, transfer, kind, trace, sourceSequence, trackedRegions = [], fixedAttempts = 0, sourceOpticsEpoch, preferredWorker) {
  if (message.strictHotPath === void 0) message.strictHotPath = strictHotPathActive();
  const auditMode = { generation: hotPathAuditGeneration, strict: Boolean(message.strictHotPath) };''',
)

# Plain QR support is display-only. A normal QR must not become an AirGapper
# tracked region and poison acquisition scheduling.
replace_once(
    "receive/main.js",
    '''      const text = plainQrDecoder.decode(bytes);
      if (box && !optimizerAttribution) noteRegion(box, decodedAt, true, info);
      const settled = plainQrPolicy.addPlain(text, (_a = info == null ? void 0 : info.scanId) != null ? _a : -1);''',
    '''      const text = plainQrDecoder.decode(bytes);
      const settled = plainQrPolicy.addPlain(text, (_a = info == null ? void 0 : info.scanId) != null ? _a : -1);''',
)

# Strict acquisition is one state: generic full-frame scans only. Sightings or
# stale non-lattice regions must never turn into local/tracked jobs before an
# actual AirGapper packet establishes GridLattice lock.
replace_once(
    "receive/main.js",
    '''  const captureHasTrackedWork = gridLattice.active ? lockedGeometryCandidates.length > 0 : regions.some((region) => region.decoded && region.quad && region.dim && validTrackedQuad(region, vw, vh));
  const fullScanDue = captureNextScan ? !captureHasTrackedWork : needsRecoveryScan && now - lastFullScan > scanInterval;
  if (!fullScanDue && regions.length === 0) {''',
    '''  const captureHasTrackedWork = gridLattice.active ? lockedGeometryCandidates.length > 0 : regions.some((region) => region.decoded && region.quad && region.dim && validTrackedQuad(region, vw, vh));
  const strictAcquiring = strictHotPathActive() && !gridLattice.locked;
  const fullScanDue = strictAcquiring
    ? Boolean(captureNextScan) || now - lastFullScan > ACQUISITION_SCAN_MS
    : captureNextScan ? !captureHasTrackedWork : needsRecoveryScan && now - lastFullScan > scanInterval;
  if (!fullScanDue && (strictAcquiring || regions.length === 0)) {''',
)

# In Strict mode generic QR decode is legal only for an explicit full
# acquisition job. Non-full tracked failures still cannot invoke readFull.
replace_once(
    "receive/worker.js",
    '''    if (!strictHotPath && shouldRunFullDecode(full, trackedAttempted, trackedHit)) {''',
    '''    if ((full || !strictHotPath) && shouldRunFullDecode(full, trackedAttempted, trackedHit)) {''',
)

replace_once("index.html", "v0.5.61", "v0.5.62")
replace_once("sw.js", 'airgapper-static-js-v24', 'airgapper-static-js-v25')
