import type { Plugin } from "vite";
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
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
      const output = resolve(root, "dist");
      const generatedAssets = resolve(root, "assets");
      if (existsSync(generatedAssets)) rmSync(generatedAssets, { recursive: true, force: true });
      for (const file of readdirSync(output)) {
        cpSync(resolve(output, file), resolve(root, file), { recursive: true, force: true });
      }
    },
  };
}
