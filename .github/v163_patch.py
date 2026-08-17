from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing anchor in {path}: {old[:160]!r}")
    p.write_text(text.replace(old, new, 1))

# Version/cache bump.
replace_once("index.html", "v0.5.162", "v0.5.163")
replace_once("main.js", 'const APP_BUILD = "v0.5.162";', 'const APP_BUILD = "v0.5.163";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.162";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.163";')
replace_once("sw.js", 'airgapper-static-js-v124', 'airgapper-static-js-v125')

# Remove the failed 45-QR sender experiment entirely.
replace_once("index.html", '<option value="three-six">3:6</option><option value="five-nine">5:9</option>', '<option value="three-six">3:6</option>')

p = Path("send/main.js")
text = p.read_text()
text = text.replace(
    'mode === "three-five" || mode === "three-six" || mode === "five-nine" ? mode : "four-three";',
    'mode === "three-five" || mode === "three-six" ? mode : "four-three";',
    1
)
text = text.replace(
    '    case "three-six":\n      return { cols: 3, rows: 6, codes: 18 };\n    case "five-nine":\n      return { cols: 5, rows: 9, codes: 45 };\n',
    '    case "three-six":\n      return { cols: 3, rows: 6, codes: 18 };\n',
    1
)
text = text.replace(
    'saved.layout === "four-three" || saved.layout === "three-five" || saved.layout === "three-six" || saved.layout === "five-nine") {',
    'saved.layout === "four-three" || saved.layout === "three-five" || saved.layout === "three-six") {',
    1
)
p.write_text(text)

# Restore the pre-experiment layout table and packed metadata widths. No dead
# 45-slot wire format remains after removing the option.
p = Path("shared/grid-layout.js")
text = p.read_text().replace('  { id: 6, cols: 5, rows: 9 },', '  { id: 6, cols: 5, rows: 3 },', 1)
p.write_text(text)

p = Path("shared/protocol.js")
text = p.read_text()
text = text.replace('!fitsBits(h.layoutId, 3) || !fitsBits(h.slotIndex, 6)', '!fitsBits(h.layoutId, 3) || !fitsBits(h.slotIndex, 5)', 1)
text = text.replace('bit = writeBits(out, bit, h.slotIndex, 6);', 'bit = writeBits(out, bit, h.slotIndex, 5);', 1)
text = text.replace('const slot = readBits(bytes, layout.next, 6);', 'const slot = readBits(bytes, layout.next, 5);', 1)
p.write_text(text)
