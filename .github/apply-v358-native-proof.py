from pathlib import Path

p = Path('receive/main.js')
text = p.read_text(encoding='utf-8')
old = '''    for (const slot of auditMode?.trackSlots ?? []) {\n      const region = regions.find((candidate) => candidate.gridSlot === slot);\n      if (!region?.decoded) continue;\n      region.seen = proofAt;\n'''
new = '''    for (const slot of auditMode?.trackSlots ?? []) {\n      const region = regions.find((candidate) => candidate.gridSlot === slot);\n      if (!region) continue;\n      region.seen = proofAt;\n'''
count = text.count(old)
if count != 1:
    raise SystemExit(f'expected one native-proof anchor, found {count}')
p.write_text(text.replace(old, new, 1), encoding='utf-8')
print('AIRGAPPER_V358_NATIVE_PROOF_PATCHED')
