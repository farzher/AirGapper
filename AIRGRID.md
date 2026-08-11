# AirGrid engineering plan

## Current state

Profile 3 is a recovery profile. It fixes the demonstrated profile 2 failure by giving each payload tile four local registration marks and sampling larger 3×3 logical dots. It still uses one large QR bootstrap cell for every three payload cells. v34c displays the unchanged logical cells at 1.5× physical scale to reduce screen/camera density without changing the profile 3 packet format. v34d keeps that optical format, uses a dark application theme, and guarantees a small centered safe inset around complete AirGrid groups. v34e samples five points inside each logical dot instead of relying on one camera pixel. v34f switches the sender to a black optical field with white QR/fiducials and bright payload colors; the receiver detects polarity per group so committed white-field captures remain decodable. v34g reduces physical scale to 1.3× so a 2560×1440 optical surface fits two complete group rows, and retries CRC-failed black-field tiles with a tighter cross-shaped five-point neighborhood.

The two initial phone captures in `tests/fixtures/` are profile 2 captures, not profile 3. Their QR anchors decode cleanly, but their payload geometry does not. A hard refresh or newly downloaded offline copy showing **v34g** is required for the next hardware test.

A real-phone test at 1 page per second remained unusable, so sender page rate is not the primary failure. v34b adds a zero-rate frozen-page diagnostic for obtaining stable profile 3 captures.

The first three profile 3 camera fixtures now reproduce the hardware failure in the production worker. The true frozen capture has 8/8 current bootstraps, one consistent page, 24 visible tiles, and four local fiducials per visible tile, but 0/24 CRC-valid tiles. Known-glyph accuracy is 92.4% for shape and 65.1% for color at the production 1920-pixel worker width. Native-width decoding raises shape accuracy to 97.1% but still produces 0/24 valid tiles. Acquisition, page identity, temporal transitions, and local fiducials are therefore ruled out for this frame; payload sampling and especially color modulation are not sufficiently resolvable under the measured screen/camera moiré.

The smallest evidence-supported reliability change was therefore sender-side magnification. v34c through v34f use 1.5× cells while retaining the same packet format and production decoder. v34g reduces this incrementally to 1.3× after the black-field capture established 5/7 CRC-valid tiles with strong shape and perfect known-color accuracy.

The first v34d frozen capture is the first positive hardware fixture: the production worker acquires 3 current-profile bootstraps and 6 complete payload tiles. Single-pixel sampling validates 1/6 tiles; v34e neighborhood sampling validates 2/6 while keeping known shape accuracy at 100% and known color accuracy at 95.8%.

The first v34f black-field frozen capture improves this to 5/7 CRC-valid visible tiles before decoder changes, with 99.1% known full-glyph/shape accuracy and 100% known color accuracy. A measured cross-neighborhood retry raises this to 6/7 without changing the 2/6 v34d white-field result. This is strong frozen-frame evidence for retaining black polarity, but it is not yet proof of continuous live reception or a completed transfer.

## Optical background

The application theme and optical background are separate decisions. A dark application theme alone does not improve a fullscreen transfer.

v34f introduced the black-field hardware experiment. It uses a pure black field, white QR modules and fiducials, and bright similar-luminance colors. The receiver detects black versus white field from each group's calibration samples and enables inverted QR detection, preserving the existing white-field fixture baseline. The first frozen black capture verifies 5/7 tiles before decoder changes versus 2/6 for the committed white capture, so black remains enabled. Live captures must still confirm that this advantage persists under motion and page transitions.

## Profile 3 hardware gate

Before changing the protocol again:

1. Verify the sender says `v34g`.
2. Capture still frames from both phones at normal use distance.
3. Require at least one CRC-valid payload tile per frame.
4. Complete a small transfer on each phone.
5. Add the captures to the benchmark as profile 3 acceptance fixtures.

## Profile 4: QR-free, crop-local AirGrid

The target design removes QR entirely. Every repeating cell must be independently discoverable and decodable, so a camera crop does not need the fullscreen grid origin.

Each cell will contain:

- four compact fiducials for local homography;
- black, white, and color calibration samples;
- a strongly protected header containing magic, profile, session ID, frame ID, tile coordinates, transfer dimensions, and CRC;
- fountain payload plus inner error correction;
- orientation/asymmetry bits so rotations and mirrored cameras are unambiguous.

The detector will find fiducial components, form candidate quadrilaterals, decode the local header, and reject candidates by CRC. Session metadata is repeated in every cell. Fountain ESI is derived from the local frame and tile identifiers. Any crop containing one complete cell can therefore contribute data; larger crops contribute cells in parallel.

Profile 4 should only replace profile 3 after the benchmark can compare verified bytes per frame under the two real-phone channel models. QR removal is expected to recover substantial area, but bootstrap robustness remains the first requirement.
