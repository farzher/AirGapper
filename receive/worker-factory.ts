// Served builds: a module worker fetched by URL. The browser caches it, and the
// service worker precaches it for offline use.
//
// Standalone builds swap this file for worker-factory.inline.ts at resolve time
// (see vite.config.ts). A runtime branch will not do — `?worker&inline` builds
// a Blob at module scope, so Rollup cannot prove it side-effect-free and keeps
// its ~45 KB of base64 even when the branch is provably dead.
export function createDecodeWorker(): Worker {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
}
