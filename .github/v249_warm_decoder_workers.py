from pathlib import Path

p=Path('receive/main.js')
s=p.read_text()
old='''async function start() {
  var _a;
  const startAttempt = cameraStartGen;
  clearPendingGridLanes();
  try {
    await prepareRaptorQ();
  } catch (error) {
    offerRetry(`Transport: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
'''
new='''async function start() {
  var _a;
  const startAttempt = cameraStartGen;
  clearPendingGridLanes();

  // Codec WASM startup is independent of the camera. Start every decoder
  // worker before transport prep / permission / getUserMedia so cold WASM
  // compilation is hidden behind work we already have to wait for instead of
  // beginning only after the live preview is visible.
  pool.resize(selectedWorkerCount());
  try {
    await prepareRaptorQ();
  } catch (error) {
    if (startAttempt === cameraStartGen) pool.resize(0);
    offerRetry(`Transport: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
'''
if old not in s:
    raise SystemExit('start worker warmup anchor missing')
s=s.replace(old,new,1)

old_media='''  if (!((_a = navigator.mediaDevices) == null ? void 0 : _a.getUserMedia)) {
    offerRetry(
      location.protocol === "file:" ? localCameraMessage : "Camera access needs HTTPS. Open the hosted app or its installed offline PWA."
    );
    return;
  }
'''
new_media='''  if (!((_a = navigator.mediaDevices) == null ? void 0 : _a.getUserMedia)) {
    if (startAttempt === cameraStartGen) pool.resize(0);
    offerRetry(
      location.protocol === "file:" ? localCameraMessage : "Camera access needs HTTPS. Open the hosted app or its installed offline PWA."
    );
    return;
  }
'''
if old_media not in s:
    raise SystemExit('media support anchor missing')
s=s.replace(old_media,new_media,1)

old_catch='''  } catch (err) {
    if (startAttempt !== cameraStartGen || receiverPaused) return;
    const denied = err instanceof DOMException && err.name === "NotAllowedError";
    offerRetry(
'''
new_catch='''  } catch (err) {
    if (startAttempt !== cameraStartGen || receiverPaused) return;
    pool.resize(0);
    const denied = err instanceof DOMException && err.name === "NotAllowedError";
    offerRetry(
'''
if old_catch not in s:
    raise SystemExit('getUserMedia catch anchor missing')
s=s.replace(old_catch,new_catch,1)

old_late='''  syncPreviewAspect();
  setStatus("");
  pool.resize(selectedWorkerCount());
  cameraStartedTs = receiverNow();
'''
new_late='''  syncPreviewAspect();
  setStatus("");
  cameraStartedTs = receiverNow();
'''
if old_late not in s:
    raise SystemExit('late pool resize anchor missing')
s=s.replace(old_late,new_late,1)

if 'const RECEIVER_RUNTIME_BUILD = "v0.5.248";' not in s:
    raise SystemExit('receiver v248 missing')
s=s.replace('const RECEIVER_RUNTIME_BUILD = "v0.5.248";','const RECEIVER_RUNTIME_BUILD = "v0.5.249";',1)
p.write_text(s)

for path in ['main.js','index.html']:
    q=Path(path); text=q.read_text()
    if 'v0.5.248' not in text: raise SystemExit(f'{path}: v0.5.248 missing')
    q.write_text(text.replace('v0.5.248','v0.5.249'))

sw=Path('sw.js'); text=sw.read_text()
if 'airgapper-static-js-v204' not in text: raise SystemExit('sw cache v204 missing')
sw.write_text(text.replace('airgapper-static-js-v204','airgapper-static-js-v205',1))
