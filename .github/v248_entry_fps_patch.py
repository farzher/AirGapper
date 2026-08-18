from pathlib import Path

receive = Path('receive/main.js')
s = receive.read_text()
old = '  metric("m-cap").textContent = `${decodeFrameRate.toFixed(1)} fps`;'
new = '  metric("m-cap").textContent = `${cameraRate.toFixed(1)} fps`;'
if old not in s:
    raise SystemExit('compact fps anchor missing')
s = s.replace(old, new, 1)
if 'const RECEIVER_RUNTIME_BUILD = "v0.5.247";' not in s:
    raise SystemExit('receiver v247 anchor missing')
s = s.replace('const RECEIVER_RUNTIME_BUILD = "v0.5.247";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.248";', 1)
receive.write_text(s)

main = Path('main.js')
text = main.read_text()
if 'v0.5.247' not in text:
    raise SystemExit('main v247 missing')
main.write_text(text.replace('v0.5.247','v0.5.248'))

index = Path('index.html')
text = index.read_text()
if 'v0.5.247' not in text:
    raise SystemExit('index visible v247 missing')
text = text.replace('v0.5.247','v0.5.248')
if './main.js?build=v0.5.96' not in text:
    raise SystemExit('stale entry build anchor missing')
text = text.replace('./main.js?build=v0.5.96','./main.js?build=v0.5.248',1)
index.write_text(text)

sw=Path('sw.js')
text=sw.read_text()
if 'airgapper-static-js-v203' not in text:
    raise SystemExit('sw cache v203 missing')
sw.write_text(text.replace('airgapper-static-js-v203','airgapper-static-js-v204',1))
