# AirGrid engineering plan

## AirGrid X1 milestone (current)

Profile 3 is frozen as failed historical channel evidence. The former instruction to gate protocol work on more Profile 3 phone tests is obsolete. v35k includes the QR-free AirGrid X1 acquisition/modulation laboratory and automated hardware sweep/export workflow in `airgrid-x1.js`, the precise format and capacity gates in `AIRGRID_NEXT.md`, and a separate deterministic production-worker benchmark. X1 has no file-transfer path and makes no physical capacity claim.

The X1 worker detects a shared ring-fiducial lattice on a bounded detector raster, reads only full-resolution candidate tile ROIs, BCH/CRC-checks a 128-bit local header, scores binary/M1/M2/M3 block hypotheses into soft bit values, and runs a typed-array cyclic LDPC/CRC payload check. `?airgridLab=1` exposes deterministic pitch/profile/page-rate patterns and live camera metrics.

The first v35b phone quick-sweep report is committed at `tests/fixtures/airgrid-x1/phone-v35b-quick-a.json`. The 30 FPS 1080×1920 camera produced only 1.69 useful worker FPS at 95.5% utilization. Full-resolution ROI rasterization of false header candidates dominated at roughly 455–798 ms/frame. M1 pitch 4 was the only repeatably positive condition: Frozen validated 8/8 acquired payload tiles at 7.4% raw BER, while 5 FPS validated 11/11 at 9.5% raw BER, but acquisition was only 57% and 28%. Pitch 3 was poor and 18/24 quick-sweep conditions were never acquired. v35c and later therefore BCH/CRC-prefilter headers on the detector raster before any full-resolution ROI read.

The fresh post-prefilter export is committed as `tests/fixtures/airgrid-x1/phone-v35e-quick-a.json`; the supplied export identifies v35e rather than the requested v35d because v35e cache-busted the otherwise unchanged lab worker. It has a new start time and no accumulated v35b counters. The prefilter reduced weighted average ROI raster time from 602 ms to 1.22 ms, total worker time from 696 ms to 229 ms, and raised useful FPS from 1.69 to 3.86 while utilization fell from 95.5% to 89.4%. Acquisition and channel results regressed: only 3/24 conditions appeared, 7/394 attributed scans acquired tiles, weighted BER was 26.4%, and only 1/24 complete tiles passed payload CRC. Fiducial detection is now the dominant stage at 169 ms average with a 782 ms maximum.

QR looked much better because ZXing is a mature optimized detector: it uses distinctive nested finder topology, adaptive binarization, run-length checks, geometric refinement, and optimized WASM over large binary modules. X1 v35e instead scanned neutral-white connected components in JavaScript, repeatedly queued the same pixels, combined marker candidates nearly exhaustively, sampled detector headers at one phase, and compared tiny one-chip colors directly with much larger bright calibration bars. The phone report exposed those implementation defects; it did not show an inherent advantage for QR at equal optical density.

v35f attacks that measured bottleneck rather than changing tile density. Marker components now use reused typed buffers, an exposure-adaptive neutral-white threshold, and mark pixels when queued, eliminating the old duplicate flood-fill work. Ring/center contrast rejects header fragments, candidate quadrilaterals use bounded neighbors and a spatial index instead of an exhaustive fourth-corner scan, and BCH/CRC header decoding retries small sampling phases before rejecting a candidate. Full-resolution payload samples use a five-point projective neighborhood, marker refinement is accepted only when the known protected header fits better, and active colors are compared by calibrated color direction so a one-chip dot is not rejected merely because it is dimmer than the large reference bar. Normal and dim camera-scale subpixel resampling regressions now require all 6/6 tiles to pass payload CRC. These are synthetic and algorithmic improvements. v35g keeps the v35f acquisition worker but reduces the alignment sweep from 24 conditions × 4 seconds to 12 conditions × 2 seconds. The expected on-screen dwell drops from 96 to 24 seconds; the 168-condition acceptance sweep is unchanged.

The fresh v35f phone report is committed as `tests/fixtures/airgrid-x1/phone-v35f-quick-a.json`. Useful FPS rose from v35e's 3.86 to 7.19, worker utilization fell from 89.4% to 79.3%, weighted fiducial time fell from 169 ms to 22.8 ms, 13/24 conditions were identified, and 436 complete tiles covered 48 coordinates. Acquisition is materially better, although the detector raster plus marker/header stages still average 96 ms. Payload parsing failed completely: 0/436 tiles passed CRC and weighted BER was 31.5%. M1 preserved dot position but systematically collapsed red, green, and blue toward the yellow/green hypotheses because its one-chip payload dots did not resemble the large bright calibration bars after camera demosaicing and black-field mixing.

v35h replaces every large color/white calibration bar with two isolated one-chip probes and samples those probes with the same projective neighborhood as payload chips. The 24-second alignment sweep now compares binary against M1 rather than M1 against the already worse M2, separating geometric/brightness decoding from color decoding.

The fresh v35h report is committed as `tests/fixtures/airgrid-x1/phone-v35h-quick-a.json`. Matched-scale calibration worked: 49/64 M1 tiles passed CRC, M1 BER fell from v35f's 27.4% to 8.5%, and exact M1 symbols rose from 32.6% to 77.7% while dot-position accuracy remained about 97%. Binary was worse at 22.3% BER and 3/53 CRC-valid tiles because blur from dense white occupancy turned black chips into white false positives; this is profile-specific rather than a global projective-sampling failure. Across both profiles, 52/117 tiles passed CRC at 24 screen positions. Useful FPS remained only 7.51: detector raster, fiducial/candidate work, and detector-header testing still averaged 46.5, 20.9, and 22.4 ms, respectively, with 277 markers, 370 quadrilaterals, and 27.4 tested header candidates per attributed scan.

v35i therefore leaves full-resolution payload decoding and BCH/CRC rejection unchanged. It uses the existing marker spatial index for both neighbor and fourth-corner searches, prefilters candidate orientation/phases with the header's 24 known alternating timing chips before sampling all 384 protected chips, and removes a redundant detector clear. Deterministic dense-grid and corrupted-header regressions cover the bounded neighbor search and early rejection.

The fresh v35i report is committed as `tests/fixtures/airgrid-x1/phone-v35i-quick-a.json`. The timing prefilter worked: average header time fell from 22.4 to 5.6 ms, total worker time fell from 101.8 to 85.0 ms, and useful FPS rose from 7.51 to 9.14. It still tested 29.3 candidates per attributed scan, but only 11.8% of timing-checked phases reached full BCH/CRC sampling. Detector rasterization did not improve and now dominates at 46.6 ms, followed by 18.2 ms of marker/candidate work. Acquisition remained poor at 9/174 attributed scans; 28/48 M1 tiles passed CRC at 19 positions, while binary again passed none. This clears header sampling as the next bottleneck and does not meet the 20 FPS gate.

v35j turns the next phone run into one detector-raster experiment instead of another fixed pipeline release. The receiver alternates 900, 768, and 640 detector long sides and exports complete per-size acquisition, channel, candidate, and timing aggregates while retaining the ordinary condition report.

The fresh v35j report is committed as `tests/fixtures/airgrid-x1/phone-v35j-quick-a.json`. At 900/768/640 pixels, detector raster time was 48.1/38.5/34.4 ms and total worker time was 85.8/65.7/52.8 ms. The 768 raster retained 14 CRC-valid tiles and slightly better BER while saving 20.1 ms total, but acquisition fell from 5.7% to 2.9%. The 640 raster approached the 50 ms target but recovered only seven tiles and no valid payload. No Canvas raster size met both speed and acquisition requirements. Across the mixed run, useful FPS rose to 10.19, M1 retained 27/44 CRC-valid tiles at 10.6% BER, and acquisition remained only 11/187 attributed scans.

v35k therefore fixes the detector at the better 768-pixel compromise and bypasses the Canvas detector raster when the browser exposes native camera frames. A `MediaStreamTrackProcessor` transfers `VideoFrame` objects to the worker; the worker copies native I420/NV12 planes, downsamples and converts only the detector pixels, and retains the same frame for full-resolution crop-local color ROIs. Unsupported formats fall back explicitly to Canvas and are reported by pipeline/format. A deterministic I420 pitch-2 dense-grid regression requires at least 20 complete and 15 CRC-valid tiles without fallback. This is the planned capture-path architecture test, not a physical speed claim. X1 remains spatially incapable of the capacity gate, so a denser X2 will still be required after acquisition supplies a stable physical channel baseline.

## Historical Profile 3 state

Profile 3 is a recovery profile. It fixes the demonstrated profile 2 failure by giving each payload tile four local registration marks and sampling larger 3×3 logical dots. It still uses one large QR bootstrap cell for every three payload cells. v34c displays the unchanged logical cells at 1.5× physical scale to reduce screen/camera density without changing the profile 3 packet format. v34d keeps that optical format, uses a dark application theme, and guarantees a small centered safe inset around complete AirGrid groups. v34e samples five points inside each logical dot instead of relying on one camera pixel. v34f switches the sender to a black optical field with white QR/fiducials and bright payload colors; the receiver detects polarity per group so committed white-field captures remain decodable. v34g reduces physical scale to 1.3× so a 2560×1440 optical surface fits two complete group rows, and retries CRC-failed black-field tiles with a tighter cross-shaped five-point neighborhood. v34h makes the complete receiver diagnostics panel scrollable so live throughput losses can be separated into acquisition, payload, duplicate-page, and worker bottlenecks. v34i caps the QR detector by the camera frame's long side: the measured 1080×1920 portrait feed now uses a 540×960 detector instead of 960×1707, and diagnostics report canvas, QR, and payload stage times separately.

The two initial phone captures in `tests/fixtures/` are profile 2 captures, not profile 3. Their QR anchors decode cleanly, but their payload geometry does not. A hard refresh or downloaded offline copy showing **v34i** was required for the historical Profile 3 hardware test. Current X1 hardware laboratory builds show **v35k**.

A real-phone test at 1 page per second remained unusable, so sender page rate is not the primary failure. v34b adds a zero-rate frozen-page diagnostic for obtaining stable profile 3 captures.

The first three profile 3 camera fixtures now reproduce the hardware failure in the production worker. The true frozen capture has 8/8 current bootstraps, one consistent page, 24 visible tiles, and four local fiducials per visible tile, but 0/24 CRC-valid tiles. Known-glyph accuracy is 92.4% for shape and 65.1% for color at the production 1920-pixel worker width. Native-width decoding raises shape accuracy to 97.1% but still produces 0/24 valid tiles. Acquisition, page identity, temporal transitions, and local fiducials are therefore ruled out for this frame; payload sampling and especially color modulation are not sufficiently resolvable under the measured screen/camera moiré.

The smallest evidence-supported reliability change was therefore sender-side magnification. v34c through v34f use 1.5× cells while retaining the same packet format and production decoder. v34g reduces this incrementally to 1.3× after the black-field capture established 5/7 CRC-valid tiles with strong shape and perfect known-color accuracy.

The first v34d frozen capture is the first positive hardware fixture: the production worker acquires 3 current-profile bootstraps and 6 complete payload tiles. Single-pixel sampling validates 1/6 tiles; v34e neighborhood sampling validates 2/6 while keeping known shape accuracy at 100% and known color accuracy at 95.8%.

The first v34f black-field frozen capture improves this to 5/7 CRC-valid visible tiles before decoder changes, with 99.1% known full-glyph/shape accuracy and 100% known color accuracy. A measured cross-neighborhood retry raises this to 6/7 without changing the 2/6 v34d white-field result. This is strong frozen-frame evidence for retaining black polarity, but it is not yet proof of continuous live reception or a completed transfer.

## Optical background

The application theme and optical background are separate decisions. A dark application theme alone does not improve a fullscreen transfer.

v34f introduced the black-field hardware experiment. It uses a pure black field, white QR modules and fiducials, and bright similar-luminance colors. The receiver detects black versus white field from each group's calibration samples and enables inverted QR detection, preserving the existing white-field fixture baseline. The first frozen black capture verifies 5/7 tiles before decoder changes versus 2/6 for the committed white capture, so black remains enabled. Live captures must still confirm that this advantage persists under motion and page transitions.

## Historical Profile 3 hardware gate (superseded)

This gate is retained only to explain the archived fixtures; it no longer blocks X1 work:

1. Verify the sender says `v34i`.
2. Capture still frames from both phones at normal use distance.
3. Require at least one CRC-valid payload tile per frame.
4. Complete a small transfer on each phone.
5. Add the captures to the benchmark as profile 3 acceptance fixtures.

## Profile 4 proposal (superseded by AirGrid X1)

This proposal led to the more precise `AIRGRID_NEXT.md` format. The target design removes QR entirely. Every repeating cell must be independently discoverable and decodable, so a camera crop does not need the fullscreen grid origin.

Each cell will contain:

- four compact fiducials for local homography;
- black, white, and color calibration samples;
- a strongly protected header containing magic, profile, session ID, frame ID, tile coordinates, transfer dimensions, and CRC;
- fountain payload plus inner error correction;
- orientation/asymmetry bits so rotations and mirrored cameras are unambiguous.

The detector will find fiducial components, form candidate quadrilaterals, decode the local header, and reject candidates by CRC. Session metadata is repeated in every cell. Fountain ESI is derived from the local frame and tile identifiers. Any crop containing one complete cell can therefore contribute data; larger crops contribute cells in parallel.

X1 does not replace Profile 3 with a production transfer mode. It first requires the acquisition, physical channel, vetted QC-LDPC, and measured capacity gates in `AIRGRID_NEXT.md`.
