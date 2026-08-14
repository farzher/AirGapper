import type { CodingMode } from "./coding-mode";

export function expectedCodingOverhead(_mode: CodingMode): number {
  return 1;
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
  _mode: CodingMode = "raptorq",
): TransferProgressEstimate {
  const expectedFrames = Math.max(1, sourceBlocks);
  const rank = Math.min(expectedFrames, Math.max(0, sourceRank));
  const complete = rank >= expectedFrames;
  const fraction = complete ? 1 : 0.98 * rank / expectedFrames;
  const rate = elapsedSeconds > 0 ? usefulSymbols / elapsedSeconds : 0;
  const remainingFrames = expectedFrames - rank;
  return {
    fraction,
    expectedFrames,
    remainingFrames,
    etaSeconds: usefulSymbols >= 2 && elapsedSeconds >= 1 && rate > 0
      ? remainingFrames / rate
      : undefined,
    phase: usefulSymbols < expectedFrames ? "collecting" : "decoding",
  };
}

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
