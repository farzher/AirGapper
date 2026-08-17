from pathlib import Path
p = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
text = p.read_text()
old = "                    return ConcentricPattern{(*cor1 + *cor2) / 2, (cor1->size + cor2->size) / 2};"
new = """                    ConcentricPattern found;\n                    static_cast<PointF&>(found) = (*cor1 + *cor2) / 2;\n                    found.size = (cor1->size + cor2->size) / 2;\n                    return found;"""
if old not in text:
    raise SystemExit("v160 ConcentricPattern construction anchor missing")
p.write_text(text.replace(old, new, 1))
