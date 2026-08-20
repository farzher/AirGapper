from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one anchor, found {count}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")


anchor = '''function noteDecodeCompleted(id, completion) {\n  const auditMode = hotPathJobMode.get(id);\n'''
replacement = '''function noteDecodeCompleted(id, completion) {\n  const auditMode = hotPathJobMode.get(id);\n  // Native cached-CRC hits intentionally avoid re-emitting duplicate payloads,\n  // but a full CRC-fast batch is still fresh visual proof for every tracked QR.\n  // Refresh geometry health only; do not count these as transport progress.\n  const nativeTracks = Math.max(0, Number(completion.nativeMetrics?.tracks) || 0);\n  const nativeCrcFast = Math.max(0, Number(completion.nativeMetrics?.crcFastSuccesses) || 0);\n  const nativeMisses = Math.max(0, Number(completion.nativeMetrics?.misses) || 0);\n  if (!auditMode?.full && nativeTracks > 0 && nativeCrcFast === nativeTracks && nativeMisses === 0) {\n    const proofAt = receiverNow();\n    for (const slot of auditMode?.trackSlots ?? []) {\n      const region = regions.find((candidate) => candidate.gridSlot === slot);\n      if (!region?.decoded) continue;\n      region.seen = proofAt;\n      region.decodedSeen = proofAt;\n      region.sightedSeen = proofAt;\n      region.consecutiveMisses = 0;\n      region.detectionConfidence = 1;\n      region.decodeConfidence = 1;\n    }\n  }\n'''
replace_once("receive/main.js", anchor, replacement)

for path in ["main.js", "receive/main.js", "send/main.js", "index.html"]:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    if "v0.5.357" not in text:
        raise SystemExit(f"{path}: missing v0.5.357")
    p.write_text(text.replace("v0.5.357", "v0.5.358"), encoding="utf-8")

p = Path("sw.js")
text = p.read_text(encoding="utf-8")
if "airgapper-static-js-v357" not in text:
    raise SystemExit("sw.js: missing v357 cache key")
p.write_text(text.replace("airgapper-static-js-v357", "airgapper-static-js-v358"), encoding="utf-8")

p = Path("android/app/build.gradle")
text = p.read_text(encoding="utf-8")
if 'versionCode 357' not in text or 'versionName "0.5.357"' not in text:
    raise SystemExit("android/app/build.gradle: missing v357 metadata")
text = text.replace('versionCode 357', 'versionCode 358', 1)
text = text.replace('versionName "0.5.357"', 'versionName "0.5.358"', 1)
p.write_text(text, encoding="utf-8")

print("AIRGAPPER_V358_PATCH_APPLIED")
