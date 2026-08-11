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
