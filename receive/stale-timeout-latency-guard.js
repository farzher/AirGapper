import { DecodeWorkerPool } from "../shared/worker-pool.js";

const baseFailureCompletion = DecodeWorkerPool.prototype.failureCompletion;
if (typeof baseFailureCompletion === "function" && !baseFailureCompletion.__airgapperStaleLatencyGuard) {
  const failureCompletion = function(slot, full, latencyMs, error) {
    const completion = baseFailureCompletion.call(this, slot, full, latencyMs, error);
    if (!full && completion?.timedOut) {
      // Preserve the actual timeout duration for diagnostics, but do not feed a
      // disposable stale frame into normal service-latency / Auto-worker sizing.
      completion.staleLatencyMs = Number(latencyMs) || 0;
      completion.latencyMs = 0;
    }
    return completion;
  };
  Object.defineProperty(failureCompletion, "__airgapperStaleLatencyGuard", { value: true });
  DecodeWorkerPool.prototype.failureCompletion = failureCompletion;
}
