from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:160]!r}")
    p.write_text(text.replace(old, new, 1))


send = "send/main.js"
replace_once(send, 'const SEND_RUNTIME_BUILD = "v0.5.340";', 'const SEND_RUNTIME_BUILD = "v0.5.341";')
# v340 admitted 1x1 to the Auto catalog but an older inner-loop guard still
# rejected it. The hard px floor must win even when only one QR can fit.
replace_once(send,
    '      if (codes <= 1 || codes > AUTO_GRID_MAX_CODES) continue;',
    '      if (codes < 1 || codes > AUTO_GRID_MAX_CODES) continue;')
# Close the floating Settings panel when tapping elsewhere.
replace_once(send,
    '  if (sendSettingsPanel?.hidden !== false && sendControls && !sendControls.contains(event.target)) {',
    '  if (sendSettingsPanel?.hidden === false && sendControls && !sendControls.contains(event.target)) {')

replace_once("index.html", '<span class="brand">AirGapper <span class="app-version">v0.5.340</span></span>', '<span class="brand">AirGapper <span class="app-version">v0.5.341</span></span>')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.340";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.341";')
replace_once("main.js", 'const APP_BUILD = "v0.5.340";', 'const APP_BUILD = "v0.5.341";')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v288";', 'const CACHE = "airgapper-static-js-v289";')

print("v0.5.341 candidate applied")
