// Workers are emitted once and precached with their WASM dependencies. This
// avoids duplicating large decoder binaries inside the application HTML.
import { isLegacyAndroidApp } from "../shared/android";
import DecodeWorker from "./worker.ts?worker";
import LegacyAndroidDecodeWorker from "./worker-legacy-android.ts?worker";

function supportsWasmSimd(): boolean {
  try {
    return WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123,
      3, 2, 1, 0, 10, 8, 1, 6, 0, 65, 0, 253, 15, 11,
    ]));
  } catch {
    return false;
  }
}

export const usesSimpleDecodeWorker = isLegacyAndroidApp() || !supportsWasmSimd();

export function createDecodeWorker(): Worker {
  return usesSimpleDecodeWorker ? new LegacyAndroidDecodeWorker() : new DecodeWorker();
}
