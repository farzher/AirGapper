# Receiver benchmark

The benchmark is primarily a **correctness/regression gate**, not the performance target.

AirGapper is optimized for a real handheld phone receiving a moving/shaking camera image. Stable tripod and synthetic scenarios are useful for catching bugs, state/yield regressions, and accidental CPU blowups, but they must not drive the algorithm toward unrealistic stable-only behavior.

The receiver performance goal is **30 decoder-processed camera frames/second with the 4×7 / 28-QR wall** on capable hardware. Preserve cheap stable fast paths when available, but prioritize the motion-tolerant tracked/Guided path used during normal hand shake. Validate performance decisions on handheld hardware.

The receiver UI `fps` metric means **decoder-processed camera frames per second (CPU throughput)**, not camera delivery rate. Camera capture/delivery FPS belongs in developer diagnostics.

Visible rolling throughput/progress stats update at **5 Hz (every 200 ms)** while still measuring a trailing 1-second window. Heavy developer diagnostic strings stay at 1 Hz so observability does not steal decode CPU.
