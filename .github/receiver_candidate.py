from pathlib import Path
import subprocess

for script in [
    '.github/ambiguity_erasures_patch.py',
    '.github/ambiguity_dense_fence.py',
    '.github/v268_diagnostics_patch3.py',
]:
    subprocess.run(['python3', script], check=True)

Path('.github/receiver_candidate_message.txt').write_text(
    'v0.5.268 dense ambiguity erasure sampling\n'
)
