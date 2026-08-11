# AirGapper

AirGapper transfers a file or text from a screen to a camera with animated QR codes. It uses fountain coding to recover from missed frames, preserves filename and MIME type, and offers output only after SHA-256 verification. The sender and receiver run fully offline.

> **Security warning:** offline transport is not encryption. Any camera that can see the sending screen can read the transfer.

## Develop, test, and build

Requires Node.js and npm.

```bash
npm ci
git submodule update --init --recursive
npm test
npm run test:codec
npm run dev                 # local HTTPS server for camera access
npm run diagnostics         # local run reports with verified unique-file KB/s
npm run build               # offline-capable PWA in dist/
npm run build:standalone    # self-contained sender and receiver HTML
```

The codec build is reproducible from its pinned source and toolchain; see [UPSTREAM.md](UPSTREAM.md). `npm run build:codec` downloads pinned Emscripten 6.0.6 on first use.

## Offline use

- **PWA:** serve `dist/` over HTTPS, visit once, and the service worker precaches the application and decoder. No CDN is used.
- **Standalone sender:** `dist-standalone/airgapper-sender.html` works directly from local storage.
- **Standalone receiver:** self-contained, but mobile browsers generally deny camera access to `file://` pages. Serve it from a local HTTPS origin or use the installed PWA. Camera capture has a requestAnimationFrame fallback where `requestVideoFrameCallback` is unavailable.

## Status

Automated protocol, loss/reordering, integrity, build, and codec parity tests pass in CI-compatible environments. AirGapper has not yet recorded independent hardware throughput. The next gate is a complete verified transfer on the target older Android phone, followed by sustained end-to-end unique-file KB/s measurements on the same device pair.

## License and attribution

AirGapper is a modified version of [Decimen Optical Transfer](https://github.com/bashalarmistalt/decimen-optical-transfer), modified 2026-08-11. It is licensed **AGPL-3.0-or-later** and distributed without warranty. See [LICENSE](LICENSE), [NOTICE](NOTICE), and [UPSTREAM.md](UPSTREAM.md). Corresponding source is at <https://github.com/farzher/AirGapper>.

The QR decoder is [decimen-codec](https://github.com/bashalarmistalt/decimen-codec), which incorporates zxing-cpp under Apache-2.0 and Emscripten runtime output under MIT terms. Their source and notices are retained under `vendor/`.
