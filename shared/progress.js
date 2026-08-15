function expectedCodingOverhead() {
  return 1;
}
function estimateTransferProgress(sourceBlocks, usefulSymbols, elapsedSeconds, sourceRank = usefulSymbols) {
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
    etaSeconds: usefulSymbols >= 2 && elapsedSeconds >= 1 && rate > 0 ? remainingFrames / rate : void 0,
    phase: usefulSymbols < expectedFrames ? "collecting" : "decoding"
  };
}
function completedGoodputKbs(bytes, seconds) {
  return Math.max(0, bytes) / 1024 / Math.max(1e-3, seconds);
}
function formatDuration(seconds) {
  if (seconds < 1) return `${Math.max(1, Math.round(seconds * 1e3))}ms`;
  const rounded = Math.ceil(seconds);
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  if (minutes < 60) return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}
export {
  completedGoodputKbs,
  estimateTransferProgress,
  expectedCodingOverhead,
  formatDuration
};
