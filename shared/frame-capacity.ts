// How much payload fits in a stream at a given frame size.
//
// The frame header numbers source blocks in a u16, so a large payload at a
// small bytes-per-frame runs out of block numbers long before it runs out of
// the file size limit: at 500 bytes per frame the real ceiling is about 30 MB,
// not 64. The sender has to catch that before it starts streaming, and tell
// you which setting fixes it.

import { HEADER_LEN } from "./protocol";

/** `k` is a u16 in the frame header. */
export const MAX_SOURCE_BLOCKS = 0xffff;

/** Payload bytes per frame, once the header has taken its cut. */
export function blockLength(frameBytes: number): number {
  return frameBytes - HEADER_LEN;
}

/**
 * Choose a payload block size up to the user's frame-size limit while keeping
 * the first gridful of a small transfer useful. Without this cap, a 100-byte
 * container at the 2,953-byte setting becomes one mostly-zero block: every QR
 * repeats that block and differs only in its sequence header. Splitting it
 * across the visible codes gives each code distinct source data and removes
 * almost all padding.
 *
 * Equal-sized fountain blocks cannot produce every requested count exactly.
 * This returns the largest block size whose count is at least `desiredBlocks`,
 * capped at one block per payload byte and at the configured maximum.
 */
export function denseBlockLength(
  payloadBytes: number,
  maximumBlockLength: number,
  desiredBlocks: number,
): number {
  const payload = Math.max(1, Math.floor(payloadBytes));
  const maximum = Math.max(1, Math.floor(maximumBlockLength));
  const target = Math.max(1, Math.min(Math.floor(desiredBlocks), payload));
  if (target === 1) return Math.min(payload, maximum);
  const largestForTarget = Math.floor((payload - 1) / (target - 1));
  return Math.min(maximum, Math.max(1, largestForTarget));
}

/** Source blocks a payload splits into at this frame size. */
export function sourceBlockCount(payloadBytes: number, frameBytes: number): number {
  return Math.ceil(payloadBytes / blockLength(frameBytes));
}

export function fitsInOneStream(payloadBytes: number, frameBytes: number): boolean {
  return sourceBlockCount(payloadBytes, frameBytes) <= MAX_SOURCE_BLOCKS;
}

/** The smallest bytes-per-frame that can carry this payload at all. */
export function minimumFrameBytes(payloadBytes: number): number {
  return Math.ceil(payloadBytes / MAX_SOURCE_BLOCKS) + HEADER_LEN;
}

/**
 * The smallest offered setting that works, so the sender can name a value that
 * is actually in the dropdown instead of the bare arithmetic minimum.
 *
 * Undefined when no option is large enough — unreachable while MAX_FILE_BYTES
 * holds, since the largest legal payload needs about 1045 bytes per frame, but
 * the caller should not have to know that.
 */
export function smallestSufficientFrameSize(
  payloadBytes: number,
  options: readonly number[],
): number | undefined {
  const minimum = minimumFrameBytes(payloadBytes);
  return options
    .filter((value) => value >= minimum)
    .sort((a, b) => a - b)[0];
}
