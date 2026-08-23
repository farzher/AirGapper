from pathlib import Path
import re

p = Path('receive/main.js')
s = p.read_text()

old = '''let requestedWidth = 1280;\nlet requestedHeight = 720;\nlet requestedFps = 60;'''
new = '''let requestedWidth = 2560;\nlet requestedHeight = 1440;\nlet requestedFps = 60;'''
if old not in s:
    raise SystemExit('missing requested camera defaults')
s = s.replace(old, new, 1)

old = 'video: { ...cameraChoice, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } }'
new = 'video: { ...cameraChoice, width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 60 } }'
if old not in s:
    raise SystemExit('missing auto browser getUserMedia request')
s = s.replace(old, new, 1)

pattern = re.compile(r'  const mainHint = .*?;\n  // A 7x4 wall needs more than 35\.7 camera frames/s to reach 1000 QR/s\.\n  // Prefer a camera capable of crossing that hard cadence threshold before\n  // comparing resolution; measured throughput separates cameras in each tier\.\n  const cadenceTier = fps >= 36 \? 1 : 0;\n  return cadenceTier \* 1e9 \+ area \+ fps \* 10000 \+ goodput \* 1000 \+ af \* 50000 \+ mainHint \* 1000 - index;')
replacement = '''  const mainHint = /camera(?:2)?\\s*0(?:\\D|$)|\\bmain\\b|\\bprimary\\b/.test(String(device.label ?? "").toLowerCase()) ? 1 : 0;\n  // The phone's primary rear sensor is the compatibility default even when an\n  // auxiliary rear lens advertises a higher browser FPS. If labels do not\n  // identify the main sensor, keep the existing cadence/resolution ranking.\n  const cadenceTier = fps >= 36 ? 1 : 0;\n  return mainHint * 1e12 + cadenceTier * 1e9 + area + fps * 10000 + goodput * 1000 + af * 50000 - index;'''
s, count = pattern.subn(replacement, s, count=1)
if count != 1:
    raise SystemExit('missing automatic camera ranking block')

p.write_text(s)

p = Path('version.js')
s = p.read_text()
old = 'export const APP_VERSION = "0.5.388";'
new = 'export const APP_VERSION = "0.5.389";'
if old not in s:
    raise SystemExit('unexpected version')
p.write_text(s.replace(old, new, 1))
