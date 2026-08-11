# AirGrid optical tests

Run from the repository root:

```sh
node tests/airgrid-benchmark.mjs
```

Requirements:

- Node.js 22+
- Chrome, Chromium, or Edge (`CHROME_PATH` can override detection)
- Internet access while the app still loads its vendor scripts from the CDN

The benchmark has two layers:

1. **Current-profile synthetic channel** — renders a real sender frame, applies scale, blur, rotation, contrast loss, and screen-door/moire filters, then sends the image through the production worker. Clean frames must decode every visible tile; phone presets may lose at most one tile.
2. **Hardware-capture baseline** — confirms that ZXing can recover the bootstrap anchors and records the encoded profile. Legacy profile 2 fixtures document the broken pre-v34 geometry. Profile 3 diagnostic fixtures are also sent through the exact production worker and report page values, visible tiles, local fiducials, separate known-shape/color accuracy, CRC failures, and per-tile failure reasons.

The early profile 3 diagnostic fixtures reproduce the complete failure and remain the failing hardware baseline. `phone-profile3-v34d-frozen-a.webp` is the first positive white-field acceptance fixture and must retain at least 2/6 CRC-valid payload tiles. `phone-profile3-v34f-black-frozen-a.jpg` is the first black-field acceptance fixture; v34g recovers at least 6/7 visible tiles from it, compared with 5/7 before its cross-neighborhood retry. Neither frozen fixture proves continuous live reception or a completed transfer.

For a stable profile 3 diagnostic capture, use a sender showing **v34h**, start a transfer, and move **Page rate** to **Frozen** (zero). Keep the complete optical grid visible and capture the camera image used by the receiver rather than a screenshot of the sender.
