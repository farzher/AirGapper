# AirGrid X1 hardware reports

Hardware exports are diagnostic screen/camera evidence, not file-throughput measurements. Persistent camera `deviceId` and `groupId` values are removed before reports are committed.

## `phone-v35e-quick-a.json`

This is the first fresh report after the v35c detector-raster BCH/CRC header prefilter. The requested follow-up identity was v35d, but the export truthfully identifies **v35e**. Repository commit `4ba8fe2` advanced v35d to v35e only to cache-bust and expose the lab build consistently; it did not change the detector/decoder algorithm. The report is therefore valid post-prefilter evidence, but it is not labeled as a v35d capture.

The `startedAt` value is `2026-08-11T12:34:34.498Z`, 20 minutes 31 seconds after the v35b baseline. No v35b local-storage data survived: the build and start time are new, v35b-only conditions are absent, and overlapping M1-p4 counters are lower than the baseline (including 0 rather than 11 CRC-valid M1-p4-f5 tiles), which would be impossible for accumulated records.

### Comparison with `phone-v35b-quick-a.json`

Rates below use scans attributed to a latched or decoded condition. The v35b report had 110 additional initial/unattributed receiver scans; v35e had one.

| Metric | v35b baseline | Fresh v35e |
|---|---:|---:|
| Quick-sweep conditions observed | 6/24 | 3/24 |
| Attributed / all receiver scans | 102 / 212 | 394 / 395 |
| Acquired frames / attributed scans | 16/102 (15.7%) | 7/394 (1.8%) |
| Complete tiles / acquired frame | 3.25 | 3.43 |
| Weighted raw BER | 15.8% | 26.4% |
| CRC-valid / complete tiles | 26/52 (50.0%) | 1/24 (4.2%) |
| Header-valid coordinate union | 14 | 15 |
| CRC-valid coordinate union | 9 | 1 (`2,0`) |
| Useful scan FPS | 1.69 | 3.86 |
| Worker utilization | 95.5% | 89.4% |

The only directly overlapping conditions also regressed optically:

| Condition | Acquisition, v35b → v35e | BER, v35b → v35e | CRC-valid tiles, v35b → v35e |
|---|---:|---:|---:|
| M1 pitch 4 Frozen | 57.1% → 18.2% | 7.4% → 25.9% | 8/8 → 1/13 |
| M1 pitch 4 at 5 FPS | 27.8% → 2.1% | 9.5% → 27.2% | 11/11 → 0/6 |

Header coordinates in v35e span x=1–5 and y=0–4, slightly broader than the baseline's 14-coordinate union, but they came from only three conditions. Only one coordinate produced a CRC-valid payload, so this does not satisfy complete screen-position coverage. No M2 condition was acquired.

### Worker timings

Averages are `timingSums / attributed scanFrames`; maxima are the largest condition maximum. Values are milliseconds per scan.

| Stage | v35b avg / max | v35e avg / max |
|---|---:|---:|
| Capture | 1.44 / 6.3 | 1.40 / 11.5 |
| Detector raster | 48.78 / 60.1 | 53.46 / 85.7 |
| Fiducial detection | 33.40 / 135.5 | 168.81 / 781.8 |
| Full-resolution ROI raster | 602.03 / 1463.8 | 1.22 / 258.5 |
| Header | 4.21 / 14.8 | 4.99 / 12.2 |
| Modulation | 1.52 / 58.3 | 0.23 / 34.6 |
| ECC | 2.05 / 45.6 | 0.48 / 115.4 |
| Total worker | 695.66 / 1532.7 | 229.44 / 857.9 |

The prefilter worked: average ROI cost fell 99.8%, total worker time fell 67.0%, and useful FPS rose 2.29×. It did not make the receiver fast enough. Detector rasterization plus fiducial/candidate work now accounts for about 97% of average worker time, with fiducial detection alone at 168.8 ms and a 781.8 ms outlier.

### Capacity and decision

The best fresh condition, M1 pitch 4 Frozen, measured 10.55 CRC-valid channel bytes/scan and projected only 43.14 full-grid bytes/camera frame, or 863 B/s at an assumed 20 useful FPS. The v35b values were 132.57 measured and 2,982.86 projected bytes/frame. The fresh projection is only 0.082% of the 52,429 net unique bytes/frame capacity gate; even the sparse v35b projection was only 5.69%. These figures can include repeated sounder pages and are not file throughput.

**Decision: optimize acquisition next, not full-resolution ROI and not X2 yet.** Marker detection/candidate formation must become much faster and reliable enough to measure all conditions and screen positions. The current 26% BER and one CRC-valid position do not provide a stable physical operating point from which to make a denser tile. X1's arithmetic still means a substantially denser X2 will eventually be necessary for the capacity gate, but designing it before obtaining reliable acquisition/channel evidence would be premature.

## `phone-v35f-quick-a.json`

This is the first physical report from the optimized v35f acquisition and demodulation worker. It started at `2026-08-11T12:58:47.637Z`, has the correct v35f identity, and includes the new marker/candidate/phase counters. The v35f lab automatically discarded saved reports from other builds, so the v35e fixture was not accumulated. Persistent camera identifiers are removed from the committed copy.

The sender used the historical 24-condition, four-second Quick sweep while v35g was being developed. The report ran for 111.7 seconds, scanned 778 frames, and attributed 714 scans after initial acquisition. Because failed scans are assigned to the last decoded condition, large per-condition scan totals can include later missing sender conditions; the aggregate and decoded-header evidence remain authoritative.

### Acquisition and timing

| Metric | v35e | v35f |
|---|---:|---:|
| Conditions identified | 3/24 | 13/24 |
| Acquired / attributed scans | 7/394 (1.8%) | 47/714 (6.6%) |
| Complete tiles | 24 | 436 |
| Complete tiles / acquired scan | 3.43 | 9.28 |
| Header-valid coordinate union | 15 | 48 |
| Useful FPS | 3.86 | 7.19 |
| Worker utilization | 89.4% | 79.3% |

Weighted stage timings are milliseconds per attributed scan:

| Stage | v35e avg / max | v35f avg / max |
|---|---:|---:|
| Capture | 1.40 / 11.5 | 1.33 / 7.7 |
| Detector raster | 53.46 / 85.7 | 47.17 / 67.2 |
| Fiducial detection | 168.81 / 781.8 | 22.80 / 59.3 |
| Full-resolution ROI raster | 1.22 / 258.5 | 8.60 / 400.4 |
| Header | 4.98 / 12.2 | 26.16 / 54.5 |
| Modulation | 0.23 / 34.6 | 2.74 / 161.7 |
| ECC | 0.48 / 115.4 | 3.60 / 178.5 |
| Total worker | 229.44 / 857.9 | 111.74 / 830.1 |

The acquisition optimization worked: fiducial time fell 86.5%, total time fell 51.3%, useful FPS rose 86.2%, and broad valid headers caused the expected increase in full-resolution payload work. The remaining detector-raster, marker, and header stages total about 96 ms/scan, so the 20 useful FPS gate is still not met. The detector saw hundreds of marker and quadrilateral candidates on many scans, tested about 30 headers/scan, and recovered 90 tiles only through the new phase retry; candidate rejection remains important.

### Payload failure

No payload succeeded: **0/436 CRC-valid tiles**, no CRC-valid screen coordinate, no validated bytes, and no capacity projection. Weighted BER was 31.5% overall, 27.4% for M1, and 32.8% for M2. Pitch 4 did not materially reduce BER.

The M1 confusion matrix isolates a systematic color failure rather than random tile geometry. Dot position was usually retained, but expected red symbols decoded as yellow with about 94% probability; green split between green and yellow; blue mostly decoded as green or yellow; and yellow remained yellow. The large 5×2 calibration bars therefore did not model the camera response of isolated one-chip payload dots after demosaicing, optical blur, and black-field mixing. M2 was worse and is not useful in another short alignment sweep yet.

**Decision:** retain the faster acquisition path, but fix matched-scale calibration before X2. v35h replaces each large color/white bar with repeated isolated one-chip probes and compares binary against M1 in the 12-condition alignment sweep. Binary will determine whether geometry and black/white sampling work independently of color. The v35f report contains no capacity evidence and does not justify file transport.

## `phone-v35h-quick-a.json`

This sanitized report identifies exactly **v35h** and started at `2026-08-11T13:09:51.261Z`, 11 minutes 3.624 seconds after v35f. It completed 34.634 seconds later. Its `expectedSweep` is `quick`, and its 12 expected keys are exactly binary/M1 × pitches 2/3/4 × Frozen/5 FPS.

No v35f or older local-storage counters survived. The six observed conditions are only expected binary/M1 conditions at Frozen/5 FPS; no old M2 or other-rate condition appears. The overlapping `M1-p3-f0` and `M1-p4-f5` scan counters are 93 and 32, below v35f's 128 and 64, which accumulated storage could not produce. The report also has the new build/start identity and only three initial unattributed scans. Persistent camera `deviceId` and `groupId` values were removed from both camera sections without changing measurements.

### Acquisition and worker comparison

Rates use attributed scans because failures after the first decoded condition are latched to that condition.

| Metric | v35f | v35h |
|---|---:|---:|
| Conditions identified | 13/24 (54.2%) | 6/12 (50.0%) |
| Attributed / all scans | 714 / 778 | 221 / 224 |
| Acquired / attributed scans | 47/714 (6.6%) | 13/221 (5.9%) |
| Complete tiles | 436 | 117 |
| Complete tiles / acquired scan | 9.28 | 9.00 |
| Header-valid coordinate union | 48 | 30 |
| CRC-valid tiles / complete | 0/436 | 52/117 (44.4%) |
| CRC-valid coordinate union | 0 | 24 |
| Useful FPS | 7.19 | 7.51 |
| Worker utilization | 79.3% | 78.5% |

v35h found no pitch-2 condition. Its shorter sweep is not directly comparable in tile count or coordinate union, but acquisition did not materially improve: the identified-condition fraction and acquired-scan rate remained similar. Payload decoding, by contrast, changed decisively.

Weighted timings are milliseconds per attributed scan:

| Stage | v35f avg / max | v35h avg / max |
|---|---:|---:|
| Capture | 1.33 / 7.7 | 1.30 / 5.0 |
| Detector raster | 47.17 / 67.2 | 46.48 / 66.2 |
| Fiducial detection | 22.80 / 59.3 | 20.88 / 81.2 |
| Header | 26.16 / 54.5 | 22.41 / 53.3 |
| Full-resolution ROI raster | 8.60 / 400.4 | 7.90 / 262.9 |
| Modulation | 2.74 / 161.7 | 1.99 / 80.3 |
| ECC | 3.60 / 178.5 | 1.43 / 76.5 |
| Total worker | 111.74 / 830.1 | 101.80 / 526.9 |

Detector raster, fiducial/candidate formation, and detector-header testing still consume 89.8 ms/scan before full-resolution payload work. ROI, modulation, and ECC total only 11.3 ms. Total time improved 8.9% and useful FPS 4.5%, but remains roughly twice the 50 ms / 20 useful FPS target.

| Candidate counter | v35f | v35h |
|---|---:|---:|
| Detected markers, total / scan | 243,930 / 341.6 | 61,223 / 277.0 |
| Quadrilateral candidates, total / scan | 309,449 / 433.4 | 81,725 / 369.8 |
| Tested headers, total / scan | 21,081 / 29.5 | 6,056 / 27.4 |
| Phase-retried accepted tiles | 90 | 32 |

The condition mix changed, but both reports still show hundreds of false markers/quadrilaterals and nearly exhaust the 32-header budget. Candidate rejection remains the evidence-supported hot path.

### Binary separator and M1 calibration result

Matched-scale M1 calibration worked. Across the three acquired M1 conditions, BER fell from v35f's **27.4%** to **8.53%**, exact-symbol accuracy rose from **32.6%** to **77.7%**, and 49/64 complete tiles passed CRC at 24 positions. Dot-position accuracy stayed high (97.7% in v35f and 96.9% in v35h), confirming that the large improvement came from color calibration rather than a geometry change.

M1 color confusion rows below are expected red/green/blue/yellow; columns are decoded red/green/blue/yellow:

| Build / expected | Red | Green | Blue | Yellow |
|---|---:|---:|---:|---:|
| v35f red | 0.6% | 3.8% | 0.0% | 95.6% |
| v35h red | 78.7% | 1.9% | 0.8% | 18.6% |
| v35f green | 0.0% | 41.0% | 0.1% | 58.9% |
| v35h green | 0.2% | 65.2% | 3.2% | 31.4% |
| v35f blue | 0.0% | 63.7% | 2.8% | 33.5% |
| v35h blue | 0.5% | 17.6% | 80.3% | 1.5% |
| v35f yellow | 0.0% | 10.2% | 0.0% | 89.8% |
| v35h yellow | 0.8% | 5.1% | 0.2% | 93.9% |

Binary did not act as a clean global geometry success: it had 22.34% BER, 39.2% exact blocks, and only 3/53 CRC-valid tiles at three positions. Its errors were strongly one-sided. True white chips remained white 97.4% of the time, but true black chips remained black only 57.9%; the decoder produced 21,428 false-white versus 1,306 false-black chip decisions. Dense adjacent binary whites blur into nominally black chips, unlike fixed-one-dot M1. Because M1 succeeds broadly with the same homographies and projective sampler, this is a binary occupancy/blur calibration issue, not evidence that all payload geometry is broken.

### Capacity and decision

v35h measured 6,032 CRC-valid sounder bytes over 221 attributed scans (27.29 B/scan), representing 52 valid tile observations and 47 per-condition unique sounder symbols. Its aggregate full-grid projection was 158.93 B/camera frame. The best measured condition was M1 pitch 4 at 5 FPS at 112.38 B/scan; the best projection was M1 pitch 3 at 5 FPS at 695.36 B/frame, or 13.9 KB/s at an assumed 20 useful FPS. That best projection is only 1.33% of the 52,429 net unique bytes/frame gate and can count repeated sounder pages; it is not file throughput. v35f measured and projected zero because no tile passed CRC.

**Decision:** keep the successful matched-scale M1 calibration and optimize acquisition, not full-resolution ROI or binary modulation. v35i uses the marker spatial index for neighbor searches as well as fourth-corner lookup, checks the 24 known alternating header timing chips before sampling all 384 BCH/CRC-protected chips, and removes a redundant detector clear. BCH/CRC rejection and crop-local full-resolution decoding remain unchanged. Deterministic regressions require dense-grid marker lookup to remain non-exhaustive and reject at least 95% of corrupted-header phases before full protected-header sampling. A fresh phone report must measure the speed/acquisition effect; this report does not justify X2 or file transfer.
