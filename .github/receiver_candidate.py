from pathlib import Path
import subprocess

# Reuse the fully staged v0.5.312 patch from the immediately preceding rejected
# candidate. The gate rejected it only at C++ compile time, before promotion;
# keeping that exact patch makes this retry auditable and changes only the
# scope bug identified by the compiler.
source = subprocess.check_output([
    "git", "show",
    "b7d1d1e6d36602db7937b9f45a0274a11f7a5c33:.github/receiver_candidate.py"
], text=True)
ns = {}
exec(compile(source, "v0.5.312-base-candidate", "exec"), ns)

ns["replace_once"](
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''        for (int trackIndex : order) {
            if (resultCount >= std::min({resultCapacity, maxSymbols, trackCount}))
                break;
            const auto& track = tracks[trackIndex];

            QRCode::FinderPatternSet finderSet;''',
    '''        for (int trackIndex : order) {
            if (resultCount >= std::min({resultCapacity, maxSymbols, trackCount}))
                break;
            const auto& track = tracks[trackIndex];
            const uint32_t trackBit = trackIndex < 32 ? (uint32_t(1) << trackIndex) : 0;

            QRCode::FinderPatternSet finderSet;'''
)

Path("benchmark/receiver-candidate-ci.log").unlink(missing_ok=True)
