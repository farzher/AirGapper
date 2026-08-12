# Upstream baseline

AirGapper was reset to the Decimen animated-QR baseline on **2026-08-11**.

## Pinned projects

- Decimen Optical Transfer: <https://github.com/bashalarmistalt/decimen-optical-transfer>
  - commit `c5d20f6bd8690b827d8551283d67d1aab5ae89af`
- decimen-codec: <https://github.com/bashalarmistalt/decimen-codec>
  - source submodule commit `aa89be22977b031a1f1f49502e015368dbbbb148`
  - zxing-cpp submodule commit `3e09874a9ca7c191d67101f302a1f53c71a118cc`
  - zint transitive submodule commit `55541e139e62b9209b71cd9b0ba9010cec28b1d9`
  - Emscripten SDK `6.0.6`, pinned by `vendor/decimen-codec-source/build.sh`

The vendored codec binaries came from the Decimen Optical Transfer reference tree. Their embedded build ID is `7e8acd7`, the codec v0.1.0 release commit and an ancestor of the pinned reference commit; there are no codec source/build changes between those commits. AirGapper pins the requested later commit so workflow and provenance metadata are retained too.

Vendored artifact SHA-256 values:

```text
020dee3aed2aa94b21fe5863850e9cb949416192672cda137153aa881ff81584  decimen_codec.js
2ab524373b8aefcd0642cd7f90fc974b8a571129b5f2b13d125371840ecaabfd  decimen_codec.wasm
```

## Reproduce and verify the codec

```bash
git submodule update --init --recursive
npm run test:codec            # codec npm ci, tracked/full parity and drift benchmark
npm run build:codec           # builds from pinned zxing-cpp with pinned Emscripten
```

A rebuilt codec is written to `vendor/decimen-codec-source/dist/`. Review the parity benchmark, then deliberately copy `decimen_codec.js` and `decimen_codec.wasm` into `vendor/decimen-codec/`; do not replace audited artifacts silently.

## Adaptation scope

AirGapper retains the animated multi-QR sender, systematic fountain carousel, worker-based zxing-cpp decoding, tracked decode with full-acquisition fallback, metadata container, SHA-256 verification, camera fallbacks, PWA, standalone builds, and complete-transfer diagnostics. It removes Decimen screenshots, demo payloads, benchmark records, speed claims, donation UI, and marketing assets. Defaults are reduced for older Android hardware. No upstream throughput number is presented as an AirGapper measurement.

## Licensing

The application and decimen-codec are AGPL-3.0-or-later. Decimen copyright and contributor attribution are preserved in `NOTICE`. zxing-cpp remains Apache-2.0 with its verbatim license in `vendor/decimen-codec/LICENSE.zxing-cpp`; its complete pinned source is in the codec submodule. Emscripten-generated runtime output is MIT-licensed as described in the notices. Production builds emit the legal files, and standalone files carry attribution, modification date, no-warranty, license, and source notices in their HTML and artifact banners.
