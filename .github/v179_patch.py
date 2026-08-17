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
    if "v0.5.178" not in text:
        raise SystemExit(f"expected v0.5.178 in {path}")
    p.write_text(text.replace("v0.5.178", "v0.5.179"))

replace_once("sw.js", "airgapper-static-js-v140", "airgapper-static-js-v141")

replace_once(
    "receive/main.js",
    '''  if (batchTracks.length > 1) {\n    const points = batchTracks.flatMap((track) => [''',
    '''  // A single tracked grid slot must use the same bounded shared-crop hot\n  // path as a multi-QR wall. The legacy per-region crop below is intentionally\n  // only for non-grid/provisional regions: unlike this path it is not clamped\n  // and quantized to the camera frame, which can mis-map a large 1-QR crop and\n  // strand guided decoding while periodic full scans still succeed.\n  if (batchTracks.length >= 1) {\n    const points = batchTracks.flatMap((track) => ['''
)
