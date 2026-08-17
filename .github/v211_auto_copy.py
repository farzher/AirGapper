from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:220]!r}")
    p.write_text(s.replace(old, new, count))


replace("index.html", "v0.5.210", "v0.5.211")
replace("main.js", 'const APP_BUILD = "v0.5.210";', 'const APP_BUILD = "v0.5.211";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.210";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.211";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v172";', 'const CACHE = "airgapper-static-js-v173";')

main = Path("receive/main.js")
s = main.read_text()
old = '''copyDiagnostics.addEventListener("click", async () => {
  var _a;
  const focusText = (_a = focusDiagnostics.textContent) != null ? _a : "";
  const text = [focusText, transportDiagnostics?.textContent ?? ""].filter(Boolean).join("\\n\\n");
  try {
    if (!copyTextOnAndroid(text)) await navigator.clipboard.writeText(text);
    copyDiagnostics.textContent = "Copied";
  } catch {
    copyDiagnostics.textContent = "Copy failed";
  }
  setTimeout(() => {
    copyDiagnostics.textContent = "Copy diagnostics";
  }, 1500);
});'''
new = '''let completionDiagnosticsText = "";
function diagnosticsText() {
  return [focusDiagnostics.textContent ?? "", transportDiagnostics?.textContent ?? ""]
    .filter(Boolean).join("\\n\\n");
}
function legacyClipboardCopy(text) {
  try {
    const input = document.createElement("textarea");
    input.value = text;
    input.readOnly = true;
    input.style.position = "fixed";
    input.style.opacity = "0";
    input.style.pointerEvents = "none";
    document.body.append(input);
    input.select();
    input.setSelectionRange(0, input.value.length);
    const copied = document.execCommand("copy");
    input.remove();
    return copied;
  } catch {
    return false;
  }
}
async function copyDiagnosticsToClipboard(text, automatic = false) {
  if (!text) return false;
  try {
    if (!copyTextOnAndroid(text)) {
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
        await navigator.clipboard.writeText(text);
      } catch (error) {
        if (!legacyClipboardCopy(text)) throw error;
      }
    }
    copyDiagnostics.textContent = automatic ? "Diagnostics copied" : "Copied";
    setTimeout(() => {
      copyDiagnostics.textContent = "Copy diagnostics";
    }, 1500);
    return true;
  } catch {
    if (!automatic) {
      copyDiagnostics.textContent = "Copy failed";
      setTimeout(() => {
        copyDiagnostics.textContent = "Copy diagnostics";
      }, 1500);
    }
    return false;
  }
}
copyDiagnostics.addEventListener("click", () => {
  void copyDiagnosticsToClipboard(completionDiagnosticsText || diagnosticsText());
});'''
if old not in s:
    raise SystemExit("copy diagnostics block missing")
s = s.replace(old, new, 1)

old = 'function updateStats() {\n  if (done) return;\n  const now = receiverNow();\n  if (optimizeEnabled) beginOptimizeWhenReady();\n  if (!receiverDevActions.hidden) renderFocusDiagnostics();'
new = 'function updateStats(forceDiagnostics = false) {\n  if (done) return;\n  const now = receiverNow();\n  if (optimizeEnabled) beginOptimizeWhenReady();\n  if (forceDiagnostics || !receiverDevActions.hidden) renderFocusDiagnostics();'
if old not in s:
    raise SystemExit("updateStats header missing")
s = s.replace(old, new, 1)

old = 'if (!receiverDevActions.hidden && transportDiagnostics) {'
new = 'if ((forceDiagnostics || !receiverDevActions.hidden) && transportDiagnostics) {'
if old not in s:
    raise SystemExit("transport diagnostics gate missing")
s = s.replace(old, new, 1)

old = '''  lastDistinctArrivalAt = 0;
  transferFinalizing = false;
  bar.style.width = "0";'''
new = '''  lastDistinctArrivalAt = 0;
  transferFinalizing = false;
  completionDiagnosticsText = "";
  bar.style.width = "0";'''
if old not in s:
    raise SystemExit("active transfer reset block missing")
s = s.replace(old, new, 1)

old = '''async function finish(container, hashOk, seconds) {
  done = true;'''
new = '''async function finish(container, hashOk, seconds) {
  // Freeze the final live pipeline/camera state before teardown. This avoids
  // contaminating benchmark diagnostics by requiring a physical tap/bump after
  // the transfer completes. Native Android can copy synchronously; browser/PWA
  // Clipboard is best-effort with a legacy copy fallback, and the frozen text
  // remains available to the manual Copy diagnostics button if policy blocks it.
  updateStats(true);
  completionDiagnosticsText = diagnosticsText();
  void copyDiagnosticsToClipboard(completionDiagnosticsText, true);
  done = true;'''
if old not in s:
    raise SystemExit("finish function header missing")
s = s.replace(old, new, 1)

main.write_text(s)
