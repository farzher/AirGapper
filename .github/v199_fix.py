from pathlib import Path
p = Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s = p.read_text()
old = '            if (guidedModuleSize(track) < GUIDED_TURBO_FULL_MIN_MODULE) {'
if old not in s:
    raise SystemExit('leftover full-density rollout gate missing')
s = s.replace(old, '            {', 1)
p.write_text(s)
