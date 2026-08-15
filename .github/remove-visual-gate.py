from pathlib import Path
import re


def sub(path, pattern, repl, *, count=0, flags=0, label=None):
    p = Path(path)
    text = p.read_text()
    new, n = re.subn(pattern, repl, text, count=count, flags=flags)
    if n == 0:
        raise SystemExit(f"{path}: no match for {label or pattern[:120]!r}")
    p.write_text(new)
    print(f"{path}: {label or pattern[:50]} -> {n}")


def remove_lines(path, needles):
    p = Path(path)
    lines = p.read_text().splitlines(True)
    removed = [line for line in lines if any(n in line for n in needles)]
    p.write_text(''.join(line for line in lines if not any(n in line for n in needles)))
    print(f"{path}: removed {len(removed)} lines matching {needles}")

# Remove the sparse frame fingerprint entirely. It is not a faithful production
# optimization for noisy camera input and can hide decoder correctness failures.
sub(
    "receive/worker.js",
    r"const TRACKED_VISUAL_GRID = 5;.*?(?=function ensureNativeBatch\()",
    "",
    count=1,
    flags=re.S,
    label="tracked visual fingerprint implementation",
)
sub(
    "receive/worker.js",
    r", strictTracked = false, skipUnchanged = false, visualTrackId = -1 } = e\.data;",
    ", strictTracked = false } = e.data;",
    count=1,
    label="worker message visual-gate fields",
)
sub(
    "receive/worker.js",
    r"\n\s*// Never let the unchanged-frame gate suppress a requested recovery\.\n\s*const trackedVisual = .*?\nif \(trackedVisual && shouldSkipTrackedVisual\(trackedVisual, performance\.now\(\)\)\) \{.*?\n\}\n\s*const native = decodeNativeBatch\(",
    "\n      const native = decodeNativeBatch(",
    count=1,
    flags=re.S,
    label="batched tracked visual skip",
)
remove_lines("receive/worker.js", ["trackedVisual) rememberTrackedVisual"])
sub(
    "receive/worker.js",
    r"\n\s*const trackedVisual = skipUnchanged .*?\nif \(trackedVisual && shouldSkipTrackedVisual\(trackedVisual, performance\.now\(\)\)\) \{.*?\n\}\n\s*trackedAttempted = true;",
    "\n      trackedAttempted = true;",
    count=1,
    flags=re.S,
    label="single tracked visual skip",
)

# Remove worker-pool transport fields used only by the gate.
remove_lines("shared/worker-pool.js", ["unchangedTracked:", "unchangedTrackCount:"])

# Remove main-thread accounting/diagnostics and any request flags for the gate.
p = Path("receive/main.js")
text = p.read_text()
# Completion early-return block.
text, n = re.subn(
    r"\n\s*if \(completion\.unchangedTracked\) \{\s*unchangedSkipEvents\.push\(\{.*?\}\);\s*return;\s*\}",
    "",
    text,
    count=1,
    flags=re.S,
)
print(f"receive/main.js: completion visual-skip block -> {n}")
# Declaration / pruning / resets / developer-only text. These are standalone lines.
lines = text.splitlines(True)
needles = (
    "unchangedSkipEvents",
    "Unchanged visual skips",
    "skipUnchanged:",
    "visualTrackId:",
)
removed = [line for line in lines if any(n in line for n in needles)]
text = ''.join(line for line in lines if not any(n in line for n in needles))
p.write_text(text)
print(f"receive/main.js: removed {len(removed)} visual-gate plumbing lines")

# Bump visible/cache versions.
for path, old, new in [
    ("index.html", "v0.5.48", "v0.5.49"),
    ("sw.js", "airgapper-static-js-v11", "airgapper-static-js-v12"),
]:
    p = Path(path)
    t = p.read_text()
    if old not in t:
        raise SystemExit(f"{path}: expected {old}")
    p.write_text(t.replace(old, new, 1))

# Assert the removed optimization is truly gone from production source.
for path in ["receive/worker.js", "receive/main.js", "shared/worker-pool.js"]:
    t = Path(path).read_text()
    forbidden = [
        "TRACKED_VISUAL_",
        "previousTrackedVisual",
        "trackedVisual",
        "skipUnchanged",
        "visualTrackId",
        "unchangedTracked",
        "unchangedTrackCount",
        "unchangedSkipEvents",
        "Unchanged visual skips",
    ]
    leftovers = [token for token in forbidden if token in t]
    if leftovers:
        raise SystemExit(f"{path}: visual gate leftovers: {leftovers}")

print("visual gate fully removed")
