from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:220]!r}")
    p.write_text(text.replace(old, new, 1))


cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"

new_builder = """    // Every element is overwritten exactly once. Avoid value-initializing the
    // full 177x177 PointF vector first, and emit rows sequentially so the map
    // build is one forward write stream instead of tile-ordered random stores.
    out.clear();
    out.reserve(size_t(dim) * dim);
    for (int y = 0; y < dim; ++y) {
        int ry = 0;
        while (ry + 1 < H && y >= centers[ry + 1])
            ++ry;
        const int y0 = centers[ry], y1 = centers[ry + 1];
        const float invHeight = 1.0f / float(y1 - y0);
        const float v = float(y - y0) * invHeight;
        for (int rx = 0; rx < W; ++rx) {
            const int x0 = centers[rx], x1 = centers[rx + 1];
            const int beginX = rx == 0 ? 0 : x0;
            const int endX = rx == W - 1 ? dim : x1;
            const PointF q00 = *controls(rx, ry);
            const PointF q10 = *controls(rx + 1, ry);
            const PointF q11 = *controls(rx + 1, ry + 1);
            const PointF q01 = *controls(rx, ry + 1);
            const float invWidth = 1.0f / float(x1 - x0);
            const PointF left{q00.x + (q01.x - q00.x) * v,
                              q00.y + (q01.y - q00.y) * v};
            const PointF right{q10.x + (q11.x - q10.x) * v,
                               q10.y + (q11.y - q10.y) * v};
            const PointF step{(right.x - left.x) * invWidth,
                              (right.y - left.y) * invWidth};
            PointF p{left.x + step.x * float(beginX - x0),
                     left.y + step.y * float(beginX - x0)};
            for (int x = beginX; x < endX; ++x) {
                out.push_back(p + outputOffset);
                p.x += step.x;
                p.y += step.y;
            }
        }
    }
    return out.size() == size_t(dim) * dim;
"""
old_builder = """    out.assign(size_t(dim) * dim, PointF{});
    for (int ry = 0; ry < H; ++ry) {
        for (int rx = 0; rx < W; ++rx) {
            const int x0 = centers[rx], x1 = centers[rx + 1];
            const int y0 = centers[ry], y1 = centers[ry + 1];
            const int beginX = rx == 0 ? 0 : x0;
            const int endX = rx == W - 1 ? dim : x1;
            const int beginY = ry == 0 ? 0 : y0;
            const int endY = ry == H - 1 ? dim : y1;
            const PointF q00 = *controls(rx, ry);
            const PointF q10 = *controls(rx + 1, ry);
            const PointF q11 = *controls(rx + 1, ry + 1);
            const PointF q01 = *controls(rx, ry + 1);
            const float invWidth = 1.0f / float(x1 - x0);
            const float invHeight = 1.0f / float(y1 - y0);
            for (int y = beginY; y < endY; ++y) {
                const float v = float(y - y0) * invHeight;
                const PointF left{q00.x + (q01.x - q00.x) * v,
                                  q00.y + (q01.y - q00.y) * v};
                const PointF right{q10.x + (q11.x - q10.x) * v,
                                   q10.y + (q11.y - q10.y) * v};
                const PointF step{(right.x - left.x) * invWidth,
                                  (right.y - left.y) * invWidth};
                PointF p{left.x + step.x * float(beginX - x0),
                         left.y + step.y * float(beginX - x0)};
                for (int x = beginX; x < endX; ++x) {
                    out[size_t(y) * dim + x] = p + outputOffset;
                    p.x += step.x;
                    p.y += step.y;
                }
            }
        }
    }
    return true;
"""
replace_once(cpp, new_builder, old_builder)

# Keep v326's independent lazy ambiguityScore allocation. It does no work on
# clean/data-only successes and is semantically independent of map generation.
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.326";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.327";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.326";', 'const SEND_RUNTIME_BUILD = "v0.5.327";')
replace_once("main.js", 'const APP_BUILD = "v0.5.326";', 'const APP_BUILD = "v0.5.327";')
replace_once("index.html", '<span class="app-version">v0.5.326</span>', '<span class="app-version">v0.5.327</span>')
replace_once("index.html", './main.js?build=v0.5.326', './main.js?build=v0.5.327')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v274";', 'const CACHE = "airgapper-static-js-v275";')

print("staged v0.5.327: restore fast indexed Sparse maps; retain lazy erasure scores")
