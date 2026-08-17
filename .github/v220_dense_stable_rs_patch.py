from pathlib import Path

p = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = p.read_text()

old = '''constexpr float GUIDED_TURBO_CANARY_MIN_MODULE = 2.25f;
constexpr int GUIDED_TURBO_BAD_COOLDOWN = 6;'''
new = '''// Data-only Turbo has no QR RS protection, so keep its conservative optical
// density gate. Distortion-calibrated Stable-RS is a different contract: it
// has finder/contrast evidence, full QR Reed-Solomon, and AirGapper CRC before
// acceptance. Let it work closer to the ~2 px/module regime where sparse
// Guided decoding is already reliable, while still staying above the point
// where sub-pixel phase dominates a module.
constexpr float GUIDED_TURBO_CANARY_MIN_MODULE = 2.25f;
constexpr float GUIDED_STABLE_RS_MIN_MODULE = 1.75f;
constexpr int GUIDED_TURBO_BAD_COOLDOWN = 6;'''
if old not in s:
    raise SystemExit("turbo constants target not found")
s = s.replace(old, new, 1)

old = '''    if (!cache || guidedModuleSize(track) < GUIDED_TURBO_CANARY_MIN_MODULE)
        return false;'''
new = '''    if (!cache || guidedModuleSize(track) < GUIDED_STABLE_RS_MIN_MODULE)
        return false;'''
if old not in s:
    raise SystemExit("turbo seed gate target not found")
s = s.replace(old, new, 1)

old = '''    return guidedModuleSize(track) >= GUIDED_TURBO_CANARY_MIN_MODULE;
}'''
new = '''    return guidedModuleSize(track) >= GUIDED_STABLE_RS_MIN_MODULE;
}'''
if old not in s:
    raise SystemExit("stable warp gate target not found")
s = s.replace(old, new, 1)

old = '''    if (lum < 0 || moduleSize < GUIDED_TURBO_CANARY_MIN_MODULE ||
        std::abs(lum - threshold) > GUIDED_TURBO_AMBIGUOUS)
        return lum;'''
new = '''    if (lum < 0 || moduleSize < GUIDED_STABLE_RS_MIN_MODULE ||
        std::abs(lum - threshold) > GUIDED_TURBO_AMBIGUOUS)
        return lum;'''
if old not in s:
    raise SystemExit("turbo ambiguous sampling gate target not found")
s = s.replace(old, new, 1)

p.write_text(s)
