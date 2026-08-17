from pathlib import Path

p = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
text = p.read_text()
old = "correctedBR = actualTL + (PointF(fp.tr) - actualTL) * a + (PointF(fp.bl) - actualTL) * b;"
new = "correctedBR = actualTL + a * (PointF(fp.tr) - actualTL) + b * (PointF(fp.bl) - actualTL);"
if old not in text:
    raise SystemExit("v159 scalar multiplication anchor missing")
p.write_text(text.replace(old, new, 1))
