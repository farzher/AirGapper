from pathlib import Path

p = Path("receive/main.js")
text = p.read_text()

old = '''import {
  listNativeCameras,
  nativeCameraAvailable,
  nativeCameraTrack,'''
new = '''import {
  ackNativeCameraFrame,
  listNativeCameras,
  nativeCameraAvailable,
  nativeCameraTrack,'''
if text.count(old) != 1:
    raise SystemExit(f"native import seam mismatch: {text.count(old)}")
text = text.replace(old, new, 1)

old = '''function nativeSourceFrame(buffer, width, height, gen) {
  if (!nativeCameraRunning || done || gen !== captureGen) {
    ackNativeCameraFrame();
    return;
  }'''
new = '''function nativeSourceFrame(buffer, width, height, gen) {
  // shared/native-camera.js has already ACKed ownership of every delivered
  // ArrayBuffer. Only the one explicit ACK after startup seeds the first frame.
  if (!nativeCameraRunning || done || gen !== captureGen) return;'''
if text.count(old) != 1:
    raise SystemExit(f"native invalid-frame ACK seam mismatch: {text.count(old)}")
text = text.replace(old, new, 1)
p.write_text(text)
print("native Camera2 frame-credit follow-up applied")
