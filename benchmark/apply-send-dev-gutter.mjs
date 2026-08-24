import fs from "node:fs";

function edit(path, edits) {
  let text = fs.readFileSync(path, "utf8");
  for (const [from, to, label] of edits) {
    if (!text.includes(from)) throw new Error(`${path}: missing ${label}`);
    text = text.replace(from, to);
  }
  fs.writeFileSync(path, text);
}

edit("receive/runtime.js", [[
  'const DEV_SETTINGS_TOGGLE_WINDOW_MS = 500;',
  'const DEV_SETTINGS_TOGGLE_WINDOW_MS = 1000;',
  "receive developer toggle window"
]]);

edit("index.html", [[
`              </div>\n            </div>\n          </div>\n        </div>\n      </div>\n      <div class="hint status-line" id="specs"></div>`,
`              </div>\n              <div class="send-dev-actions" id="send-dev-actions" hidden>\n                <label><span>Side gutter</span><span class="send-dev-value" id="cfg-side-gutter-value">0 px / side</span><input id="cfg-side-gutter" type="range" min="0" max="96" step="4" value="0" aria-label="Side gutter for curved displays" /></label>\n              </div>\n            </div>\n          </div>\n        </div>\n      </div>\n      <div class="hint status-line" id="specs"></div>`,
  "send developer controls"
]]);

edit("shared/style.css", [[
`.send-settings-grid input { margin-top: 2px; }\n.send-settings-grid .speed-control.has-custom { display: grid; grid-template-columns: minmax(0, 3fr) minmax(64px, 2fr); }`,
`.send-settings-grid input { margin-top: 2px; }\n.send-dev-actions { margin-top: 11px; padding-top: 10px; border-top: 1px solid var(--line); }\n.send-dev-actions[hidden] { display: none; }\n.send-dev-actions label { display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; align-items: center; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }\n.send-dev-actions input { grid-column: 1 / -1; width: 100%; margin: 2px 0 0; }\n.send-dev-value { color: var(--muted); font-size: 10px; font-weight: 500; letter-spacing: 0; text-transform: none; }\n.send-settings-grid .speed-control.has-custom { display: grid; grid-template-columns: minmax(0, 3fr) minmax(64px, 2fr); }`,
  "send developer styles"
]]);

edit("send/main.js", [
[
`const SEND_SETTINGS_KEY = "airgapper:send-settings:v2";`,
`const SEND_SETTINGS_KEY = "airgapper:send-settings:v2";\nconst SEND_DEV_TOGGLE_WINDOW_MS = 1000;`,
"send developer toggle constant"
],
[
`const sendSettingsPanel = document.getElementById("send-settings-panel");\nconst stageBottom = document.getElementById("stage-bottom");`,
`const sendSettingsPanel = document.getElementById("send-settings-panel");\nconst sendDevActions = document.getElementById("send-dev-actions");\nconst cfgSideGutter = document.getElementById("cfg-side-gutter");\nconst cfgSideGutterValue = document.getElementById("cfg-side-gutter-value");\nconst stageBottom = document.getElementById("stage-bottom");`,
"send developer DOM"
],
[
`sendSettingsToggle?.addEventListener("click", () => {\n  setSenderSettingsOpen(sendSettingsPanel?.hidden !== false);\n});`,
`const sendSettingsToggleTimes = [];\nlet previousSendSettingsToggleAt = 0;\nfunction noteSendDeveloperToggle(open) {\n  const now = performance.now();\n  const slowToggle = previousSendSettingsToggleAt > 0 && now - previousSendSettingsToggleAt > SEND_DEV_TOGGLE_WINDOW_MS;\n  previousSendSettingsToggleAt = now;\n  if (sendDevActions && !sendDevActions.hidden) {\n    // Mirror Receive: closing keeps dev controls armed; a later slow open hides them.\n    if (!open || !slowToggle) return;\n    sendDevActions.hidden = true;\n    sendSettingsToggleTimes.length = 0;\n    return;\n  }\n  sendSettingsToggleTimes.push(now);\n  while (sendSettingsToggleTimes.length && sendSettingsToggleTimes[0] < now - SEND_DEV_TOGGLE_WINDOW_MS) sendSettingsToggleTimes.shift();\n  if (open && sendSettingsToggleTimes.length >= 3 && sendDevActions) {\n    sendDevActions.hidden = false;\n    sendSettingsToggleTimes.length = 0;\n  }\n}\nsendSettingsToggle?.addEventListener("click", () => {\n  const open = sendSettingsPanel?.hidden !== false;\n  setSenderSettingsOpen(open);\n  noteSendDeveloperToggle(open);\n});`,
"send developer reveal"
],
[
`function selectedUpdatePattern() {\n  const value = cfgUpdatePattern?.value;\n  return value === "synchronous" || value === "fixed" || value === "fixed-columns" || value === "dispersed" ? value : "synchronous";\n}`,
`function selectedUpdatePattern() {\n  const value = cfgUpdatePattern?.value;\n  return value === "synchronous" || value === "fixed" || value === "fixed-columns" || value === "dispersed" ? value : "synchronous";\n}\nfunction selectedSideGutter() {\n  const value = Number(cfgSideGutter?.value);\n  return Number.isFinite(value) ? Math.max(0, Math.min(96, Math.round(value / 4) * 4)) : 0;\n}\nfunction syncSideGutterOutput() {\n  if (cfgSideGutterValue) cfgSideGutterValue.textContent = `${selectedSideGutter()} px / side`;\n}\nfunction widthAfterSideGutter(width) {\n  return Math.max(1, width - selectedSideGutter() * 2);\n}`,
"send gutter helpers"
],
[
`      width: Math.max(1, Number(viewport?.width) || window.innerWidth),`,
`      width: widthAfterSideGutter(Math.max(1, Number(viewport?.width) || window.innerWidth)),`,
"fullscreen gutter budget"
],
[
`      width: Math.max(1, rect.width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)),`,
`      width: widthAfterSideGutter(Math.max(1, rect.width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight))),`,
"stage gutter budget"
],
[
`    width: Math.max(1, Math.min(1400, window.innerWidth - 24)),`,
`    width: widthAfterSideGutter(Math.max(1, Math.min(1400, window.innerWidth - 24))),`,
"fallback gutter budget"
],
[
`    if (saved.orientation === "auto" || saved.orientation === "portrait" || saved.orientation === "landscape") {\n      cfgOrientation.value = saved.orientation;\n    }`,
`    if (saved.orientation === "auto" || saved.orientation === "portrait" || saved.orientation === "landscape") {\n      cfgOrientation.value = saved.orientation;\n    }\n    if (typeof saved.sideGutter === "number" && Number.isFinite(saved.sideGutter) && cfgSideGutter) {\n      cfgSideGutter.value = String(Math.max(0, Math.min(96, Math.round(saved.sideGutter / 4) * 4)));\n    }\n    syncSideGutterOutput();`,
"restore gutter"
],
[
`      updatePattern: selectedUpdatePattern(),\n      orientation: selectedOrientation()`,
`      updatePattern: selectedUpdatePattern(),\n      orientation: selectedOrientation(),\n      sideGutter: selectedSideGutter()`,
"save gutter"
],
[
`  for (const el of [cfgSize, cfgScaling, cfgLayout, cfgUpdatePattern, cfgOrientation]) {\n    el.addEventListener("change", () => {\n      if (el === cfgLayout || el === cfgSize) updateAutoGridControlState();\n      saveSendSettings();\n      void startStream();\n    });\n  }`,
`  for (const el of [cfgSize, cfgScaling, cfgLayout, cfgUpdatePattern, cfgOrientation]) {\n    el.addEventListener("change", () => {\n      if (el === cfgLayout || el === cfgSize) updateAutoGridControlState();\n      saveSendSettings();\n      void startStream();\n    });\n  }\n  cfgSideGutter?.addEventListener("input", syncSideGutterOutput);\n  cfgSideGutter?.addEventListener("change", () => {\n    syncSideGutterOutput();\n    saveSendSettings();\n    if (selectedFile) void startStream();\n  });`,
"gutter listeners"
]
]);

edit("version.js", [[
  'export const APP_VERSION = "0.5.413";',
  'export const APP_VERSION = "0.5.414";',
  "version bump"
]]);

console.log("AIRGAPPER_SEND_DEV_GUTTER_APPLIED");
