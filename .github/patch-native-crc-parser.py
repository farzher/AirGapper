from pathlib import Path

protocol = Path("shared/protocol.js")
text = protocol.read_text()
old = '''function parseVerifiedFrame(bytes) {
  return parseFrameBody(bytes, "verified");
}'''
new = '''function parseVerifiedFrame(bytes, hasCrc = true) {
  return parseFrameBody(bytes, hasCrc ? "verified" : false);
}'''
count = text.count(old)
if count == 1:
    protocol.write_text(text.replace(old, new, 1))
elif count == 0 and new in text:
    pass
else:
    raise SystemExit(f"shared/protocol.js: expected one parseVerifiedFrame body, found {count}")

worker = Path("receive/worker.js")
text = worker.read_text()
old = 'const packet = mapped.input.crc32 ? parseVerifiedFrame(rawView) : parseFrame(rawView);'
new = 'const packet = mapped.input.crc32 ? parseVerifiedFrame(rawView, false) : parseFrame(rawView);'
count = text.count(old)
if count == 1:
    worker.write_text(text.replace(old, new, 1))
elif count == 0 and new in text:
    pass
else:
    raise SystemExit(f"receive/worker.js: expected one native verified parser call, found {count}")

print("patched CRC-stripped native frame parsing")
