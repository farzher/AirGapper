from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:220]!r}")
    p.write_text(text.replace(old, new, 1))


cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"
replace_once(
    cpp,
    "    ByteArray raw(totalCodewords);\n    ByteArray ambiguityScore;\n    bool erasureSampling = false;",
    "    ByteArray raw(totalCodewords);\n"
    "    ByteArray ambiguityScore(totalCodewords);\n"
    "    std::fill(ambiguityScore.begin(), ambiguityScore.end(), uint8_t(255));\n"
    "    bool erasureSampling = false;"
)
replace_once(
    cpp,
    "        erasureSampling = !tryNoRsFirst && !centerOnly && moduleSize < GUIDED_TURBO_NEAREST_MIN_MODULE;\n"
    "        if (erasureSampling) {\n"
    "            ambiguityScore.resize(totalCodewords);\n"
    "            std::fill(ambiguityScore.begin(), ambiguityScore.end(), uint8_t(255));\n"
    "        }\n"
    "        ByteArray progressiveData;",
    "        erasureSampling = !tryNoRsFirst && !centerOnly && moduleSize < GUIDED_TURBO_NEAREST_MIN_MODULE;\n"
    "        ByteArray progressiveData;"
)

replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.327";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.328";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.327";', 'const SEND_RUNTIME_BUILD = "v0.5.328";')
replace_once("main.js", 'const APP_BUILD = "v0.5.327";', 'const APP_BUILD = "v0.5.328";')
replace_once("index.html", '<span class="app-version">v0.5.327</span>', '<span class="app-version">v0.5.328</span>')
replace_once("index.html", './main.js?build=v0.5.327', './main.js?build=v0.5.328')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v275";', 'const CACHE = "airgapper-static-js-v276";')

print("staged v0.5.328: restore exact v323 decoder hot-path logic")
