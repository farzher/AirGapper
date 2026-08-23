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
    "./receive/agcap.js",
    "./receive/auto-phase.js",
    "./receive/auto-phase-policy.js",
    "./receive/optics-guard.js",
    "./receive/focus-controller.js",
    "./receive/grid-lattice.js",
    "./receive/main.js",
    "./receive/performance-policy.js",
    "./receive/phase-nudge.js",
    "./receive/qr-optics.js",
    "./receive/temporal-soft-grid.js",
    "./receive/worker.js",
    "./receive/worker-reconstruct.js",
    "./receive/worker-temporal-generalized.js",
    "./send/main.js",
    "./send/render-worker.js",
    "./shared/android.js",
    "./shared/camera-start-guard.js",
    "./shared/native-camera.js",
    "./shared/native-camera-v2.js",
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
    "./shared/receiver-recovery-policy.js",
    "./shared/receiver-recovery-state.js",
    "./shared/snippet.js",
    "./shared/status-line.js",
    "./shared/style.css",
    "./shared/transport.js",
    "./shared/wake-lock.js",
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
    event.waitUntil(caches.open(CACHE).then(async (cache) => {
      await Promise.all(PRECACHE.map(async (url) => {
        const response = await fetch(url, { cache: "reload" });
        if (!response.ok) throw new Error(`Precache failed ${response.status}: ${url}`);
        await cache.put(url, response);
      }));
    }));
  });
  self.addEventListener("activate", (event) => {
    event.waitUntil(caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE && key.startsWith("airgapper-")).map((key) => caches.delete(key))
    )));
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
