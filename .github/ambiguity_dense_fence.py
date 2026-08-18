from pathlib import Path
p=Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s=p.read_text()
old='erasureSampling = !tryNoRsFirst && !centerOnly;'
new='erasureSampling = !tryNoRsFirst && !centerOnly && moduleSize < GUIDED_TURBO_NEAREST_MIN_MODULE;'
if old not in s:
    raise SystemExit('erasure sampling gate missing')
p.write_text(s.replace(old,new,1))
