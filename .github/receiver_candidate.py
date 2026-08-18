from pathlib import Path
import subprocess

# Reuse the already-green v299 candidate exactly, except do not let a candidate
# modify the workflow that is trying to promote it. GitHub Actions' token has
# contents:write but intentionally cannot push workflow changes without the
# separate workflows permission. The workflow update is applied separately.
source = subprocess.check_output([
    "git", "show", "11c5639395f8583ec5333fc50e66346b01665fb6:.github/receiver_candidate.py"
], text=True)
start = source.index("workflow = Path('.github/workflows/apply-v217-offline-benchmark.yml').read_text()")
end = source.index("\nfor path, needle in [", start)
source = source[:start] + source[end:]
source = source.replace("\n('.github/workflows/apply-v217-offline-benchmark.yml','benchmark/corpora/**')", "")
exec(compile(source, ".github/v299-implementation.py", "exec"), globals(), globals())
