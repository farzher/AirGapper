from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:180]!r}")
    p.write_text(text.replace(old, new, 1))

recv = "receive/main.js"
replace_once(recv, 'const RECEIVER_RUNTIME_BUILD = "v0.5.345";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.346";')

replace_once(recv,
'''const DEV_SETTINGS_TOGGLE_WINDOW_MS = 500;
const settingsToggleTimes = [];
let previousSettingsToggleAt = 0;
''',
'''const DEV_SETTINGS_TOGGLE_WINDOW_MS = 500;
const DEVELOPER_MODE_EVER_KEY = "airgapper:developer-mode-ever:v1";
let developerModeEverUsed = false;
try { developerModeEverUsed = localStorage.getItem(DEVELOPER_MODE_EVER_KEY) === "1"; } catch {}
function rememberDeveloperModeUse() {
  if (developerModeEverUsed) return;
  developerModeEverUsed = true;
  try { localStorage.setItem(DEVELOPER_MODE_EVER_KEY, "1"); } catch {}
}
const settingsToggleTimes = [];
let previousSettingsToggleAt = 0;
''')

replace_once(recv,
'''  if (receiverSettings.open && settingsToggleTimes.length >= 3) receiverDevActions.hidden = false;
});
''',
'''  if (receiverSettings.open && settingsToggleTimes.length >= 3) {
    receiverDevActions.hidden = false;
    rememberDeveloperModeUse();
  }
});
''')

replace_once(recv,
'''  completionDiagnosticsText = diagnosticsText();
  void copyDiagnosticsToClipboard(completionDiagnosticsText, true);
}
''',
'''  completionDiagnosticsText = diagnosticsText();
  // Clipboard mutation is developer behavior. Normal users should never have
  // their clipboard replaced merely because a receive completed. Once this
  // browser/device has actually unlocked Developer Mode, retain the convenient
  // auto-copy behavior across future sessions.
  if (developerModeEverUsed) void copyDiagnosticsToClipboard(completionDiagnosticsText, true);
}
''')

replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.345";', 'const SEND_RUNTIME_BUILD = "v0.5.346";')
replace_once("main.js", 'const APP_BUILD = "v0.5.345";', 'const APP_BUILD = "v0.5.346";')
replace_once("index.html", '<span class="brand">AirGapper <span class="app-version">v0.5.345</span></span>', '<span class="brand">AirGapper <span class="app-version">v0.5.346</span></span>')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v293";', 'const CACHE = "airgapper-static-js-v294";')

print("v0.5.346 candidate applied")
