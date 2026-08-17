from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old!r}")
    p.write_text(text.replace(old, new, 1))

for path in ["index.html", "main.js", "receive/main.js"]:
    p = Path(path)
    text = p.read_text()
    if "v0.5.177" not in text:
        raise SystemExit(f"expected v0.5.177 in {path}")
    p.write_text(text.replace("v0.5.177", "v0.5.178"))
replace_once("sw.js", "airgapper-static-js-v139", "airgapper-static-js-v140")
replace_once(
    "receive/focus-controller.js",
    '''    this.requestedMode = "single-shot";\n    await this.apply(track, { focusMode: "single-shot" });''',
    '''    this.requestedMode = "single-shot";\n    // Start the retry clock with the initial sweep. Without this fence the\n    // first target-absent callback can issue a second single-shot immediately\n    // and restart the lens before the original sweep has had time to settle.\n    this.lastSeekingAfAt = performance.now();\n    await this.apply(track, { focusMode: "single-shot" });'''
)
