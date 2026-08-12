import type { Plugin } from "vite";

/** Keep file:// completely quiet while enabling install/update behavior for the
 * same HTML artifact when it is hosted. */
export function rootPwaHead(): Plugin {
  const hostedSetup = `<script>
if (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1") {
  const manifest = document.createElement("link");
  manifest.rel = "manifest";
  manifest.href = "./manifest.webmanifest";
  document.head.append(manifest);
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      const wasControlled = !!navigator.serviceWorker.controller;
      let reloading = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!wasControlled || reloading) return;
        reloading = true;
        location.reload();
      });
      navigator.serviceWorker.register("./sw.js", { scope: "./" }).then((reg) => {
        const promote = (worker) => worker && worker.postMessage({ type: "SKIP_WAITING" });
        promote(reg.waiting);
        reg.addEventListener("updatefound", () => {
          const next = reg.installing;
          if (!next) return;
          next.addEventListener("statechange", () => {
            if (next.state === "installed") promote(reg.waiting || next);
          });
        });
      });
    });
  }
}
</script>`;
  const manifestLink = /<link[^>]*rel=["']manifest["'][^>]*>/i;
  return {
    name: "root-pwa-head",
    enforce: "post",
    generateBundle(_options, bundle) {
      const asset = bundle["index.html"];
      if (!asset || asset.type !== "asset" || typeof asset.source !== "string") {
        throw new Error("index.html unavailable for hosted PWA setup");
      }
      // vite-plugin-pwa emits the manifest and injects this static link. A
      // static link would make file:// probe for a sibling asset, so create it
      // only on a hosted secure origin instead.
      if (!manifestLink.test(asset.source)) throw new Error("PWA manifest link was not injected");
      asset.source = asset.source
        .replace(manifestLink, "")
        .replace("</body>", `${hostedSetup}</body>`);
    },
  };
}
