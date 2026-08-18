import subprocess
from pathlib import Path

SOURCE_COMMIT = '72e85d0ff2c0742000707688e8045b2582f0d4a7'
raw = subprocess.check_output(
    ['git', 'show', f'{SOURCE_COMMIT}:.github/v242_warp_metrics_patch.py'],
    text=True,
)
exec(compile(raw, '<v242-warp-metrics>', 'exec'), {'__name__': '__main__'})

cpp = Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp')
s = cpp.read_text()
if 'sizeof(DecimenGuidedMetrics) == 168' not in s:
    raise SystemExit('Guided metrics ABI assert anchor missing')
s = s.replace('sizeof(DecimenGuidedMetrics) == 168', 'sizeof(DecimenGuidedMetrics) == 176', 1)
s = s.replace('DecimenGuidedMetrics JS ABI must allocate 168 bytes', 'DecimenGuidedMetrics JS ABI must allocate 176 bytes', 1)
cpp.write_text(s)
