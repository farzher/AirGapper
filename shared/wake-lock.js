import { setAndroidKeepScreenOn } from "./android.js";
let sentinel;
let requestVersion = 0;
async function requestScreenWakeLock() {
  var _a;
  setAndroidKeepScreenOn(true);
  const version = ++requestVersion;
  if (sentinel) return;
  try {
    const acquired = await ((_a = navigator.wakeLock) == null ? void 0 : _a.request("screen"));
    if (!acquired) return;
    if (version !== requestVersion) {
      void acquired.release();
      return;
    }
    sentinel = acquired;
    acquired.addEventListener("release", () => {
      if (sentinel === acquired) sentinel = void 0;
    });
  } catch {
  }
}
function releaseScreenWakeLock() {
  requestVersion++;
  setAndroidKeepScreenOn(false);
  void (sentinel == null ? void 0 : sentinel.release());
  sentinel = void 0;
}
export {
  releaseScreenWakeLock,
  requestScreenWakeLock
};
