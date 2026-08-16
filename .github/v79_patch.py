from pathlib import Path


def replace_exact(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    found = s.count(old)
    if found != count:
        raise SystemExit(f"{path}: expected {count} matches, got {found}: {old[:160]!r}")
    p.write_text(s.replace(old, new, count))

replace_exact('index.html', 'v0.5.78', 'v0.5.79', 2)
replace_exact('main.js', 'const APP_BUILD = "v0.5.78";', 'const APP_BUILD = "v0.5.79";')
replace_exact('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.77";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.79";')
replace_exact('sw.js', 'airgapper-static-js-v41', 'airgapper-static-js-v42')
replace_exact('vendor/decimen-codec/source/VERSION', '0.1.5', '0.1.6')

replace_exact(
    'vendor/decimen-codec/source/wrapper/decimen_codec.h',
    '\tuint32_t anchorBypassAttempts;\n\tuint32_t anchorBypassSuccesses;\n};',
    '\tuint32_t anchorBypassAttempts;\n\tuint32_t anchorBypassSuccesses;\n\tuint32_t translationAttempts;\n\tuint32_t translationSuccesses;\n\tuint32_t calibrationAttempts;\n\tuint32_t calibrationSuccesses;\n};'
)

replace_exact(
    'vendor/decimen-codec/source/wrapper/decimen_codec.cpp',
    '\tdst.anchorBypassAttempts += src.anchorBypassAttempts;\n\tdst.anchorBypassSuccesses += src.anchorBypassSuccesses;\n}',
    '\tdst.anchorBypassAttempts += src.anchorBypassAttempts;\n\tdst.anchorBypassSuccesses += src.anchorBypassSuccesses;\n\tdst.translationAttempts += src.translationAttempts;\n\tdst.translationSuccesses += src.translationSuccesses;\n\tdst.calibrationAttempts += src.calibrationAttempts;\n\tdst.calibrationSuccesses += src.calibrationSuccesses;\n}'
)

replace_exact(
    'vendor/decimen-codec/source/wrapper/decimen_codec.cpp',
    '\t\tByteArray packet = track.crc32Payload ? decodeCachedTrack(track, lumAt, measured) : ByteArray{};',
    '''\t\t// The distortion map is persistent, but a handheld camera is not. Before\n\t\t// touching the full module grid, align the three invariant finder patterns\n\t\t// and apply that cheap translation to every cached sample point. On a\n\t\t// stable frame this is only 147 luminance reads.\n\t\tif (track.crc32Payload) {\n\t\t\t++measured.translationAttempts;\n\t\t\tAnchorReading motion;\n\t\t\tconst double motionStarted = emscripten_get_now();\n\t\t\tconst bool tracked = refineAnchor(track, lumAt, motion);\n\t\t\tmeasured.anchorMs += emscripten_get_now() - motionStarted;\n\t\t\tif (tracked)\n\t\t\t\t++measured.translationSuccesses;\n\t\t}\n\n\t\tByteArray packet = track.crc32Payload ? decodeCachedTrack(track, lumAt, measured) : ByteArray{};'''
)

replace_exact(
    'vendor/decimen-codec/source/wrapper/decimen_codec.cpp',
    '''\t\t\tconst double calibrationStarted = emscripten_get_now();\n\t\t\tconst bool ok = calibrateTrackSampleMap(track, *bits);\n\t\t\tmeasured.anchorMs += emscripten_get_now() - calibrationStarted;\n\t\t\tif (ok) {\n\t\t\t\t++measured.anchorSuccesses;''',
    '''\t\t\t++measured.calibrationAttempts;\n\t\t\tconst double calibrationStarted = emscripten_get_now();\n\t\t\tconst bool ok = calibrateTrackSampleMap(track, *bits);\n\t\t\tmeasured.anchorMs += emscripten_get_now() - calibrationStarted;\n\t\t\tif (ok) {\n\t\t\t\t++measured.anchorSuccesses;\n\t\t\t\t++measured.calibrationSuccesses;'''
)

replace_exact('receive/worker.js', 'const NATIVE_BATCH_METRICS_BYTES = 112;', 'const NATIVE_BATCH_METRICS_BYTES = 128;')
replace_exact(
    'receive/worker.js',
    '''    anchorBypassAttempts: view.getUint32(nativeMetricsPtr + 100, true),\n    anchorBypassSuccesses: view.getUint32(nativeMetricsPtr + 104, true)\n  };''',
    '''    anchorBypassAttempts: view.getUint32(nativeMetricsPtr + 100, true),\n    anchorBypassSuccesses: view.getUint32(nativeMetricsPtr + 104, true),\n    translationAttempts: view.getUint32(nativeMetricsPtr + 108, true),\n    translationSuccesses: view.getUint32(nativeMetricsPtr + 112, true),\n    calibrationAttempts: view.getUint32(nativeMetricsPtr + 116, true),\n    calibrationSuccesses: view.getUint32(nativeMetricsPtr + 120, true)\n  };'''
)

replace_exact(
    'receive/main.js',
    '''  anchorBypassAttempts: 0,\n  anchorBypassSuccesses: 0,\n  localRecoveryAttempts: 0,''',
    '''  anchorBypassAttempts: 0,\n  anchorBypassSuccesses: 0,\n  translationAttempts: 0,\n  translationSuccesses: 0,\n  calibrationAttempts: 0,\n  calibrationSuccesses: 0,\n  localRecoveryAttempts: 0,'''
)
replace_exact(
    'receive/main.js',
    '''    hotPathAudit.anchorBypassAttempts += completion.nativeMetrics.anchorBypassAttempts ?? 0;\n    hotPathAudit.anchorBypassSuccesses += completion.nativeMetrics.anchorBypassSuccesses ?? 0;\n  }''',
    '''    hotPathAudit.anchorBypassAttempts += completion.nativeMetrics.anchorBypassAttempts ?? 0;\n    hotPathAudit.anchorBypassSuccesses += completion.nativeMetrics.anchorBypassSuccesses ?? 0;\n    hotPathAudit.translationAttempts += completion.nativeMetrics.translationAttempts ?? 0;\n    hotPathAudit.translationSuccesses += completion.nativeMetrics.translationSuccesses ?? 0;\n    hotPathAudit.calibrationAttempts += completion.nativeMetrics.calibrationAttempts ?? 0;\n    hotPathAudit.calibrationSuccesses += completion.nativeMetrics.calibrationSuccesses ?? 0;\n  }'''
)
replace_exact(
    'receive/main.js',
    '''Calibration ${hotPathAudit.anchorSuccesses}/${hotPathAudit.anchorSuccesses + hotPathAudit.anchorMisses} · frame misses ${hotPathAudit.outOfFrameMisses} · bitstream ${hotPathAudit.bitstreamFailures} · CRC ${hotPathAudit.crcFailures}\nCached map CRC ${hotPathAudit.fastSamplerSuccesses}/${hotPathAudit.fastSamplerAttempts} · Hybrid fallback CRC ${hotPathAudit.anchorBypassSuccesses}/${hotPathAudit.anchorBypassAttempts}''',
    '''Motion ${hotPathAudit.translationSuccesses}/${hotPathAudit.translationAttempts} · calibration ${hotPathAudit.calibrationSuccesses}/${hotPathAudit.calibrationAttempts} · frame misses ${hotPathAudit.outOfFrameMisses}\nCached map CRC ${hotPathAudit.fastSamplerSuccesses}/${hotPathAudit.fastSamplerAttempts} · bitstream ${hotPathAudit.bitstreamFailures} · CRC ${hotPathAudit.crcFailures} · Hybrid fallback ${hotPathAudit.anchorBypassSuccesses}/${hotPathAudit.anchorBypassAttempts}'''
)
