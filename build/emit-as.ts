import type { Plugin } from "vite";
import { renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";

/** Vite names HTML output after its input path, so send/index.html lands at
 *  send/index.html. Standalone builds want one file with a memorable name. */
export function emitAs(outDir: string, from: string, to: string): Plugin {
  return {
    name: "emit-standalone-as",
    enforce: "post",
    closeBundle() {
      renameSync(resolve(outDir, from), resolve(outDir, to));
      rmSync(resolve(outDir, from.split("/")[0]!), { recursive: true, force: true });
    },
  };
}
