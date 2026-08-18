from pathlib import Path

p = Path('receive/main.js')
s = p.read_text()

old_vars = '''let framePumpProcessorTotal = 0;
let framePumpProcessorDiscarded = 0;
let rvfcLastPresentedFrames = 0;
'''
new_vars = '''let framePumpProcessorTotal = 0;
let framePumpProcessorDiscarded = 0;
let framePumpStartedAt = 0;
let framePumpFirstFrameAt = 0;
let rvfcLastPresentedFrames = 0;
'''
if old_vars not in s:
    raise SystemExit('frame pump vars anchor missing')
s = s.replace(old_vars, new_vars, 1)

old_stop = '''  framePumpProcessorTotal = 0;
  framePumpProcessorDiscarded = 0;
  rvfcLastPresentedFrames = 0;
'''
new_stop = '''  framePumpProcessorTotal = 0;
  framePumpProcessorDiscarded = 0;
  framePumpStartedAt = 0;
  framePumpFirstFrameAt = 0;
  rvfcLastPresentedFrames = 0;
'''
if old_stop not in s:
    raise SystemExit('stopFramePump reset anchor missing')
s = s.replace(old_stop, new_stop, 1)

old_track = '''      framePumpProcessorTotal = Number(processor.totalFrames ?? framePumpProcessorTotal + 1);
      framePumpProcessorDiscarded = Number(processor.discardedFrames ?? framePumpProcessorDiscarded);
      processSourceFrame(sourceFrameMeta(value), gen);
'''
new_track = '''      framePumpProcessorTotal = Number(processor.totalFrames ?? framePumpProcessorTotal + 1);
      framePumpProcessorDiscarded = Number(processor.discardedFrames ?? framePumpProcessorDiscarded);
      if (!framePumpFirstFrameAt) framePumpFirstFrameAt = receiverNow();
      processSourceFrame(sourceFrameMeta(value), gen);
'''
if old_track not in s:
    raise SystemExit('TrackProcessor first frame anchor missing')
s = s.replace(old_track, new_track, 1)

old_start = '''function startFramePump(gen, track) {
  stopFramePump();
  if (track && typeof MediaStreamTrackProcessor === "function") {
'''
new_start = '''function startFramePump(gen, track) {
  stopFramePump();
  framePumpStartedAt = receiverNow();
  if (track && typeof MediaStreamTrackProcessor === "function") {
'''
if old_start not in s:
    raise SystemExit('startFramePump timing anchor missing')
s = s.replace(old_start, new_start, 1)

old_rvfc = '''  const next = (callbackTime = performance.now(), metadata = {}) => {
    if (done || gen !== captureGen || framePumpMode === "MediaStreamTrackProcessor") return;
    scheduleFrame(gen);
'''
new_rvfc = '''  const next = (callbackTime = performance.now(), metadata = {}) => {
    if (done || gen !== captureGen || framePumpMode === "MediaStreamTrackProcessor") return;
    if (!framePumpFirstFrameAt) framePumpFirstFrameAt = receiverNow();
    scheduleFrame(gen);
'''
if old_rvfc not in s:
    raise SystemExit('rVFC first frame anchor missing')
s = s.replace(old_rvfc, new_rvfc, 1)

old_diag_vars = '''  const cameraSeconds = cameraStartedTs ? Math.max(0, (now - cameraStartedTs) / 1e3) : 0;
  const runUniqueRate = decoder && runSeconds ? decoder.framesNew / runSeconds : 0;
'''
new_diag_vars = '''  const cameraSeconds = cameraStartedTs ? Math.max(0, (now - cameraStartedTs) / 1e3) : 0;
  const startupBase = framePumpStartedAt || cameraStartedTs;
  const firstCaptureAt = captureTimes[0] ?? 0;
  const firstJobAt = hotJobSubmitSamples[0]?.at ?? 0;
  const firstQrAt = qrReadTimes[0] ?? 0;
  const startupMs = (at) => startupBase && at ? Math.max(0, at - startupBase) : null;
  const startupValue = (at) => {
    const value = startupMs(at);
    return value === null ? "waiting" : `${value.toFixed(0)}ms`;
  };
  const runUniqueRate = decoder && runSeconds ? decoder.framesNew / runSeconds : 0;
'''
if old_diag_vars not in s:
    raise SystemExit('diagnostic startup variables anchor missing')
s = s.replace(old_diag_vars, new_diag_vars, 1)

old_diag = '''Run ${runSeconds ? formatDuration(runSeconds) : "waiting for first packet"}${cameraSeconds ? ` · camera ${formatDuration(cameraSeconds)}` : ""} · recent window ${(STATS_WINDOW_MS / 1e3).toFixed(1)}s
Average unique'''
new_diag = '''Run ${runSeconds ? formatDuration(runSeconds) : "waiting for first packet"}${cameraSeconds ? ` · camera ${formatDuration(cameraSeconds)}` : ""} · recent window ${(STATS_WINDOW_MS / 1e3).toFixed(1)}s
Startup  source ${startupValue(framePumpFirstFrameAt)} · capture ${startupValue(firstCaptureAt)} · job ${startupValue(firstJobAt)} · QR ${startupValue(firstQrAt)} · pump ${framePumpMode}
Average unique'''
if old_diag not in s:
    raise SystemExit('transport diagnostics startup line anchor missing')
s = s.replace(old_diag, new_diag, 1)

if 'const RECEIVER_RUNTIME_BUILD = "v0.5.246";' not in s:
    raise SystemExit('receiver v246 anchor missing')
s = s.replace('const RECEIVER_RUNTIME_BUILD = "v0.5.246";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.247";', 1)
p.write_text(s)

for path in ['main.js','index.html']:
    q=Path(path)
    text=q.read_text()
    if 'v0.5.246' not in text:
        raise SystemExit(f'{path}: v0.5.246 missing')
    q.write_text(text.replace('v0.5.246','v0.5.247'))

sw=Path('sw.js')
text=sw.read_text()
if 'airgapper-static-js-v202' not in text:
    raise SystemExit('sw cache v202 missing')
sw.write_text(text.replace('airgapper-static-js-v202','airgapper-static-js-v203',1))
