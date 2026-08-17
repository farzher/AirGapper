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
    if "v0.5.179" not in text:
        raise SystemExit(f"expected v0.5.179 in {path}")
    p.write_text(text.replace("v0.5.179", "v0.5.180"))

replace_once("sw.js", "airgapper-static-js-v141", "airgapper-static-js-v142")

replace_once(
    "receive/main.js",
    '''  const direct = cloneVideoFrame(source, false);\n  if (!direct || direct.pixelFormat !== "y8") {\n    direct?.frame.close();\n    return null;\n  }\n  const pixelXf = direct.visibleX + x * direct.scaleX;\n  const pixelYf = direct.visibleY + y * direct.scaleY;\n  const pixelRf = direct.visibleX + (x + w) * direct.scaleX;\n  const pixelBf = direct.visibleY + (y + h) * direct.scaleY;''',
    '''  const direct = cloneVideoFrame(source, false);\n  if (!direct || direct.pixelFormat !== "y8") {\n    direct?.frame.close();\n    return null;\n  }\n  // Padded tracked crops are allowed to extend beyond the display frame. Canvas\n  // readback naturally clips those requests, but VideoFrame copyTo/visibleRect\n  // does not accept a negative/out-of-range crop. Clamp in display coordinates\n  // before mapping into the coded frame; track quads stay in global coordinates\n  // and are localized by ox/oy in the worker as before.\n  const cropX = Math.max(0, Math.min(source.width, x));\n  const cropY = Math.max(0, Math.min(source.height, y));\n  const cropRight = Math.max(cropX, Math.min(source.width, x + w));\n  const cropBottom = Math.max(cropY, Math.min(source.height, y + h));\n  if (cropRight - cropX < 2 || cropBottom - cropY < 2) {\n    direct.frame.close();\n    return null;\n  }\n  const pixelXf = direct.visibleX + cropX * direct.scaleX;\n  const pixelYf = direct.visibleY + cropY * direct.scaleY;\n  const pixelRf = direct.visibleX + cropRight * direct.scaleX;\n  const pixelBf = direct.visibleY + cropBottom * direct.scaleY;'''
)
