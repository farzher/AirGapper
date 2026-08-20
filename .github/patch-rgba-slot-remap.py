from pathlib import Path

path = Path("receive/worker.js")
text = path.read_text()
old = '''  const pending = [];
  let outputEnd = 0;
  for (let index = 0; index < count; index++) {
    const at = nativeResultsPtr + index * NATIVE_TRACK_RESULT_BYTES;
    const id = view.getInt32(at, true);
    const status = view.getInt32(at + 4, true);
    const bytesOffset = view.getInt32(at + 8, true);
    const bytesLength = view.getInt32(at + 12, true);
    const dx = view.getFloat32(at + 24, true);
    const dy = view.getFloat32(at + 28, true);
    const mapped = byId.get(id);
    if (!mapped) continue;
    const slot = mapped.nativeSlot;
    if (status !== NATIVE_TRACK_OK || bytesOffset < 0 || bytesLength <= 0) continue;
    const rawView = zx.HEAPU8.subarray(nativeOutputPtr + bytesOffset, nativeOutputPtr + bytesOffset + bytesLength);
    const packet = mapped.input.crc32 ? parseVerifiedFrame(rawView) : parseFrame(rawView);
    if (!packet || mapped.input.slot !== void 0 && packet.header.slotIndex !== mapped.input.slot) {
      if (slot >= 0) nativeRefresh.add(slot);
      continue;
    }
    outputEnd = Math.max(outputEnd, bytesOffset + bytesLength);
    pending.push({ mapped, bytesOffset, bytesLength, dx, dy, header: packet.header });
  }
  const output = outputEnd ? zx.HEAPU8.slice(nativeOutputPtr, nativeOutputPtr + outputEnd) : new Uint8Array(0);
  const symbols = pending.map(({ mapped, bytesOffset, bytesLength, dx, dy, header }) => {
    const quad = translatedQuad(mapped.configured.baseQuad, dx, dy);
    return {
      bytes: output.subarray(bytesOffset, bytesOffset + bytesLength),
      box: boundsOf(quad, 0, 0),
      quad,
      modules: mapped.input.dim,
      tracked: true,
      decodePath: "native",
      crc32: mapped.input.crc32,
      verifiedPayload: mapped.input.crc32,
      header
    };
  });
'''
new = '''  const pending = [];
  const byPacketSlot = new Map();
  for (const mapped of byId.values()) {
    const packetSlot = Number(mapped.input.slot);
    if (Number.isInteger(packetSlot) && packetSlot >= 0) byPacketSlot.set(packetSlot, mapped);
  }
  const decodedSlots = new Set();
  let outputEnd = 0;
  for (let index = 0; index < count; index++) {
    const at = nativeResultsPtr + index * NATIVE_TRACK_RESULT_BYTES;
    const id = view.getInt32(at, true);
    const status = view.getInt32(at + 4, true);
    const bytesOffset = view.getInt32(at + 8, true);
    const bytesLength = view.getInt32(at + 12, true);
    const dx = view.getFloat32(at + 24, true);
    const dy = view.getFloat32(at + 28, true);
    const mapped = byId.get(id);
    if (!mapped) continue;
    const slot = mapped.nativeSlot;
    if (status !== NATIVE_TRACK_OK || bytesOffset < 0 || bytesLength <= 0) continue;
    const rawView = zx.HEAPU8.subarray(nativeOutputPtr + bytesOffset, nativeOutputPtr + bytesOffset + bytesLength);
    const packet = mapped.input.crc32 ? parseVerifiedFrame(rawView) : parseFrame(rawView);
    if (!packet) {
      if (slot >= 0) nativeRefresh.add(slot);
      continue;
    }
    const packetSlot = Number(packet.header.slotIndex);
    let outputMapped = mapped;
    let geometryMeasured = true;
    if (mapped.input.slot !== void 0 && packetSlot !== Number(mapped.input.slot)) {
      // CRC-valid AirGapper bytes are stronger identity evidence than the native
      // track result id. A stale native sample map can land on a neighboring QR
      // and still decode it perfectly. Keep the bytes, but never attach the
      // stale track geometry to that packet: remap to the packet's scheduled
      // physical slot and reuse only that slot's already-trusted lattice quad.
      if (slot >= 0) nativeRefresh.add(slot);
      if (!mapped.input.crc32) continue;
      outputMapped = byPacketSlot.get(packetSlot);
      if (!outputMapped) continue;
      geometryMeasured = false;
    }
    if (Number.isInteger(packetSlot)) {
      if (decodedSlots.has(packetSlot)) continue;
      decodedSlots.add(packetSlot);
    }
    outputEnd = Math.max(outputEnd, bytesOffset + bytesLength);
    pending.push({ mapped: outputMapped, bytesOffset, bytesLength, dx, dy, header: packet.header, geometryMeasured });
  }
  const output = outputEnd ? zx.HEAPU8.slice(nativeOutputPtr, nativeOutputPtr + outputEnd) : new Uint8Array(0);
  const symbols = pending.map(({ mapped, bytesOffset, bytesLength, dx, dy, header, geometryMeasured }) => {
    const quad = geometryMeasured
      ? translatedQuad(mapped.configured.baseQuad, dx, dy)
      : mapped.configured.baseQuad;
    return {
      bytes: output.subarray(bytesOffset, bytesOffset + bytesLength),
      box: boundsOf(quad, 0, 0),
      quad,
      modules: mapped.input.dim,
      tracked: true,
      geometryMeasured,
      decodePath: geometryMeasured ? "native" : "native-remap",
      crc32: mapped.input.crc32,
      verifiedPayload: mapped.input.crc32,
      header
    };
  });
'''
count = text.count(old)
if count == 0:
    print("RGBA slot remap patch already applied or source changed; no-op")
    raise SystemExit(0)
if count != 1:
    raise SystemExit(f"expected exactly one native batch block, found {count}")
path.write_text(text.replace(old, new, 1))
print("patched receive/worker.js with CRC-gated native slot remapping")
