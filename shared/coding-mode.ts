export const MDS_MAX_K = 32;
export const RAPTOR_PACKET_ID_BYTES = 4;
export const RAPTOR_MAX_K = 56_403;

export type CodingMode = "direct" | "mds" | "raptorq";

export function codingMode(k: number): CodingMode {
  return k <= 1 ? "direct" : k <= MDS_MAX_K ? "mds" : "raptorq";
}
