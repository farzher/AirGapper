const receiverSettings = document.querySelector(".receiver-settings");
const receiverDevActions = document.querySelector(".receiver-dev-actions");
const DEV_SETTINGS_TOGGLE_WINDOW_MS = 1000;
const DEVELOPER_MODE_EVER_KEY = "airgapper:developer-mode-ever:v1";
const settingsToggleTimes = [];
let previousSettingsToggleAt = 0;
let receiverDevToolsPromise;

function loadReceiverDevTools() {
  if (!receiverDevToolsPromise) {
    receiverDevToolsPromise = Promise.all([
      import("./phase-nudge.js").then(() => import("./auto-phase.js")),
      import("./agcap.js"),
      import("./dev-tools.js")
    ]);
  }
  return receiverDevToolsPromise;
}

receiverSettings?.addEventListener("toggle", (event) => {
  // This module loads before runtime.js and owns the unlock gesture so the old
  // 500 ms listener cannot also evaluate the same toggle.
  event.stopImmediatePropagation();

  const now = performance.now();
  const slowToggle = previousSettingsToggleAt > 0 &&
    now - previousSettingsToggleAt > DEV_SETTINGS_TOGGLE_WINDOW_MS;
  previousSettingsToggleAt = now;

  if (receiverDevActions && !receiverDevActions.hidden) {
    if (!receiverSettings.open || !slowToggle) return;
    receiverDevActions.hidden = true;
    settingsToggleTimes.length = 0;
  }

  settingsToggleTimes.push(now);
  while (settingsToggleTimes.length &&
      settingsToggleTimes[0] < now - DEV_SETTINGS_TOGGLE_WINDOW_MS) {
    settingsToggleTimes.shift();
  }

  if (receiverSettings.open && settingsToggleTimes.length >= 3 && receiverDevActions) {
    receiverDevActions.hidden = false;
    settingsToggleTimes.length = 0;
    void loadReceiverDevTools();
    try { localStorage.setItem(DEVELOPER_MODE_EVER_KEY, "1"); } catch {}
  }
});
