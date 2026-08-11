# AirGrid engineering plan

## AirGrid X1 milestone (current)

Profile 3 is frozen as failed historical channel evidence. The former instruction to gate protocol work on more Profile 3 phone tests is obsolete. v35e includes the QR-free AirGrid X1 acquisition/modulation laboratory and automated hardware sweep/export workflow in `airgrid-x1.js`, the precise format and capacity gates in `AIRGRID_NEXT.md`, and a separate deterministic production-worker benchmark. X1 has no file-transfer path and makes no physical capacity claim.

The X1 worker detects a shared ring-fiducial lattice on a bounded detector raster, reads only full-resolution candidate tile ROIs, BCH/CRC-checks a 128-bit local header, scores binary/M1/M2/M3 block hypotheses into soft bit values, and runs a typed-array cyclic LDPC/CRC payload check. `?airgridLab=1` exposes deterministic pitch/profile/page-rate patterns and live camera metrics.

The first v35b phone quick-sweep report is committed at `tests/fixtures/airgrid-x1/phone-v35b-quick-a.json`. The 30 FPS 1080×1920 camera produced only 1.69 useful worker FPS at 95.5% utilization. Full-resolution ROI rasterization of false header candidates dominated at roughly 455–798 ms/frame. M1 pitch 4 was the only repeatably positive condition: Frozen validated 8/8 acquired payload tiles at 7.4% raw BER, while 5 FPS validated 11/11 at 9.5% raw BER, but acquisition was only 57% and 28%. Pitch 3 was poor and 18/24 quick-sweep conditions were never acquired. v35c and later therefore BCH/CRC-prefilter headers on the detector raster before any full-resolution ROI read.

The fresh post-prefilter export is committed as `tests/fixtures/airgrid-x1/phone-v35e-quick-a.json`; the supplied export identifies v35e rather than the requested v35d because v35e cache-busted the otherwise unchanged lab worker. It has a new start time and no accumulated v35b counters. The prefilter reduced weighted average ROI raster time from 602 ms to 1.22 ms, total worker time from 696 ms to 229 ms, and raised useful FPS from 1.69 to 3.86 while utilization fell from 95.5% to 89.4%. Acquisition and channel results regressed: only 3/24 conditions appeared, 7/394 attributed scans acquired tiles, weighted BER was 26.4%, and only 1/24 complete tiles passed payload CRC. Fiducial detection is now the dominant stage at 169 ms average with a 782 ms maximum. Optimize detector acquisition/candidate formation next; do not spend more effort on full-resolution ROI reads or design X2 until acquisition supplies a stable physical channel baseline. X1 remains spatially incapable of the capacity gate, so a denser X2 will still be required later.

## Historical Profile 3 state

Profile 3 is a recovery profile. It fixes the demonstrated profile 2 failure by giving each payload tile four local registration marks and sampling larger 3×3 logical dots. It still uses one large QR bootstrap cell for every three payload cells. v34c displays the unchanged logical cells at 1.5× physical scale to reduce screen/camera density without changing the profile 3 packet format. v34d keeps that optical format, uses a dark application theme, and guarantees a small centered safe inset around complete AirGrid groups. v34e samples five points inside each logical dot instead of relying on one camera pixel. v34f switches the sender to a black optical field with white QR/fiducials and bright payload colors; the receiver detects polarity per group so committed white-field captures remain decodable. v34g reduces physical scale to 1.3× so a 2560×1440 optical surface fits two complete group rows, and retries CRC-failed black-field tiles with a tighter cross-shaped five-point neighborhood. v34h makes the complete receiver diagnostics panel scrollable so live throughput losses can be separated into acquisition, payload, duplicate-page, and worker bottlenecks. v34i caps the QR detector by the camera frame's long side: the measured 1080×1920 portrait feed now uses a 540×960 detector instead of 960×1707, and diagnostics report canvas, QR, and payload stage times separately.

The two initial phone captures in `tests/fixtures/` are profile 2 captures, not profile 3. Their QR anchors decode cleanly, but their payload geometry does not. A hard refresh or downloaded offline copy showing **v34i** was required for the historical Profile 3 hardware test. Current X1 hardware laboratory builds show **v35e**.

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
