from pathlib import Path

p = Path('receive/worker.js')
s = p.read_text()
s = s.replace('    const samplerDiagnostics = [];\n', '')
p.write_text(s)
