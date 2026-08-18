from pathlib import Path
import subprocess

# Reapply the original complete v0.5.312 candidate directly, then layer the
# two fixes found by the gate. Keep this retry flat: do not execute another
# retry script, because its internal `ns` dictionary would hide helpers such
# as replace_once from this namespace.
source = subprocess.check_output([
    "git", "show",
    "b7d1d1e6d36602db7937b9f45a0274a11f7a5c33:.github/receiver_candidate.py"
], text=True)
base = {}
exec(compile(source, "v0.5.312-base-candidate", "exec"), base)
replace_once = base["replace_once"]

# Fix 1: sparse/fallback metrics run in the later trackIndex loop, so define
# the 32-bit salvage lane bit in that loop's scope.
replace_once(
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

# Fix 2: makeCandidate must validate observations through the same dynamic
# extended-grid resolver as accept(), otherwise slots above the legacy layout
# table disappear before homography construction.
replace_once(
    "receive/grid-lattice.js",
    '''      const declared = gridLayoutById(observation.layoutId);
      if (!declared || declared.cols !== layout.cols || declared.rows !== layout.rows) continue;''',
    '''      const declared = declaredGridLayout(observation);
      if (!declared || declared.cols !== layout.cols || declared.rows !== layout.rows) continue;'''
)

Path("benchmark/receiver-candidate-ci.log").unlink(missing_ok=True)
