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
2. **Hardware-capture baseline** — confirms that ZXing can recover all four bootstrap anchors from each supplied phone photograph and records the encoded profile. The current fixtures are intentionally marked as profile 2: they document the broken pre-v34 geometry and are not acceptance captures for profile 3.

The fixture presets are only a first approximation of the two supplied phones. Once profile 3 is captured on hardware, add those images as the first payload-decoding acceptance fixtures and tune the synthetic filter against them.

For a stable profile 3 diagnostic capture, use a sender showing **v34b**, start a transfer, and move **Page rate** to **Frozen** (zero). Keep the complete optical grid visible and capture the camera image used by the receiver rather than a screenshot of the sender.
