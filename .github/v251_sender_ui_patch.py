from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'{path}: patch anchor missing')
    p.write_text(text.replace(old, new, 1))

# Sender controls: keep layout labels consistent and add a button that opens the
# existing receiver-link QR dialog.
replace_once(
    'index.html',
    '<label><span>Layout</span><select id="cfg-layout"><option value="single" selected>1:1</option><option value="one-two">1:2</option><option value="two-two">2:2</option><option value="two-three">2:3</option><option value="four-three">3:4</option><option value="three-five">3:5</option><option value="three-six">3:6</option><option value="four-six">4:6 · 24</option><option value="four-seven">4:7 · 28</option><option value="four-eight">4:8 · 32</option></select></label>',
    '<label><span>Layout</span><select id="cfg-layout"><option value="single" selected>1:1</option><option value="one-two">1:2</option><option value="two-two">2:2</option><option value="two-three">2:3</option><option value="four-three">3:4</option><option value="three-five">3:5</option><option value="three-six">3:6</option><option value="four-six">4:6</option><option value="four-seven">4:7</option><option value="four-eight">4:8</option></select></label>'
)
replace_once(
    'index.html',
    '<label><span>Scaling</span><select id="cfg-scaling"><option value="integer">Pixel perfect</option><option value="fit">Fit screen</option></select></label>\n          </div>',
    '<label><span>Scaling</span><select id="cfg-scaling"><option value="integer">Pixel perfect</option><option value="fit">Fit screen</option></select></label>\n            <div class="send-link-control"><span>Receiver</span><button class="secondary-button" id="send-receiver-link-open" type="button">Show QR</button></div>\n          </div>'
)

# Reuse the existing receiver QR dialog from both the home-page logo and the
# sender control. The header logo belongs only on Home now.
replace_once(
    'main.js',
    'const headerQrButton = document.getElementById("receiver-link-open");\nconst receiverLinkDialog = document.getElementById("receiver-link-dialog");',
    'const headerQrButton = document.getElementById("receiver-link-open");\nconst sendReceiverLinkButton = document.getElementById("send-receiver-link-open");\nconst receiverLinkDialog = document.getElementById("receiver-link-dialog");'
)
replace_once(
    'main.js',
    'headerQrButton.addEventListener("click", () => receiverLinkDialog.showModal());\ncloseOnBackdropClick(receiverLinkDialog);',
    'const openReceiverLinkDialog = () => receiverLinkDialog.showModal();\nheaderQrButton.addEventListener("click", openReceiverLinkDialog);\nsendReceiverLinkButton?.addEventListener("click", openReceiverLinkDialog);\ncloseOnBackdropClick(receiverLinkDialog);'
)
replace_once(
    'main.js',
    'headerQrButton.hidden = name === "receive";',
    'headerQrButton.hidden = name !== "home";'
)

# Six sender controls on desktop; mobile remains the existing two-column grid.
replace_once(
    'shared/style.css',
    '.send-controls { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); align-items: start; gap: 12px; padding: 8px 4px 0; border-top: 1px solid var(--line); }\n.send-controls label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }',
    '.send-controls { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); align-items: start; gap: 12px; padding: 8px 4px 0; border-top: 1px solid var(--line); }\n.send-controls label,\n.send-link-control { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }\n.send-link-control .secondary-button { width: 100%; min-height: 34px; padding: 5px 9px; color: var(--ink); background: var(--card); }'
)

# Completion must visibly paint 100% before *any* completion freeze/assembly
# work. Keep the two-rAF paint fence, then snapshot diagnostics and create the
# actual file.
replace_once(
    'receive/main.js',
    '} else if (decoder.isComplete && !transferFinalizing) {\n    freezeCompletionDiagnostics();\n    void finalizeCompletedTransfer(header.payloadId);\n  }',
    '} else if (decoder.isComplete && !transferFinalizing) {\n    void finalizeCompletedTransfer(header.payloadId);\n  }'
)
replace_once(
    'receive/main.js',
    '  await waitForProgressPaint();\n  if (done || decoder !== completingDecoder || captureGen !== completingGeneration) {\n    transferFinalizing = false;\n    return;\n  }\n  const payload = completingDecoder.assemble();',
    '  await waitForProgressPaint();\n  if (done || decoder !== completingDecoder || captureGen !== completingGeneration) {\n    transferFinalizing = false;\n    return;\n  }\n  freezeCompletionDiagnostics();\n  const payload = completingDecoder.assemble();'
)

# Version/cache bump.
for path in ['main.js', 'receive/main.js', 'index.html']:
    replace_once(path, 'v0.5.250', 'v0.5.251')
replace_once('sw.js', 'airgapper-static-js-v206', 'airgapper-static-js-v207')
