from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:160]!r}")
    p.write_text(text.replace(old, new, 1))


# ---------------------------------------------------------------------------
# Sender behavior: hard on-screen module density + clean control surface.
# ---------------------------------------------------------------------------
send = "send/main.js"
replace_once(send, 'const SEND_RUNTIME_BUILD = "v0.5.336";', 'const SEND_RUNTIME_BUILD = "v0.5.340";')

# Auto is allowed to reduce all the way to one QR before violating density.
replace_once(send,
    '      if (codes <= 1 || codes > AUTO_GRID_MAX_CODES) continue;',
    '      if (codes < 1 || codes > AUTO_GRID_MAX_CODES) continue;')

replace_once(send,
    'const selectionSummary = document.getElementById("selection-summary");\nconst sendControls = document.getElementById("send-controls");\nconst stageBottom = document.getElementById("stage-bottom");',
    'const selectionSummary = document.getElementById("selection-summary");\nconst sendControls = document.getElementById("send-controls");\nconst sendSettingsToggle = document.getElementById("send-settings-toggle");\nconst sendSettingsPanel = document.getElementById("send-settings-panel");\nconst stageBottom = document.getElementById("stage-bottom");')

replace_once(send,
'''function showStreamPanels(visible) {
  sendControls.hidden = !visible;
}
''',
'''function setSenderSettingsOpen(open) {
  if (!sendSettingsPanel || !sendSettingsToggle) return;
  sendSettingsPanel.hidden = !open;
  sendSettingsToggle.setAttribute("aria-expanded", open ? "true" : "false");
}
function showStreamPanels(visible) {
  sendControls.hidden = !visible;
  if (!visible) setSenderSettingsOpen(false);
}
sendSettingsToggle?.addEventListener("click", () => {
  setSenderSettingsOpen(sendSettingsPanel?.hidden !== false);
});
document.addEventListener("pointerdown", (event) => {
  if (sendSettingsPanel?.hidden !== false && sendControls && !sendControls.contains(event.target)) {
    setSenderSettingsOpen(false);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setSenderSettingsOpen(false);
});
''')

replace_once(send,
    '  return Number.isFinite(value) ? Math.max(1, Math.min(480, Math.round(value))) : 15;',
    '  return Number.isFinite(value) ? Math.max(1, Math.min(480, Math.round(value))) : 30;')

replace_once(send,
    '    ? `Auto ${autoGridTargetModulePx()} uses this Size when it fits and steps down only when needed`',
    '    ? `${autoGridTargetModulePx()}px Auto uses this Size when it fits and steps down only when needed`')

# chooseAutoGrid currently measures moduleScale in backing/device pixels. The UI
# and the camera care about angular/on-screen size, so Auto N is a hard CSS-pixel
# minimum. High-DPI phones must not turn 2px Auto into <1 CSS px/module.
replace_once(send,
'''      const availableScale = Math.min(budgetW / displayW, budgetH / displayH);
      const moduleScale = fitScaling ? availableScale : Math.floor(availableScale);
      if (!(moduleScale > 0)) continue;
      const renderedW = displayW * moduleScale;
''',
'''      const availableScale = Math.min(budgetW / displayW, budgetH / displayH);
      const moduleScale = fitScaling ? availableScale : Math.floor(availableScale);
      if (!(moduleScale > 0)) continue;
      const displayModulePx = moduleScale / dpr;
      const renderedW = displayW * moduleScale;
''')

replace_once(send,
'''        codes,
        moduleScale,
        screenFill,
''',
'''        codes,
        moduleScale,
        displayModulePx,
        screenFill,
''')

replace_once(send,
    '  const densityCandidates = candidates.filter((candidate) => candidate.moduleScale >= densityTarget);',
    '  const densityCandidates = candidates.filter((candidate) => candidate.displayModulePx + 1e-9 >= densityTarget);')
replace_once(send,
    '      `Auto ${densityTarget} cannot fit ${formatBytes(requestedMaximumFrameBytes)} or any smaller Size at ${densityTarget} px/module in this viewport.`',
    '      `${densityTarget}px Auto cannot fit ${formatBytes(requestedMaximumFrameBytes)} or any smaller Size at ${densityTarget} on-screen px/module in this viewport.`')

# Keep the verbose description available to diagnostics/code, but do not show it
# in the normal sender UI anymore.
replace_once(send,
    'return `Auto ${autoGrid.targetModulePx} · ${gridCols}×${gridRows} · ${gridCodes} QR · v${transport.qrVersion} · ${formatBytes(transport.frameBytes)}/QR · ${autoGrid.moduleScale.toFixed(2)} display px/module · ${Math.round(autoGrid.screenFill * 100)}% screen · ${txFps} fps · ${Math.round(autoGrid.refreshHz)} Hz display · ${autoGrid.changesPerRefresh.toFixed(2)} QR changes/refresh · ${updatePatternLabel}${sizeFallback}${fallback}`;',
    'return `${autoGrid.targetModulePx}px Auto · ${gridCols}×${gridRows} · ${gridCodes} QR · v${transport.qrVersion} · ${formatBytes(transport.frameBytes)}/QR · ${autoGrid.displayModulePx.toFixed(2)} on-screen px/module · ${Math.round(autoGrid.screenFill * 100)}% screen · ${txFps} fps · ${Math.round(autoGrid.refreshHz)} Hz display · ${autoGrid.changesPerRefresh.toFixed(2)} QR changes/refresh · ${updatePatternLabel}${sizeFallback}${fallback}`;')

text = Path(send).read_text()
if text.count('setStatus(describeGrid());') != 2:
    raise SystemExit(f"expected two sender description status sites, found {text.count('setStatus(describeGrid());')}")
text = text.replace('setStatus(describeGrid());', 'setStatus("");')
Path(send).write_text(text)

# ---------------------------------------------------------------------------
# Sender markup: two-button surface, settings hidden in a compact popover.
# ---------------------------------------------------------------------------
html = "index.html"
p = Path(html)
text = p.read_text()
text = text.replace('<span class="brand">AirGapper <span class="app-version">v0.5.336</span></span>',
                    '<span class="brand">AirGapper <span class="app-version">v0.5.340</span></span>', 1)
old_start = '          <div class="selection-summary" id="selection-summary" hidden></div>\n          <div class="send-controls" id="send-controls" hidden>\n'
old_end = '            <div class="send-link-control"><span>Receive</span><button class="secondary-button" id="send-receiver-link-open" type="button">Show QR</button></div>\n          </div>\n'
start = text.find(old_start)
if start < 0:
    raise SystemExit("missing sender controls start")
end = text.find(old_end, start)
if end < 0:
    raise SystemExit("missing sender controls end")
end += len(old_end)
new_controls = '''          <div class="selection-summary" id="selection-summary" hidden></div>
          <div class="send-toolbar" id="send-controls" hidden>
            <button class="secondary-button send-toolbar-button" id="send-settings-toggle" type="button" aria-expanded="false" aria-controls="send-settings-panel">Settings</button>
            <button class="secondary-button send-toolbar-button" id="send-receiver-link-open" type="button">Receive QR</button>
            <div class="send-settings-panel" id="send-settings-panel" hidden>
              <div class="send-settings-grid">
                <label class="speed-control"><span>Speed</span><select id="cfg-fps"><option value="1">1 fps</option><option value="5">5 fps</option><option value="10">10 fps</option><option value="15">15 fps</option><option value="20">20 fps</option><option value="24">24 fps</option><option value="30" selected>30 fps</option><option value="55">55 fps</option><option value="60">60 fps</option><option value="custom">Custom…</option></select><input id="cfg-fps-custom" type="number" min="1" max="480" step="1" value="30" aria-label="Custom frames per second" hidden /></label>
                <label><span>Size</span><select id="cfg-size"></select></label>
                <label><span>Layout</span><select id="cfg-layout"><option value="auto-1">1px Auto</option><option value="auto-2" selected>2px Auto</option><option value="auto-3">3px Auto</option><option value="auto-4">4px Auto</option><option value="single">1:1</option><option value="one-two">1:2</option><option value="two-two">2:2</option><option value="two-three">2:3</option><option value="four-three">3:4</option><option value="three-five">3:5</option><option value="three-six">3:6</option><option value="four-six">4:6</option><option value="four-seven">4:7</option><option value="four-eight">4:8</option></select></label>
                <label><span>Update</span><select id="cfg-update-pattern"><option value="synchronous">Synchronous</option><option value="fixed">Fixed rows</option><option value="fixed-columns">Fixed columns</option><option value="dispersed" selected>Dispersed</option></select></label>
                <label><span>Orientation</span><select id="cfg-orientation"><option value="auto" selected>Auto</option><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
                <label><span>Scaling</span><select id="cfg-scaling"><option value="integer">Pixel perfect</option><option value="fit">Fit screen</option></select></label>
              </div>
            </div>
          </div>
'''
text = text[:start] + new_controls + text[end:]
p.write_text(text)

# ---------------------------------------------------------------------------
# Sender CSS: clean two-button toolbar; settings float above without changing
# QR viewport geometry. Keep the verbose status line absent when empty.
# ---------------------------------------------------------------------------
style = "shared/style.css"
replace_once(style,
'''.stage-bottom { width: min(100%, 920px); flex: none; padding: 0 10px 8px; }
.selection-summary { display: flex; justify-content: space-between; gap: 20px; padding: 6px 4px; color: var(--muted); font-size: 11px; }
.selection-summary span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.selection-summary span:last-child { flex: none; font-variant-numeric: tabular-nums; }
.send-controls { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); align-items: start; gap: 12px; padding: 8px 4px 0; border-top: 1px solid var(--line); }
.send-controls label,
.send-link-control { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.send-link-control .secondary-button { width: 100%; min-height: 34px; padding: 5px 8px; color: var(--ink); background: var(--bg); border-radius: 8px; }
.send-controls select,
.send-controls input { width: 100%; }
.send-controls input { margin-top: 2px; }
.send-controls .speed-control.has-custom { display: grid; grid-template-columns: minmax(0, 3fr) minmax(64px, 2fr); }
.speed-control span { grid-column: 1 / -1; }
.speed-control input { margin: 0; }
''',
'''.stage-bottom { width: min(100%, 920px); flex: none; padding: 0 10px 8px; }
/* The active sender intentionally exposes only two controls. File details and
   transport diagnostics belong in Settings/dev tooling, not the transfer UI. */
.selection-summary { display: none !important; }
.send-toolbar { position: relative; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; padding: 8px 4px 0; border-top: 1px solid var(--line); }
.send-toolbar-button { width: 100%; min-height: 38px; background: var(--card); font-weight: 650; }
.send-settings-panel { position: absolute; z-index: 12; left: 4px; right: 4px; bottom: calc(100% + 8px); padding: 12px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 14px 38px #0002; }
.send-settings-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 12px; }
.send-settings-grid label { display: flex; flex-direction: column; gap: 4px; min-width: 0; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
.send-settings-grid select,
.send-settings-grid input { width: 100%; min-width: 0; }
.send-settings-grid input { margin-top: 2px; }
.send-settings-grid .speed-control.has-custom { display: grid; grid-template-columns: minmax(0, 3fr) minmax(64px, 2fr); }
.speed-control span { grid-column: 1 / -1; }
.speed-control input { margin: 0; }
#specs:empty { display: none; }
''')
replace_once(style,
    '  .send-controls { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }',
    '  .send-settings-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }')

# ---------------------------------------------------------------------------
# Version/cache bump. Receiver logic is unchanged but its diagnostic build should
# match the shipped app version.
# ---------------------------------------------------------------------------
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.339";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.340";')
replace_once("main.js", 'const APP_BUILD = "v0.5.339";', 'const APP_BUILD = "v0.5.340";')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v287";', 'const CACHE = "airgapper-static-js-v288";')

print("v0.5.340 candidate applied")
