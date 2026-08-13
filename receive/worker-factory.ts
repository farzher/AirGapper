// The decoder worker is always embedded. A blob worker works from file:// and
// avoids maintaining a second hosted implementation; the PWA caches the same
// self-contained application artifact.
import { isLegacyAndroidApp } from "../shared/android";
import InlineDecodeWorker from "./worker.ts?worker&inline";
import LegacyAndroidDecodeWorker from "./worker-legacy-android.ts?worker&inline";

function supportsWasmSimd(): boolean {
  try {
    return WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123,
      3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 11,
    ]));
  } catch {
    return false;
  }
}

const useScalarDecoder = isLegacyAndroidApp() || !supportsWasmSimd();

export function createDecodeWorker(): Worker {
  return useScalarDecoder ? new LegacyAndroidDecodeWorker() : new InlineDecodeWorker();
}
