// Joint source-block and QR-density selection. The Size control is a ceiling,
// never a fill target: data is balanced over enough blocks to stay below a
// layout-scaled optical density target.

import { FRAME_CRC_LEN, HEADER_LEN } from "./protocol";

export const MAX_SOURCE_BLOCKS = 0xffff;

/** QR byte-mode capacities at ECC L, versions 1..40. */
const QR_BYTE_CAPACITY_L: readonly number[] = [
  17, 32, 53, 78, 106, 134, 154, 192, 230, 271,
  321, 367, 425, 458, 520, 586, 644, 718, 792, 858,
  929, 1003, 1091, 1171, 1273, 1367, 1465, 1528, 1628, 1732,
  1840, 1952, 2068, 2188, 2303, 2431, 2563, 2699, 2809, 2953,
];

export interface TransportPlan {
  blockLen: number;
  k: number;
  frameBytes: number;
  qrVersion: number;
  qrModules: number;
  paddingBytes: number;
  paddingFraction: number;
  headerFraction: number;
}

export function blockLength(frameBytes: number): number {
  return frameBytes - HEADER_LEN - FRAME_CRC_LEN;
}

export function qrVersionForBytes(frameBytes: number): number {
  const index = QR_BYTE_CAPACITY_L.findIndex((capacity) => capacity >= frameBytes);
  if (index < 0) throw new Error("Frame exceeds standard QR capacity.");
  return index + 1;
}

/**
 * Pick blockLen and K together.
 *
 * A grid divides the available screen area among its symbols. Filling every
 * cell to the single-code ceiling would increase module density by sqrt(N).
 * Scaling payload by 1/sqrt(N) takes the geometric midpoint: aggregate useful
 * bytes per display state grow by sqrt(N), while optical density worsens by
 * only the fourth root of N. The selected Size remains a hard upper bound.
 *
 * Once the optical target is known, balancing over ceil(payload/target)
 * blocks removes the capacity-boundary padding cliff. Padding is then below K
 * bytes instead of as much as one maximum-sized QR.
 */
export function selectTransportPlan(
  payloadBytes: number,
  maximumFrameBytes: number,
  gridCodes: number,
): TransportPlan {
  const payload = Math.max(1, Math.floor(payloadBytes));
  const maximumBlock = Math.max(1, blockLength(maximumFrameBytes));
  const slots = Math.max(1, Math.floor(gridCodes));

  let blockLen: number;
  if (payload <= maximumBlock) {
    blockLen = payload;
  } else {
    const opticalTarget = Math.max(1, Math.floor(maximumBlock / Math.sqrt(slots)));
    const countLimitedMinimum = Math.ceil(payload / MAX_SOURCE_BLOCKS);
    const target = Math.min(maximumBlock, Math.max(opticalTarget, countLimitedMinimum));
    const desiredK = Math.min(MAX_SOURCE_BLOCKS, Math.max(2, Math.ceil(payload / target)));
    blockLen = Math.min(maximumBlock, Math.ceil(payload / desiredK));
  }

  const k = Math.ceil(payload / blockLen);
  const frameBytes = blockLen + HEADER_LEN + FRAME_CRC_LEN;
  const qrVersion = qrVersionForBytes(frameBytes);
  const paddingBytes = k * blockLen - payload;
  return {
    blockLen,
    k,
    frameBytes,
    qrVersion,
    qrModules: 17 + 4 * qrVersion,
    paddingBytes,
    paddingFraction: paddingBytes / (k * blockLen),
    headerFraction: (HEADER_LEN + FRAME_CRC_LEN) / frameBytes,
  };
}

export function sourceBlockCount(payloadBytes: number, frameBytes: number): number {
  return Math.ceil(payloadBytes / blockLength(frameBytes));
}

export function fitsInOneStream(payloadBytes: number, frameBytes: number): boolean {
  return sourceBlockCount(payloadBytes, frameBytes) <= MAX_SOURCE_BLOCKS;
}

export function minimumFrameBytes(payloadBytes: number): number {
  return Math.ceil(payloadBytes / MAX_SOURCE_BLOCKS) + HEADER_LEN + FRAME_CRC_LEN;
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
