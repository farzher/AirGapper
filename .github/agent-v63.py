from pathlib import Path

def repl(path, old, new):
    p=Path(path); s=p.read_text(); n=s.count(old)
    if n != 1: raise SystemExit(f'{path}: expected 1 match, got {n}: {old[:100]!r}')
    p.write_text(s.replace(old,new,1))

# Never mix <video> display coordinates with a differently-sized VideoFrame pixel grid.
repl('receive/main.js', '''function cloneVideoFrame(source, forceRgba = false) {
  let frame = source.videoFrame;
  if (!frame) {
    try {
      frame = source.videoFrame = new VideoFrame(video);
    } catch {
      return null;
    }
  }
  lastVideoFrameInfo = `${frame.codedWidth || "—"}×${frame.codedHeight || "—"} coded · ${frame.displayWidth || "—"}×${frame.displayHeight || "—"} display · ${frame.format || "—"}`;
  try {
    return { frame: frame.clone(), pixelFormat: forceRgba ? "video-rgba" : DIRECT_LUMA_FORMATS.has(frame.format) ? "y8" : "video-rgba" };
  } catch {
    return null;
  }
}''', '''function cloneVideoFrame(source, forceRgba = false) {
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
}''')

# Enforce Strict pre-lock at the one submission boundary and remember submitted job semantics.
repl('receive/main.js', '''function submitReceiverJob(message, transfer, kind, trace, sourceSequence, trackedRegions = [], fixedAttempts = 0, sourceOpticsEpoch, preferredWorker) {
  if (message.strictHotPath === void 0) message.strictHotPath = strictHotPathActive();
  const auditMode = { generation: hotPathAuditGeneration, strict: Boolean(message.strictHotPath) };
  const accepted = preferredWorker === void 0 ? pool.submit(message, transfer) : pool.submitTo(preferredWorker, message, transfer);''', '''function submitReceiverJob(message, transfer, kind, trace, sourceSequence, trackedRegions = [], fixedAttempts = 0, sourceOpticsEpoch, preferredWorker) {
  if (message.strictHotPath === void 0) message.strictHotPath = strictHotPathActive();
  if (message.strictHotPath && !strictHotPathLockSeen && !message.full) {
    notePipelineEvent("strict-prelock-job-rejected");
    if (trace) trace.decision = "strict pre-lock: only full acquisition allowed";
    return false;
  }
  const auditMode = {
    generation: hotPathAuditGeneration,
    strict: Boolean(message.strictHotPath),
    full: Boolean(message.full),
    acquisition: Boolean(message.full && !gridLattice.active),
    reacquire: Boolean(message.full && gridLattice.state === "REACQUIRE"),
    kind
  };
  const accepted = preferredWorker === void 0 ? pool.submit(message, transfer) : pool.submitTo(preferredWorker, message, transfer);''')

# Audit the submitted operation, not reply flags. A full acquisition can never be called local recovery.
repl('receive/main.js', '''  if (auditThisCompletion && completion.fallbackAttempted) {
    hotPathAudit.localRecoveryAttempts++;
    if (completion.fallbackSucceeded) hotPathAudit.localRecoverySuccesses++;
  }
  if (auditThisCompletion && completion.full) {
    hotPathAudit.fullScanJobs++;
    if (completion.symbolCount > 0) hotPathAudit.fullScanSuccesses++;
    if (fullJob?.reacquire) hotPathAudit.reacquireFullScans++;
    else if (fullJob?.acquisition) hotPathAudit.acquisitionFullScans++;
  }''', '''  if (auditThisCompletion && !auditMode?.full && completion.fallbackAttempted) {
    hotPathAudit.localRecoveryAttempts++;
    if (completion.fallbackSucceeded) hotPathAudit.localRecoverySuccesses++;
  }
  if (auditThisCompletion && auditMode?.full) {
    hotPathAudit.fullScanJobs++;
    if (completion.symbolCount > 0) hotPathAudit.fullScanSuccesses++;
    if (auditMode.reacquire || fullJob?.reacquire) hotPathAudit.reacquireFullScans++;
    else if (auditMode.acquisition || fullJob?.acquisition) hotPathAudit.acquisitionFullScans++;
  }''')

# Include build in copied diagnostics so stale PWA results are obvious.
repl('receive/main.js', '''  transportDiagnostics.textContent = `Transport
Unique ${uniqueRate.toFixed(1)} QR/s''', '''  transportDiagnostics.textContent = `Build ${document.querySelector(".app-version")?.textContent ?? "—"}
Transport
Unique ${uniqueRate.toFixed(1)} QR/s''')

repl('index.html','v0.5.62','v0.5.63')
repl('sw.js','airgapper-static-js-v25','airgapper-static-js-v26')
