function fitQrDisplaySize(viewportWidth, viewportHeight, containerWidth, requestedSize, horizontalChrome = 0) {
  const viewportBudget = 0.9 * Math.min(viewportWidth, viewportHeight);
  const containerBudget = Math.max(1, containerWidth - horizontalChrome);
  return Math.max(1, Math.min(viewportBudget, containerBudget, requestedSize));
}
export {
  fitQrDisplaySize
};
