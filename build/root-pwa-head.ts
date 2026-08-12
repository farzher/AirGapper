import type { Plugin } from "vite";

/** Enable install and updates when hosted without probing for sibling files on file://. */
export function rootPwaHead(): Plugin {
  const hostedSetup = `<script>
if (location.hostname !== "appassets.androidplatform.net" && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  const manifest = document.createElement("link");
  manifest.rel = "manifest";
  manifest.href = "./manifest.webmanifest";
  document.head.append(manifest);
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js", { scope: "./" }));
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
      if (!manifestLink.test(asset.source)) throw new Error("PWA manifest link was not injected");
      asset.source = asset.source.replace(manifestLink, "").replace("</body>", `${hostedSetup}</body>`);
    },
  };
}
