// The decoder worker is always embedded. A blob worker works from file:// and
// avoids maintaining a second hosted implementation; the PWA caches the same
// self-contained application artifact.
import { isAndroidApp } from "../shared/android";
import InlineDecodeWorker from "./worker.ts?worker&inline";
import AndroidDecodeWorker from "./worker-android.ts?worker&inline";

export function createDecodeWorker(): Worker {
  // Older APK WebViews use the smaller, proven decoder instead of loading the
  // browser codec's larger batched WASM implementation.
  return isAndroidApp() ? new AndroidDecodeWorker() : new InlineDecodeWorker();
}
