# Receiver benchmark

The benchmark is primarily a **correctness/regression gate**, not the performance target.

AirGapper is optimized for a real handheld phone receiving a moving/shaking camera image. Stable tripod and synthetic scenarios are useful for catching bugs, state/yield regressions, and accidental CPU blowups, but they must not drive the algorithm toward unrealistic stable-only behavior.

Performance decisions should be validated on handheld hardware. Preserve cheap stable fast paths when available, but prioritize the motion-tolerant tracked/Guided path used during normal hand shake.

The receiver UI `fps` metric means **decoder-processed camera frames per second (CPU throughput)**, not camera delivery rate. Camera capture/delivery FPS belongs in developer diagnostics.
