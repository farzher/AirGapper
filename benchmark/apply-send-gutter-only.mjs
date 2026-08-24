import fs from "node:fs";

const path = "send/main.js";
let source = fs.readFileSync(path, "utf8");

function once(from, to, label) {
  if (!source.includes(from)) throw new Error(`send/main.js: missing ${label}`);
  source = source.replace(from, to);
}

once(
  'const SEND_SETTINGS_KEY = "airgapper:send-settings:v2";',
  'const SEND_SETTINGS_KEY = "airgapper:send-settings:v2";\nconst SEND_DEV_TOGGLE_WINDOW_MS = 1000;',
  "settings key"
);

once(
  'const sendSettingsPanel = document.getElementById("send-settings-panel");\nconst stageBottom = document.getElementById("stage-bottom");',
  `const sendSettingsPanel = document.getElementById("send-settings-panel");
const sendDevActions = document.createElement("div");
sendDevActions.id = "send-dev-actions";
sendDevActions.hidden = true;
sendDevActions.style.cssText = "margin-top:11px;padding-top:10px;border-top:1px solid var(--line)";
const sideGutterLabel = document.createElement("label");
sideGutterLabel.style.cssText = "display:grid;grid-template-columns:1fr auto;gap:4px 10px;align-items:center;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em";
const sideGutterName = document.createElement("span");
sideGutterName.textContent = "Side gutter";
const cfgSideGutterValue = document.createElement("span");
cfgSideGutterValue.style.cssText = "color:var(--muted);font-size:10px;font-weight:500;letter-spacing:0;text-transform:none";
const cfgSideGutter = document.createElement("input");
cfgSideGutter.type = "range";
cfgSideGutter.min = "0";
cfgSideGutter.max = "96";
cfgSideGutter.step = "4";
cfgSideGutter.value = "0";
cfgSideGutter.setAttribute("aria-label", "Side gutter for curved displays");
cfgSideGutter.style.cssText = "grid-column:1/-1;width:100%;margin:2px 0 0";
sideGutterLabel.append(sideGutterName, cfgSideGutterValue, cfgSideGutter);
sendDevActions.append(sideGutterLabel);
sendSettingsPanel?.append(sendDevActions);
const stageBottom = document.getElementById("stage-bottom");`,
  "settings panel"
);

once(
`sendSettingsToggle?.addEventListener("click", () => {
  setSenderSettingsOpen(sendSettingsPanel?.hidden !== false);
});`,
`const sendSettingsToggleTimes = [];
let previousSendSettingsToggleAt = 0;
function noteSendDeveloperToggle(open) {
  const now = performance.now();
  const slowToggle = previousSendSettingsToggleAt > 0 &&
    now - previousSendSettingsToggleAt > SEND_DEV_TOGGLE_WINDOW_MS;
  previousSendSettingsToggleAt = now;

  if (!sendDevActions.hidden) {
    if (!open || !slowToggle) return;
    sendDevActions.hidden = true;
    sendSettingsToggleTimes.length = 0;
    return;
  }

  sendSettingsToggleTimes.push(now);
  while (sendSettingsToggleTimes.length &&
      sendSettingsToggleTimes[0] < now - SEND_DEV_TOGGLE_WINDOW_MS) {
    sendSettingsToggleTimes.shift();
  }
  if (open && sendSettingsToggleTimes.length >= 3) {
    sendDevActions.hidden = false;
    sendSettingsToggleTimes.length = 0;
  }
}
sendSettingsToggle?.addEventListener("click", () => {
  const open = sendSettingsPanel?.hidden !== false;
  setSenderSettingsOpen(open);
  noteSendDeveloperToggle(open);
});`,
  "settings toggle"
);

once(
`function selectedUpdatePattern() {
  const value = cfgUpdatePattern?.value;
  return value === "synchronous" || value === "fixed" || value === "fixed-columns" || value === "dispersed" ? value : "synchronous";
}`,
`function selectedUpdatePattern() {
  const value = cfgUpdatePattern?.value;
  return value === "synchronous" || value === "fixed" || value === "fixed-columns" || value === "dispersed" ? value : "synchronous";
}
function selectedSideGutter() {
  const value = Number(cfgSideGutter.value);
  return Number.isFinite(value) ? Math.max(0, Math.min(96, Math.round(value / 4) * 4)) : 0;
}
function syncSideGutterOutput() {
  cfgSideGutterValue.textContent = \`${selectedSideGutter()} px / side\`;
}
function widthAfterSideGutter(width) {
  return Math.max(1, width - selectedSideGutter() * 2);
}
syncSideGutterOutput();`,
  "gutter helpers"
);

once(
  '      width: Math.max(1, Number(viewport?.width) || window.innerWidth),',
  '      width: widthAfterSideGutter(Math.max(1, Number(viewport?.width) || window.innerWidth)),',
  "fullscreen budget"
);
once(
  '      width: Math.max(1, rect.width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)),',
  '      width: widthAfterSideGutter(Math.max(1, rect.width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight))),',
  "stage budget"
);
once(
  '    width: Math.max(1, Math.min(1400, window.innerWidth - 24)),',
  '    width: widthAfterSideGutter(Math.max(1, Math.min(1400, window.innerWidth - 24))),',
  "fallback budget"
);

once(
`    if (saved.orientation === "auto" || saved.orientation === "portrait" || saved.orientation === "landscape") {
      cfgOrientation.value = saved.orientation;
    }`,
`    if (saved.orientation === "auto" || saved.orientation === "portrait" || saved.orientation === "landscape") {
      cfgOrientation.value = saved.orientation;
    }
    if (typeof saved.sideGutter === "number" && Number.isFinite(saved.sideGutter)) {
      cfgSideGutter.value = String(Math.max(0, Math.min(96, Math.round(saved.sideGutter / 4) * 4)));
      syncSideGutterOutput();
    }`,
  "restore settings"
);

once(
`      updatePattern: selectedUpdatePattern(),
      orientation: selectedOrientation()`,
`      updatePattern: selectedUpdatePattern(),
      orientation: selectedOrientation(),
      sideGutter: selectedSideGutter()`,
  "save settings"
);

once(
`  for (const el of [cfgSize, cfgScaling, cfgLayout, cfgUpdatePattern, cfgOrientation]) {
    el.addEventListener("change", () => {
      if (el === cfgLayout || el === cfgSize) updateAutoGridControlState();
      saveSendSettings();
      void startStream();
    });
  }
  cfgFpsCustom.addEventListener("input", () => {`,
`  for (const el of [cfgSize, cfgScaling, cfgLayout, cfgUpdatePattern, cfgOrientation]) {
    el.addEventListener("change", () => {
      if (el === cfgLayout || el === cfgSize) updateAutoGridControlState();
      saveSendSettings();
      void startStream();
    });
  }
  cfgSideGutter.addEventListener("input", syncSideGutterOutput);
  cfgSideGutter.addEventListener("change", () => {
    syncSideGutterOutput();
    saveSendSettings();
    if (selectedFile) void startStream();
  });
  cfgFpsCustom.addEventListener("input", () => {`,
  "gutter listeners"
);

fs.writeFileSync(path, source);
console.log("AIRGAPPER_SEND_GUTTER_ONLY_APPLIED");
