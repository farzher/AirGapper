import { isLegacyAndroidApp } from "../shared/android.js";

function supportsWasmSimd() {
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

export function createDecodeWorker() {
  const url = usesSimpleDecodeWorker
    ? new URL("./worker-legacy-android.js", import.meta.url)
    : new URL("./worker.js", import.meta.url);
  return new Worker(url, { type: "module" });
}
