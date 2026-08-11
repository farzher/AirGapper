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

The profile 3 diagnostic fixtures reproduce the current failure but are not acceptance fixtures: none contains a CRC-valid payload tile. Keep them as the failing hardware baseline. Once a reliability fix works on hardware, add its captures as acceptance fixtures and tune the synthetic filter against them.

For a stable profile 3 diagnostic capture, use a sender showing **v34d**, start a transfer, and move **Page rate** to **Frozen** (zero). Keep the complete optical grid visible and capture the camera image used by the receiver rather than a screenshot of the sender.
