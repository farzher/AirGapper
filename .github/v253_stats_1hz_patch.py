from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'{path}: patch anchor missing')
    p.write_text(text.replace(old, new, 1))

replace_once(
    'receive/main.js',
    'const STATS_TICK_MS = 100;\nconst DIAGNOSTICS_TICK_MS = 250;',
    '// Keep visible rolling status intentionally calm/readable: one DOM refresh per second.\n// The underlying event timestamps remain precise; only presentation is 1 Hz.\nconst STATS_TICK_MS = 1000;\nconst DIAGNOSTICS_TICK_MS = 1000;'
)

for path in ['main.js', 'receive/main.js', 'index.html']:
    replace_once(path, 'v0.5.252', 'v0.5.253')
replace_once('sw.js', 'airgapper-static-js-v208', 'airgapper-static-js-v209')

replace_once(
    'benchmark/README.md',
    'The receiver UI `fps` metric means **decoder-processed camera frames per second (CPU throughput)**, not camera delivery rate. Camera capture/delivery FPS belongs in developer diagnostics.\n',
    'The receiver UI `fps` metric means **decoder-processed camera frames per second (CPU throughput)**, not camera delivery rate. Camera capture/delivery FPS belongs in developer diagnostics.\n\nLive status DOM updates are intentionally **1 Hz** for readability and to avoid unnecessary main-thread UI churn. The rolling measurements still use their normal timestamped 1-second window.\n'
)
