from pathlib import Path

p = Path('receive/main.js')
s = p.read_text()

old_start = '''  preview.classList.remove("camera-loading");
  const activeTrack = stream.getVideoTracks()[0];
  if (activeTrack) {
    await refreshCameraDevices(activeTrack);
    populateBrowserCapabilities(activeTrack);
    showNegotiatedWebMode(activeTrack);
    if (!legacyAndroidApp) attachCameraController(activeTrack);
  }
  syncPreviewAspect();
  setStatus("");
  pool.resize(selectedWorkerCount());
  cameraStartedTs = receiverNow();
  resetLivePipeline(cameraStartedTs);
  captureGen++;
  startFramePump(captureGen, activeTrack);
  if (activeTrack && !automaticOptics) void reapplyManualOpticsAfterFreshFrames(activeTrack, "camera started");
  statsTimer = setInterval(updateStats, STATS_TICK_MS);
  await requestScreenWakeLock();
'''
new_start = '''  preview.classList.remove("camera-loading");
  const activeTrack = stream.getVideoTracks()[0];

  // Decoder startup is the critical path. A live <video> must never sit visible
  // while enumerateDevices/capability UI work delays the first camera frame.
  syncPreviewAspect();
  setStatus("");
  pool.resize(selectedWorkerCount());
  cameraStartedTs = receiverNow();
  resetLivePipeline(cameraStartedTs);
  captureGen++;
  startFramePump(captureGen, activeTrack);
  statsTimer = setInterval(updateStats, STATS_TICK_MS);

  if (activeTrack) {
    populateBrowserCapabilities(activeTrack);
    showNegotiatedWebMode(activeTrack);
    if (!legacyAndroidApp) attachCameraController(activeTrack);
    void refreshCameraDevices(activeTrack);
  }
  if (activeTrack && !automaticOptics) void reapplyManualOpticsAfterFreshFrames(activeTrack, "camera started");
  await requestScreenWakeLock();
'''
if old_start not in s:
    raise SystemExit('camera startup ordering anchor missing')
s = s.replace(old_start, new_start, 1)

old_pump = '''function startFramePump(gen, track) {
  stopFramePump();
  if (track && typeof MediaStreamTrackProcessor === "function") {
    try {
      const processor = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 });
      const reader = processor.readable.getReader();
      frameTrackProcessor = processor;
      frameTrackReader = reader;
      framePumpMode = "MediaStreamTrackProcessor";
      void pumpTrackFrames(gen, reader, processor);
      return;
    } catch (error) {
      console.warn("MediaStreamTrackProcessor unavailable; using requestVideoFrameCallback", error);
    }
  }
  framePumpMode = "rVFC fallback";
  scheduleFrame(gen);
}
'''
new_pump = '''function startFramePump(gen, track) {
  stopFramePump();
  if (track && typeof MediaStreamTrackProcessor === "function") {
    try {
      const processor = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 });
      const reader = processor.readable.getReader();
      frameTrackProcessor = processor;
      frameTrackReader = reader;
      framePumpMode = "MediaStreamTrackProcessor";

      // Some Android camera stacks can leave TrackProcessor.read() pending even
      // though the <video> preview is already advancing. Do not allow a silent
      // processor stall to leave Receive at 0 fps indefinitely; rVFC can start
      // decoding from the same live stream immediately.
      const startupWatchdog = setTimeout(() => {
        if (done || gen !== captureGen || frameTrackReader !== reader || framePumpProcessorTotal > 0) return;
        console.warn("MediaStreamTrackProcessor produced no startup frame; using requestVideoFrameCallback");
        frameTrackReader = null;
        frameTrackProcessor = null;
        framePumpMode = "rVFC startup fallback";
        notePipelineEvent("frame-pump-startup-fallback");
        void reader.cancel().catch(() => void 0).finally(() => {
          try { reader.releaseLock(); } catch {}
        });
        scheduleFrame(gen);
      }, 800);
      void pumpTrackFrames(gen, reader, processor).finally(() => clearTimeout(startupWatchdog));
      return;
    } catch (error) {
      console.warn("MediaStreamTrackProcessor unavailable; using requestVideoFrameCallback", error);
    }
  }
  framePumpMode = "rVFC fallback";
  scheduleFrame(gen);
}
'''
if old_pump not in s:
    raise SystemExit('startFramePump anchor missing')
s = s.replace(old_pump, new_pump, 1)

s = s.replace('const RECEIVER_RUNTIME_BUILD = "v0.5.242";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.243";', 1)
p.write_text(s)

for path in ['main.js', 'index.html']:
    q = Path(path)
    text = q.read_text()
    if 'v0.5.242' not in text:
        raise SystemExit(f'{path}: v0.5.242 missing')
    q.write_text(text.replace('v0.5.242', 'v0.5.243'))

sw = Path('sw.js')
text = sw.read_text()
if 'airgapper-static-js-v198' not in text:
    raise SystemExit('sw cache v198 missing')
sw.write_text(text.replace('airgapper-static-js-v198', 'airgapper-static-js-v199', 1))
