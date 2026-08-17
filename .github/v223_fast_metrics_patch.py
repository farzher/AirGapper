from pathlib import Path

p = Path("receive/main.js")
s = p.read_text()
old = '''    stableRsAttempts: sumGuided("stableRsAttempts"),
    stableRsSuccesses: sumGuided("stableRsSuccesses"),
    sparseAttempts: sumGuided("fastDecodeAttempts"),'''
new = '''    stableRsAttempts: sumGuided("stableRsAttempts"),
    stableRsSuccesses: sumGuided("stableRsSuccesses"),
    dataOnlyAttempts: sumGuided("sparseNoRsAttempts"),
    dataOnlySuccesses: sumGuided("sparseNoRsSuccesses"),
    rsFallbacks: sumGuided("sparseRsFallbacks"),
    sparseAttempts: sumGuided("fastDecodeAttempts"),'''
if old not in s:
    if 'dataOnlyAttempts: sumGuided("sparseNoRsAttempts")' in s:
        raise SystemExit(0)
    raise SystemExit("fast guided metrics target not found")
p.write_text(s.replace(old, new, 1))
