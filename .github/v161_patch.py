from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing anchor in {path}: {old[:140]!r}")
    p.write_text(text.replace(old, new, 1))

# Version/cache bump.
replace_once("index.html", "v0.5.160", "v0.5.161")
replace_once("main.js", 'const APP_BUILD = "v0.5.160";', 'const APP_BUILD = "v0.5.161";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.160";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.161";')
replace_once("sw.js", 'airgapper-static-js-v122', 'airgapper-static-js-v123')

# Add the high-density 45-code sender option. The sender's existing orientation
# system rotates the 5x9 base grid in landscape, yielding the requested 9x5 wall.
replace_once(
    "index.html",
    '<option value="three-six">3:6</option></select></label>',
    '<option value="three-six">3:6</option><option value="five-nine">9×5 · 45 QR</option></select></label>'
)

p = Path("send/main.js")
text = p.read_text()
text = text.replace(
    'mode === "three-five" || mode === "three-six" ? mode : "four-three";',
    'mode === "three-five" || mode === "three-six" || mode === "five-nine" ? mode : "four-three";',
    1
)
text = text.replace(
    '    case "three-six":\n      return { cols: 3, rows: 6, codes: 18 };\n',
    '    case "three-six":\n      return { cols: 3, rows: 6, codes: 18 };\n    case "five-nine":\n      return { cols: 5, rows: 9, codes: 45 };\n',
    1
)
text = text.replace(
    'saved.layout === "four-three" || saved.layout === "three-five" || saved.layout === "three-six") {',
    'saved.layout === "four-three" || saved.layout === "three-five" || saved.layout === "three-six" || saved.layout === "five-nine") {',
    1
)
p.write_text(text)

# Protocol-visible layout ID. Auto/landscape rotates display pixels but the
# header continues to describe the canonical 5x9 layout, as with existing grids.
p = Path("shared/grid-layout.js")
text = p.read_text()
text = text.replace(
    '  { id: 7, cols: 3, rows: 6 }\n];',
    '  { id: 7, cols: 3, rows: 6 },\n  { id: 8, cols: 5, rows: 9 }\n];',
    1
)
p.write_text(text)
