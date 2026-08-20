from pathlib import Path
p = Path('receive/main.js')
s = p.read_text()
old = '${acquisitionAgeMs.toFixed(0)}ms race'
new = '${(acquisitionRaceStartedAt ? Math.max(0, perfNow - acquisitionRaceStartedAt) : 0).toFixed(0)}ms race'
if old not in s:
    raise SystemExit('acquisition diagnostic scope target not found')
s = s.replace(old, new, 1)
s = s.replace('  ACQUISITION_ESCALATE_MS,\n', '', 1)
p.write_text(s)
print('final browser optimization runtime fix applied')
