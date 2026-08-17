from pathlib import Path

p = Path("receive/worker.js")
s = p.read_text()
old = '    const robustLaneFirst = !strictHotPath && !full && Array.isArray(tracks) && tracks.length > 0 && (usedDirectFrame || pixelFormat === "rgba");\n'
new = '''    // Direct camera frames use the Y8 Guided lane first. Buffered RGBA frames\n    // (corpus replay, benchmark images, legacy/canvas inputs) already have\n    // trusted lattice geometry, so do not throw that information away by\n    // running the generic finder before the persistent tracked decoder. Try\n    // native tracked sampling first; the existing cold-track recovery below\n    // still wakes robust detection when geometry genuinely stops working.\n    const robustLaneFirst = !strictHotPath && !full && Array.isArray(tracks) && tracks.length > 0 && usedDirectFrame;\n'''
if old not in s:
    raise SystemExit("worker robustLaneFirst target not found")
s = s.replace(old, new, 1)
p.write_text(s)
