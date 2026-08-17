from pathlib import Path
p = Path('receive/main.js')
s = p.read_text()
old = '''  // Memory is still the first fallback in acquisition rescue and is reused after\n  // lock for the normal motion-safe shutter/ISO tuning pass.\n'''
new = '''  // Remembered ISO is deliberately not used before first lock; memory is reused\n  // only after acquisition for the normal motion-safe shutter/ISO tuning pass.\n'''
if old not in s:
    raise SystemExit('cold acquisition comment anchor missing')
p.write_text(s.replace(old, new, 1))
