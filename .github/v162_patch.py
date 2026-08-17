from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing anchor in {path}: {old[:160]!r}")
    p.write_text(text.replace(old, new, 1))

# Version/cache bump.
replace_once("index.html", "v0.5.161", "v0.5.162")
replace_once("main.js", 'const APP_BUILD = "v0.5.161";', 'const APP_BUILD = "v0.5.162";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.161";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.162";')
replace_once("sw.js", 'airgapper-static-js-v123', 'airgapper-static-js-v124')

# Match the terse existing layout labels.
replace_once("index.html", '>9×5 · 45 QR</option>', '>5:9</option>')

# The old id=6 5x3 entry was a legacy orientation mirror; current sender layouts
# use canonical 3x5 plus an orientation flag/display rotation. Reuse that 3-bit
# wire ID for the new canonical 5x9 layout so layoutId remains 3 bits.
p = Path("shared/grid-layout.js")
text = p.read_text()
text = text.replace('  { id: 6, cols: 5, rows: 3 },\n', '  { id: 6, cols: 5, rows: 9 },\n', 1)
text = text.replace('  { id: 7, cols: 3, rows: 6 },\n  { id: 8, cols: 5, rows: 9 }\n', '  { id: 7, cols: 3, rows: 6 }\n', 1)
p.write_text(text)

# 45 slots need six slot bits (0..63). Both packed headers already have room:
# MDS goes from 85/88 used bits to 86/88; RaptorQ from 111/112 to 112/112.
# Header byte lengths and QR payload overhead therefore stay unchanged.
p = Path("shared/protocol.js")
text = p.read_text()
text = text.replace('!fitsBits(h.layoutId, 3) || !fitsBits(h.slotIndex, 5)', '!fitsBits(h.layoutId, 3) || !fitsBits(h.slotIndex, 6)', 1)
text = text.replace('bit = writeBits(out, bit, h.slotIndex, 5);', 'bit = writeBits(out, bit, h.slotIndex, 6);', 1)
text = text.replace('const slot = readBits(bytes, layout.next, 5);', 'const slot = readBits(bytes, layout.next, 6);', 1)
p.write_text(text)
