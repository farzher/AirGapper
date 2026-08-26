(() => {
  const build = new URL(self.location.href).searchParams.get("build") || "dev";
  const cacheBuild = build.replace(/[^a-zA-Z0-9._-]/g, "-");
  const CACHE = `airgapper-static-js-${cacheBuild}`;
  const PRECACHE = [
    "./main.js",
    "./version.js",
    "./icon-192.png",
    "./icon-512-maskable.png",
    "./icon-512.png",
    "./index.html",
    "./manifest.webmanifest",
    "./audio/main.js",
    "./audio/modem.js",
    "./audio/quiet-modem.js",
    "./receive/agcap.js",
    "./receive/auto-phase-policy.js",
    "./receive/auto-phase.js",
    "./receive/camera-constraints.js",
    "./receive/camera-ui.js",
    "./receive/decode-health.js",
    "./receive/dev-settings-unlock.js",
    "./receive/dev-tools-core.js",
    "./receive/dev-tools.js",
    "./receive/exposure-ev.js",
    "./receive/focus-controller-core.js",
    "./receive/focus-controller.js",
    "./receive/grid-lattice-geometry.js",
    "./receive/grid-lattice.js",
    "./receive/guided-motion.js",
    "./receive/main.js",
    "./receive/overlay-coordinate-dev.js",
    "./receive/performance-policy.js",
    "./receive/phase-nudge.js",
    "./receive/qr-optics.js",
    "./receive/result.js",
    "./receive/rgba-luma.js",
    "./receive/runtime.js",
    "./receive/startup-throughput.js",
    "./receive/timeout-diagnostics.js",
    "./receive/track-processor-proxy.js",
    "./receive/track-processor-worker-proxy.js",
    "./receive/track-processor-worker.js",
    "./receive/user-overlay.js",
    "./receive/worker-camera.js",
    "./receive/worker-core.js",
    "./receive/worker-rvfc.js",
    "./receive/worker.js",
    "./send/dev-settings.js",
    "./send/main.js",
    "./send/render-worker.js",
    "./send/transfer-qr.js",
    "./shared/android.js",
    "./shared/camera-start-guard.js",
    "./shared/coding-mode.js",
    "./shared/format.js",
    "./shared/frame-capacity.js",
    "./shared/grid-layout.js",
    "./shared/plain-qr-policy.js",
    "./shared/platform.js",
    "./shared/progress.js",
    "./shared/protocol.js",
    "./shared/qr-raster.js",
    "./shared/raptorq.js",
    "./shared/snippet.js",
    "./shared/status-line.js",
    "./shared/style.css",
    "./shared/transport.js",
    "./shared/wake-lock.js",
    "./shared/worker-pool-core.js",
    "./shared/worker-pool.js",
    "./shared/zip.js",
    "./codec/scalar/airgapper_codec.js",
    "./codec/scalar/airgapper_codec.wasm",
    "./codec/airgapper_codec.js",
    "./codec/airgapper_codec.wasm",
    "./vendor/qrcode.js",
    "./vendor/raptorq/raptorq.js",
    "./vendor/raptorq/raptorq_bg.wasm"
  ];

  self.addEventListener("install", (event) => {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(PRECACHE.map(async (url) => {
        const response = await fetch(url, { cache: "reload" });
        if (!response.ok) throw new Error(`Precache failed ${response.status}: ${url}`);
        await cache.put(url, response);
      }));
      await self.skipWaiting();
    })());
  });

  self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== CACHE && key.startsWith("airgapper-")).map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })());
  });

  async function rangeResponse(request, response) {
    const range = request.headers.get("range");
    if (!range || !response) return response;
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return new Response(null, { status: 416 });
    const blob = await response.blob();
    let start = match[1] ? Number(match[1]) : void 0;
    let end = match[2] ? Number(match[2]) : void 0;
    if (start === void 0) {
      start = Math.max(0, blob.size - (end ?? 0));
      end = blob.size - 1;
    } else if (end === void 0 || end >= blob.size) end = blob.size - 1;
    if (start < 0 || start > end || start >= blob.size) return new Response(null, { status: 416 });
    const body = blob.slice(start, end + 1);
    const headers = new Headers(response.headers);
    headers.set("Content-Range", "bytes " + start + "-" + end + "/" + blob.size);
    headers.set("Content-Length", String(body.size));
    headers.set("Accept-Ranges", "bytes");
    return new Response(body, { status: 206, statusText: "Partial Content", headers });
  }

  self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    if (url.origin !== location.origin) return;
    if (url.pathname.includes("/received-media/")) {
      event.respondWith(caches.match(request, { ignoreSearch: true }).then((response) => rangeResponse(request, response)));
      return;
    }
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request, { cache: "no-store" });
        if (response.ok) cache.put(request, response.clone());
        return response;
      } catch {
        const cached = await cache.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === "navigate") return cache.match("./index.html");
        throw new Error("Offline and not cached");
      }
    })());
  });
})();
