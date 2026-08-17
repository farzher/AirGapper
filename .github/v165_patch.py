from pathlib import Path
import subprocess

# Restore the exact v0.5.163 decoder/diagnostic files, removing the failed
# v0.5.164 sparse-geometry reuse experiment completely.
BASE = "bc4a6a3725759b5b168badca272ca7f3468b6f8a"
restore = [
    "index.html",
    "main.js",
    "receive/main.js",
    "receive/worker.js",
    "sw.js",
    "vendor/decimen-codec/decimen_codec.js",
    "vendor/decimen-codec/decimen_codec.wasm",
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    "vendor/decimen-codec/source/wrapper/decimen_codec.h",
]
subprocess.run(["git", "checkout", BASE, "--", *restore], check=True)


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing anchor in {path}: {old!r}")
    p.write_text(text.replace(old, new, 1))

# New experiment: exact v163 decoder, one extra worker on 8-thread hardware.
replace_once("index.html", "v0.5.163", "v0.5.165")
replace_once("main.js", 'const APP_BUILD = "v0.5.163";', 'const APP_BUILD = "v0.5.165";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.163";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.165";')
replace_once("receive/main.js",
             'const autoWorkerCount = Math.max(1, Math.min(6, hardwareThreadCount - 1));',
             'const autoWorkerCount = Math.max(1, Math.min(7, hardwareThreadCount - 1));')
replace_once("sw.js", 'airgapper-static-js-v125', 'airgapper-static-js-v127')
