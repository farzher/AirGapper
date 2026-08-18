 stride, 1);''',
    '''        auto postFastAllowed = [&](int trackIndex) {\n            const int id = tracks[trackIndex].id;\n            const uint32_t bit = id >= 0 && id < 32 ? (uint32_t(1) << id) : 0;\n            if (cheapAttempted[trackIndex] && !salvageAllowed[trackIndex]) {\n                if (bit) metrics->erasureRepairSuppressedMask |= bit;\n                return false;\n            }\n            return true;\n        };\n        bool needsPostFast = false;\n        for (int i = 0; i < trackCount; ++i)\n            if (!completed[i] && postFastAllowed(i)) { needsPostFast = true; break; }\n        if (!needsPostFast) {\n            metrics->misses = metrics->tracks - metrics->successful;\n            metrics->totalMs = guidedNowMs() - started;\n            return resultCount;\n        }\n\n        const double binStart = guidedNowMs();\n        ImageView iv(const_cast<uint8_t*>(yPlane), width, height, ImageFormat::Lum, stride, 1);'''
)
replace(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''        for (int i = 0; i < trackCount; ++i)\n            if (!completed[i])\n                order.push_back(i);''',
    '''        for (int i = 0; i < trackCount; ++i)\n            if (!completed[i] && postFastAllowed(i))\n                order.push_back(i);'''
)
replace("receive/worker.js", "const GUIDED_METRICS_BYTES = 192;", "const GUIDED_METRICS_BYTES = 208;")
replace(
    "receive/worker.js",
    "function decodeGuidedBatch(zx, yPtr, width, height, stride, ox, oy, tracks, fallbackAllowedMask = 0xffffffff) {",
    "function decodeGuidedBatch(zx, yPtr, width, height, stride, ox, oy, tracks, fallbackAllowedMask = 0xffffffff, repairAllowedMask = 0xffffffff) {"
)
replace(
    "receive/worker.js",
    '''    guidedOutputPtr, GUIDED_OUTPUT_BYTES,\n    tracks.length, fallbackAllowedMask >>> 0, guidedMetricsPtr\n  );''',
    '''    guidedOutputPtr, GUIDED_OUTPUT_BYTES,\n    tracks.length, fallbackAllowedMask >>> 0, repairAllowedMask >>> 0, guidedMetricsPtr\n  );'''
)
replace(
    "receive/worker.js",
    '''    erasureRsAttempts: metricsView.getUint32(180, true),\n    erasureRsSuccesses: metricsView.getUint32(184, true),\n    erasureRepairCodewords: metricsView.getUint32(188, true)\n  };''',
    '''    erasureRsAttempts: metricsView.getUint32(180, true),\n    erasureRsSuccesses: metricsView.getUint32(184, true),\n    erasureRepairCodewords: metricsView.getUint32(188, true),\n    erasureRepairAttemptMask: metricsView.getUint32(192, true),\n    erasureRepairSuccessMask: metricsView.getUint32(196, true),\n    erasureRepairSuppressedMask: metricsView.getUint32(200, true)\n  };'''
)
replace(
    "receive/worker.js",
    '''guidedDecode = false, guidedFallbackMask = 0xffffffff, sourceSequence, repeatFilter = false,''',
    '''guidedDeco