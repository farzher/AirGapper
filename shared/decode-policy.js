function shouldRunFullDecode(fullFrame, trackedAttempted, trackedHit) {
  return fullFrame || !trackedAttempted || !trackedHit;
}
export {
  shouldRunFullDecode
};
