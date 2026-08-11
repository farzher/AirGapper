import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { viteSingleFile } from "vite-plugin-singlefile";
import { VitePWA } from "vite-plugin-pwa";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MAX_FILE_LABEL } from "./shared/protocol";
import { MAX_SNIPPET_LABEL } from "./shared/snippet";
import { DEFAULT_FRAME_BYTES, DEFAULT_TX_FPS, FRAME_BYTES_OPTIONS, TX_FPS_OPTIONS } from "./shared/send-settings";
import { htmlTokens } from "./build/html-tokens";
import { inlineCodecWasm } from "./build/inline-codec-wasm";
import { useInlineVariants } from "./build/use-inline-variants";
import { rewriteStandaloneLinks } from "./build/rewrite-standalone-links";
import { standaloneCsp } from "./build/standalone-csp";
import { emitAs } from "./build/emit-as";
import { rootPwaHead } from "./build/root-pwa-head";
import { licenseBanner } from "./build/license-banner";
import { diagnosticsEndpoint } from "./build/diagnostics-endpoint";
import { legalAssets } from "./build/legal-assets";

const SITE_URL = process.env.VITE_SITE_URL ?? "https://farzher.github.io/AirGapper/";
const SOURCE_URL = "https://github.com/farzher/AirGapper";
const MODIFIED = "2026-08-11";
const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")) as { version: string };

function buildId(): string {
  const git = (cmd: string) => execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  try {
    const hash = git("git rev-parse --short HEAD");
    return git("git status --porcelain").length > 0 ? `${hash}-dirty` : hash;
  } catch {
    return "unknown";
  }
}

const selectOptions = (values: readonly number[], selected: number) =>
  values.map((v) => `<option${v === selected ? " selected" : ""}>${v}</option>`).join("");

const LEGAL_BLOCK = `<details class="legal"><summary>Legal / Source</summary><div><p>AirGapper is free software licensed AGPL-3.0-or-later, with absolutely no warranty. Corresponding source: <a href="${SOURCE_URL}">${SOURCE_URL}</a>.</p><p>Modified ${MODIFIED} from Decimen Optical Transfer, © 2026 Evan Crawley (Bash Alarmist). Portions © 2026 Steve Dakh. The decoder incorporates zxing-cpp under Apache-2.0 and Emscripten runtime output under MIT terms. See <a href="${SITE_URL}NOTICE.txt">NOTICE</a>, <a href="${SITE_URL}LICENSE.txt">AGPL license</a>, and <a href="${SITE_URL}UPSTREAM.txt">upstream commits and build source</a>.</p></div></details>`;

const TOKENS = {
  MAX_FILE_LABEL,
  MAX_SNIPPET_LABEL,
  SITE_URL,
  TX_FPS_OPTIONS: selectOptions(TX_FPS_OPTIONS, DEFAULT_TX_FPS),
  FRAME_BYTES_OPTIONS: selectOptions(FRAME_BYTES_OPTIONS, DEFAULT_FRAME_BYTES),
  APP_VERSION: pkg.version,
  BUILD_ID: buildId(),
  LEGAL_BLOCK,
};

export default defineConfig(({ mode }) => {
  const standalone = mode === "standalone-send" || mode === "standalone-receive";
  const page = mode === "standalone-send" ? "send" : "receive";
  const outDir = "dist-standalone";

  if (standalone) {
    return {
      base: "./",
      publicDir: false,
      plugins: [
        htmlTokens(TOKENS),
        useInlineVariants(__dirname),
        inlineCodecWasm(),
        rewriteStandaloneLinks(page),
        standaloneCsp(page),
        viteSingleFile(),
        licenseBanner(pkg.version),
        emitAs(outDir, `${page}/index.html`, `airgapper-${page === "send" ? "sender" : "receiver"}.html`),
      ],
      worker: { format: "iife", plugins: () => [useInlineVariants(__dirname), inlineCodecWasm()] },
      build: {
        outDir,
        emptyOutDir: false,
        assetsInlineLimit: Number.MAX_SAFE_INTEGER,
        rollupOptions: { input: resolve(__dirname, `${page}/index.html`) },
      },
    };
  }

  return {
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
          theme_color: "#070a11",
          background_color: "#070a11",
          display: "standalone",
          start_url: "./",
          icons: [
            { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
            { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          ],
        },
        workbox: {
          clientsClaim: true,
          globPatterns: ["**/*.{js,css,html,wasm,svg,png,txt}"],
          runtimeCaching: [{
            urlPattern: /\/received-media\//,
            handler: "CacheOnly" as const,
            options: { cacheName: "received-media", rangeRequests: true, matchOptions: { ignoreSearch: true } },
          }],
        },
      }),
      rootPwaHead(),
      licenseBanner(pkg.version),
      legalAssets(__dirname),
      diagnosticsEndpoint(pkg.version),
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "index.html"),
          send: resolve(__dirname, "send/index.html"),
          receive: resolve(__dirname, "receive/index.html"),
        },
      },
    },
    server: { host: true },
    preview: { host: true },
  };
});
