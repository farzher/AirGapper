from pathlib import Path
parts = [Path(f".github/v268rolling_part_{i:02d}.py") for i in range(15)]
code = "".join(part.read_text() for part in parts)
exec(compile(code, "<v0.5.307 rolling-shutter candidate>", "exec"), globals())

cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"

replace(
    cpp,
    '''        std::vector<uint8_t> completed(trackCount, 0);
        std::vector<uint8_t> cheapAttempted(trackCount, 0);
        std::vector<uint8_t> salvageAllowed(trackCount, 1);
        int repairTracksSpent = 0;
        constexpr int GUIDED_MAX_REPAIR_TRACKS_PER_BATCH = 2;''',
    '''        std::vector<uint8_t> completed(trackCount, 0);
        int repairTracksSpent = 0;
        constexpr int GUIDED_MAX_REPAIR_TRACKS_PER_BATCH = 2;'''
)
replace(
    cpp,
    '''            const bool repairMaskAllowed = !trackBit || (repairAllowedMask & trackBit) != 0;
            const bool allowExpensiveRepair = repairMaskAllowed && repairTracksSpent < GUIDED_MAX_REPAIR_TRACKS_PER_BATCH;
            salvageAllowed[i] = uint8_t(allowExpensiveRepair);
            bool repairSpentThisTrack = false;''',
    '''            const bool repairMaskAllowed = !trackBit || (repairAllowedMask & trackBit) != 0;
            const bool allowExpensiveRepair = repairMaskAllowed && repairTracksSpent < GUIDED_MAX_REPAIR_TRACKS_PER_BATCH;
            bool repairSpentThisTrack = false;'''
)
replace(
    cpp,
    '''            const bool decoderAttempted = directAttempted || stableRsAttempted;
            cheapAttempted[i] = uint8_t(decoderAttempted);
            if (repairSpentThisTrack && !success) salvageAllowed[i] = 0;
            if (success) {''',
    '''            const bool decoderAttempted = directAttempted || stableRsAttempted;
            if (success) {'''
)
replace(
    cpp,
    '''        auto postFastAllowed = [&](int trackIndex) {
            const int id = tracks[trackIndex].id;
            const uint32_t bit = id >= 0 && id < 32 ? (uint32_t(1) << id) : 0;
            if (cheapAttempted[trackIndex] && !salvageAllowed[trackIndex]) {
                if (bit) metrics->erasureRepairSuppressedMask |= bit;
                return false;
            }
            return true;
        };
        bool needsPostFast = false;
        for (int i = 0; i < trackCount; ++i)
            if (!completed[i] && postFastAllowed(i)) { needsPostFast = true; break; }
        if (!needsPostFast) {
            metrics->misses = metrics->tracks - metrics->successful;
            metrics->totalMs = guidedNowMs() - started;
            return resultCount;
        }

        const double binStart = guidedNowMs();
        ImageView iv(const_cast<uint8_t*>(yPlane), width, height, ImageFormat::Lum, stride, 1);''',
    '''        const double binStart = guidedNowMs();
        ImageView iv(const_cast<uint8_t*>(yPlane), width, height, ImageFormat::Lum, stride, 1);'''
)
replace(
    cpp,
    '''        for (int i = 0; i < trackCount; ++i)
            if (!completed[i] && postFastAllowed(i))
                order.push_back(i);''',
    '''        for (int i = 0; i < trackCount; ++i)
            if (!completed[i])
                order.push_back(i);'''
)
Path("benchmark/receiver-candidate-ci.log").unlink(missing_ok=True)
print("v0.5.307 optical recovery lane preserved")
