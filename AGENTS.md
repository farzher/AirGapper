# AGENTS.md

## Goal

Build AirGapper: a simple, fully offline screen-to-camera file and text transfer tool, primarily for an older Android receiver with no network connection.

## Architecture

- `app.html` is the only user-facing HTML source template.
- `npm run build` must produce the self-contained root `index.html`; it contains inline CSS, application JavaScript, decoder worker, and decoder WASM and must work from `file://`.
- The hosted PWA caches that same application artifact. Do not create separate hosted, sender, receiver, or standalone implementations.
- TypeScript is build-time source for strict protocol and hot-path checking; built HTML must never reference it.
- Animated standard QR codes may use one or multiple codes per frame.
- The shared wire format uses deterministic systematic fountain/Luby-style recovery.
- The worker-based decimen-codec/zxing-cpp receiver keeps tracked decode opportunistic and always falls back immediately to full acquisition after a tracked miss.
- Filename, MIME type, optional gzip, and SHA-256 live in the transfer container. Output is never offered before SHA-256 verification.

## Priorities

1. Complete verified transfer on the target old Android phone.
2. Sustained end-to-end unique-file KB/s on a fixed device pair.
3. Recovery under dropped, blurred, missing, duplicated, and reordered frames.
4. A compact warm-white single-page UI with Send, Receive, Back, and Download offline.
5. Benchmark-driven hot-path optimization without unsupported projections.

## Preserve

- Worker decoding, frame dropping instead of stale queues, tracked geometry, padded crop decoding, cached regions, periodic and degraded full-scan reacquisition, and immediate tracked-miss fallback.
- Efficient integer QR rasterization, valid pinned mask generation, multi-code layouts, and staggered cell updates.
- Deterministic fountain composition and pinned wire vectors.
- Hosted offline camera use through the PWA; mobile `file://` camera denial is browser policy and must be explained honestly.
- Root AGPL license verbatim; AirGapper modification notice/date; Decimen and Steve Dakh attribution; decimen-codec, zxing-cpp, and Emscripten notices; exact upstream commits and pinned corresponding source.

## Change rules

- Reproduce and protect the retained QR/fountain protocol before optimizing it.
- Do not add frameworks, page routers, duplicate HTML pages, custom optical symbols, color modulation, CDNs, analytics, remote fonts, or automatic network services.
- Keep settings and diagnostics collapsed and secondary. Keep the light UI free of dark themes, gradients, marketing copy, and decorative clutter.
- The root artifact must not depend on sibling scripts, stylesheets, workers, WASM, icons, or TypeScript. `Download offline` must save a complete working copy.
- Do not publish upstream, projected, or codec-only speed as an AirGapper measurement.
- Keep prose documentation to README.md, RETROSPECTIVE.md, UPSTREAM.md, AGENTS.md, and required legal files.
- Run `npm ci`, `npm test`, `npm run build`, `npm run build:standalone`, `npm run test:codec`, `npm run verify:build`, `npm run test:browser`, and `git diff --check`.
- After changes, commit and push.
