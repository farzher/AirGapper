// Joint source-block and QR-density selection. The Size control is a ceiling,
// never a fill target: data is balanced over enough blocks to stay below a
// layout-scaled optical density target.

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
  headerFraction: number;
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
  slots: number,
  mode: "mds" | "fountain",
): { blockLen: number; k: number } {
  const maximumBlock = Math.max(1, blockLength(maximumFrameBytes, mode));
  const opticalTarget = Math.max(1, Math.floor(maximumBlock / Math.sqrt(slots)));
  const countLimitedMinimum = Math.ceil(payload / MAX_SOURCE_BLOCKS);
  const target = Math.min(maximumBlock, Math.max(opticalTarget, countLimitedMinimum));
  const desiredK = Math.min(MAX_SOURCE_BLOCKS, Math.max(2, Math.ceil(payload / target)));
  const blockLen = Math.min(maximumBlock, Math.ceil(payload / desiredK));
  return { blockLen, k: Math.ceil(payload / blockLen) };
}

/**
 * Pick mode, blockLen, and K together. Direct, MDS, and fountain packets have
 * different packed overhead, so each candidate spends only the bytes its mode
 * needs. Grid payload scales by 1/sqrt(N), balancing aggregate throughput and
 * optical module density.
 */
export function selectTransportPlan(
  payloadBytes: number,
  maximumFrameBytes: number,
  gridCodes: number,
): TransportPlan {
  const payload = Math.max(1, Math.floor(payloadBytes));
  const slots = Math.max(1, Math.floor(gridCodes));
  let mode: CodingMode;
  let blockLen: number;
  let k: number;

  const directCapacity = blockLength(maximumFrameBytes, "direct");
  if (payload <= directCapacity) {
    mode = "direct";
    blockLen = payload;
    k = 1;
  } else {
    const mds = balancedPlan(payload, maximumFrameBytes, slots, "mds");
    if (mds.k <= MDS_MAX_K) {
      mode = "mds";
      ({ blockLen, k } = mds);
    } else {
      mode = "fountain";
      ({ blockLen, k } = balancedPlan(payload, maximumFrameBytes, slots, mode));
    }
  }

  // The candidate calculation and the shared wire rule must always agree.
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
    headerFraction: frameOverhead(mode) / frameBytes,
  };
}

/** Source count at the largest block available to a long fountain stream. */
export function sourceBlockCount(payloadBytes: number, frameBytes: number): number {
  return Math.ceil(payloadBytes / blockLength(frameBytes, "fountain"));
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
