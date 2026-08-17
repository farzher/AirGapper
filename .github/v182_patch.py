from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old!r}")
    p.write_text(text.replace(old, new, 1))

for path in ["index.html", "main.js", "receive/main.js"]:
    p = Path(path)
    text = p.read_text()
    if "v0.5.181" not in text:
        raise SystemExit(f"expected v0.5.181 in {path}")
    p.write_text(text.replace("v0.5.181", "v0.5.182"))

replace_once("sw.js", "airgapper-static-js-v143", "airgapper-static-js-v144")
replace_once("vendor/decimen-codec/source/VERSION", "0.1.17", "0.1.18")

cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"
replace_once(
    cpp,
    '''                int sparseAlignmentFound = 0;\n                auto sparse = sampleGuidedSparse(*bits, track, finderSet, &sparseAlignmentFound);''',
    '''                auto sparse = sampleGuidedSparse(*bits, track, finderSet, nullptr);'''
)
replace_once(
    cpp,
    '''                    if (sparseAlignmentFound >= 6) {\n                        ++metrics->sparseNoRsAttempts;\n                        auto fast = decodeWithoutErrorCorrection(sparse.bits());\n                        if (fast.isValid() && !fast.content().bytes.empty() && hasValidCRC32(fast.content().bytes)) {\n                            decodedTrack = commitDecoded(sparse, fast);\n                            if (decodedTrack) ++metrics->sparseNoRsSuccesses;\n                        }\n                    }\n''',
    ''''''
)

# workflow trigger
