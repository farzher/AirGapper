(() => {
  const CACHE = "airgapper-static-js-v351";
  const PRECACHE = [
    "./main.js",
    "./icon-192.png",
    "./icon-512-maskable.png",
    "./icon-512.png",
    "./index.html",
    "./manifest.webmanifest",
    "./send/main.js",
    "./receive/main.js",
    "./receive/worker.js",
    "./receive/focus-controller.js",
    "./receive/grid-lattice.js",
    "./receive/qr-optics.js",
    "./receive/agcap.js",
    "./shared/android.js",
    "./shared/coding-mode.js",
    "./shared/format.js",
    "./shared/native-camera.js",
    "./shared/plain-qr-policy.js",
    "./shared/platform.js",
    "./shared/progress.js",
    "./shared/protocol.js",
    "./shared/raptorq.js",
    "./shared/snippet.js",
    "./shared/status-line.js",
    "./shared/style.css",
    "./shared/transport.js",
    "./shared/wake-lock.js",
    "./shared/worker-pool.js",
    "./shared/zip.js",
    "./vendor/qrcode.js",
    "./vendor/raptorq/raptorq.js",
    "./vendor/raptorq/raptorq_bg.wasm",
    "./codec/airgapper_codec.js",
    "./codec/airgapper_codec.wasm",
    "./codec/scalar/airgapper_codec.js",
    "./codec/scalar/airgapper_codec.wasm"
  ];

  self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
    self.skipWaiting();
  });

  self.addEventListener("activate", (event) => {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
    self.clients.claim();
  });

  self.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET") return;
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
  });
})();
