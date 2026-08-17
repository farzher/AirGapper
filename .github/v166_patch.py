from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing anchor in {path}: {old!r}")
    p.write_text(text.replace(old, new, 1))

replace_once("index.html", "v0.5.165", "v0.5.166")
replace_once("main.js", 'const APP_BUILD = "v0.5.165";', 'const APP_BUILD = "v0.5.166";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.165";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.166";')
replace_once("receive/main.js", 'const GUIDED_ROBUST_SCOUT_EVERY = 12;', 'const GUIDED_ROBUST_SCOUT_EVERY = 30;')
replace_once("sw.js", 'airgapper-static-js-v127', 'airgapper-static-js-v128')
