from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    found = text.count(old)
    if found != count:
        raise SystemExit(f"{path}: expected {count} occurrence(s), found {found}: {old[:120]!r}")
    p.write_text(text.replace(old, new, count))

# Version/cache bump.
replace("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.304";', 'const SEND_RUNTIME_BUILD = "v0.5.305";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.304";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.305";')
replace("main.js", 'const APP_BUILD = "v0.5.304";', 'const APP_BUILD = "v0.5.305";')
replace("index.html", 'v0.5.304', 'v0.5.305', 2)
replace("sw.js", 'airgapper-static-js-v251', 'airgapper-static-js-v252')

# Keep legacy `fixed` as row-major so existing saved settings preserve the exact
# winning behavior. Add a distinct column-major mode for a clean hardware A/B.
replace(
    "send/main.js",
    'return value === "synchronous" || value === "fixed" || value === "dispersed" ? value : "dispersed";',
    'return value === "synchronous" || value === "fixed" || value === "fixed-columns" || value === "dispersed" ? value : "dispersed";'
)
replace(
    "send/main.js",
    'if (saved.updatePattern === "synchronous" || saved.updatePattern === "fixed" || saved.updatePattern === "dispersed") cfgUpdatePattern.value = saved.updatePattern;',
    'if (saved.updatePattern === "synchronous" || saved.updatePattern === "fixed" || saved.updatePattern === "fixed-columns" || saved.updatePattern === "dispersed") cfgUpdatePattern.value = saved.updatePattern;'
)
replace(
    "send/main.js",
    '''  const temporalSourceOffset = (pageId, phase) => {\n    if (gridCodes <= 1 || updatePattern === "fixed" || updatePattern === "synchronous") return phase;\n    const rotation = pageId * phaseStep % gridCodes;''',
    '''  const temporalSourceOffset = (pageId, phase) => {\n    if (gridCodes <= 1 || updatePattern === "fixed" || updatePattern === "synchronous") return phase;\n    if (updatePattern === "fixed-columns") {\n      // Transpose the existing row-major fixed schedule without changing packet\n      // assignment, page cadence, or aggregate rate: top-to-bottom through one\n      // logical column, then advance to the next column.\n      const row = phase % gridRows;\n      const col = Math.floor(phase / gridRows);\n      return row * gridCols + col;\n    }\n    const rotation = pageId * phaseStep % gridCodes;'''
)
replace(
    "send/main.js",
    'const updatePatternLabel = updatePattern === "synchronous" ? "synchronous wall" : updatePattern === "fixed" ? "fixed phased" : "dispersed rotating phases";',
    'const updatePatternLabel = updatePattern === "synchronous" ? "synchronous wall" : updatePattern === "fixed" ? "fixed rows" : updatePattern === "fixed-columns" ? "fixed columns" : "dispersed rotating phases";'
)

replace(
    "index.html",
    '<label><span>Update</span><select id="cfg-update-pattern"><option value="synchronous">Synchronous</option><option value="fixed">Fixed phased</option><option value="dispersed" selected>Dispersed</option></select></label>',
    '<label><span>Update</span><select id="cfg-update-pattern"><option value="synchronous">Synchronous</option><option value="fixed">Fixed rows</option><option value="fixed-columns">Fixed columns</option><option value="dispersed" selected>Dispersed</option></select></label>'
)

# Sanity assertions on the generated candidate.
send = Path("send/main.js").read_text()
html = Path("index.html").read_text()
assert 'value === "fixed-columns"' in send
assert 'updatePattern === "fixed-columns"' in send
assert 'const row = phase % gridRows;' in send
assert 'const col = Math.floor(phase / gridRows);' in send
assert '>Fixed rows<' in html and '>Fixed columns<' in html
print("v305 fixed row/column phase candidate applied")
