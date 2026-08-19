from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:220]!r}")
    p.write_text(text.replace(old, new, 1))


cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"
old_sampler = """    auto sampleByte = [&](const std::vector<uint32_t>& plan, size_t firstBit,
                          uint8_t& value) -> bool {
        value = 0;
        for (int bit = 0; bit < 8; ++bit) {
            const uint32_t entry = plan[firstBit + bit];
            const int xx = int(entry & 0xff);
            const int y = int((entry >> 8) & 0xff);
            const bool mask = ((entry >> 16) & 1) != 0;
            const int threshold = turboThreshold(thresholdPlane, xx, y);
            int lum;
            if (centerOnly) {
                const PointF p = turboWarpedPoint(cache, frameTransform, xx, y);
                lum = turboNearestLum(yPlane, width, height, stride, p, dx, dy);
            } else {
                lum = turboModuleLum(cache, track, frameTransform,
                                     yPlane, width, height, stride,
                                     xx, y, dx, dy, threshold, moduleSize);
            }
            if (lum < 0)
                return false;
            value = uint8_t((value << 1) | uint8_t(mask != (lum <= threshold)));
        }
        return true;
    };
"""
new_sampler = """    // centerOnly is fixed for the entire Stable-RS attempt. Dispatch once per
    // codeword instead of branching on it for every one of the eight QR bits.
    // The two samplers are byte-for-byte equivalent to the old branches.
    auto sampleByteNearest = [&](const std::vector<uint32_t>& plan, size_t firstBit,
                                 uint8_t& value) -> bool {
        value = 0;
        for (int bit = 0; bit < 8; ++bit) {
            const uint32_t entry = plan[firstBit + bit];
            const int xx = int(entry & 0xff);
            const int y = int((entry >> 8) & 0xff);
            const bool mask = ((entry >> 16) & 1) != 0;
            const int threshold = turboThreshold(thresholdPlane, xx, y);
            const PointF p = turboWarpedPoint(cache, frameTransform, xx, y);
            const int lum = turboNearestLum(yPlane, width, height, stride, p, dx, dy);
            if (lum < 0)
                return false;
            value = uint8_t((value << 1) | uint8_t(mask != (lum <= threshold)));
        }
        return true;
    };

    auto sampleByteRobust = [&](const std::vector<uint32_t>& plan, size_t firstBit,
                                uint8_t& value) -> bool {
        value = 0;
        for (int bit = 0; bit < 8; ++bit) {
            const uint32_t entry = plan[firstBit + bit];
            const int xx = int(entry & 0xff);
            const int y = int((entry >> 8) & 0xff);
            const bool mask = ((entry >> 16) & 1) != 0;
            const int threshold = turboThreshold(thresholdPlane, xx, y);
            const int lum = turboModuleLum(cache, track, frameTransform,
                                           yPlane, width, height, stride,
                                           xx, y, dx, dy, threshold, moduleSize);
            if (lum < 0)
                return false;
            value = uint8_t((value << 1) | uint8_t(mask != (lum <= threshold)));
        }
        return true;
    };
"""
replace_once(cpp, old_sampler, new_sampler)

# Data and parity sampling: one centerOnly choice per codeword, not per bit.
replace_once(
    cpp,
    "            const bool sampled = erasureSampling\n                ? sampleByteCenter(dataPlan.samples, size_t(codeword) * 8, value, minMargin)\n                : sampleByte(dataPlan.samples, size_t(codeword) * 8, value);",
    "            const bool sampled = erasureSampling\n"
    "                ? sampleByteCenter(dataPlan.samples, size_t(codeword) * 8, value, minMargin)\n"
    "                : centerOnly\n"
    "                    ? sampleByteNearest(dataPlan.samples, size_t(codeword) * 8, value)\n"
    "                    : sampleByteRobust(dataPlan.samples, size_t(codeword) * 8, value);"
)
replace_once(
    cpp,
    "        const bool sampled = erasureSampling\n            ? sampleByteCenter(fullPlan, size_t(codeword) * 8, value, minMargin)\n            : sampleByte(fullPlan, size_t(codeword) * 8, value);",
    "        const bool sampled = erasureSampling\n"
    "            ? sampleByteCenter(fullPlan, size_t(codeword) * 8, value, minMargin)\n"
    "            : centerOnly\n"
    "                ? sampleByteNearest(fullPlan, size_t(codeword) * 8, value)\n"
    "                : sampleByteRobust(fullPlan, size_t(codeword) * 8, value);"
)

# Repair is reachable only from erasureSampling, which is explicitly !centerOnly.
# Use the robust sampler directly and remove the now-unnecessary runtime branch.
replace_once(cpp, "            if (!sampleByte(fullPlan, size_t(codeword) * 8, value)) {",
             "            if (!sampleByteRobust(fullPlan, size_t(codeword) * 8, value)) {")
replace_once(cpp, "                if (!sampleByte(fullPlan, size_t(codeword) * 8, value)) {",
             "                if (!sampleByteRobust(fullPlan, size_t(codeword) * 8, value)) {")

replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.333";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.334";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.333";', 'const SEND_RUNTIME_BUILD = "v0.5.334";')
replace_once("main.js", 'const APP_BUILD = "v0.5.333";', 'const APP_BUILD = "v0.5.334";')
replace_once("index.html", '<span class="app-version">v0.5.333</span>', '<span class="app-version">v0.5.334</span>')
replace_once("index.html", './main.js?build=v0.5.333', './main.js?build=v0.5.334')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v281";', 'const CACHE = "airgapper-static-js-v282";')

print("staged v0.5.334: move Stable-RS center-only dispatch out of the per-bit loop")
