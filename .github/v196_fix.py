from pathlib import Path
p = Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s = p.read_text()
a = s.index('static DecoderResult decodeTurboDataOnly')
b = s.index('static PointF turboRefineWallOffset', a)
chunk = s[a:b].replace('metrics->', 'metrics.')
p.write_text(s[:a] + chunk + s[b:])
