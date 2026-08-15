import { codingMode, MDS_MAX_K, RAPTOR_MAX_K, RAPTOR_PACKET_ID_BYTES } from "./coding-mode.js";
import { frameOverhead } from "./protocol.js";
const MAX_SOURCE_BLOCKS = RAPTOR_MAX_K;
const QR_BYTE_CAPACITY_L = [
  17,
  32,
  53,
  78,
  106,
  134,
  154,
  192,
  230,
  271,
  321,
  367,
  425,
  458,
  520,
  586,
  644,
  718,
  792,
  858,
  929,
  1003,
  1091,
  1171,
  1273,
  1367,
  1465,
  1528,
  1628,
  1732,
  1840,
  1952,
  2068,
  2188,
  2303,
  2431,
  2563,
  2699,
  2809,
  2953
];
function blockLength(frameBytes, mode) {
  return frameBytes - frameOverhead(mode);
}
function qrVersionForBytes(frameBytes) {
  const index = QR_BYTE_CAPACITY_L.findIndex((capacity) => capacity >= frameBytes);
  if (index < 0) throw new Error("Frame exceeds standard QR capacity.");
  return index + 1;
}
function balancedPlan(payload, maximumFrameBytes, mode, minimumK) {
  const packetIdBytes = mode === "raptorq" ? RAPTOR_PACKET_ID_BYTES : 0;
  const availableSourceBlock = blockLength(maximumFrameBytes, mode) - packetIdBytes;
  const maximumSourceBlock = mode === "raptorq" ? Math.floor(availableSourceBlock / 8) * 8 : availableSourceBlock;
  if (maximumSourceBlock < 1) throw new Error("Size is too small for transport metadata.");
  const k = Math.max(minimumK, Math.ceil(payload / maximumSourceBlock));
  const minimumSourceBlock = Math.ceil(payload / k);
  let sourceBlockLen = mode === "raptorq" ? Math.ceil(minimumSourceBlock / 8) * 8 : minimumSourceBlock;
  if (mode === "raptorq" && Math.ceil(payload / sourceBlockLen) < minimumK) {
    sourceBlockLen = Math.floor(minimumSourceBlock / 8) * 8;
  }
  return {
    blockLen: sourceBlockLen + packetIdBytes,
    k: Math.ceil(payload / sourceBlockLen)
  };
}
function sourcePlan(payloadBytes, maximumFrameBytes) {
  const payload = Math.max(1, Math.floor(payloadBytes));
  const directCapacity = blockLength(maximumFrameBytes, "direct");
  if (payload <= directCapacity) return { mode: "direct", blockLen: payload, k: 1 };
  const mds = balancedPlan(payload, maximumFrameBytes, "mds", 2);
  if (mds.k <= MDS_MAX_K) return { mode: "mds", ...mds };
  return { mode: "raptorq", ...balancedPlan(payload, maximumFrameBytes, "raptorq", MDS_MAX_K + 1) };
}
function selectTransportPlan(payloadBytes, maximumFrameBytes) {
  const payload = Math.max(1, Math.floor(payloadBytes));
  const { mode, blockLen, k } = sourcePlan(payload, maximumFrameBytes);
  if (k > MAX_SOURCE_BLOCKS) throw new Error("Transfer requires too many source blocks at this Size.");
  if (codingMode(k) !== mode) throw new Error("Could not select a consistent coding mode.");
  const frameBytes = blockLen + frameOverhead(mode);
  const qrVersion = qrVersionForBytes(frameBytes);
  const sourceBlockLen = blockLen - (mode === "raptorq" ? RAPTOR_PACKET_ID_BYTES : 0);
  const paddingBytes = k * sourceBlockLen - payload;
  return {
    mode,
    blockLen,
    k,
    frameBytes,
    qrVersion,
    qrModules: 17 + 4 * qrVersion,
    paddingBytes,
    paddingFraction: paddingBytes / (k * sourceBlockLen),
    overheadFraction: (frameOverhead(mode) + (mode === "raptorq" ? RAPTOR_PACKET_ID_BYTES : 0)) / frameBytes
  };
}
function sourceBlockCount(payloadBytes, frameBytes) {
  return sourcePlan(payloadBytes, frameBytes).k;
}
function fitsInOneStream(payloadBytes, frameBytes) {
  return sourceBlockCount(payloadBytes, frameBytes) <= MAX_SOURCE_BLOCKS;
}
function minimumFrameBytes(payloadBytes) {
  const sourceBytes = Math.ceil(Math.ceil(payloadBytes / MAX_SOURCE_BLOCKS) / 8) * 8;
  return sourceBytes + RAPTOR_PACKET_ID_BYTES + frameOverhead("raptorq");
}
function smallestSufficientFrameSize(payloadBytes, options) {
  const minimum = minimumFrameBytes(payloadBytes);
  return options.filter((value) => value >= minimum).sort((a, b) => a - b)[0];
}
export {
  MAX_SOURCE_BLOCKS,
  blockLength,
  fitsInOneStream,
  minimumFrameBytes,
  qrVersionForBytes,
  selectTransportPlan,
  smallestSufficientFrameSize,
  sourceBlockCount
};
