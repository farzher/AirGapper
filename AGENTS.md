# AGENTS.md

## Goal

Build AirGapper: a simple, fully offline screen-to-camera file and text transfer tool, primarily for an older Android receiver with no network connection.

## Architecture

- Animated standard QR codes; one or multiple codes per displayed frame.
- Systematic fountain/Luby-style coding for loss and reordering tolerance.
- Worker-based decimen-codec/zxing-cpp receiver.
- Tracked QR decode is opportunistic and must always fall back to full acquisition.
- Filename, MIME type, optional gzip, and SHA-256 live in the transfer container.
- Output must never be offered before SHA-256 verification.
- Hosted PWA and self-contained sender/receiver builds must run without CDN or runtime network dependencies.

## Priorities

1. Complete verified transfer on the target old Android phone.
2. Sustained end-to-end unique-file KB/s on a fixed device pair.
3. Recovery under dropped, blurred, missing, and reordered frames.
4. Minimal UI and conservative old-phone defaults.
5. Benchmark-driven hot-path optimization without unsupported projections.

## Change rules

- Reproduce and protect the retained QR/fountain protocol before optimizing it.
- Do not introduce custom optical symbols or color modulation.
- Keep required AGPL, Decimen, zxing-cpp, and Emscripten attribution in source and builds.
- Do not publish upstream or projected performance as an AirGapper measurement.
- Run `npm ci`, `npm test`, `npm run build`, `npm run build:standalone`, `npm run test:codec`, and `git diff --check`.
- After changes, commit and push.
