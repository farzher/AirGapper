// The decoder worker is always embedded. A blob worker works from file:// and
// avoids maintaining a second hosted implementation; the PWA caches the same
// self-contained application artifact.
import InlineDecodeWorker from "./worker.ts?worker&inline";

export function createDecodeWorker(): Worker {
  return new InlineDecodeWorker();
}
