import type { Plugin } from "vite";
import { gzipSync } from "node:zlib";

export function buildSizeReport(): Plugin {
  return {
    name: "build-size-report",
    enforce: "post",
    generateBundle(_options, bundle) {
      const files = Object.values(bundle);
      const html = files.find((item) => item.fileName === "index.html" || item.fileName.endsWith("app.html"));
      if (!html || html.type !== "asset") return;
      const bytes = Buffer.from(typeof html.source === "string" ? html.source : html.source);
      const text = bytes.toString("utf8");
      const payloads = [...text.matchAll(/data:application\/wasm;base64,([A-Za-z0-9+/=]+)/g)].map((match) => match[1]!);
      const unique = new Set(payloads);
      const wasm = files.filter((item) => item.fileName.endsWith(".wasm"));
      const wasmBytes = wasm.reduce((sum, item) => sum + (item.type === "asset" ? Buffer.byteLength(item.source) : Buffer.byteLength(item.code)), 0);
      const appBytes = files.reduce((sum, item) => sum + (item.type === "asset"
        ? Buffer.byteLength(item.source)
        : Buffer.byteLength(item.code)), 0);
      console.log(
        `\nAirGapper size: index ${bytes.byteLength.toLocaleString()} B raw / ${gzipSync(bytes).byteLength.toLocaleString()} B gzip` +
        ` · embedded WASM ${payloads.length} payloads / ${unique.size} unique / ${payloads.reduce((sum, value) => sum + Buffer.from(value, "base64").byteLength, 0).toLocaleString()} B` +
        ` · emitted WASM ${wasm.length} / ${wasmBytes.toLocaleString()} B` +
        ` · offline bundle ${appBytes.toLocaleString()} B\n`,
      );
      if (payloads.length !== unique.size) this.error("Duplicate embedded WASM payloads detected");
    },
  };
}
