from pathlib import Path
import subprocess

# Reuse the already-reviewed v266 implementation from git history, then apply
# the one partial-compositing correction found by its regression run.
source = subprocess.check_output([
    "git", "show",
    "6d9762e28c3645dfecec7f1cbccf23f709a17358:.github/v266_staggered_sender_patch.py"
], text=True)
source = source.replace('v0.5.266', 'v0.5.267')
exec(compile(source, "v267_base_patch", "exec"), {})

p = Path("send/main.js")
s = p.read_text()
start = s.find('    const drawPageCell = (page, offset) => {')
end = s.find('\n    };\n\n    for (let i = 0; i < workerCount; ++i) {', start)
if start < 0 or end < 0:
    raise SystemExit("drawPageCell block missing after base patch")
chunk = s[start:end]
# Porter-Duff `copy` is appropriate for replacing the complete wall, but not
# for regional updates: transparent source outside the draw can erase the rest
# of the destination. Every QR/page source is opaque, so source-over exactly
# replaces the touched region while preserving all other staggered cells.
chunk = chunk.replace('globalCompositeOperation = "copy"', 'globalCompositeOperation = "source-over"')
s = s[:start] + chunk + s[end:]
p.write_text(s)
