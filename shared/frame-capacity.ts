// Joint source-block and QR-density selection. The Size control is a ceiling,
// never a fill target: use the fewest source blocks that fit, then balance the
// payload evenly across them.

import { codingMode, MDS_MAX_K, type CodingMode } from "./coding-mode";
import { frameOverhead } from "./protocol";

export const MAX_SOURCE_BLOCKS = 0xffff;

/** QR byte-mode capacities at ECC L, versions 1..40. */
const QR_BYTE_CAPACITY_L: readonly number[] = [
  17, 32, 53, 78, 106, 134, 154, 192, 230, 271,
  321, 367, 425, 458, 520, 586, 644, 718, 792, 858,
  929, 1003, 1091, 1171, 1273, 1367, 1465, 1528, 1628, 1732,
  1840, 1952, 2068, 2188, 2303, 2431, 2563, 2699, 2809, 2953,
];

export interface TransportPlan {
  mode: CodingMode;
  blockLen: number;
  k: number;
  frameBytes: number;
  qrVersion: number;
  qrModules: number;
  paddingBytes: number;
  paddingFraction: number;
  overheadFraction: number;
}

export function blockLength(frameBytes: number, mode: CodingMode): number {
  return frameBytes - frameOverhead(mode);
}

export function qrVersionForBytes(frameBytes: number): number {
  const index = QR_BYTE_CAPACITY_L.findIndex((capacity) => capacity >= frameBytes);
  if (index < 0) throw new Error("Frame exceeds standard QR capacity.");
  return index + 1;
}

function balancedPlan(
  payload: number,
  maximumFrameBytes: number,
  mode: "mds" | "fountain",
  minimumK: number,
): { blockLen: number; k: number } {
  const maximumBlock = blockLength(maximumFrameBytes, mode);
  if (maximumBlock < 1) throw new Error("Size is too small for transport metadata.");
  const k = Math.max(minimumK, Math.ceil(payload / maximumBlock));
  const blockLen = Math.ceil(payload / k);
  return { blockLen, k: Math.ceil(payload / blockLen) };
}

function sourcePlan(payloadBytes: number, maximumFrameBytes: number): {
  mode: CodingMode;
  blockLen: number;
  k: number;
} {
  const payload = Math.max(1, Math.floor(payloadBytes));
  const directCapacity = blockLength(maximumFrameBytes, "direct");
  if (payload <= directCapacity) return { mode: "direct", blockLen: payload, k: 1 };

  const mds = balancedPlan(payload, maximumFrameBytes, "mds", 2);
  if (mds.k <= MDS_MAX_K) return { mode: "mds", ...mds };
  return { mode: "fountain", ...balancedPlan(payload, maximumFrameBytes, "fountain", MDS_MAX_K + 1) };
}

/**
 * Pick mode, blockLen, and K together. Each mode gets its exact packed
 * overhead. The smallest feasible K is selected at the Size ceiling, then the
 * payload is spread evenly over those blocks so the final block adds minimal
 * padding. Physical grid slots are scheduling opportunities, not a density
 * input.
 */
export function selectTransportPlan(
  payloadBytes: number,
  maximumFrameBytes: number,
): TransportPlan {
  const payload = Math.max(1, Math.floor(payloadBytes));
  const { mode, blockLen, k } = sourcePlan(payload, maximumFrameBytes);

  // The candidate calculation and the shared wire rule must always agree.
  if (k > MAX_SOURCE_BLOCKS) throw new Error("Transfer requires too many source blocks at this Size.");
  if (codingMode(k) !== mode) throw new Error("Could not select a consistent coding mode.");
  const frameBytes = blockLen + frameOverhead(mode);
  const qrVersion = qrVersionForBytes(frameBytes);
  const paddingBytes = k * blockLen - payload;
  return {
    mode,
    blockLen,
    k,
    frameBytes,
    qrVersion,
    qrModules: 17 + 4 * qrVersion,
    paddingBytes,
    paddingFraction: paddingBytes / (k * blockLen),
    overheadFraction: frameOverhead(mode) / frameBytes,
  };
}

/** Exact source count after mode-specific overhead and coding boundaries. */
export function sourceBlockCount(payloadBytes: number, frameBytes: number): number {
  return sourcePlan(payloadBytes, frameBytes).k;
}

export function fitsInOneStream(payloadBytes: number, frameBytes: number): boolean {
  return sourceBlockCount(payloadBytes, frameBytes) <= MAX_SOURCE_BLOCKS;
}

export function minimumFrameBytes(payloadBytes: number): number {
  return Math.ceil(payloadBytes / MAX_SOURCE_BLOCKS) + frameOverhead("fountain");
}

export function smallestSufficientFrameSize(
  payloadBytes: number,
  options: readonly number[],
): number | undefined {
  const minimum = minimumFrameBytes(payloadBytes);
  return options
    .filter((value) => value >= minimum)
    .sort((a, b) => a - b)[0];
}
