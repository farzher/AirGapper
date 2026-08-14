import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { VitePWA } from "vite-plugin-pwa";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { htmlTokens } from "./build/html-tokens";
import { buildSizeReport } from "./build/build-size-report";
import { diagnosticsEndpoint } from "./build/diagnostics-endpoint";
import { appArtifact } from "./build/app-artifact";

const SITE_URL = process.env.VITE_SITE_URL ?? "https://farzher.github.io/AirGapper/";
const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")) as { version: string };

const TOKENS = { SITE_URL, VERSION: pkg.version };

export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [
    htmlTokens(TOKENS),
    basicSsl(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "inline",
      manifest: {
        name: "AirGapper",
        short_name: "AirGapper",
        description: "Offline file and text transfer with animated QR codes.",
        theme_color: "#f7f7f5",
        background_color: "#f7f7f5",
        display: "standalone",
        start_url: "./",
        scope: "./",
        icons: [
          { src: "./icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "./icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "./icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        clientsClaim: true,
        inlineWorkboxRuntime: true,
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        dontCacheBustURLsMatching: /-[\w-]{8}\./,
        globPatterns: ["**/*.{html,js,css,wasm,png}"],
        runtimeCaching: [{
          urlPattern: /\/received-media\//,
          handler: "CacheOnly" as const,
          options: { cacheName: "received-media", rangeRequests: true, matchOptions: { ignoreSearch: true } },
        }],
      },
    }),
    appArtifact(__dirname),
    diagnosticsEndpoint(pkg.version),
    buildSizeReport(),
  ],
  worker: { format: "iife" },
  build: {
    // The hosted app keeps the fast native syntax used by the known-good web
    // build. Only the APK needs downlevel output for its older WebView.
    target: mode === "apk" ? "chrome67" : "es2022",
    outDir: "dist",
    assetsInlineLimit: 0,
    rollupOptions: { input: resolve(__dirname, "app.html") },
  },
  server: { host: true },
  preview: { host: true },
}));
