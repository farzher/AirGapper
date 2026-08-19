from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:180]!r}")
    p.write_text(text.replace(old, new, 1))


cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"

# Revert v320's majority short-circuit. Its four up-front bounds/floor checks
# cost more than the saved probes on realistic optical ambiguity. Restore the
# v319 fixed median network.
old_vote = """    // Both callers consume only (returnedLum <= threshold), so the median's
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
new_vote = """    int values[5] = {lum, 0, 0, 0, 0};
    for (int i = 0; i < 4; ++i) {
        values[i + 1] = turboLum(yPlane, width, height, stride, probes[i], dx, dy);
        if (values[i + 1] < 0)
            return lum;
    }
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
replace_once(cpp, old_vote, new_vote)

# v319 proved cached-basis reuse is a win for translation. Affine transforms
# preserve vectors too: M*(right-left) is exactly transformedRight-transformedLeft,
# while translation cancels. Apply the 2x2 affine matrix to the two cached basis
# vectors instead of transforming four neighboring points separately.
old_basis = """    PointF ux, uy;
    if (frameTransform.translationOnly) {
        // Translation cancels from neighboring-point differences exactly. The
        // distortion-aware cache already stores the calibrated module centers,
        // so do not re-run four transforms just to recover the same local basis.
        const PointF& left = cache.samples[size_t(y) * dim + lx];
        const PointF& right = cache.samples[size_t(y) * dim + rx];
        const PointF& up = cache.samples[size_t(uyIndex) * dim + x];
        const PointF& down = cache.samples[size_t(dyIndex) * dim + x];
        ux = PointF{(right.x - left.x) / xDiv, (right.y - left.y) / xDiv};
        uy = PointF{(down.x - up.x) / yDiv, (down.y - up.y) / yDiv};
    } else {
"""
new_basis = """    PointF ux, uy;
    if (frameTransform.translationOnly || frameTransform.affineOnly) {
        const PointF& left = cache.samples[size_t(y) * dim + lx];
        const PointF& right = cache.samples[size_t(y) * dim + rx];
        const PointF& up = cache.samples[size_t(uyIndex) * dim + x];
        const PointF& down = cache.samples[size_t(dyIndex) * dim + x];
        const PointF sourceUx{(right.x - left.x) / xDiv, (right.y - left.y) / xDiv};
        const PointF sourceUy{(down.x - up.x) / yDiv, (down.y - up.y) / yDiv};
        if (frameTransform.translationOnly) {
            // Translation cancels from neighboring-point differences exactly.
            ux = sourceUx;
            uy = sourceUy;
        } else {
            // Affine translation also cancels; apply only the linear 2x2 part.
            ux = PointF{frameTransform.m00 * float(sourceUx.x) + frameTransform.m01 * float(sourceUx.y),
                        frameTransform.m10 * float(sourceUx.x) + frameTransform.m11 * float(sourceUx.y)};
            uy = PointF{frameTransform.m00 * float(sourceUy.x) + frameTransform.m01 * float(sourceUy.y),
                        frameTransform.m10 * float(sourceUy.x) + frameTransform.m11 * float(sourceUy.y)};
        }
    } else {
"""
replace_once(cpp, old_basis, new_basis)

replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.320";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.321";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.320";', 'const SEND_RUNTIME_BUILD = "v0.5.321";')
replace_once("main.js", 'const APP_BUILD = "v0.5.320";', 'const APP_BUILD = "v0.5.321";')
replace_once("index.html", '<span class="app-version">v0.5.320</span>', '<span class="app-version">v0.5.321</span>')
replace_once("index.html", './main.js?build=v0.5.320', './main.js?build=v0.5.321')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v268";', 'const CACHE = "airgapper-static-js-v269";')

print("staged v0.5.321: restore v319 vote and reuse cached basis for affine ambiguity sampling")
