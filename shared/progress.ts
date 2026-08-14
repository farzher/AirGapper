/**
 * Distinct frames per source block a stream needs.
 *
 * The older soliton fountain needed 1.15–1.6 depending on k (see git history
 * for the measured curve). The systematic carousel (fountain.ts) needs exactly
 * 1.00 at zero loss — measured p50 AND p90 over 100 trials each at
 * k ∈ {5, 25, 100, 400, 1600} — because one caught sweep is the whole file.
 * The 2% margin keeps the bar and the goodput figure from over-promising on
 * the odd dropped frame; under real loss the ETA's overshoot handling extends
 * the target instead of this model pretending to know the loss rate.
 */
export function expectedCodingOverhead(mode: "direct" | "mds" | "fountain"): number {
  return mode === "fountain" ? 1.02 : 1;
}

export interface TransferProgressEstimate {
  fraction: number;
  expectedFrames: number;
  remainingFrames: number;
  etaSeconds?: number;
  phase: "collecting" | "decoding";
}

export function estimateTransferProgress(
  sourceBlocks: number,
  usefulSymbols: number,
  elapsedSeconds: number,
  sourceRank = usefulSymbols,
  mode: "direct" | "mds" | "fountain" = "fountain",
): TransferProgressEstimate {
  const minimumFrames = Math.max(1, sourceBlocks);
  if (mode !== "fountain") {
    const rank = Math.min(minimumFrames, Math.max(0, sourceRank));
    const fraction = rank >= minimumFrames ? 1 : 0.98 * rank / minimumFrames;
    const rate = elapsedSeconds > 0 ? rank / elapsedSeconds : 0;
    const remainingFrames = minimumFrames - rank;
    return {
      fraction,
      expectedFrames: minimumFrames,
      remainingFrames,
      etaSeconds: rank >= 2 && elapsedSeconds >= 1 && rate > 0 ? remainingFrames / rate : undefined,
      phase: rank < minimumFrames ? "collecting" : "decoding",
    };
  }
  // An aligned clean systematic sweep finishes at k, while a mid-cycle join or
  // dropped symbols consumes repair frames. Reserve 20% for that carousel time:
  // enough to avoid camping at 99%, but not the old solved-block estimate that
  // could sit near 70% until one peeling cascade completed everything.
  const expectedFrames = Math.max(
    minimumFrames + 1,
    Math.ceil(minimumFrames * 1.2),
  );
  const expectedRedundancy = expectedFrames - minimumFrames;

  // Fountain completion is discrete: the last few missing blocks can require
  // an unpredictable repair-frame combination. Reach 92% at the nominal
  // target and creep only to 95%, so a slow tail never looks stuck at 98–99%.
  // This intentionally makes completion arrive a little earlier than the bar
  // predicts instead of promising that an unknown final repair is imminent.
  let fraction: number;
  if (usefulSymbols <= expectedFrames) {
    fraction = 0.92 * (usefulSymbols / expectedFrames);
  } else {
    const repairStep = Math.max(expectedRedundancy, Math.ceil(minimumFrames / 10));
    fraction = 0.92 + 0.03 * (1 - Math.exp(-(usefulSymbols - expectedFrames) / repairStep));
  }
  const phase = usefulSymbols < minimumFrames ? "collecting" : "decoding";
  const rate = elapsedSeconds > 0 ? usefulSymbols / elapsedSeconds : 0;

  // Past the expected frame count the stream is running long — poor light,
  // motion blur, a camera that won't hold focus. That is exactly when someone
  // is staring at the bar wondering whether it has stalled, so keep quoting a
  // time instead of going silent: extend the target a tenth of the stream at
  // a time. (The carousel's nominal redundancy is only 2%, which as a step
  // size would quote a perpetual "about 1s" — a floor keeps the steps honest.)
  const overshoot = usefulSymbols - expectedFrames;
  const step = Math.max(expectedRedundancy, Math.ceil(minimumFrames / 10));
  const target =
    overshoot < 0
      ? expectedFrames
      : expectedFrames + step * (Math.floor(overshoot / step) + 1);
  const remainingFrames = Math.max(0, target - usefulSymbols);
  const etaSeconds =
    usefulSymbols >= 3 && elapsedSeconds >= 1 && rate > 0
      ? remainingFrames / rate
      : undefined;
  return { fraction, expectedFrames, remainingFrames, etaSeconds, phase };
}

/** Completed-transfer goodput from the exact measured transfer time. */
export function completedGoodputKbs(bytes: number, seconds: number): number {
  return Math.max(0, bytes) / 1024 / Math.max(0.001, seconds);
}

export function formatDuration(seconds: number): string {
  if (seconds < 1) return `${Math.max(1, Math.round(seconds * 1000))}ms`;
  const rounded = Math.ceil(seconds);
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  if (minutes < 60) return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}
