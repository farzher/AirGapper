# AirGrid optical tests

Run from the repository root:

```sh
node tests/airgrid-benchmark.mjs
node tests/airgrid-next-benchmark.mjs
```

Requirements:

- Node.js 22+
- Chrome, Chromium, or Edge (`CHROME_PATH` can override detection)
- Internet access while the app still loads its vendor scripts from the CDN

`airgrid-benchmark.mjs` preserves the frozen Profile 3 evidence and has two layers:

1. **Current-profile synthetic channel** — renders a real sender frame, applies scale, blur, rotation, contrast loss, and screen-door/moire filters, exercises both landscape and portrait camera frames, then sends the image through the production worker. Clean frames must decode every visible tile; phone presets may lose at most one tile.
2. **Hardware-capture baseline** — confirms that ZXing can recover the bootstrap anchors and records the encoded profile. Legacy profile 2 fixtures document the broken pre-v34 geometry. Profile 3 diagnostic fixtures are also sent through the exact production worker and report page values, visible tiles, local fiducials, separate known-shape/color accuracy, CRC failures, and per-tile failure reasons.

The early profile 3 diagnostic fixtures reproduce the complete failure and remain the failing hardware baseline. `phone-profile3-v34d-frozen-a.webp` is the first positive white-field acceptance fixture and must retain at least 2/6 CRC-valid payload tiles. `phone-profile3-v34f-black-frozen-a.jpg` is the first black-field acceptance fixture; v34g recovers at least 6/7 visible tiles from it, compared with 5/7 before its cross-neighborhood retry. Neither frozen fixture proves continuous live reception or a completed transfer.

For a stable profile 3 diagnostic capture, use a sender showing **v34i**, start a transfer, and move **Page rate** to **Frozen** (zero). Keep the complete optical grid visible and capture the camera image used by the receiver rather than a screenshot of the sender.

## AirGrid X1 benchmark

`airgrid-next-benchmark.mjs` is deterministic, uses no QR library, and exercises the exact worker source created by `airgrid-x1.js`. It covers full grids, arbitrary one- and multiple-tile crops, perspective, rotation, mirror, blur, moiré, exposure/white-balance/channel mixing, mixed frame IDs, header and payload corruption, false positives, clean binary/M1/M2/M3 modulation, persistent tracking, bounded detector rasters, direct native-I420 detector input, BCH header recovery, soft LDPC reconstruction, and fountain reconstruction.

The benchmark's BER, mutual information, verified bytes, and stage timings are synthetic regression measurements. They are not evidence of physical screen/camera capacity. Use `?airgridLab=1` for X1 sender/receiver hardware sounding; retain captures and exported measurements before selecting a production pitch or palette.

See [`HARDWARE_TESTING.md`](HARDWARE_TESTING.md) for the automated quick/full sweep procedure, recorded 40-second phone capture, JSON/CSV exports, offline video replay benchmark, fixed-device controls, and acceptance gates.

`fixtures/airgrid-x1/phone-v35b-quick-a.json` is the first physical X1 report. It identified full-resolution false-candidate ROI reads as the dominant 455–798 ms/frame bottleneck; v35c rejects headers on the detector raster first, so the report is retained as a diagnostic baseline rather than an acceptance result.

`fixtures/airgrid-x1/phone-v35e-quick-a.json` is the fresh post-prefilter phone export. It is v35e rather than the requested v35d because the intervening build cache-busted the same worker. The sanitized fixture confirms that ROI prefiltering worked, but acquisition remains slow and unreliable.

`fixtures/airgrid-x1/phone-v35f-quick-a.json` measures the optimized acquisition worker. It is substantially faster and finds many more complete tiles, but no color payload passes CRC.

`fixtures/airgrid-x1/phone-v35h-quick-a.json` validates matched-scale M1 calibration on the phone: 49/64 M1 tiles pass CRC, but the receiver remains limited to 7.51 useful FPS and binary exposes a separate dense-occupancy blur failure.

`fixtures/airgrid-x1/phone-v35i-quick-a.json` validates timing-chip candidate rejection: header time falls to 5.6 ms and useful FPS reaches 9.14, exposing the unchanged 46.6 ms detector raster as the dominant stage.

`fixtures/airgrid-x1/phone-v35j-quick-a.json` compares 900/768/640 detector rasters in one phone run. Lower resolutions are faster, but 640 loses the channel completely and 768 remains above the worker-time gate, motivating the v35k direct native-YUV path. v35l adds a high-bitrate recorded quick test and `airgrid-video-benchmark.mjs`, so one physical capture can be replayed against many decoder and format changes. See [`fixtures/airgrid-x1/README.md`](fixtures/airgrid-x1/README.md) for the report comparisons and evidence-driven next steps.
