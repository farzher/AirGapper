import type { Plugin } from "vite";
import { copyFileSync } from "node:fs";
import { resolve } from "node:path";

/** Name the single HTML output index.html and keep the checked-in root artifact
 * synchronized on every production build. */
export function appArtifact(root: string): Plugin {
  return {
    name: "app-artifact",
    enforce: "post",
    generateBundle(_options, bundle) {
      const htmlName = Object.keys(bundle).find((name) => name.endsWith("app.html"));
      if (!htmlName) throw new Error("single-page build did not emit app.html");
      bundle["index.html"] = { ...bundle[htmlName]!, fileName: "index.html" };
      delete bundle[htmlName];
    },
    closeBundle() {
      for (const file of [
        "index.html",
        "manifest.webmanifest",
        "sw.js",
        "icon-192.png",
        "icon-512.png",
        "icon-512-maskable.png",
      ]) {
        copyFileSync(resolve(root, "dist", file), resolve(root, file));
      }
    },
  };
}
