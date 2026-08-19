from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:180]!r}")
    p.write_text(text.replace(old, new, 1))

send = "send/main.js"
replace_once(send, 'const SEND_RUNTIME_BUILD = "v0.5.346";', 'const SEND_RUNTIME_BUILD = "v0.5.347";')

replace_once(send,
'''function showStreamPanels(visible) {
  sendControls.hidden = !visible;
  if (!visible) setSenderSettingsOpen(false);
}
''',
'''function showStreamPanels(visible, closeSettings = false) {
  sendControls.hidden = !visible;
  // Geometry/transport rebuilds briefly hide the toolbar. That is an internal
  // render transition, not a user request to dismiss Settings. Preserve the
  // popup while editing and only close it at a real send-session boundary.
  if (closeSettings) setSenderSettingsOpen(false);
}
''')

# Real session exits still dismiss Settings.
old = '''  if (sendStart) sendStart.hidden = false;
  showStreamPanels(false);
  cfgFile.value = "";
'''
new = '''  if (sendStart) sendStart.hidden = false;
  showStreamPanels(false, true);
  cfgFile.value = "";
'''
replace_once(send, old, new)

old2 = '''  if (sendStart) sendStart.hidden = false;
  showStreamPanels(false);
  paneFile.hidden = false;
'''
new2 = '''  if (sendStart) sendStart.hidden = false;
  showStreamPanels(false, true);
  paneFile.hidden = false;
'''
replace_once(send, old2, new2)

replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.346";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.347";')
replace_once("main.js", 'const APP_BUILD = "v0.5.346";', 'const APP_BUILD = "v0.5.347";')
replace_once("index.html", '<span class="brand">AirGapper <span class="app-version">v0.5.346</span></span>', '<span class="brand">AirGapper <span class="app-version">v0.5.347</span></span>')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v294";', 'const CACHE = "airgapper-static-js-v295";')

print("v0.5.347 candidate applied")
