import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { viteSingleFile } from "vite-plugin-singlefile";
import { VitePWA } from "vite-plugin-pwa";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { MAX_FILE_LABEL } from "./shared/protocol";
import { DEFAULT_FRAME_BYTES, DEFAULT_TX_FPS, FRAME_BYTES_OPTIONS, TX_FPS_OPTIONS } from "./shared/send-settings";
import { htmlTokens } from "./build/html-tokens";
import { inlineCodecWasm } from "./build/inline-codec-wasm";
import { rootPwaHead } from "./build/root-pwa-head";
import { licenseBanner } from "./build/license-banner";
import { diagnosticsEndpoint } from "./build/diagnostics-endpoint";
import { legalAssets } from "./build/legal-assets";
import { appArtifact } from "./build/app-artifact";

const SITE_URL = process.env.VITE_SITE_URL ?? "https://farzher.github.io/AirGapper/";
const SOURCE_URL = "https://github.com/farzher/AirGapper";
const MODIFIED = "2026-08-11";
const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")) as { version: string };

/** A deterministic cache generation. index.html has a stable filename, so the
 * generated service worker needs a source-derived cache id to update it. */
function appRevision(): string {
  const hash = createHash("sha256");
  const add = (relative: string): void => {
    const path = resolve(__dirname, relative);
    const entries = readdirSync(path, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) add(child);
      else {
        hash.update(child);
        hash.update(readFileSync(resolve(__dirname, child)));
      }
    }
  };
  for (const file of ["app.html", "package.json", "package-lock.json", "vite.config.ts"]) {
    hash.update(file);
    hash.update(readFileSync(resolve(__dirname, file)));
  }
  for (const directory of ["app", "build", "send", "receive", "shared", "vendor/decimen-codec"]) add(directory);
  return hash.digest("hex").slice(0, 16);
}
const APP_REVISION = appRevision();
const selectOptions = (values: readonly number[], selected: number) =>
  values.map((value) => `<option${value === selected ? " selected" : ""}>${value}</option>`).join("");

const LEGAL_BLOCK = `<details class="legal"><summary>Legal / Source</summary><div><p>AirGapper is free software licensed AGPL-3.0-or-later, with absolutely no warranty. Corresponding source: <a href="${SOURCE_URL}">${SOURCE_URL}</a>.</p><p>Modified ${MODIFIED} from Decimen Optical Transfer, © 2026 Evan Crawley (Bash Alarmist). Portions © 2026 Steve Dakh. The decoder incorporates decimen-codec and zxing-cpp under Apache-2.0, with Emscripten runtime output under MIT terms. Hosted copies include <a href="${SITE_URL}NOTICE.txt">NOTICE</a>, <a href="${SITE_URL}LICENSE.txt">AGPL license</a>, and <a href="${SITE_URL}UPSTREAM.txt">pinned upstream source details</a>.</p></div></details>`;

const TOKENS = {
  MAX_FILE_LABEL,
  SITE_URL,
  TX_FPS_OPTIONS: selectOptions(TX_FPS_OPTIONS, DEFAULT_TX_FPS),
  FRAME_BYTES_OPTIONS: selectOptions(FRAME_BYTES_OPTIONS, DEFAULT_FRAME_BYTES),
  APP_VERSION: pkg.version,
  LEGAL_BLOCK,
};

export default defineConfig({
  base: "./",
  plugins: [
    htmlTokens(TOKENS),
    basicSsl(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false,
      manifest: {
        name: "AirGapper",
        short_name: "AirGapper",
        description: "Offline file and text transfer with animated QR codes.",
        theme_color: "#f7f7f5",
        background_color: "#f7f7f5",
        display: "standalone",
        start_url: "./",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        ],
      },
      workbox: {
        cacheId: `airgapper-${APP_REVISION}`,
        clientsClaim: true,
        // VitePWA already contributes emitted/public assets. Globbing PNGs or
        // the manifest again creates conflicting duplicate precache entries.
        globPatterns: ["**/*.{html,txt}"],
        runtimeCaching: [{
          urlPattern: /\/received-media\//,
          handler: "CacheOnly" as const,
          options: { cacheName: "received-media", rangeRequests: true, matchOptions: { ignoreSearch: true } },
        }],
      },
    }),
    inlineCodecWasm(),
    viteSingleFile(),
    licenseBanner(pkg.version),
    appArtifact(__dirname),
    rootPwaHead(),
    legalAssets(__dirname),
    diagnosticsEndpoint(pkg.version),
  ],
  worker: { format: "iife", plugins: () => [inlineCodecWasm()] },
  build: {
    outDir: "dist",
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: { input: resolve(__dirname, "app.html") },
  },
  server: { host: true },
  preview: { host: true },
});
