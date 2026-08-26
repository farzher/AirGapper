from pathlib import Path

p = Path("main.js")
s = p.read_text()
old = '''function syncPortraitFallback() {
  const landscape = window.innerWidth > window.innerHeight;
  document.body.classList.toggle("portrait-fallback", landscape);
  if (landscape) document.documentElement.style.setProperty("--portrait-fallback-rotation", portraitFallbackRotation());
  else document.documentElement.style.removeProperty("--portrait-fallback-rotation");
}
async function requestPortraitLock() {
  try {
    await screen.orientation?.lock?.("portrait-primary");
  } catch {
'''
new = '''const portraitLockEnabled = isIOS || isAndroid || isAndroidApp();
function syncPortraitFallback() {
  const landscape = portraitLockEnabled && window.innerWidth > window.innerHeight;
  document.body.classList.toggle("portrait-fallback", landscape);
  if (landscape) document.documentElement.style.setProperty("--portrait-fallback-rotation", portraitFallbackRotation());
  else document.documentElement.style.removeProperty("--portrait-fallback-rotation");
}
async function requestPortraitLock() {
  if (!portraitLockEnabled) return;
  try {
    await screen.orientation?.lock?.("portrait-primary");
  } catch {
'''
count = s.count(old)
if count != 1:
    raise SystemExit(f"orientation scope anchor count {count}")
p.write_text(s.replace(old, new, 1))
