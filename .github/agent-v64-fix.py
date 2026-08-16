from pathlib import Path
import re


def read(path): return Path(path).read_text()
def write(path, text): Path(path).write_text(text)
def one(path, old, new):
    text = read(path)
    n = text.count(old)
    if n != 1:
        raise SystemExit(f"{path}: expected one match, got {n}: {old[:100]!r}")
    write(path, text.replace(old, new, 1))

worker = read("receive/worker.js")

# Temporary sampler-oracle diagnostics were useful to find the coordinate bug,
# but are not part of the production receive path anymore.
worker = worker.replace("let qrGeneratorPromise;\n", "")
worker = re.sub(r'''function globalQuad\(q, ox, oy\) \{.*?\n\}\nfunction projectedNeighbor''', 'function projectedNeighbor', worker, count=1, flags=re.S)
worker = worker.replace("    const samplerDiagnostics = [];\n", "")
worker = re.sub(r'''\n            if \(diagnoseSampler\) \{\n              const diagnostic = await diagnoseTrackedSampler\(zx, ptr, pw, ph, ox, oy, tracks\[trackIndex\], trackIndex, result\);\n              if \(diagnostic\) samplerDiagnostics\.push\(diagnostic\);\n            \}''', '', worker, count=1)
worker = worker.replace("        samplerDiagnostics,\n", "")

# Coordinate mapping applies to the native result array too; it does not share
# the generic symbols array used by fallback/full decoding.
worker = worker.replace(
    "    const mapOutputToDisplay = () => {\n",
    "    const mapOutputToDisplay = (decodedSymbols = symbols, decodedSightings = sightings) => {\n"
)
worker = worker.replace("      for (const symbol of symbols) {\n", "      for (const symbol of decodedSymbols) {\n", 1)
worker = worker.replace("      for (const box of sightings) {\n", "      for (const box of decodedSightings) {\n", 1)
worker = worker.replace("        mapOutputToDisplay();\n        const reply = {\n          id,\n          symbols: nativeSymbols,", "        mapOutputToDisplay(nativeSymbols);\n        const reply = {\n          id,\n          symbols: nativeSymbols,", 1)
write("receive/worker.js", worker)

main = read("receive/main.js")
main = main.replace("  if (completion.samplerDiagnostics?.length) lastSamplerDiagnostics = completion.samplerDiagnostics;\n", "")
main = main.replace(
    '        reacquire: gridLattice.state === "REACQUIRE",\n        acquisition: !gridLattice.active',
    '        reacquire: gridLattice.locked,\n        acquisition: !gridLattice.locked'
)
write("receive/main.js", main)
