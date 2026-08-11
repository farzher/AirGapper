# AirGrid X1 format and stage gates

Status: **X1 acquisition/modulation laboratory, not a file-transfer profile**. The legacy Profile 3 implementation and fixtures remain only as historical channel evidence.

## Scope and invariants

AirGrid X1 is a tiled optical modem with no QR dependency. A tile is identified only from its four lattice fiducials and local protected header. Tiles from different display refreshes are accepted independently. No full camera-frame `getImageData()` is permitted in the X1 worker: it consumes a native `VideoFrame` when available (with an `ImageBitmap` fallback), creates a bounded detector image, then rasterizes only full-resolution tile ROIs.

The format constants are in `airgrid-x1.js`; the same production worker is used by `?airgridLab=1` and `tests/airgrid-next-benchmark.mjs`.

## Tile geometry

Coordinates below are channel chips. The marker centers form a `64 × 64` square. At the initial pitch of 3 display pixels/chip, marker-center distance is `192 × 192` display pixels.

| Region | Chip coordinates | Reserved chips | Purpose |
|---|---:|---:|---|
| Shared lattice marker | centered at every `(64n,64m)` | 49 equivalent/tile | 7×7 white ring with 3×3 black center; four quarters are shared |
| Protected header | x 8–55, y 7–14 | 384 | 48×8 binary chips |
| Calibration/timing band | x 8–61, y 16–21 | 324 | black, white, eight color references, asymmetric orientation marks |
| Payload | x 8–55, y 23–62 | 1,920 | 24×20 2×2 microblocks |
| Guard/unused | remainder | 1,419 | marker clearance and future detector/header improvements |

The renderer adds a four-chip outer margin so boundary fiducials are complete. Adjacent tiles share one physical marker at each lattice intersection. Header CRC and magic resolve all four rotations and mirror order; asymmetric timing marks provide an additional future tracking check.

Geometry, pitch, grid size, and modulation are configuration rather than receiver assumptions. The laboratory exposes pitches 2, 3, 4, 5, 6, and 8.

## Header

The information header is exactly 128 bits:

| Field | Bits |
|---|---:|
| Magic (`0xA7D1`) | 16 |
| X1 version | 4 |
| Modulation | 2 |
| ECC rate | 2 |
| Session ID | 32 |
| Tile-local frame/page ID | 24 |
| Tile X / Y | 6 + 6 |
| Grid width / height | 6 + 6 |
| Flags | 8 |
| CRC16-CCITT | 16 |
| **Total** | **128** |

In laboratory frames, flag bit 7 marks a sounder condition, bits 6–4 encode the pitch index (`2/3/4/5/6/8`), bits 3–1 encode the requested page-rate index (`Frozen/1/2/5/10/15/30`), and bit 0 is set. This lets an offline receiver aggregate an unsynchronized sender sweep without a network control channel.

The first 128 bits are padded to twelve 11-bit words. Each word uses binary BCH/Hamming `(15,11)` encoding. The 180 coded bits are repeated twice, spatially permuted with multiplier 137 modulo 360, and followed by 24 alternating timing chips. The decoder combines both copies as soft values, corrects each BCH word, then requires magic, bounds, version, and CRC16. This 384-chip product construction is intentionally much stronger than payload protection.

Fountain ESI is the deterministic 32-bit mix of session ID, 24-bit frame ID, and tile coordinates. It is not transmitted separately. A later production format must specify collision handling for transfers large enough to make a 32-bit ESI unsafe.

## Modulation

All profiles use calibrated RGB squared-distance hypotheses. For every legal 2×2 hypothesis, the decoder computes a metric. Per-bit LLR is `min(metric | bit=1) - min(metric | bit=0)`, so positive values favor zero. Hard symbols are retained only for sounder confusion statistics.

- **binary (sounder):** four independent black/white chips, 4 bits/block.
- **M1:** one active chip among four and one of four colors. Symbol `v` uses position `v & 3` and two color bits. Format version 1 mapped color labels directly to red/green/blue/yellow. Version 2 maps labels 0/1/2/3 to red/blue/yellow/green, minimizing Hamming cost under the first recorded phone confusion matrix; 4 bits/block and 25% occupancy.
- **M2:** two active positions and four colors. The deterministic 64-entry legal-hypothesis table carries 6 bits/block and has 50% occupancy.
- **M3 experimental:** two active positions and eight colors. The deterministic 256-entry table carries 8 bits/block and has 50% occupancy.

M3's committed palette exists only to sound the channel. It is not a production palette. Physical confusion matrices must justify every retained optical state.

Payload bits are spatially interleaved with `physical = logical × 301 mod N`. The multipliers are coprime to the current M1/M2/M3 code lengths.

## Inner ECC API and current code

The X1 worker has a flat typed-array codec path:

```text
encode(info bytes) -> interleaved code bits
demodulate(RGB samples, calibration) -> code-bit LLRs
decode(LLRs, rate, maxIterations) -> {info, syndrome, iterations, crcOk}
```

The implemented rate-1/2 code is a real sparse cyclic LDPC code with `H = [A | I]`; `A` is the XOR of four cyclic permutation matrices. Decoding uses normalized min-sum and CRC32. M1 has `N=1920`, `K=960`; M2 has `N=2880`, `K=1440`; M3 has `N=3840`, `K=1920`. The hot loop uses contiguous typed arrays rather than per-edge objects.

This matrix is suitable for validating soft-demodulator and worker interfaces, but it is not yet a production-selected QC-LDPC matrix: parity variables have degree one. Vetted QC matrices and encoders for rates 1/2, 2/3, and 3/4 are a required stage gate. The UI's 2/3 and 3/4 capacity values are estimates, not implemented decoders.

Every decoded information block ends in CRC32. At rate 1/2 the deterministic sounder bytes per tile are:

| Profile | Channel bits | Information bytes | CRC | Net laboratory bytes |
|---|---:|---:|---:|---:|
| binary | 1,920 | 120 | 4 | 116 |
| M1 | 1,920 | 120 | 4 | 116 |
| M2 | 2,880 | 180 | 4 | 176 |
| M3 experimental | 3,840 | 240 | 4 | 236 |

## Capacity budget

For M1 at rate 1/2:

- Payload modulation: 1,920 raw bits over 1,920 payload chips = 1.0 raw bit/payload chip.
- Whole tile: 1,920 / 4,096 = 0.469 raw bits/tile chip.
- After rate-1/2 LDPC and CRC: 928 useful bits/tile = 0.227 net bits/tile chip.
- Marker bounding allocation: 49 chips/tile equivalent (1.2%).
- Header: 384 chips (9.4%).
- Calibration/timing reserved band: 324 chips (7.9%).
- Payload: 1,920 chips (46.9%).
- Guard/future area: 1,419 chips (34.6%).
- Fountain and session metadata overhead: not yet included; file transport is intentionally disabled.

At 20 useful camera frames/s, 1 MiB/s requires 52,429 verified **unique** bytes/camera frame. At three pixels/chip, a 2560×1440 display fits at most roughly 13×7 complete marker-center tiles before safe margins. Even perfect synthetic decoding would therefore yield only about 10.3 KiB/frame for M1 or 21.0 KiB/frame for experimental M3 at rate 1/2. X1 does **not** currently meet the capacity gate. A 4K surface is only near the M3 arithmetic threshold before safe margins, detector loss, CRC loss, and fountain overhead.

## Receiver and tracking

1. Transfer a native `VideoFrame` to the X1 worker when available, otherwise an `ImageBitmap`.
2. Draw it directly to a detector canvas whose long side is at most 900 pixels.
3. Find neutral-white ring components with black centers.
4. Form and rank near-square marker quadrilaterals.
5. Try rotation/mirror orders and BCH/CRC-check headers directly on the detector raster.
6. Rasterize a full-resolution ROI only after its low-resolution local header passes.
7. Sample local calibration references with projective coordinates.
8. Score every legal modulation hypothesis and produce LLRs.
9. Deinterleave, min-sum decode, and CRC32-check.
10. Cache accepted normalized quadrilaterals and track them on following frames; reacquire after tracking failure.

Reported timing fields are capture, detector raster, fiducial detection, ROI raster, header, modulation, ECC, and total worker time. The JavaScript laboratory bounds each frame to 32 detector-header candidates and periodically rotates the candidate batch so dense fullscreen grids cover all screen positions without locking the phone on one frame. It reports both actually CRC-validated bytes and an explicitly labeled full-grid projection from the sampled tile success rate; only the former is measured work.

## Sounder metrics

`?airgridLab=1` renders deterministic session/frame/tile patterns at selectable pitch, binary/M1/M2/M3 profile, and Frozen/1/2/5/10/15/30 page FPS. The auto sender has a 12-condition alignment sweep (binary/M1, pitches 2/3/4, Frozen/5 FPS) with a two-second default dwell and a complete 168-condition sweep, holds each condition for a configurable dwell, uses a fullscreen physical-pixel grid, and alternates two pre-rendered pages on `requestAnimationFrame` boundaries. The receiver can record a high-bitrate 40-second quick test while decoding; `tests/airgrid-video-benchmark.mjs` replays sampled frames through the exact current worker and extracts representative PNG stills for repeatable decoder iteration. Receiver mode uses the camera and reports:

- fiducials, quadrilateral candidates, complete/header-valid/payload-valid tiles;
- symbol confusion, occupancy and color error;
- raw BER and mutual information per block/chip;
- CRC-valid sampled channel bytes/frame, unique validated symbol IDs, projected full-grid bytes/frame, and estimated bytes/frame by ECC rate;
- tile-local frame IDs and measured mixed-transition-frame rate;
- camera capture, worker utilization, and worker stage timings.

Screen position is represented by tile coordinates in every result. Results are aggregated by the condition encoded in each protected header, periodically persisted in local storage, and exportable as detailed JSON or summary CSV. The receiver should start before the independent sender sweep; it latches the last valid condition to account for acquisition failures. Exposure telemetry is limited to fields made available by `MediaStreamTrack.getSettings()`.

## Stage gates

1. **Synthetic acquisition (implemented):** deterministic full frames, arbitrary one-tile crops, multiple-tile crops, transforms, mirror/rotation, channel perturbations, corruption rejection, mixed frame IDs, ECC/fountain self-tests, and false-positive rejection use the production X1 worker.
2. **Phone acquisition:** each target phone must acquire complete crop-local tiles at every tested screen region. Record pitch/exposure/focus and detector/ROI timings.
3. **Channel selection:** confusion and mutual information measurements choose pitch, palette, modulation, and page hold. No palette is selected by appearance.
4. **ECC selection:** replace the laboratory matrix with vetted QC-LDPC matrices at the measured channel operating point and validate WASM/SIMD implementation.
5. **Capacity:** demonstrate at least 52 KiB verified unique payload/camera frame at 20 useful FPS after all marker, header, CRC, ECC, and fountain overhead, or revise the 1 MiB/s target.
6. **Transport:** only after the prior gates, specify and implement a Wirehair/Raptor-class systematic fountain and file/session transport.

## Not yet verified

Seven physical quick-sweep reports are committed, and v35l adds the first original camera video. The v35b baseline established a 1.69 useful FPS / 95.5% worker-utilization bottleneck caused primarily by full-resolution rasterization of false candidate ROIs. The fresh export identifies v35e (the cache-busted equivalent of the requested v35d worker), has a new start time, and contains no persisted v35b counters. Detector-raster header rejection cut weighted average ROI time from 602 ms to 1.22 ms and raised useful FPS to 3.86, but fiducial detection became the 169 ms average bottleneck. Only 3/24 conditions were observed, 7/394 attributed scans acquired tiles, weighted BER was 26.4%, and 1/24 complete tiles passed payload CRC. Its best full-grid projection was only 43.14 B/frame, not unique file throughput. v35f replaces the allocation-heavy component flood fill and exhaustive fourth-corner search with a reused typed-array component pass, exposure-adaptive white threshold, and spatially indexed candidate formation. It also retries detector-header sample phase, averages payload samples projectively, and compares calibrated color direction independently of dot intensity. Normal and dim synthetic camera-scale subpixel resampling pass all 6/6 tiles. The v35f sweep raised useful FPS to 7.19, cut average fiducial work to 22.8 ms, identified 13/24 conditions, and recovered 436 complete tiles across 48 coordinates, but weighted total time remained 112 ms and every payload failed CRC at 31.5% BER. v35h replaces large calibration bars with isolated one-chip references that match payload-dot optics and changes the short alignment sweep to binary/M1. The fresh v35h report validated 52/117 payloads at 24 coordinates; M1 improved from 27.4% to 8.5% BER and passed 49/64 tiles, while binary's dense white occupancy produced 22.3% BER and only 3/53 valid tiles. Useful FPS remained 7.51, with detector raster plus marker/header work averaging 89.8 ms and 27.4 of the 32 allowed candidates tested per scan. v35i spatially bounds both marker-neighbor and fourth-corner searches and checks the known alternating header timing chips before full BCH/CRC sampling. The fresh v35i report raised useful FPS from 7.51 to 9.14 and cut average header work from 22.4 to 5.6 ms, but total worker time remained 85.0 ms and detector rasterization alone remained 46.6 ms. It acquired 9/174 attributed scans; 28/48 M1 tiles passed CRC, while binary passed 0/63. v35j alternates 900/768/640 detector rasters in one receiver run and exports per-size timing/acquisition/channel aggregates. Its 900/768/640 paths averaged 85.8/65.7/52.8 ms total, but acquisition fell from 5.7% to 2.9% to 1.9%, and 640 produced no CRC-valid payload. v35k fixes the 768-pixel detector and uses `MediaStreamTrackProcessor` plus native I420/NV12 plane copies to bypass the Canvas detector raster, with explicit Canvas fallback telemetry. v35l adds recorded phone capture and exact-worker replay so the same physical video can drive many decoder changes. Its first report measures an 11.2 ms native detector raster and 50.5 ms total worker time, versus v35j's 38.5 and 65.8 ms Canvas-768 measurements. v35m uses that immutable recording to reject non-ring components above a measured 0.4 marker shape-quality score; at five replay samples/s it raises observed conditions from 3 to 7, complete tiles from 9 to 73, CRC-valid tiles from 4 to 18, and halves desktop fiducial time. Format version 2 also remaps M1 color labels to reduce projected hard color-bit error from 22.46% to 15.24%; the worker remains able to replay version-1 captures. A fresh recorded v35m run is required to validate the version-2 color map and marker filter; because recording alters the live path, final speed acceptance still requires an unrecorded run. X1's spatial budget still guarantees that a denser format will eventually be needed for the capacity gate. Palette separability across all states, blur/moire tolerance, rolling-shutter behavior, exposure stability, 20 useful FPS, complete CRC-valid screen-position coverage, and post-ECC unique throughput remain unverified. Synthetic results, the recorded replay, and all seven phone diagnostics are regression evidence, not channel-capacity evidence.
