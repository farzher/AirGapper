from pathlib import Path

EXPECTED = {
    "index.html": [("v0.5.358", "v0.5.359", 1)],
    "main.js": [("v0.5.358", "v0.5.359", 1)],
    "receive/main.js": [("v0.5.358", "v0.5.359", 1)],
    "sw.js": [("airgapper-static-js-v358", "airgapper-static-js-v359", 1)],
    "android/app/build.gradle": [
        ("versionCode 358", "versionCode 359", 1),
        ('versionName "0.5.358"', 'versionName "0.5.359"', 1),
    ],
}

# Refuse to leave an unexpected app-version reference behind. Workflow release
# metadata is updated separately through the GitHub connector because Actions
# tokens intentionally cannot modify workflow files.
needles = ("v0.5.358", "0.5.358", "airgapper-static-js-v358", "versionCode 358")
exts = {".js", ".mjs", ".html", ".gradle", ".json", ".webmanifest", ".md", ".txt"}
found = set()
for path in Path(".").rglob("*"):
    if not path.is_file() or path.suffix.lower() not in exts:
        continue
    parts = path.parts
    if ".git" in parts or ".github" in parts or "node_modules" in parts:
        continue
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        continue
    if any(needle in text for needle in needles):
        found.add(path.as_posix().removeprefix("./"))

expected_paths = set(EXPECTED)
if found != expected_paths:
    raise SystemExit(
        "unexpected v0.5.358 references; expected "
        + repr(sorted(expected_paths))
        + " but found "
        + repr(sorted(found))
    )

for filename, replacements in EXPECTED.items():
    path = Path(filename)
    text = path.read_text(encoding="utf-8")
    for old, new, expected_count in replacements:
        count = text.count(old)
        if count != expected_count:
            raise SystemExit(f"{filename}: expected {expected_count} occurrences of {old!r}, found {count}")
        text = text.replace(old, new)
    path.write_text(text, encoding="utf-8")

print("v0.5.359 source bump applied:", ", ".join(sorted(EXPECTED)))
