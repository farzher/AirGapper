# AirGrid engineering plan

## Current state

Profile 3 is a recovery profile. It fixes the demonstrated profile 2 failure by giving each payload tile four local registration marks and sampling larger 3×3 logical dots. It still uses one large QR bootstrap cell for every three payload cells.

The two initial phone captures in `tests/fixtures/` are profile 2 captures, not profile 3. Their QR anchors decode cleanly, but their payload geometry does not. A hard refresh or newly downloaded offline copy showing **v34a** is required for the next hardware test.

## Optical background

The application theme and optical background are separate decisions. A dark application theme does not improve a fullscreen transfer. AirGrid currently keeps a white optical background because it gives the camera a stable exposure reference and avoids bright-symbol bloom and color-channel clipping.

Pure black may help some LCD/OLED and camera combinations, but it can also make auto-exposure amplify noise. Do not switch the optical polarity by intuition. Add black-field and white-field presets to the calibrated hardware benchmark and choose from verified tile throughput.

## Profile 3 hardware gate

Before changing the protocol again:

1. Verify the sender says `v34a`.
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
