from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:140]!r}")
    p.write_text(text.replace(old, new, 1))


main = "receive/main.js"
replace_once(main, 'const RECEIVER_RUNTIME_BUILD = "v0.5.338";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.339";')

replace_once(main,
    'let streamKey = "";\nlet startTs = 0;\nlet captureGen = 0;',
    'let streamKey = "";\nlet startTs = 0;\nlet completionScanAt = 0;\nlet captureGen = 0;')

# Reset completion timing everywhere the active transfer clock is reset.
text = Path(main).read_text()
text = text.replace('  startTs = 0;\n', '  startTs = 0;\n  completionScanAt = 0;\n')
Path(main).write_text(text)

replace_once(main,
    '  if (startTs) startTs += pausedFor;\n  if (cameraStartedTs) cameraStartedTs += pausedFor;',
    '  if (startTs) startTs += pausedFor;\n  if (completionScanAt) completionScanAt += pausedFor;\n  if (cameraStartedTs) cameraStartedTs += pausedFor;')

replace_once(main,
    '    streamKey = identity;\n    startTs = receiverNow();\n    progressEl.style.display = "block";',
    '    streamKey = identity;\n    // Start on the first accepted camera scan below, after TransportDecoder has\n    // actually consumed it. Do not include pre-stream camera/acquisition time.\n    startTs = 0;\n    completionScanAt = 0;\n    progressEl.style.display = "block";')

replace_once(main,
    '  decoder.addFrame(header.seq, block);\n  const receivedAt = receiverNow();\n  const duplicateFrame = decoder.framesNew === framesNewBefore;',
    '  decoder.addFrame(header.seq, block);\n  const receivedAt = receiverNow();\n  // Time optical transfer using the source scan timestamp, not worker-result\n  // arrival. Decoder latency can vary by hundreds of milliseconds and must not\n  // bias the first/last-scan throughput measurement.\n  const transferScanAt = info?.scanId === void 0 ? decodedAt : scanCapturedAt.get(info.scanId) ?? decodedAt;\n  if (!startTs) startTs = transferScanAt;\n  // Freeze the end clock on the scan that actually advanced the fountain\n  // decoder. Assembly, hashing, verification, UI painting and file unpacking\n  // happen after this and must not lower the reported optical KB/s.\n  if (decoder.usefulSymbols > usefulBefore) completionScanAt = transferScanAt;\n  const duplicateFrame = decoder.framesNew === framesNewBefore;')

old_paint = '''function paintTransferComplete() {
  // Snap, do not animate, the final 100%. Expensive assembly immediately after
  // completion can block animation frames for large transfers; leaving the
  // normal width transition active makes the bar appear stuck around 97-99%.
  bar.classList.add("finalizing");
  bar.getAnimations?.().forEach((animation) => animation.cancel());
  bar.style.width = "100%";
  progressEl.setAttribute("aria-valuenow", "100");
  progressLabel.textContent = "100%";
  transferSizeLabel.textContent = "";
  etaLabel.textContent = "Processing…";
}
async function waitForProgressPaint() {
  // One rAF is still before paint. Resolve from the following frame: yielding
  // between the two callbacks gives the browser a guaranteed rendering turn
  // with the snapped 100% bar and Processing label visible.
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  );
}
'''
new_paint = '''function paintTransferComplete() {
  // Final completion is a state change, not an animation. Override motion on the
  // element itself before changing width so selector timing/compositor state can
  // never leave the bar visually sitting at 97-99% while assembly blocks JS.
  bar.classList.add("finalizing");
  bar.getAnimations?.().forEach((animation) => animation.cancel());
  bar.style.setProperty("transition", "none", "important");
  bar.style.setProperty("animation", "none", "important");
  bar.style.setProperty("opacity", "1", "important");
  bar.style.width = "100%";
  // Force the 100% layout now; the render turn below is only for paint.
  void bar.offsetWidth;
  progressEl.setAttribute("aria-valuenow", "100");
  progressLabel.textContent = "100%";
  transferSizeLabel.textContent = "";
  etaLabel.textContent = "Processing…";
}
async function waitForProgressPaint() {
  // rAF runs immediately before rendering. A zero-delay task queued from that
  // callback runs after that rendering opportunity, so heavy assembly cannot
  // start until the snapped 100% state has had a chance to hit the screen.
  await new Promise((resolve) =>
    requestAnimationFrame(() => setTimeout(resolve, 0))
  );
}
'''
replace_once(main, old_paint, new_paint)

replace_once(main,
    '  const completingDecoder = decoder;\n  const completingGeneration = captureGen;\n  paintTransferComplete();',
    '  const completingDecoder = decoder;\n  const completingGeneration = captureGen;\n  // Freeze transfer duration at the last useful optical scan, before any UI or\n  // final-processing latency. This is the number shown as “X MB in Y seconds”.\n  const transferEndAt = completionScanAt || receiverNow();\n  const transferSeconds = Math.max(1e-3, (transferEndAt - startTs) / 1e3);\n  paintTransferComplete();')

replace_once(main,
    '  const payload = completingDecoder.assemble();\n  const seconds = (receiverNow() - startTs) / 1e3;\n  const ok = fnv1a(payload) === payloadId;\n  await finish(payload, ok, seconds);',
    '  const payload = completingDecoder.assemble();\n  const ok = fnv1a(payload) === payloadId;\n  await finish(payload, ok, transferSeconds);')

replace_once(main,
    '    seconds = (receiverNow() - startTs) / 1e3;\n    document.body.classList.add("receive-complete");',
    '    // `seconds` was frozen at the last useful scan. Verification and file\n    // processing are intentionally excluded from optical-transfer throughput.\n    document.body.classList.add("receive-complete");')

# The final inline !important overrides must not leak into a subsequent receive.
# Reset sites already put the hidden bar back at zero; force that zero while the
# override is active, then restore normal CSS transitions for the next transfer.
reset_old = '''  bar.style.width = "0";
  bar.classList.remove("error", "finalizing");
'''
reset_new = '''  bar.style.width = "0";
  bar.classList.remove("error", "finalizing");
  void bar.offsetWidth;
  bar.style.removeProperty("transition");
  bar.style.removeProperty("animation");
  bar.style.removeProperty("opacity");
'''
text = Path(main).read_text()
if text.count(reset_old) < 1:
    raise SystemExit("missing progress reset anchor")
text = text.replace(reset_old, reset_new)
Path(main).write_text(text)

# One reset path has width=0 without class removal. Clear final inline overrides there too.
replace_once(main,
    '  completionDiagnosticsText = "";\n  bar.style.width = "0";\n  progressEl.setAttribute("aria-valuenow", "0");',
    '  completionDiagnosticsText = "";\n  bar.style.width = "0";\n  void bar.offsetWidth;\n  bar.style.removeProperty("transition");\n  bar.style.removeProperty("animation");\n  bar.style.removeProperty("opacity");\n  progressEl.setAttribute("aria-valuenow", "0");')

replace_once("main.js", 'const APP_BUILD = "v0.5.338";', 'const APP_BUILD = "v0.5.339";')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v286";', 'const CACHE = "airgapper-static-js-v287";')

print("v0.5.339 candidate applied")
