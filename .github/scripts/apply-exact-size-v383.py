from pathlib import Path

p = Path('shared/frame-capacity.js')
s = p.read_text()

anchor = '''function sourcePlan(payloadBytes, maximumFrameBytes, extendedGrid = false) {
  const payload = Math.max(1, Math.floor(payloadBytes));
  const directCapacity = blockLength(maximumFrameBytes, "direct", false);
  if (payload <= directCapacity) return { mode: "direct", blockLen: payload, k: 1 };
  const mds = balancedPlan(payload, maximumFrameBytes, "mds", 2, extendedGrid);
  if (mds.k <= MDS_MAX_K) return { mode: "mds", ...mds };
  return { mode: "raptorq", ...balancedPlan(payload, maximumFrameBytes, "raptorq", MDS_MAX_K + 1, extendedGrid) };
}
'''
if anchor not in s: raise SystemExit('sourcePlan anchor mismatch')
addition = anchor + '''function exactSourcePlan(payloadBytes, frameBytes, extendedGrid = false) {
  const payload = Math.max(1, Math.floor(payloadBytes));
  const directCapacity = blockLength(frameBytes, "direct", false);
  if (payload <= directCapacity) return { mode: "direct", blockLen: payload, k: 1 };

  const mdsBlockLen = blockLength(frameBytes, "mds", extendedGrid);
  if (mdsBlockLen < 1) throw new Error("Size is too small for transport metadata.");
  const mdsK = Math.ceil(payload / mdsBlockLen);
  if (mdsK <= MDS_MAX_K) return { mode: "mds", blockLen: mdsBlockLen, k: mdsK };

  const availableRaptorSource = blockLength(frameBytes, "raptorq", extendedGrid) - RAPTOR_PACKET_ID_BYTES;
  const sourceBlockLen = Math.floor(availableRaptorSource / 8) * 8;
  if (sourceBlockLen < 1) throw new Error("Size is too small for RaptorQ transport metadata.");
  return {
    mode: "raptorq",
    blockLen: sourceBlockLen + RAPTOR_PACKET_ID_BYTES,
    k: Math.ceil(payload / sourceBlockLen)
  };
}
'''
s = s.replace(anchor, addition, 1)

old = '''function selectTransportPlan(payloadBytes, maximumFrameBytes, extendedGrid = false) {
  const payload = Math.max(1, Math.floor(payloadBytes));
  const { mode, blockLen, k } = sourcePlan(payload, maximumFrameBytes, extendedGrid);
'''
new = '''function selectTransportPlan(payloadBytes, maximumFrameBytes, extendedGrid = false, exactFrameBytes = false) {
  const payload = Math.max(1, Math.floor(payloadBytes));
  const { mode, blockLen, k } = exactFrameBytes
    ? exactSourcePlan(payload, maximumFrameBytes, extendedGrid)
    : sourcePlan(payload, maximumFrameBytes, extendedGrid);
'''
if old not in s: raise SystemExit('selectTransportPlan signature mismatch')
s = s.replace(old, new, 1)
p.write_text(s)

p = Path('send/main.js')
s = p.read_text()
s = s.replace('selectTransportPlan(payloadBytes, maximumFrameBytes, true);', 'selectTransportPlan(payloadBytes, maximumFrameBytes, true, true);')
s = s.replace('selectTransportPlan(payload.length, maximumFrameBytes, true);', 'selectTransportPlan(payload.length, maximumFrameBytes, true, true);')
s = s.replace('selectTransportPlan(payload.length, frameBytes);', 'selectTransportPlan(payload.length, frameBytes, false, true);')
if 'selectTransportPlan(payloadBytes, maximumFrameBytes, true, true);' not in s:
    raise SystemExit('Auto exact transport call missing')
if 'selectTransportPlan(payload.length, frameBytes, false, true);' not in s:
    raise SystemExit('manual exact transport call missing')
p.write_text(s)

p = Path('version.js')
s = p.read_text()
if 'APP_VERSION = "0.5.382"' not in s: raise SystemExit('unexpected current version')
p.write_text(s.replace('APP_VERSION = "0.5.382"', 'APP_VERSION = "0.5.383"', 1))
