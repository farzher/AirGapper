from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}: {old[:80]!r}")
    p.write_text(text.replace(old, new, 1))

# Worker: truthy-but-incomplete quads must never reach a corner dereference.
replace_once(
    "receive/worker.js",
    "if (!full && quad && dim) {",
    "if (!full && validQuad(quad) && dim) {",
)

# Main receiver: never persist or consume a partial quad object.
replace_once(
    "receive/main.js",
    "if (geometryIsFresh && (info == null ? void 0 : info.quad)) r.quad = info.quad;",
    "if (geometryIsFresh && validQuadObject(info == null ? void 0 : info.quad)) r.quad = info.quad;",
)
replace_once(
    "receive/main.js",
    "quad: info == null ? void 0 : info.quad,",
    "quad: validQuadObject(info == null ? void 0 : info.quad) ? info.quad : void 0,",
)
replace_once(
    "receive/main.js",
    "if (!region.quad || !region.dim || region.visibleFraction < 0.85) continue;",
    "if (!validQuadObject(region.quad) || !region.dim || region.visibleFraction < 0.85) continue;",
)
replace_once(
    "receive/main.js",
    "const targets = optimizerFixedTargets;\n  const points = targets.flatMap((target) => [",
    "const targets = optimizerFixedTargets.filter((target) => validQuadObject(target.quad) && target.dim);\n  if (!targets.length) return;\n  const points = targets.flatMap((target) => [",
)
replace_once(
    "receive/main.js",
    "if ((info == null ? void 0 : info.quad) && info.modules) {",
    "if (validQuadObject(info == null ? void 0 : info.quad) && info.modules) {",
)
replace_once(
    "receive/main.js",
    "if (!optimizerAttribution && box && (info == null ? void 0 : info.quad) && info.modules) {",
    "if (!optimizerAttribution && box && validQuadObject(info == null ? void 0 : info.quad) && info.modules) {",
)
replace_once(
    "receive/main.js",
    "const drawQuad = (quad, color, width) => {\n    const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];",
    "const drawQuad = (quad, color, width) => {\n    if (!validQuadObject(quad)) return;\n    const points = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];",
)
replace_once(
    "receive/main.js",
    "const quad = (value, color, width) => {\n    if (!value) return;",
    "const quad = (value, color, width) => {\n    if (!validQuadObject(value)) return;",
)

# Make the displayed error identify whether the main capture scheduler threw.
replace_once(
    "receive/main.js",
    "lastDecodeError = error instanceof Error ? error.message : String(error);",
    "lastDecodeError = `captureFrame: ${error instanceof Error ? error.message : String(error)}`;\n      console.error(\"AirGapper captureFrame failed\", error);",
)

# Optics is a separate geometry consumer; enforce the invariant at its own API boundary too.
replace_once(
    "receive/qr-optics.js",
    "function clamp01(value) {\n  return Math.max(0, Math.min(1, value));\n}",
    "function clamp01(value) {\n  return Math.max(0, Math.min(1, value));\n}\nfunction validQuad(quad) {\n  if (!quad) return false;\n  return [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft].every((point) =>\n    point && Number.isFinite(point.x) && Number.isFinite(point.y)\n  );\n}",
)
replace_once(
    "receive/qr-optics.js",
    "  setTransform(quad, modules, offsetX, offsetY) {\n    const p0 = quad.topLeft, p1 = quad.topRight, p2 = quad.bottomRight, p3 = quad.bottomLeft;",
    "  setTransform(quad, modules, offsetX, offsetY) {\n    if (!validQuad(quad)) return false;\n    const p0 = quad.topLeft, p1 = quad.topRight, p2 = quad.bottomRight, p3 = quad.bottomLeft;",
)
replace_once(
    "receive/qr-optics.js",
    "function quadPoints(quad) {\n  return [",
    "function quadPoints(quad) {\n  if (!validQuad(quad)) return [];\n  return [",
)

# Version/cache bump.
replace_once("index.html", "v0.5.59", "v0.5.60")
replace_once("sw.js", 'airgapper-static-js-v22', 'airgapper-static-js-v23')
