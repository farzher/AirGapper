import { DecodeWorkerPool } from "../shared/worker-pool.js";

const threads = Math.max(1, Number(navigator.hardwareConcurrency) || 2);
const autoWorkerFloor = threads >= 8 ? Math.min(7, threads - 1) : 0;

if (autoWorkerFloor > 0) {
  const baseResize = DecodeWorkerPool.prototype.resize;
  if (typeof baseResize === "function" && !baseResize.__airgapperCapacityGuard) {
    const resize = function(count) {
      const requested = Math.max(0, Math.trunc(Number(count) || 0));
      const selector = document.getElementById("decode-workers");
      const effective = requested > 0 && selector?.value === "auto"
        ? Math.max(requested, autoWorkerFloor)
        : requested;
      return baseResize.call(this, effective);
    };
    Object.defineProperty(resize, "__airgapperCapacityGuard", { value: true });
    DecodeWorkerPool.prototype.resize = resize;
  }

  const syncLabel = () => {
    const selector = document.getElementById("decode-workers");
    const option = selector?.querySelector('option[value="auto"]');
    if (option && selector.value === "auto") {
      const label = `Auto (${autoWorkerFloor})`;
      if (option.textContent !== label) option.textContent = label;
    }
  };
  queueMicrotask(syncLabel);
  const selector = document.getElementById("decode-workers");
  const option = selector?.querySelector('option[value="auto"]');
  if (selector && option && typeof MutationObserver === "function") {
    new MutationObserver(syncLabel).observe(option, { childList: true, characterData: true, subtree: true });
    selector.addEventListener("change", syncLabel);
  }
}
