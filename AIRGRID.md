# AirGrid engineering plan

## Current state

Profile 3 is a recovery profile. It fixes the demonstrated profile 2 failure by giving each payload tile four local registration marks and sampling larger 3×3 logical dots. It still uses one large QR bootstrap cell for every three payload cells. v34c displays the unchanged logical cells at 1.5× physical scale to reduce screen/camera density without changing the profile 3 packet format.

The two initial phone captures in `tests/fixtures/` are profile 2 captures, not profile 3. Their QR anchors decode cleanly, but their payload geometry does not. A hard refresh or newly downloaded offline copy showing **v34c** is required for the next hardware test.

A real-phone test at 1 page per second remained unusable, so sender page rate is not the primary failure. v34b adds a zero-rate frozen-page diagnostic for obtaining stable profile 3 captures.

The first three profile 3 camera fixtures now reproduce the hardware failure in the production worker. The true frozen capture has 8/8 current bootstraps, one consistent page, 24 visible tiles, and four local fiducials per visible tile, but 0/24 CRC-valid tiles. Known-glyph accuracy is 92.4% for shape and 65.1% for color at the production 1920-pixel worker width. Native-width decoding raises shape accuracy to 97.1% but still produces 0/24 valid tiles. Acquisition, page identity, temporal transitions, and local fiducials are therefore ruled out for this frame; payload sampling and especially color modulation are not sufficiently resolvable under the measured screen/camera moiré.

The smallest evidence-supported reliability change is therefore sender-side magnification. v34c uses 1.5× cells while retaining the same packet format and production decoder. This costs visible tiles per frame but should move each logical dot farther above the camera sampling and moiré limit. It still requires a new physical frozen-page capture and transfer test.

## Optical background

The application theme and optical background are separate decisions. A dark application theme does not improve a fullscreen transfer. AirGrid currently keeps a white optical background because it gives the camera a stable exposure reference and avoids bright-symbol bloom and color-channel clipping.

Pure black may help some LCD/OLED and camera combinations, but it can also make auto-exposure amplify noise. Do not switch the optical polarity by intuition. Add black-field and white-field presets to the calibrated hardware benchmark and choose from verified tile throughput.

## Profile 3 hardware gate

Before changing the protocol again:

1. Verify the sender says `v34c`.
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
