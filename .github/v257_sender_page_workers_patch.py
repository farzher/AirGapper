from pathlib import Path
import subprocess

# Reuse the rejected v256 implementation exactly, changing only its version/cache
# stamps and the bad replacement boundary. v256 stopped at the first rAF call
# inside tick(), leaving the remainder of the old sender scheduler appended.
with open("/tmp/v256.py", "wb") as out:
    subprocess.run([
        "git", "show", "05d9eb9167d7a2d03fd8b6129b7706301c75cc2b:.github/v256_sender_page_workers_patch.py"
    ], check=True, stdout=out)
text = Path("/tmp/v256.py").read_text()
text = text.replace("v0.5.256", "v0.5.257")
text = text.replace("airgapper-static-js-v211", "airgapper-static-js-v212")
old = "end_marker = '  requestAnimationFrame(tick);\\n'\nend = send.index(end_marker, start) + len(end_marker)"
new = "end_marker = '  };\\n  requestAnimationFrame(tick);\\n'\nend = send.index(end_marker, start) + len(end_marker)"
if old not in text:
    raise SystemExit("v256 replacement-boundary anchor missing")
text = text.replace(old, new, 1)
Path("/tmp/v257-apply.py").write_text(text)
subprocess.run(["python3", "/tmp/v257-apply.py"], check=True)
