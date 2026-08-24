const MDS_MAX_K = 32;
const RAPTOR_PACKET_ID_BYTES = 4;
const RAPTOR_MAX_K = 56403;
function codingMode(k) {
  return k <= 1 ? "direct" : k <= MDS_MAX_K ? "mds" : "raptorq";
}
function raptorPacketEsi(packet) {
  if (!(packet instanceof Uint8Array) || packet.length < RAPTOR_PACKET_ID_BYTES || packet[0] !== 0) return -1;
  return packet[1] * 65536 + packet[2] * 256 + packet[3];
}
export {
  MDS_MAX_K,
  RAPTOR_MAX_K,
  RAPTOR_PACKET_ID_BYTES,
  codingMode,
  raptorPacketEsi
};
