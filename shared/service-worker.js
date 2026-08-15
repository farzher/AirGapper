const serviceWorkers = navigator.serviceWorker;
if (serviceWorkers) {
  const hadController = Boolean(serviceWorkers.controller);
  let reloading = false;
  let registration;
  serviceWorkers.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener("load", () => {
    void serviceWorkers.register("./sw.js", { scope: "./", updateViaCache: "none" }).then((current) => {
      var _a;
      registration = current;
      (_a = current.waiting) == null ? void 0 : _a.postMessage({ type: "SKIP_WAITING" });
      return current.update();
    }).catch(() => void 0);
  }, { once: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void (registration == null ? void 0 : registration.update().catch(() => void 0));
  });
}
