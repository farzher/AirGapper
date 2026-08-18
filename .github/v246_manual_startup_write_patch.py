from pathlib import Path

p = Path('receive/main.js')
s = p.read_text()
old = '''function attachCameraController(track) {
  focusController.attach(track);
  if (automaticOptics) void primeAutomaticQrOpticsStartup(track);
  else void applyExposureSetting(track);
}
'''
new = '''function attachCameraController(track) {
  focusController.attach(track);
  if (automaticOptics) void primeAutomaticQrOpticsStartup(track);
  // Manual sensor settings are applied explicitly before camera playback and
  // verified after fresh frames arrive. Do not write them again merely because
  // the focus/controller UI attached; duplicate constraint writes can restart
  // Android camera delivery and hold decoding during acquisition.
}
'''
if old not in s:
    raise SystemExit('attachCameraController anchor missing')
s = s.replace(old, new, 1)
if 'const RECEIVER_RUNTIME_BUILD = "v0.5.245";' not in s:
    raise SystemExit('receiver version anchor missing')
s = s.replace('const RECEIVER_RUNTIME_BUILD = "v0.5.245";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.246";', 1)
p.write_text(s)

for path in ['main.js', 'index.html']:
    q=Path(path)
    text=q.read_text()
    if 'v0.5.245' not in text:
        raise SystemExit(f'{path}: v0.5.245 missing')
    q.write_text(text.replace('v0.5.245','v0.5.246'))

sw=Path('sw.js')
text=sw.read_text()
if 'airgapper-static-js-v201' not in text:
    raise SystemExit('sw cache v201 missing')
sw.write_text(text.replace('airgapper-static-js-v201','airgapper-static-js-v202',1))
