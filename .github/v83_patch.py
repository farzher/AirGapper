from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    s = p.read_text()
    count = s.count(old)
    assert count == 1, f"{path}: expected one match, got {count}"
    p.write_text(s.replace(old, new, 1))

replace_once(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    """\t// Only cache a calibration that decodes the current AirGapper packet and\n\t// passes its CRC. A bad alignment fit therefore cannot poison later frames.\n\tauto decoded = decodeWithoutErrorCorrection(sampled);\n\tif (!decoded.isValid() || !hasValidCRC32(decoded.content().bytes))\n\t\treturn false;\n""",
    """\t// Only cache a calibration that decodes the current AirGapper packet and\n\t// passes its CRC. At v40/high density, a geometrically correct sample can\n\t// still contain a few bad modules, so requiring a bit-perfect no-RS parse\n\t// here creates a catch-22: the map can never become calibrated and therefore\n\t// never reaches the cached QR-RS path. Calibration is rare setup work, so\n\t// validate with no-RS first, then QR Reed-Solomon before rejecting the map.\n\tauto decoded = decodeWithoutErrorCorrection(sampled);\n\tbool calibrationValid = decoded.isValid() && hasValidCRC32(decoded.content().bytes);\n\tif (!calibrationValid) {\n\t\tauto corrected = QRCode::Decode(sampled);\n\t\tcalibrationValid = corrected.isValid() && hasValidCRC32(corrected.content().bytes);\n\t}\n\tif (!calibrationValid)\n\t\treturn false;\n"""
)

replace_once("vendor/decimen-codec/source/VERSION", "0.1.8\n", "0.1.9\n")
p = Path("index.html")
s = p.read_text()
assert s.count("v0.5.82") == 2, f"index.html: expected two v0.5.82 strings, got {s.count('v0.5.82')}"
p.write_text(s.replace("v0.5.82", "v0.5.83"))
replace_once("main.js", 'const APP_BUILD = "v0.5.82";', 'const APP_BUILD = "v0.5.83";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.82";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.83";')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v45";', 'const CACHE = "airgapper-static-js-v46";')
