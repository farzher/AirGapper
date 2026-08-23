from pathlib import Path


def one(s, old, new, label):
    if old not in s:
        raise SystemExit(f"missing {label}")
    return s.replace(old, new, 1)

p = Path('main.js')
s = p.read_text()
s = one(s,
'''void prepareServiceWorker();
await import(`./send/main.js?build=${APP_BUILD}`);
let receiveModulePromise;
''',
'''void prepareServiceWorker();
let sendModulePromise;
function ensureSendModule() {
  if (!sendModulePromise) sendModulePromise = import(`./send/main.js?build=${APP_BUILD}`);
  return sendModulePromise;
}
let receiveModulePromise;
''', 'lazy send module')
s = one(s,
'''  void ensureReceiveModule().then(() => {
    receiveLoadDispatchQueued = false;
    if (active === "receive") window.dispatchEvent(new CustomEvent("airgapper:enter-receive"));
  }).catch(() => {
''',
'''  void ensureReceiveModule().then(() => {
    receiveLoadDispatchQueued = false;
    if (active === "receive" && !suspended && document.visibilityState === "visible") {
      window.dispatchEvent(new CustomEvent("airgapper:enter-receive"));
      if (isIOS) scheduleReceiveHealthCheck(1500);
    }
  }).catch(() => {
''', 'receive load visibility')
s = one(s,
'''  if (name === "receive") dispatchReceiveWhenReady();
  const hasMobileInput = isIOS || isAndroid || matchMedia("(pointer: coarse)").matches;
''',
'''  if (name === "receive") dispatchReceiveWhenReady();
  else if (name === "send" || name === "home") void ensureSendModule();
  const hasMobileInput = isIOS || isAndroid || matchMedia("(pointer: coarse)").matches;
''', 'send view lazy load')
s = one(s,
'''} else {
  history.replaceState({ ...history.state, airgapperView: "home" }, "");
}
''',
'''} else {
  history.replaceState({ ...history.state, airgapperView: "home" }, "");
  void ensureSendModule();
}
''', 'home send warmup')
s = one(s,
'''function recycleReceiveCamera() {
  if (!isIOS || !receiveNeedsCamera() || document.visibilityState !== "visible" || cameraRequestPending()) return;
''',
'''function recycleReceiveCamera() {
  if (!receiveModuleLoaded || !isIOS || !receiveNeedsCamera() || document.visibilityState !== "visible" || cameraRequestPending()) return;
''', 'receive recycle guard')
s = one(s,
'''function scheduleReceiveHealthCheck(delay = 1200, attempt = 0) {
  if (!isIOS) return;
''',
'''function scheduleReceiveHealthCheck(delay = 1200, attempt = 0) {
  if (!isIOS || !receiveModuleLoaded) return;
''', 'receive health guard')
s = one(s,
'''  if (receiveNeedsCamera()) scheduleReceiveHealthCheck(wasSuspended ? 1500 : 1200);
''',
'''  if (receiveNeedsCamera() && receiveModuleLoaded) scheduleReceiveHealthCheck(wasSuspended ? 1500 : 1200);
''', 'receive health schedule')
p.write_text(s)

p = Path('send/main.js')
s = p.read_text()
s = one(s, 'let activeTransportEncoder = null;\n', 'let activeTransportEncoder = null;\nlet activeTransportEncoderKey = null;\n', 'encoder key')
s = one(s,
'''  activeTransportEncoder == null ? void 0 : activeTransportEncoder.free();
  activeTransportEncoder = null;
  activeTransportCursor = null;
''',
'''  activeTransportEncoder?.free();
  activeTransportEncoder = null;
  activeTransportEncoderKey = null;
  activeTransportCursor = null;
''', 'discard encoder')
s = one(s,
'''    selectedFile = {
      name,
      size,
      payload: packed.container,
      compression: packed.compression,
''',
'''    selectedFile = {
      name,
      size,
      payload: packed.container,
      payloadId: fnv1a(packed.container),
      compression: packed.compression,
''', 'cached payload id')
s = one(s,
'''  stopSendRenderer();
  activeTransportEncoder == null ? void 0 : activeTransportEncoder.free();
  activeTransportEncoder = null;
  resizeDisplay = null;
''',
'''  stopSendRenderer();
  resizeDisplay = null;
''', 'preserve encoder on rebuild')
s = one(s,
'''  const { name, size: fileSize, payload, compression, transmittedSize } = selectedFile;
''',
'''  const { name, size: fileSize, payload, payloadId, compression, transmittedSize } = selectedFile;
''', 'payload id use')
s = one(s,
'''  const blockLen = transport.blockLen;
  const payloadId = fnv1a(payload);
  if (transport.mode === "raptorq") {
    await prepareRaptorQ();
    if (gen !== generation) return;
  }
  const encoder = new TransportEncoder(payload, blockLen, transport.mode);
  activeTransportEncoder = encoder;
  // FPS, layout, orientation and visual scaling do not change the erasure
  // code. Continue at the next symbol that was actually painted. A transport
  // Size change changes blockLen/K/mode, so its key differs and correctly
  // starts a fresh coding stream at ESI 0.
  const transportKey = `${payloadId}:${encoder.mode}:${encoder.k}:${blockLen}:${payload.length}`;
''',
'''  const blockLen = transport.blockLen;
  if (transport.mode === "raptorq") {
    await prepareRaptorQ();
    if (gen !== generation) return;
  }
  // Visual/layout changes do not alter the erasure code. Keep the expensive
  // encoder and its payload/WASM state warm whenever transport parameters match.
  const transportKey = `${payloadId}:${transport.mode}:${transport.k}:${blockLen}:${payload.length}`;
  let encoder = activeTransportEncoder;
  if (!encoder || activeTransportEncoderKey !== transportKey) {
    encoder?.free();
    encoder = new TransportEncoder(payload, blockLen, transport.mode);
    activeTransportEncoder = encoder;
    activeTransportEncoderKey = transportKey;
  }
  // Continue at the next symbol that was actually painted. A transport Size
  // change changes the key and correctly starts a fresh coding stream at ESI 0.
''', 'reuse transport encoder')
p.write_text(s)

p = Path('version.js')
s = one(p.read_text(), 'APP_VERSION = "0.5.385"', 'APP_VERSION = "0.5.386"', 'version')
p.write_text(s)
