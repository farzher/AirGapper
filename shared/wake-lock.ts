import { setAndroidKeepScreenOn } from "./android";

let sentinel: WakeLockSentinel | undefined;
let requestVersion = 0;

/** Keep the screen awake for the duration of a transfer, best effort — a
 *  sender that sleeps mid-stream kills the transfer, but a browser without
 *  the API (or a denied request) is fine to run without it. */
export async function requestScreenWakeLock(): Promise<void> {
  setAndroidKeepScreenOn(true);
  const version = ++requestVersion;
  if (sentinel) return;
  try {
    const acquired = await navigator.wakeLock?.request("screen");
    if (!acquired) return;
    if (version !== requestVersion) {
      void acquired.release();
      return;
    }
    sentinel = acquired;
    acquired.addEventListener("release", () => {
      if (sentinel === acquired) sentinel = undefined;
    });
  } catch {
    /* fine without it */
  }
}

export function releaseScreenWakeLock(): void {
  requestVersion++;
  setAndroidKeepScreenOn(false);
  void sentinel?.release();
  sentinel = undefined;
}
