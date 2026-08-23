// The reconstruction wrapper dynamically imports the mature base decoder so it
// can preserve scalar/SIMD selection. A module worker can receive its first
// postMessage while that top-level import is still suspended. Install this
// listener synchronously before importing anything and hold those already-
// transferred messages until the final wrapper handler exists. This retains no
// extra camera copy: a queued MessageEvent owns the same transferred VideoFrame
// or ArrayBuffer the worker would have received normally.
const scope = self;
const queued = [];
let booting = true;

function holdDuringBootstrap(event) {
  if (!booting) return;
  event.stopImmediatePropagation();
  queued.push(event);
}

scope.addEventListener("message", holdDuringBootstrap);

const scalar = new URL(scope.location.href).searchParams.has("scalar");
await import(scalar ? "./worker-reconstruct.js?scalar=1" : "./worker-reconstruct.js");

const finalHandler = scope.onmessage;
if (typeof finalHandler !== "function")
  throw new Error("Reconstruction worker failed to install its message handler");

booting = false;
scope.removeEventListener("message", holdDuringBootstrap);

// Preserve arrival order. DecodeWorkerPool never has more than one owned job on
// a worker, but sequential replay also makes this safe for startup probes/tests.
for (const event of queued)
  await finalHandler.call(scope, event);
queued.length = 0;
