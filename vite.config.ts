import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { viteSingleFile } from "vite-plugin-singlefile";
import { VitePWA } from "vite-plugin-pwa";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { htmlTokens } from "./build/html-tokens";
import { inlineCodecWasm } from "./build/inline-codec-wasm";
import { rootPwaHead } from "./build/root-pwa-head";
import { diagnosticsEndpoint } from "./build/diagnostics-endpoint";
import { appArtifact } from "./build/app-artifact";

const SITE_URL = process.env.VITE_SITE_URL ?? "https://farzher.github.io/AirGapper/";
const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")) as { version: string };

const TOKENS = { SITE_URL };

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
      },
      workbox: {
        clientsClaim: true,
        globPatterns: ["**/*.html"],
        runtimeCaching: [{
          urlPattern: /\/received-media\//,
          handler: "CacheOnly" as const,
          options: { cacheName: "received-media", rangeRequests: true, matchOptions: { ignoreSearch: true } },
        }],
      },
    }),
    inlineCodecWasm(),
    viteSingleFile(),
    appArtifact(__dirname),
    rootPwaHead(),
    diagnosticsEndpoint(pkg.version),
  ],
  worker: { format: "iife", plugins: () => [inlineCodecWasm()] },
  build: {
    // Firefox 68 was the last pre-Fenix Android release and is still common
    // on deliberately offline older phones. Avoid shipping newer syntax that
    // makes the entire module fail to parse before any buttons are wired up.
    target: "firefox68",
    outDir: "dist",
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: { input: resolve(__dirname, "app.html") },
  },
  server: { host: true },
  preview: { host: true },
});
