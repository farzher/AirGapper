const MDS_MAX_K = 32;
const RAPTOR_PACKET_ID_BYTES = 4;
const RAPTOR_MAX_K = 56403;
function codingMode(k) {
  return k <= 1 ? "direct" : k <= MDS_MAX_K ? "mds" : "raptorq";
}
export {
  MDS_MAX_K,
  RAPTOR_MAX_K,
  RAPTOR_PACKET_ID_BYTES,
  codingMode
};
