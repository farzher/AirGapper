from pathlib import Path

p = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
text = p.read_text()
old = "const double moduleSize = std::max(1.0, guidedModuleSize(track));"
new = "const double moduleSize = std::max(1.0f, guidedModuleSize(track));"
if old not in text:
    raise SystemExit("v164 module-size anchor missing")
p.write_text(text.replace(old, new, 1))
