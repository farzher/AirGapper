from pathlib import Path
import re
def read(path):
    return Path(path).read_text()
def write(path, text):
    Path(path).write_text(text)
def replace(path, old, new, expected=1):
    text = read(path)
    found = text.count(old)
    if found != expected:
        raise SystemExit(f"{path}: expected {expected} exact occurrence(s), found {found}: {old[:180]!r}")
    write(path, text.replace(old, new, expected))
def sub(path, pattern, replacement, expected=1, flags=0):
    text = read(path)
    out, found = re.subn(pattern, replacement, text, count=expected, flags=flags)
    if found != expected:
        raise SystemExit(f"{path}: expected {expected} regex occurrence(s), found {found}: {pattern[:180]!r}")
    write(path, out)
replace("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.306";', 'const SEND_RUNTIME_BUILD = "v0.5.307";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.306";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.307";')
replace("main.js", 'const APP_BUILD = "v0.5.306";', 'const APP_BUILD = "v0.5.307";')
replace("index.html", 'v0.5.306', 'v0.5.307', expected=2)
replace("sw.js", 'airgapper-static-js-v254', 'airgapper-static-js-v255')
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.h",
    '''\tuint32_t erasureRsAttempts;\n\tuint32_t erasureRsSuccesses;\n\tuint32_t erasureRepairCodewords;\n};''',
    '''\tuint32_t erasureRsAttempts;\n\tuint32_t erasureRsSuccesses;\n\tuint32_t erasureRepairCodewords;\n\tuint32_t erasureRepairAttemptMask;\n\tuint32_t erasureRepairSuccessMask;\n\tuint32_t erasureRepairSuppressedMask;\n};'''
)
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.h",
    '''\t\t\t\t\t\t uint8_t* output, int outputCapacity, int maxSymbols,\n\t\t\t\t\t\t uint32_t fallbackAllowedMask, DecimenGuidedMetrics* metrics);''',
    '''\t\t\t\t\t\t uint8_t* output, int outputCapacity, int maxSymbols,\n\t\t\t\t\t\t uint32_t fallbackAllowedMask, uint32_t repairAllowedMask,\n\t\t\t\t\t\t DecimenGuidedMetrics* metrics);'''
)
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''static_assert(sizeof(DecimenGuidedMetrics) == 192,\n              "DecimenGuidedMetrics JS ABI must allocate 176 bytes");''',
    '''static_assert(sizeof(DecimenGuidedMetrics) == 208,\n              "DecimenGuidedMetrics JS ABI must allocate 208 bytes");'''
)
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''static DecoderResult decodeTurboStableRS(const GuidedTurboTrack& cache,\n                                         const DecimenGuidedTrack& track,\n                                         const TurboFrameTransform& frameTransform,\n                                         const uint8_t* yPlane, int width, int height, int stride,\n                                         float 