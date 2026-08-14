export const MDS_MAX_K = 32;

export type CodingMode = "direct" | "mds" | "fountain";

export function codingMode(k: number): CodingMode {
  return k <= 1 ? "direct" : k <= MDS_MAX_K ? "mds" : "fountain";
}
