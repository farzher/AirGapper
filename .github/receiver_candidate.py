from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:180]!r}")
    p.write_text(text.replace(old, new, 1))


cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"
old = """    int values[5] = {lum, 0, 0, 0, 0};
    for (int i = 0; i < 4; ++i) {
        values[i + 1] = turboLum(yPlane, width, height, stride, probes[i], dx, dy);
        if (values[i + 1] < 0)
            return lum;
    }
    // We only need the median of five. A fixed eight-comparison network is
    // cheaper in WASM than invoking the generic tiny-range sort thousands
    // of times on a dense ambiguous frame, with identical output.
    auto swapIf = [](int& a, int& b) { if (a > b) std::swap(a, b); };
    swapIf(values[0], values[1]);
    swapIf(values[3], values[4]);
    swapIf(values[0], values[2]);
    swapIf(values[1], values[2]);
    swapIf(values[0], values[3]);
    swapIf(values[2], values[3]);
    swapIf(values[1], values[4]);
    swapIf(values[1], values[2]);
    return values[2];
"""
new = """    // Both callers consume only (returnedLum <= threshold), so the median's
    // numeric value is irrelevant; its side of the threshold is exactly the
    // 3-of-5 vote. Preserve the old edge behavior by validating every probe
    // before using early majority: previously any out-of-frame probe discarded
    // the whole vote and returned the center sample.
    auto bilinearInFrame = [&](PointF probe) {
        const float px = float(probe.x) + dx;
        const float py = float(probe.y) + dy;
        const int x0 = int(std::floor(px));
        const int y0 = int(std::floor(py));
        return x0 >= 0 && y0 >= 0 && x0 + 1 < width && y0 + 1 < height;
    };
    for (const auto& probe : probes)
        if (!bilinearInFrame(probe))
            return lum;

    int darkVotes = int(lum <= threshold);
    int lightVotes = 1 - darkVotes;
    for (const auto& probe : probes) {
        const int voteLum = turboLum(yPlane, width, height, stride, probe, dx, dy);
        // bilinearInFrame above guarantees this, but retain a defensive fallback.
        if (voteLum < 0)
            return lum;
        if (voteLum <= threshold)
            ++darkVotes;
        else
            ++lightVotes;
        if (darkVotes >= 3)
            return threshold;
        if (lightVotes >= 3)
            return threshold + 1;
    }
    return darkVotes >= 3 ? threshold : threshold + 1;
"""
replace_once(cpp, old, new)

replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.319";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.320";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.319";', 'const SEND_RUNTIME_BUILD = "v0.5.320";')
replace_once("main.js", 'const APP_BUILD = "v0.5.319";', 'const APP_BUILD = "v0.5.320";')
replace_once("index.html", '<span class="app-version">v0.5.319</span>', '<span class="app-version">v0.5.320</span>')
replace_once("index.html", './main.js?build=v0.5.319', './main.js?build=v0.5.320')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v267";', 'const CACHE = "airgapper-static-js-v268";')

print("staged v0.5.320: short-circuit exact ambiguity majority votes")
