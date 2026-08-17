from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:220]!r}")
    p.write_text(s.replace(old, new, count))

replace("index.html", "v0.5.212", "v0.5.213")
replace("main.js", 'const APP_BUILD = "v0.5.212";', 'const APP_BUILD = "v0.5.213";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.212";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.213";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v174";', 'const CACHE = "airgapper-static-js-v175";')

p = Path("receive/main.js")
s = p.read_text()
old = '''copyDiagnostics.addEventListener("click", () => {
  void copyDiagnosticsToClipboard(completionDiagnosticsText || diagnosticsText());
});'''
new = '''copyDiagnostics.addEventListener("click", () => {
  void copyDiagnosticsToClipboard(completionDiagnosticsText || diagnosticsText());
});
function freezeCompletionDiagnostics() {
  if (completionDiagnosticsText) return;
  // Snapshot the last live transfer instant, before finalization/paint/file
  // verification can drain the camera/worker recent window.
  updateStats(true);
  completionDiagnosticsText = diagnosticsText();
  void copyDiagnosticsToClipboard(completionDiagnosticsText, true);
}'''
if old not in s:
    raise SystemExit("copy diagnostics listener missing")
s = s.replace(old, new, 1)

old = '''  } else if (decoder.isComplete && !transferFinalizing) {
    void finalizeCompletedTransfer(header.payloadId);
  }'''
new = '''  } else if (decoder.isComplete && !transferFinalizing) {
    freezeCompletionDiagnostics();
    void finalizeCompletedTransfer(header.payloadId);
  }'''
if old not in s:
    raise SystemExit("completion dispatch missing")
s = s.replace(old, new, 1)

old = '''async function finish(container, hashOk, seconds) {
  // Freeze the final live pipeline/camera state before teardown. This avoids
  // contaminating benchmark diagnostics by requiring a physical tap/bump after
  // the transfer completes. Native Android can copy synchronously; browser/PWA
  // Clipboard is best-effort with a legacy copy fallback, and the frozen text
  // remains available to the manual Copy diagnostics button if policy blocks it.
  updateStats(true);
  completionDiagnosticsText = diagnosticsText();
  void copyDiagnosticsToClipboard(completionDiagnosticsText, true);
  done = true;'''
new = '''async function finish(container, hashOk, seconds) {
  // Normal completion freezes at decoder.isComplete. Keep this as a defensive
  // fallback for any future completion path that reaches finish directly.
  freezeCompletionDiagnostics();
  done = true;'''
if old not in s:
    raise SystemExit("finish snapshot block missing")
s = s.replace(old, new, 1)
p.write_text(s)
