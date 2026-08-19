from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:160]!r}")
    p.write_text(text.replace(old, new, 1))


# Completion assembly/verification is intentionally synchronous and can block the
# main thread for a noticeable interval. Merely writing 100% and yielding one
# rAF/timer turn does not guarantee that Android Chrome has presented that state
# before the blocking work begins. Keep the snapped 100% / Processing state alive
# across at least one completed frame and a short idle window. Transfer timing is
# already frozen at the final useful camera scan, so this UI-only hold cannot
# reduce the reported optical throughput.
replace_once(
    "receive/main.js",
    'requestAnimationFrame(() => setTimeout(resolve, 0))',
    'requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)))'
)
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.342";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.343";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.342";', 'const SEND_RUNTIME_BUILD = "v0.5.343";')
replace_once("main.js", 'const APP_BUILD = "v0.5.342";', 'const APP_BUILD = "v0.5.343";')
replace_once("index.html", 'AirGapper <span class="app-version">v0.5.342</span>', 'AirGapper <span class="app-version">v0.5.343</span>')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v290";', 'const CACHE = "airgapper-static-js-v291";')

print("v0.5.343 candidate applied")
