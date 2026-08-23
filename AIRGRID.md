# AirGrid RS

Experimental rolling-shutter-native optical PHY. This branch starts from the clean v0.5.376 QR baseline; production QR remains on `master`.

## Performance bar

The real QR implementation has already demonstrated about **2.0 MB/s verified goodput on a phone with a 1440p sender at 60 Hz**. That is the floor, not an aspirational target. AirGrid is only a win if real hardware beats it. The first meaningful AirGrid milestone is **2.5 MB/s sustained verified goodput**, then keep optimizing rather than treating 2.5 MB/s as a ceiling.

For a display/grid equivalent to 2560x1440 at 60 camera fps, the current binary lane framing has roughly these PHY payload ceilings:

| Cell pitch | Raw payload/camera capture | Raw @ 60 camera fps | Efficiency required to beat 2 MB/s |
| --- | ---: | ---: | ---: |
| 4 px | ~25 KB | ~1.5 MB/s | impossible |
| 3.5 px | ~32 KB | ~1.9 MB/s | impossible |
| 3 px | ~44.6 KB | ~2.68 MB/s | ~75% |
| 2.5 px | ~66.2 KB | ~3.97 MB/s | ~50% |

Therefore the first binary target is reliable **3 projected camera px/cell or denser at ~60 camera fps**. In practice, 2.5 px/cell gives much healthier headroom for the 2.5 MB/s milestone. If the receiving camera only supplies ~30 fps, binary 3 px/cell cannot beat the existing 2 MB/s result; diagnostics must make that immediately obvious, and the next lever becomes higher camera FPS, denser cells, or multi-level modulation.

## Hardware lab

`airgrid.html` is a standalone sender/receiver test harness. It does not touch the production QR UI and does not require an APK.

Recommended Android test setup from a checkout of `airgrid-rs`:

```bash
python -m http.server 8080
adb reverse tcp:8080 tcp:8080
```

Then open:

- desktop sender: `http://localhost:8080/airgrid.html?send`
- Android receiver: `http://localhost:8080/airgrid.html?receive`

`adb reverse` makes the desktop server appear as `localhost` on Android, so Chrome treats the page as a secure-context localhost origin and camera access works without deploying a branch preview.

Hardware run procedure:

1. On the sender choose 60 Hz and start at **3 display px/cell** on the 1440p monitor.
2. Note the planned sender raster/grid. The receiver must use the same sender width, height and display-cell pitch; it will independently measure actual projected **camera px/cell** from the calibrated quad.
3. On the phone request the desired camera resolution/FPS and start the camera.
4. Tap **Calibrate 4 corners**, then tap the visible display corners in TL → TR → BR → BL order.
5. Reset stats and let the run stabilize. The primary number is **byte-exact verified MB/s**. A lane only counts when CRC passes and the decoded payload exactly matches the deterministic payload expected from its payload ID, display sequence and physical lane index.
6. Watch camera FPS, projected px/cell, valid-lane rate, SNR/separation, rolling-shutter readout, frame-copy cost, CPU frame-budget usage, and explicit worker-busy drops.
7. Export JSON after each useful run. The export contains the final summary plus a bounded per-frame trace for later comparison.
8. Repeat at 3.5 / 3 / 2.5 / 2 display px/cell and useful camera resolutions/FPS. Do not infer a win from raw sender capacity: the gate is sustained verified receiver goodput above the 2.0 MB/s QR floor.

The sender uses a logical-grid raster renderer rather than thousands of Canvas `fillRect` calls. Sender presentation diagnostics separately report actual Hz, render time and missed intervals. Press `D` in fullscreen to show the HUD, but keep it hidden during measurements because any HUD necessarily overwrites optical data.

The browser receiver uses `MediaStreamTrackProcessor` → transferable `VideoFrame` → worker → direct I420 Y plane when Chrome supports it. There is a canvas/RGBA fallback, but its extra copy/conversion cost is reported and should not be confused with the AirGrid PHY cost. Only one decode job may be in flight; excess camera frames are dropped immediately and counted as backpressure rather than queued.

## Core decision

AirGrid does not define one display refresh as one decodable frame. The screen is a stack of independent horizontal 1D codeword lanes. A rolling-shutter camera may capture several display refreshes in one physical camera frame; each intact lane is decoded independently and carries its own 24-bit display sequence. A refresh boundary should cost approximately one lane, not the whole screen.

## Binary lane v1

Each lane spans the screen width and is repeated over one optical-cell row vertically.

- 16 cells: balanced sync/preamble and per-lane black/white calibration
- 9 bytes: magic/version/profile + 32-bit payload ID + 24-bit display sequence
- N bytes: payload, determined by logical grid width
- 16 bits: CRC-16/CCITT; the physical lane index is included in the CRC but is not transmitted
- sub-byte remainder: deterministic alternating fill

The lane index is geometry, not bandwidth. Including it in CRC catches vertical misregistration without spending lane bits.

## Receiver pipeline

1. Camera2/browser Y8 plane.
2. Acquire/enter the four screen corners and retain a cached screen homography.
3. Sample one luminance value per optical cell directly from Y8.
4. Use each lane's known preamble to estimate its black/white levels locally.
5. Decode each lane independently. CRC discards a lane touched by exposure integration or a refresh boundary.
6. For the hardware benchmark, regenerate the deterministic expected payload and require byte-for-byte equality before counting throughput.
7. Feed valid lane payloads into the existing MDS/RaptorQ transport once the PHY is proven. Missing lanes are normal erasures, not repair jobs.
8. Optimize verified bytes/sec by adapting cell pitch, optical symbol rate, exposure and eventually inner FEC/modulation.

No RGBA conversion, whole-frame QR decode, cross-frame reconstruction, temporal history, or display/camera FPS synchronization is required in steady state.

## Diagnostics are part of the PHY

Every real-hardware test must produce enough telemetry to identify the bottleneck instead of merely reporting a failed decode.

Per camera frame AirGrid records:

- projected screen width/height in camera pixels and effective px/cell in X/Y
- valid lanes, payload capacity, verified decoded bytes and lane utilization
- CRC-valid lanes versus deterministic payload mismatches
- failure classes: low contrast, preamble, magic/header, version, CRC, pattern mismatch and malformed/short
- per-lane black/white separation, preamble noise, estimated SNR, decision confidence and preamble errors
- decoded display-sequence runs down the sensor, exposing how many sender refreshes coexist in one camera capture
- refresh-boundary failure runs rather than hiding failed lanes
- cell sampling time, lane decoding time, total PHY time and sampled cells/sec

The rolling window additionally records:

- actual camera FPS and frame-time jitter
- requested/actual sender presentation Hz, render time, vsync misses and presentation jitter
- Camera2 timestamp, exposure, ISO, frame duration and rolling-shutter skew/readout metadata when using the native path
- browser frame-copy path/cost, worker queue delay, explicit busy-frame drops and end-to-end CPU frame-budget consumption
- measured verified MB/s versus both the **2.0 MB/s QR floor** and the **2.5 MB/s first AirGrid target**
- inferred rolling-shutter readout time from display-sequence stripe spacing when hardware metadata does not expose it
- automatic bottleneck classification: CPU, optics, rolling-shutter/exposure, camera capture, spatial density, QR baseline cleared, or AirGrid target cleared

Diagnostics should stay cheap in the production fast path. Expensive per-lane traces are opt-in; aggregate quantiles and failure runs are always sufficient for normal tuning.

## Sender pipeline

1. Existing file/snippet container and outer transport eventually generate an endless stream of independent symbols; the hardware lab currently uses deterministic byte-exact test payloads.
2. Fill every lane with a unique symbol for the current display sequence.
3. Rasterize the logical binary grid once, then scale it pixel-sharp to the fullscreen sender canvas.
4. Present a completely new state on every selected optical refresh. Do not stagger lanes and do not wait for the receiver.
5. Measure actual presentation cadence separately from receiver capture cadence so sender vsync failures cannot masquerade as camera problems.

A 360 Hz panel is useful only when camera exposure is short enough to separate those states. AirGrid should prefer the optical refresh rate that maximizes verified goodput rather than the highest nominal panel FPS.

## Fast branch CI

`airgrid-rs` intentionally skips codec rebuilds, Playwright/corpus production regression and Android/APK builds. Its push gate is lightweight JavaScript syntax plus AirGrid PHY/rolling-shutter/diagnostic/throughput proofs. The complete QR/app build pipeline remains on `master`.

## Development order

1. **Current:** real browser hardware lab, binary lane framing, fast sender rasterizer, transferable VideoFrame worker/Y8 receiver, manual four-corner homography, byte-exact verification, mixed-refresh proofs and channel diagnostics.
2. Run the first real hardware curve: display density, camera resolution/FPS, exposure and verified MB/s.
3. Use the measured loss map to optimize sampler geometry/CPU and decide whether automatic fiducials are worth their optical overhead.
4. Wire Camera2 raw Y8 directly into this same AirGrid lab/diagnostics when native iteration becomes useful.
5. Feed actual MDS/RaptorQ symbols into lanes and reconstruct files.
6. Add soft cell values + short inner FEC only if measured loss patterns show it improves net goodput.
7. Add 4-level luminance modulation if binary cannot retain enough margin above 2 MB/s; fall back automatically when SNR is insufficient.
8. Investigate 1D multicarrier modulation inside lanes only if it beats direct cells on real cameras.

## Proof gates

- `benchmark/airgrid-rolling-shutter-proof.mjs`: multiple display sequences coexist in one capture while intact lanes remain byte-exact and boundary lanes fail CRC.
- `benchmark/airgrid-y8-proof.mjs`: synthetic 1920x1080 Y8 camera plane with multiple rolling-shutter refresh boundaries and exposure-blurred boundary bands.
- `benchmark/airgrid-diagnostics-proof.mjs`: optical/decode failure classification, rolling-shutter boundary diagnosis, Camera2 metadata aggregation and sender cadence telemetry.
- `benchmark/airgrid-throughput-budget.mjs`: guards the architecture against regressing below the existing 2 MB/s QR benchmark at the 1440p/60-fps target geometry.
