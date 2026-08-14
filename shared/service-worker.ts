const serviceWorkers = navigator.serviceWorker;

if (serviceWorkers) {
  const hadController = Boolean(serviceWorkers.controller);
  let reloading = false;
  let registration: ServiceWorkerRegistration | undefined;

  serviceWorkers.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  window.addEventListener("load", () => {
    void serviceWorkers.register("./sw.js", { scope: "./", updateViaCache: "none" })
      .then((current) => {
        registration = current;
        current.waiting?.postMessage({ type: "SKIP_WAITING" });
        return current.update();
      })
      .catch(() => undefined);
  }, { once: true });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void registration?.update().catch(() => undefined);
  });
}
