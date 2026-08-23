from pathlib import Path


def one(s, old, new, label):
    if old not in s:
        raise SystemExit(f"missing {label}")
    return s.replace(old, new, 1)

# Root: make both large feature runtimes lazy. Direct receiver links should not
# parse sender + QR encoder at all; Home warms Send in the background.
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
''', 'eager send import')
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
''', 'lazy send view load')
s = one(s,
'''  } else {
    history.replaceState({ ...history.state, airgapperView: "home" }, "");
  }
''',
'''  } else {
    history.replaceState({ ...history.state, airgapperView: "home" }, "");
    void ensureSendModule();
  }
''', 'home sender warmup')
s = one(s,
'''function recycleReceiveCamera() {
  if (!isIOS || !receiveNeedsCamera() || document.visibilityState !== "visible" || cameraRequestPending()) return;
''',
'''function recycleReceiveCamera() {
  if (!receiveModuleLoaded || !isIOS || !receiveNeedsCamera() || document.visibilityState !== "visible" || cameraRequestPending()) return;
''', 'lazy recycle guard')
s = one(s,
'''function scheduleReceiveHealthCheck(delay = 1200, attempt = 0) {
  if (!isIOS) return;
''',
'''function scheduleReceiveHealthCheck(delay = 1200, attempt = 0) {
  if (!isIOS || !receiveModuleLoaded) return;
''', 'lazy health guard')
s = one(s,
'''  if (receiveNeedsCamera()) scheduleReceiveHealthCheck(wasSuspended ? 1500 : 1200);
''',
'''  if (receiveNeedsCamera() && receiveModuleLoaded) scheduleReceiveHealthCheck(wasSuspended ? 1500 : 1200);
''', 'lazy health scheduling')
p.write_text(s)

# Sender: cache payload identity and transport encoder across visual/layout-only rebuilds.
p = Path('send/main.js')
s = p.read_text()
s = one(s, 'let activeTransportEncoder = null;\n', 'let activeTransportEncoder = null;\nlet activeTransportEncoderKey = null;\n', 'encoder key state')
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
''', 'payload id cache')
s = one(s,
'''  stopSendRenderer();
  activeTransportEncoder == null ? void 0 : activeTransportEncoder.free();
  activeTransportEncoder = null;
  resizeDisplay = null;
''',
'''  stopSendRenderer();
  resizeDisplay = null;
''', 'start encoder teardown')
s = one(s,
'''  const { name, size: fileSize, payload, compression, transmittedSize } = selectedFile;
''',
'''  const { name, size: fileSize, payload, payloadId, compression, transmittedSize } = selectedFile;
''', 'payload id destructure')
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
  // Layout, scaling, orientation and fullscreen changes do not change the
  // erasure code. Keep the expensive encoder (and its payload/WASM state) warm
  // whenever the transport itself is unchanged.
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
''', 'encoder reuse')
# Cache canvas contexts once per stream instead of repeatedly asking DOM canvases in frame loops.
s = one(s,
'''  const staging = document.createElement("canvas");
  const fitStaging = fitScaling ? document.createElement("canvas") : null;
  const fitFiltered = fitScaling ? document.createElement("canvas") : null;
  const queue = [];
''',
'''  const staging = document.createElement("canvas");
  const fitStaging = fitScaling ? document.createElement("canvas") : null;
  const fitFiltered = fitScaling ? document.createElement("canvas") : null;
  const canvasCtx = canvas.getContext("2d");
  const stagingCtx = staging.getContext("2d");
  const fitStagingCtx = fitStaging?.getContext("2d") ?? null;
  const fitFilteredCtx = fitFiltered?.getContext("2d") ?? null;
  const queue = [];
''', 'canvas context cache')
s = s.replace('      const filterCtx = fitFiltered.getContext("2d");', '      const filterCtx = fitFilteredCtx;', 1)
s = s.replace('    const ctx = canvas.getContext("2d");', '    const ctx = canvasCtx;', 1)
s = s.replace('      const stagingCtx = staging.getContext("2d");\n      cells.forEach', '      cells.forEach', 1)
s = s.replace('        const fitCtx = fitStaging.getContext("2d");', '        const fitCtx = fitStagingCtx;', 1)
s = s.replace('      const ctx = canvas.getContext("2d");', '      const ctx = canvasCtx;', 1)
s = s.replace('        const stagingCtx = staging.getContext("2d");', '        const stagingCtx = stagingCtx;', 1)
# Undo the shadowing replacement above by directly naming cached context in that block.
s = s.replace('        const stagingCtx = stagingCtx;\n        stagingCtx.setTransform', '        stagingCtx.setTransform', 1)
s = s.replace('        const fitCtx = fitStaging.getContext("2d");', '        const fitCtx = fitStagingCtx;', 1)
s = s.replace('        const ctx = canvas.getContext("2d");', '        const ctx = canvasCtx;', 1)
s = s.replace('      const stagingCtx = staging.getContext("2d");', '      const stagingCtxLocal = stagingCtx;', 1)
s = s.replace('      stagingCtx.setTransform', '      stagingCtxLocal.setTransform', 1)
s = s.replace('      stagingCtx.globalCompositeOperation', '      stagingCtxLocal.globalCompositeOperation', 2)
s = s.replace('      stagingCtx.imageSmoothingEnabled', '      stagingCtxLocal.imageSmoothingEnabled', 1)
s = s.replace('      stagingCtx.drawImage', '      stagingCtxLocal.drawImage', 1)
s = s.replace('        const fitCtx = fitStaging.getContext("2d");', '        const fitCtx = fitStagingCtx;', 1)
s = s.replace('      const ctx = canvas.getContext("2d");', '      const ctx = canvasCtx;', 1)
s = s.replace('    staging.getContext("2d").putImageData(img, cx, cy);', '    stagingCtx.putImageData(img, cx, cy);', 1)
s = s.replace('      const fitCtx = fitStaging.getContext("2d");', '      const fitCtx = fitStagingCtx;', 1)
s = s.replace('    const ctx = canvas.getContext("2d");', '    const ctx = canvasCtx;', 1)
p.write_text(s)

# Receiver worker: remove per-frame collection churn around the native/guided WASM calls.
p = Path('receive/worker.js')
s = p.read_text()
s = one(s,
'''  const moduleSizes = tracks.map((track) => quadModuleSize(track.quad, track.dim)).filter((value) => value > 0 && Number.isFinite(value));
  if (moduleSizes.length) {
    metrics.moduleSizeMin = Math.min(...moduleSizes);
    metrics.moduleSizeMax = Math.max(...moduleSizes);
    metrics.moduleSizeAvg = moduleSizes.reduce((sum, value) => sum + value, 0) / moduleSizes.length;
  } else {
    metrics.moduleSizeMin = metrics.moduleSizeMax = metrics.moduleSizeAvg = 0;
  }
''',
'''  let moduleSizeMin = Infinity, moduleSizeMax = 0, moduleSizeSum = 0, moduleSizeCount = 0;
  for (const track of tracks) {
    const value = quadModuleSize(track.quad, track.dim);
    if (!(value > 0) || !Number.isFinite(value)) continue;
    moduleSizeMin = Math.min(moduleSizeMin, value);
    moduleSizeMax = Math.max(moduleSizeMax, value);
    moduleSizeSum += value;
    moduleSizeCount++;
  }
  metrics.moduleSizeMin = moduleSizeCount ? moduleSizeMin : 0;
  metrics.moduleSizeMax = moduleSizeCount ? moduleSizeMax : 0;
  metrics.moduleSizeAvg = moduleSizeCount ? moduleSizeSum / moduleSizeCount : 0;
''', 'guided module size arrays')
s = one(s,
'''  const symbols = [];
  const expectedSlots = new Set(
    tracks.map((track) => Number(track.slot ?? track.id))
      .filter((slot) => Number.isInteger(slot) && slot >= 0)
  );
  const decodedSlots = new Set();
  const trackBySlot = new Map(tracks.map((track) => [Number(track.slot ?? track.id), track]));
  const trackIndexBySlot = new Map(tracks.map((track, index) => [Number(track.slot ?? track.id), index]));
''',
'''  const symbols = [];
  const trackIndexBySlot = new Map();
  for (let index = 0; index < tracks.length; index++) {
    const slot = Number(tracks[index].slot ?? tracks[index].id);
    if (Number.isInteger(slot) && slot >= 0) trackIndexBySlot.set(slot, index);
  }
  const decodedSlots = new Set();
''', 'guided slot collections')
s = s.replace('    if (expectedSlots.size && !expectedSlots.has(slot) || decodedSlots.has(slot)) continue;', '    if (trackIndexBySlot.size && !trackIndexBySlot.has(slot) || decodedSlots.has(slot)) continue;', 1)
s = one(s,
'''    const input = trackBySlot.get(slot);
    if (input?.quad && validQuad(input.quad)) {
      const names = ["topLeft", "topRight", "bottomRight", "bottomLeft"];
      const dx = names.reduce((sum, name) => sum + outputQuad[name].x - input.quad[name].x, 0) / names.length;
      const dy = names.reduce((sum, name) => sum + outputQuad[name].y - input.quad[name].y, 0) / names.length;
      if (Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) <= 5.1) {
        const points = [input.quad.topLeft, input.quad.topRight, input.quad.bottomRight, input.quad.bottomLeft];
        const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
        const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
        const edge = points.reduce((sum, point, index) => {
          const next = points[(index + 1) % points.length];
          return sum + Math.hypot(next.x - point.x, next.y - point.y);
        }, 0) / points.length;
        wallMotionSamples.push({ dx, dy, x, y, edge, slot, measured: geometryMeasured });
      }
    }
''',
'''    const input = Number.isInteger(trackIndex) ? tracks[trackIndex] : void 0;
    if (input?.quad && validQuad(input.quad)) {
      const iq = input.quad, oq = outputQuad;
      const dx = ((oq.topLeft.x - iq.topLeft.x) + (oq.topRight.x - iq.topRight.x) +
        (oq.bottomRight.x - iq.bottomRight.x) + (oq.bottomLeft.x - iq.bottomLeft.x)) * 0.25;
      const dy = ((oq.topLeft.y - iq.topLeft.y) + (oq.topRight.y - iq.topRight.y) +
        (oq.bottomRight.y - iq.bottomRight.y) + (oq.bottomLeft.y - iq.bottomLeft.y)) * 0.25;
      if (Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) <= 5.1) {
        const x = (iq.topLeft.x + iq.topRight.x + iq.bottomRight.x + iq.bottomLeft.x) * 0.25;
        const y = (iq.topLeft.y + iq.topRight.y + iq.bottomRight.y + iq.bottomLeft.y) * 0.25;
        const edge = (Math.hypot(iq.topRight.x - iq.topLeft.x, iq.topRight.y - iq.topLeft.y) +
          Math.hypot(iq.bottomRight.x - iq.topRight.x, iq.bottomRight.y - iq.topRight.y) +
          Math.hypot(iq.bottomLeft.x - iq.bottomRight.x, iq.bottomLeft.y - iq.bottomRight.y) +
          Math.hypot(iq.topLeft.x - iq.bottomLeft.x, iq.topLeft.y - iq.bottomLeft.y)) * 0.25;
        wallMotionSamples.push({ dx, dy, x, y, edge, slot, measured: geometryMeasured });
      }
    }
''', 'guided motion arrays')
s = one(s,
'''  for (const pending of pendingSymbols) symbols.push({
    ...pending,
    bytes: output.subarray(pending.outputOffset, pending.outputOffset + pending.outputLength)
  });
  for (const symbol of symbols) {
    delete symbol.outputOffset;
    delete symbol.outputLength;
  }
''',
'''  for (const pending of pendingSymbols) symbols.push({
    bytes: output.subarray(pending.outputOffset, pending.outputOffset + pending.outputLength),
    box: pending.box,
    quad: pending.quad,
    modules: pending.modules,
    tracked: pending.tracked,
    geometryMeasured: pending.geometryMeasured,
    decodePath: pending.decodePath,
    crc32: pending.crc32,
    verifiedPayload: pending.verifiedPayload,
    header: pending.header
  });
''', 'guided symbol deletes')
s = s.replace('let nativeCropOrigin = "";\n', 'let nativeCropX = NaN;\nlet nativeCropY = NaN;\n', 1)
s = one(s,
'''  const origin = `${ox},${oy}`;
  const originChanged = origin !== nativeCropOrigin;
''',
'''  const originChanged = ox !== nativeCropX || oy !== nativeCropY;
''', 'native origin string')
s = s.replace('  nativeCropOrigin = origin;\n', '  nativeCropX = ox;\n  nativeCropY = oy;\n', 1)
s = one(s,
'''  const pending = [];
  const byPacketSlot = new Map();
  for (const mapped of byId.values()) {
    const packetSlot = Number(mapped.input.slot);
    if (Number.isInteger(packetSlot) && packetSlot >= 0) byPacketSlot.set(packetSlot, mapped);
  }
  const decodedSlots = new Set();
''',
'''  const pending = [];
  const decodedSlots = new Set();
  const mappingForPacketSlot = (packetSlot) => {
    for (const mapped of byId.values()) {
      if (Number(mapped.input.slot) === packetSlot) return mapped;
    }
    return void 0;
  };
''', 'native packet map')
s = s.replace('      outputMapped = byPacketSlot.get(packetSlot);', '      outputMapped = mappingForPacketSlot(packetSlot);', 1)
s = one(s,
'''function translatedQuad(q, dx, dy) {
  if (!validQuad(q)) return null;
  const move = (p) => ({ x: p.x + dx, y: p.y + dy });
  return {
    topLeft: move(q.topLeft),
    topRight: move(q.topRight),
    bottomRight: move(q.bottomRight),
    bottomLeft: move(q.bottomLeft)
  };
}
''',
'''function translatedQuad(q, dx, dy) {
  if (!validQuad(q)) return null;
  return {
    topLeft: { x: q.topLeft.x + dx, y: q.topLeft.y + dy },
    topRight: { x: q.topRight.x + dx, y: q.topRight.y + dy },
    bottomRight: { x: q.bottomRight.x + dx, y: q.bottomRight.y + dy },
    bottomLeft: { x: q.bottomLeft.x + dx, y: q.bottomLeft.y + dy }
  };
}
''', 'translated quad closure')
s = one(s,
'''    const coldTrackCount = !strictHotPath && !full && Array.isArray(tracks)
      ? tracks.filter((track) => (track.misses ?? 0) >= 4).length
      : 0;
''',
'''    let coldTrackCount = 0;
    if (!strictHotPath && !full && Array.isArray(tracks)) {
      for (const track of tracks) coldTrackCount += Number((track.misses ?? 0) >= 4);
    }
''', 'cold track filter')
# Keep repeat signature compact as a typed array; structured clone handles it directly.
s = s.replace('  return { key: keys.join(\'|\'), bits: Array.from(bits), bitCount: bitIndex };', '  return { key: keys.join(\'|\'), bits, bitCount: bitIndex };', 1)
s = one(s,
'''  if (!current || !previous || current.key !== previous.key || current.bitCount !== previous.bitCount ||
      !Array.isArray(current.bits) || !Array.isArray(previous.bits) || current.bits.length !== previous.bits.length) return null;
''',
'''  if (!current || !previous || current.key !== previous.key || current.bitCount !== previous.bitCount ||
      !current.bits || !previous.bits || current.bits.length !== previous.bits.length) return null;
''', 'typed repeat signature')
p.write_text(s)

p = Path('version.js')
s = p.read_text()
s = one(s, 'APP_VERSION = "0.5.385"', 'APP_VERSION = "0.5.386"', 'version')
p.write_text(s)
