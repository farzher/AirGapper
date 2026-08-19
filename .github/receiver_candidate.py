from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:160]!r}")
    p.write_text(text.replace(old, new, 1))


# Auto may now legitimately resolve to a 1x1 wall to preserve the requested
# on-screen module-pixel floor. The extended-grid wire format intentionally
# represents multi-slot dynamic walls only (gridCount >= 2). A 1x1 Auto wall
# must therefore use the existing legacy 1x1 layout encoding: layoutId 0,
# slotIndex 0. This is byte-compatible with every receiver and avoids
# "Frame metadata exceeds its packed field" on mobile density fallback.
replace_once(
    "send/main.js",
    '  const extendedGrid = Boolean(autoGrid);',
    '  const extendedGrid = Boolean(autoGrid && gridCodes > 1);'
)
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.341";', 'const SEND_RUNTIME_BUILD = "v0.5.342";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.341";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.342";')
replace_once("main.js", 'const APP_BUILD = "v0.5.341";', 'const APP_BUILD = "v0.5.342";')
replace_once("index.html", 'AirGapper <span class="app-version">v0.5.341</span>', 'AirGapper <span class="app-version">v0.5.342</span>')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v289";', 'const CACHE = "airgapper-static-js-v290";')

print("v0.5.342 candidate applied")
