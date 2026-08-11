# AirGrid X1 automated hardware test

This test needs no connection between the sender computer and receiver phone. Both sides use deterministic pages, and every protected tile header identifies the active test condition.

## Prepare

1. Open/download an AirGapper **v35l** offline copy on both devices. The offline download embeds `airgrid-x1.js` and the worker source.
2. Open **Hardware lab**, or append `?airgridLab=1` to the HTML URL. The header must visibly show **v35l · X1 hardware lab** before testing.
3. On the display device, disable adaptive brightness, set a recorded fixed brightness, disable night-light/color-temperature features, use 100% browser zoom, and prevent sleep.
4. On the phone, clean the lens, disable battery saver, prevent sleep, and record the phone model/browser. Do not digitally zoom.
5. Mount or hold the phone so the complete optical display is visible. Keep distance and angle fixed during a sweep.

The sender reports canvas backing pixels and `devicePixelRatio`. A fullscreen backing pixel is intended to map to one physical display pixel. Record any OS display scaling or browser behavior that violates this assumption.

## Alignment run

1. On a phone, the lab automatically selects **Receiver** and hides sender-only controls. Leave **detector** on **Fixed 768** and **pipeline** on **Direct native YUV**, then press **Record 40s quick test** and grant camera permission. This clears old counters, starts the live decoder and a high-bitrate camera recording, and schedules an automatic stop.
2. As soon as the phone says **start the computer sender now**, choose **Quick 12-condition sweep** on the computer, leave dwell at 2 seconds, press **Start auto sender**, and grant fullscreen.
3. The quick sweep covers binary/M1, pitches 2/3/4, and Frozen/5 FPS: 12 conditions. It displays for about 24 seconds; the 40-second phone capture leaves startup and tail room.
4. Do not move either device. At the end the phone automatically downloads a timestamped WebM/MP4. If the browser blocks or loses the download, press **Save video again** before reloading the page.
5. Press **Export JSON** too. Give both the original video and JSON to the decoder benchmark. Confirm the live report's detector variant is `i420-d768` with source format I420 or NV12 and an empty fallback reason. A `canvas-fallback-d768` report is still useful evidence.
6. The recorder runs concurrently with the live decoder and can change phone utilization. Use the video for reproducible decoder/format iteration, but use a separate unrecorded **Start auto receiver** run for final live-speed acceptance.
7. If acquisition is poor even at pitch 4 Frozen, fix framing/focus/exposure before a full run. Press **Clear saved** before an unrecorded acceptance run.

The sender and receiver are intentionally unsynchronized. Start the receiver first. It identifies condition changes from BCH/CRC-valid local headers and attributes temporary acquisition failures to the last accepted condition.

## Full sweep

1. Select **Full 168-condition sweep** on both devices. On the receiver, retain the detector size and pipeline validated by the alignment run, then start the phone receiver first. Matching the receiver sweep selector makes its export list every missing condition explicitly.
2. Start **Full 168-condition sweep** on the sender.
3. Use at least 4 seconds dwell; use 8–10 seconds for acceptance captures.
4. Start the sender and do not move either device until fullscreen exits.
5. Stop the receiver and export both JSON and CSV. On the sender, export JSON as well; it records preparation time and measured displayed page FPS for every condition.
6. Repeat for each required phone, display brightness, camera orientation, distance/angle, and exposure mode.
7. Add exports and representative original camera frames under a dated fixture directory. Do not recompress acceptance images.

The full sweep covers:

- pitches: 2, 3, 4, 5, 6, 8 physical display pixels/chip;
- profiles: binary, M1, M2, experimental M3;
- requested page rates: Frozen, 1, 2, 5, 10, 15, 30 FPS;
- every visible tile coordinate/screen position.

Each moving-rate condition alternates two pre-rendered deterministic pages. This isolates optical transition behavior from sender encoding cost while preserving tile-local mixed frame IDs.

## Export interpretation

The receiver JSON contains:

- scanned and acquired camera frames;
- complete and CRC-valid tiles/frame;
- raw errors/bits and BER;
- sparse symbol confusion matrix and mutual information/chip;
- occupancy/color diagnostics from worker results;
- transition-frame rate;
- CRC-valid channel bytes/frame and unique symbol count;
- per-tile-coordinate acquisition/error totals;
- average and maximum capture, detector, ROI, header, modulation, ECC, and total timings;
- camera settings and capabilities exposed by the browser;
- per detector-size/pipeline acquisition, candidate, channel, and timing aggregates, including native pixel format and explicit fallback reason;
- useful scan FPS and worker utilization.

The receiver CSV is a compact comparison table. Receiver JSON is the authoritative channel evidence; sender JSON verifies the requested sweep and actual display cadence.

`validatedBytesPerFrame × 20` is a channel estimate, not file throughput. It excludes production fountain/session overhead and can count repeated sounder pages. Do not call it verified unique transfer throughput.

## Acceptance gates

Do not select a production profile until captures demonstrate:

1. Reliable fiducial/header acquisition across all required screen positions.
2. A stable confusion matrix and raw BER at the selected pitch/profile.
3. Post-ECC CRC-valid payload at the selected page rate.
4. Worker total time compatible with at least 20 useful FPS on the old phone.
5. At least 52,429 net unique bytes/camera frame after projected marker, header, LDPC, CRC, and fountain overhead.

If no measured condition meets the final capacity gate, revise geometry or the 1 MiB/s target before implementing file transport.

## Recorded-video replay

Run a supplied phone recording through the exact current production worker:

```sh
node tests/airgrid-video-benchmark.mjs path/to/phone-quick.webm
```

The default samples five video frames per second through direct I420 conversion at detector side 768. It writes `report.json` plus lossless decoded PNG stills beside the input video. Useful comparisons include:

```sh
node tests/airgrid-video-benchmark.mjs phone.webm --sample-fps=10
node tests/airgrid-video-benchmark.mjs phone.webm --pipeline=canvas --output=canvas-analysis
```

Replay results measure the recorded/compressed channel on the benchmark computer, not old-phone live FPS. Keep the original video immutable and compare worker builds against the same recording.

## Regression commands

```sh
node tests/airgrid-benchmark.mjs
node tests/airgrid-next-benchmark.mjs
node --check tests/airgrid-benchmark.mjs
node --check tests/airgrid-next-benchmark.mjs
node --check tests/airgrid-video-benchmark.mjs
git diff --check
```
