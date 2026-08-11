/**
 * Distinct frames per source block a stream needs.
 *
 * The v1 soliton fountain needed 1.15–1.6 depending on k (see git history for
 * the measured curve). The v2 systematic carousel (fountain.ts) needs exactly
 * 1.00 at zero loss — measured p50 AND p90 over 100 trials each at
 * k ∈ {5, 25, 100, 400, 1600} — because one caught sweep is the whole file.
 * The 2% margin keeps the bar and the goodput figure from over-promising on
 * the odd dropped frame; under real loss the ETA's overshoot handling extends
 * the target instead of this model pretending to know the loss rate.
 */
export function expectedFountainOverhead(sourceBlocks: number): number {
  return sourceBlocks <= 1 ? 1 : 1.02;
}

export interface TransferProgressEstimate {
  fraction: number;
  expectedFrames: number;
  etaSeconds?: number;
  phase: "collecting" | "decoding";
}

export function estimateTransferProgress(
  sourceBlocks: number,
  uniqueFrames: number,
  elapsedSeconds: number,
  _solvedBlocks = 0,
): TransferProgressEstimate {
  const minimumFrames = Math.max(1, sourceBlocks);
  const expectedFrames = Math.max(
    minimumFrames + 1,
    Math.ceil(minimumFrames * expectedFountainOverhead(minimumFrames)),
  );
  const expectedRedundancy = expectedFrames - minimumFrames;

  // Every useful frame contributes one block-sized equation. Solved blocks are
  // deliberately NOT used here: fountain peeling is back-loaded and can solve
  // a large pending graph in one cascade. The first k equations fill 97% of the
  // bar, expected repair reaches 98%, then extra repair approaches 99%. This
  // keeps moving under loss without ever showing 0 bytes left before decode and
  // verification actually finish.
  let fraction: number;
  if (uniqueFrames <= minimumFrames) {
    fraction = 0.97 * (uniqueFrames / minimumFrames);
  } else if (uniqueFrames <= expectedFrames) {
    fraction = 0.97 + 0.01 * ((uniqueFrames - minimumFrames) / expectedRedundancy);
  } else {
    const repairStep = Math.max(expectedRedundancy, Math.ceil(minimumFrames / 10));
    fraction = 0.98 + 0.01 * (1 - Math.exp(-(uniqueFrames - expectedFrames) / repairStep));
  }
  const phase = uniqueFrames < minimumFrames ? "collecting" : "decoding";
  const rate = elapsedSeconds > 0 ? uniqueFrames / elapsedSeconds : 0;

  // Past the expected frame count the stream is running long — poor light,
  // motion blur, a camera that won't hold focus. That is exactly when someone
  // is staring at the bar wondering whether it has stalled, so keep quoting a
  // time instead of going silent: extend the target a tenth of the stream at
  // a time. (The v2 carousel's nominal redundancy is only 2%, which as a step
  // size would quote a perpetual "about 1s" — a floor keeps the steps honest.)
  const overshoot = uniqueFrames - expectedFrames;
  const step = Math.max(expectedRedundancy, Math.ceil(minimumFrames / 10));
  const target =
    overshoot < 0
      ? expectedFrames
      : expectedFrames + step * (Math.floor(overshoot / step) + 1);
  const etaSeconds =
    uniqueFrames >= 3 && elapsedSeconds >= 1 && rate > 0
      ? (target - uniqueFrames) / rate
      : undefined;
  return { fraction, expectedFrames, etaSeconds, phase };
}

export function formatDuration(seconds: number): string {
  const rounded = Math.max(1, Math.ceil(seconds));
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  if (minutes < 60) return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}
