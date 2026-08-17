from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing anchor in {path}: {old!r}")
    p.write_text(s.replace(old, new, 1))


replace_once("index.html", "v0.5.170", "v0.5.171")
replace_once("main.js", 'const APP_BUILD = "v0.5.170";', 'const APP_BUILD = "v0.5.171";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.170";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.171";')
replace_once("sw.js", 'airgapper-static-js-v132', 'airgapper-static-js-v133')

p = Path("receive/main.js")
s = p.read_text()
replacements = {
    'const PORTFOLIO_EVAL_MS = 1500;': 'const PORTFOLIO_EVAL_MS = 2200;',
    'const PORTFOLIO_SHRINK_STEP = 2;': 'const PORTFOLIO_SHRINK_STEP = 1;',
    'const PORTFOLIO_PRESSURE_UTIL = 0.86;': 'const PORTFOLIO_PRESSURE_UTIL = 0.84;',
    'const PORTFOLIO_PRESSURE_COVERAGE = 0.90;': 'const PORTFOLIO_PRESSURE_COVERAGE = 0.92;',
    'const PORTFOLIO_HEADROOM_UTIL = 0.72;': 'const PORTFOLIO_HEADROOM_UTIL = 0.78;',
    'const PORTFOLIO_KEEP_SHRINK_RATIO = 0.97;': 'const PORTFOLIO_KEEP_SHRINK_RATIO = 1.01;',
    'const PORTFOLIO_KEEP_GROW_RATIO = 1.02;': 'const PORTFOLIO_KEEP_GROW_RATIO = 0.99;',
}
for old, new in replacements.items():
    if old not in s:
        raise SystemExit(f"missing constant: {old}")
    s = s.replace(old, new, 1)

old = '''  const pressure = captureRate >= 12 && (\n    utilization >= PORTFOLIO_PRESSURE_UTIL || busyRate >= 2 ||\n    coverage < PORTFOLIO_PRESSURE_COVERAGE && utilization >= 0.7\n  );\n  const headroom = captureRate >= 12 && coverage >= 0.94 && utilization <= PORTFOLIO_HEADROOM_UTIL && busyRate < 1;\n'''
new = '''  // Throughput-first pressure: worker-busy events are harmless when we are\n  // still consuming nearly every camera frame. Only shrink the QR portfolio\n  // when saturation is causing real schedule loss. This prevents the controller\n  // from trading useful QR opportunities merely to make worker occupancy pretty.\n  const overloaded = utilization >= PORTFOLIO_PRESSURE_UTIL || busyRate >= 2;\n  const pressure = captureRate >= 12 && (\n    coverage < PORTFOLIO_PRESSURE_COVERAGE && overloaded ||\n    coverage < 0.97 && utilization >= 0.95\n  );\n  const headroom = captureRate >= 12 && coverage >= 0.94 && utilization <= PORTFOLIO_HEADROOM_UTIL;\n'''
if old not in s:
    raise SystemExit("pressure formula anchor missing")
s = s.replace(old, new, 1)
p.write_text(s)
