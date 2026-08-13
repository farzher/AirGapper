// The decoder worker is always embedded. A blob worker works from file:// and
// avoids maintaining a second hosted implementation; the PWA caches the same
// self-contained application artifact.
import { isAndroidApp } from "../shared/android";
import InlineDecodeWorker from "./worker.ts?worker&inline";
import AndroidDecodeWorker from "./worker-android.ts?worker&inline";

export function createDecodeWorker(): Worker {
  // The optimized batched codec introduced after the last known-working APK
  // can take down an old 32-bit WebView renderer during WASM startup. Use the
  // proven pre-batch codec in the APK; browsers retain the current pipeline.
  return isAndroidApp() ? new AndroidDecodeWorker() : new InlineDecodeWorker();
}
