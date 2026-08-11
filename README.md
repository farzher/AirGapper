# AirGapper

AirGapper is a light, one-page application for transferring a file or text from a screen to a camera with animated standard QR codes. It uses a systematic fountain carousel to tolerate missed, duplicate, and reordered frames. Filename and MIME metadata are preserved, useful payloads may be gzip-compressed, and no recovered output is offered until SHA-256 verification succeeds.

> **Security warning:** offline transport is not encryption. Any camera that can see the sending screen can read the transfer.

## Offline use

The checked-in [`index.html`](index.html) is the complete application. Open it directly, choose **Send** or **Receive**, and use **Download offline** to save another complete `airgapper.html` copy. CSS, QR generation, the decoder worker, decimen-codec, and its WASM are embedded; opening the file makes no automatic network request.

Desktop browsers may permit camera capture from `file://`. Android Chrome and iOS Safari commonly deny it because a local file is not a secure origin; HTML cannot override that policy. For a phone receiver, use the hosted HTTPS application once and install it as a PWA. Its service worker caches the same self-contained application and decoder, so it continues to receive with the camera after the phone goes offline.

The small Legal / Source footer remains available in hosted and downloaded copies. Production has no CDN, analytics, remote font, external API, or other runtime service.

## Source and build

TypeScript is retained for the protocol, binary container, camera pipeline, and worker boundaries because strict checking protects wire compatibility and typed-array handling. It is build-time source only: no `.ts`, sibling script, stylesheet, worker, or WASM reference appears in `index.html`.

- `app.html` is the only HTML source template.
- `app/main.ts` owns in-page navigation and offline download.
- `send/main.ts` and `receive/main.ts` contain the performance-sensitive sender and receiver.
- `shared/` contains the one protocol/fountain implementation used by both.
- `vite.config.ts` creates one inline artifact, the PWA support files, and legal assets.
- Every `npm run build` deterministically replaces the root `index.html`, so an ordinary build cannot leave it stale.

Requires Node.js and npm:

```bash
git submodule update --init --recursive
npm ci
npm test
npm run build              # dist/ PWA and checked-in root index.html
npm run build:standalone   # also writes dist-standalone/airgapper.html
npm run test:codec
npm run verify:build
npm run test:browser       # headless Chrome file:// and downloaded-copy smoke test
```

For development, `npm run dev` opens the source template on local HTTPS. `npm run diagnostics` enables local complete-transfer reports for measured, verified unique-file KB/s. The codec build is reproducible from pinned corresponding source with `npm run build:codec`; see [UPSTREAM.md](UPSTREAM.md).

## Technical behavior

The sender emits one or more ordinary QR codes per displayed frame. Frames use deterministic systematic fountain composition, and multi-code cells update on staggered phases. QR rasterization uses integer module geometry and a pinned valid mask to avoid repeated mask evaluation.

The receiver drops captures instead of building stale worker queues. It acquires full frames, tracks decoded geometry, submits padded crops in parallel workers, and tries the decimen-codec tracked sampling path. Every tracked miss immediately falls back to full QR acquisition on the same crop; periodic full-frame scans reacquire lost or missing codes. Final goodput is reported only as unique original-file KB/s through SHA-256 verification.

Automated protocol, loss/reordering, integrity, artifact, browser, and codec parity checks are available. AirGapper has not yet recorded an independent target-hardware throughput result. The next hardware gate remains a complete verified transfer on the older Android receiver, followed by sustained end-to-end measurements on a fixed device pair.

## License and attribution

AirGapper is a modified version of [Decimen Optical Transfer](https://github.com/bashalarmistalt/decimen-optical-transfer), modified 2026-08-11. It is licensed **AGPL-3.0-or-later** and distributed without warranty. See [LICENSE](LICENSE), [NOTICE](NOTICE), [UPSTREAM.md](UPSTREAM.md), and the pinned corresponding source under `vendor/decimen-codec-source`. Corresponding AirGapper source is at <https://github.com/farzher/AirGapper>.

The decoder is [decimen-codec](https://github.com/bashalarmistalt/decimen-codec), incorporating zxing-cpp under Apache-2.0 and Emscripten runtime output under MIT terms. Required notices and the verbatim zxing-cpp license remain under `vendor/decimen-codec/` and are copied into hosted builds.
