# AirGrid RS

Experimental rolling-shutter-native optical PHY. This branch starts from the clean v0.5.376 QR baseline; production QR remains on `master`.

## Core decision

AirGrid does not define one display refresh as one decodable frame. The screen is a stack of independent horizontal 1D codeword lanes. A rolling-shutter camera may capture several display refreshes in one physical camera frame; each intact lane is decoded independently and carries its own 24-bit display sequence. A refresh boundary should cost approximately one lane, not the whole screen.

## Binary lane v1

Each lane spans the screen width and is repeated over one optical-cell row vertically.

- 16 cells: balanced sync/preamble and per-lane black/white calibration
- 9 bytes: magic/version/profile + 32-bit payload ID + 24-bit display sequence
- N bytes: payload, determined by projected width / cell pitch
- 16 bits: CRC-16/CCITT; the physical lane index is included in the CRC but is not transmitted
- sub-byte remainder: deterministic alternating fill

The lane index is geometry, not bandwidth. Including it in CRC catches vertical misregistration without spending lane bits.

## Geometry target

All density decisions are based on projected camera pixels, not CSS/display pixels.

At 1920x1080 projected camera pixels:

| Cell pitch | Columns | Lanes | Payload/lane | Raw payload/camera capture | Raw @ 30 camera fps |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4 px | 480 | 270 | 47 B | 12.69 KB | 380.7 KB/s |
| 3 px | 640 | 360 | 67 B | 24.12 KB | 723.6 KB/s |
| 2.5 px | 768 | 432 | 83 B | 35.86 KB | 1.08 MB/s |

These are PHY payload ceilings before boundary losses, FEC and tracking overhead; they are targets, not promised real-camera goodput.

## Receiver pipeline

1. Camera2/browser Y8 plane.
2. Acquire four tiny persistent corner fiducials, then retain a cached screen homography.
3. Sample one luminance value per optical cell directly from Y8.
4. Use each lane's known preamble to estimate its black/white levels locally.
5. Decode each lane independently. CRC discards a lane touched by exposure integration or a refresh boundary.
6. Feed valid lane payloads into the existing MDS/RaptorQ transport. Missing lanes are normal erasures, not repair jobs.
7. Optimize decoded bytes/sec by adapting cell pitch, optical symbol rate, exposure and eventually inner FEC.

No RGBA conversion, whole-frame QR decode, cross-frame reconstruction, temporal history, or display/camera FPS synchronization is required in steady state.

## Sender pipeline

1. Existing file/snippet container and outer transport generate an endless stream of independent symbols.
2. Fill every lane with a unique transport symbol for the current display sequence.
3. Render black/white lanes with integer/pixel-sharp edges.
4. Present a completely new state on every selected optical refresh. Do not stagger lanes and do not wait for the receiver.

A 360 Hz panel is useful only when camera exposure is short enough to separate those states. AirGrid should automatically prefer the optical refresh rate that maximizes verified goodput rather than the highest nominal panel FPS.

## Development order

1. **Current commit:** binary lane framing, canvas renderer, projective Y8 sampler, synthetic mixed-refresh proofs.
2. Add tiny corner acquisition markers and persistent homography tracking.
3. Wire real Camera2 Y8 capture directly into the AirGrid sampler.
4. Feed actual MDS/RaptorQ symbols into lanes and reconstruct files.
5. Add soft cell values + short inner FEC (LDPC/BCH-class), keeping CRC as the acceptance oracle.
6. Auto-tune projected cell pitch (5 -> 4 -> 3.5 -> 3 -> 2.5 px) and optical refresh rate from measured lane goodput.
7. Add 4-level luminance modulation only after binary is stable; fall back per-session when SNR is insufficient.
8. Investigate 1D multicarrier modulation inside lanes only if it beats direct cells on real cameras.

## Proof gate

`benchmark/airgrid-rolling-shutter-proof.mjs` proves that several display sequences can coexist in one capture while every intact lane remains byte-exact and boundary lanes fail CRC.

`benchmark/airgrid-y8-proof.mjs` generates an actual synthetic 1920x1080 Y8 camera plane with multiple rolling-shutter refresh boundaries and exposure-blurred boundary bands, then decodes it through the projective raw-Y8 sampler.
