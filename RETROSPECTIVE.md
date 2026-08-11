# Retrospective

## What we tried

- QR-anchored payload grids
- Black-field and larger-cell experiments
- Custom AirGrid/X1 ring fiducials
- Binary and color modulation
- Protected local headers, LDPC, tracking, native I420, and recorded-video replay

## What worked

- Mature QR acquisition was much more reliable than the custom detector.
- Black optical backgrounds and larger symbols improved frozen-frame reliability.
- Matched-scale color calibration improved M1.
- Native I420 reduced detector conversion cost.
- Tracking and cached frame rasterization reduced repeated receiver work.
- Recorded-camera replay was useful for deterministic optimization.

## What failed

- No completed file transfer was produced by X1.
- The measured sounder rate was nowhere near useful file throughput.
- Pitch 2/3 was not reliably resolvable by the old phone.
- Pitch 4 improved reliability but destroyed spatial capacity.
- X1’s format could not mathematically reach 1 MiB/s even under ideal conditions.
- Acquisition, optical BER, ECC loss, and old-phone processing losses multiplied together.
- Projected or repeated sounder bytes were not unique end-to-end goodput.
