from pathlib import Path


def one(s, old, new, label):
    if old not in s:
        raise SystemExit(f"missing {label}")
    return s.replace(old, new, 1)

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
''', 'module size temporary array')
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
s = one(s,
'    if (expectedSlots.size && !expectedSlots.has(slot) || decodedSlots.has(slot)) continue;\n',
'    if (trackIndexBySlot.size && !trackIndexBySlot.has(slot) || decodedSlots.has(slot)) continue;\n', 'guided expected slot lookup')
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
''', 'guided motion temporary arrays')
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
''', 'guided hidden-class deletes')
s = one(s, 'let nativeCropOrigin = "";\n', 'let nativeCropX = NaN;\nlet nativeCropY = NaN;\n', 'native crop string state')
s = one(s,
'''  const origin = `${ox},${oy}`;
  const originChanged = origin !== nativeCropOrigin;
''',
'''  const originChanged = ox !== nativeCropX || oy !== nativeCropY;
''', 'native crop string allocation')
s = one(s, '  nativeCropOrigin = origin;\n', '  nativeCropX = ox;\n  nativeCropY = oy;\n', 'native crop state update')
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
''', 'native packet slot map')
s = one(s,
'''      outputMapped = byPacketSlot.get(packetSlot);
      if (!outputMapped) continue;
''',
'''      outputMapped = void 0;
      for (const candidate of byId.values()) {
        if (Number(candidate.input.slot) === packetSlot) {
          outputMapped = candidate;
          break;
        }
      }
      if (!outputMapped) continue;
''', 'rare native remap scan')
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
''', 'cold track filter array')
p.write_text(s)

p = Path('version.js')
s = one(p.read_text(), 'APP_VERSION = "0.5.386"', 'APP_VERSION = "0.5.387"', 'version')
p.write_text(s)
