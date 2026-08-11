import type { Plugin } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Keep the complete license and attribution files beside every hosted build. */
export function legalAssets(root: string): Plugin {
  const files = [
    ["LICENSE.txt", "LICENSE"],
    ["NOTICE.txt", "NOTICE"],
    ["UPSTREAM.txt", "UPSTREAM.md"],
    ["LICENSE.zxing-cpp.txt", "vendor/decimen-codec/LICENSE.zxing-cpp"],
    ["CODEC-NOTICE.txt", "vendor/decimen-codec/NOTICE.md"],
  ] as const;
  return {
    name: "legal-assets",
    generateBundle() {
      for (const [fileName, sourcePath] of files) {
        this.emitFile({ type: "asset", fileName, source: readFileSync(resolve(root, sourcePath), "utf8") });
      }
    },
  };
}
