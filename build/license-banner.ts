import type { Plugin } from "vite";

/** Put license, attribution, modification date, and source on copied artifacts. */
export function licenseBanner(version: string): Plugin {
  const text =
    `AirGapper v${version} — modified 2026-08-11 — SPDX-License-Identifier: AGPL-3.0-or-later — ` +
    `modified from Decimen Optical Transfer, (c) 2026 Evan Crawley (Bash Alarmist); portions (c) 2026 Steve Dakh; ` +
    `zxing-cpp Apache-2.0; Emscripten runtime MIT — NO WARRANTY — ` +
    `Source: https://github.com/farzher/AirGapper`;
  const comment = `/*! ${text} */\n`;
  const htmlComment = `<!-- ${text} -->`;
  return {
    name: "license-banner",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === "chunk") {
          if (!output.code.startsWith(comment)) output.code = comment + output.code;
        } else if (typeof output.source === "string" && (fileName.endsWith(".js") || fileName.endsWith(".css"))) {
          if (!output.source.startsWith(comment)) output.source = comment + output.source;
        } else if (output.type === "asset" && typeof output.source === "string" && fileName.endsWith(".html")) {
          if (!/^<!doctype html>/i.test(output.source)) throw new Error(`${fileName}: missing doctype`);
          if (!output.source.includes(htmlComment)) output.source = output.source.replace(/^<!doctype html>/i, (m) => `${m}\n${htmlComment}`);
        }
      }
    },
  };
}
