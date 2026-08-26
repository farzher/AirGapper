function bridge() {
  return window.AirGapperAndroid;
}
function isAndroidApp() {
  return bridge() !== void 0;
}
function isLegacyAndroidApp() {
  var _a;
  const android = bridge();
  return android !== void 0 && ((_a = android.is64BitProcess) == null ? void 0 : _a.call(android)) === false;
}
function getAndroidMediaOutputLevel() {
  const android = bridge();
  if (!(android == null ? void 0 : android.getMediaOutputLevel)) return null;
  const level = Number(android.getMediaOutputLevel());
  return Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : null;
}
function saveFileOnAndroid(name, type, bytes) {
  const android = bridge();
  if (!android) return false;
  android.beginDownload(name, type);
  const chunkSize = 48 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
    let binary = "";
    for (const byte of chunk) binary += String.fromCharCode(byte);
    android.appendDownloadChunk(btoa(binary));
  }
  android.finishDownload();
  return true;
}
function showScanCaptureMenuOnAndroid() {
  const android = bridge();
  if (!(android == null ? void 0 : android.showScanCaptureMenu)) return false;
  android.showScanCaptureMenu();
  return true;
}
function copyTextOnAndroid(text) {
  const android = bridge();
  if (!android) return false;
  android.copyText(text);
  return true;
}
function setAndroidKeepScreenOn(enabled) {
  var _a;
  (_a = bridge()) == null ? void 0 : _a.setKeepScreenOn(enabled);
}
export {
  copyTextOnAndroid,
  getAndroidMediaOutputLevel,
  isAndroidApp,
  isLegacyAndroidApp,
  saveFileOnAndroid,
  setAndroidKeepScreenOn,
  showScanCaptureMenuOnAndroid
};
