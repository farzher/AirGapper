// Standalone builds only. A module worker loaded from a file:// page is blocked
// by the opaque origin, so the worker ships as a base64 blob URL, which file://
// permits.
import InlineDecodeWorker from "./worker.ts?worker&inline";

export function createDecodeWorker(): Worker {
  return new InlineDecodeWorker();
}
