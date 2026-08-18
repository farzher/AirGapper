from pathlib import Path

# Reuse the rejected v256 patch source from git, but fix the replacement boundary:
# v256 stopped at the first requestAnimationFrame(tick) *inside* the old tick body.
# v257 removes the whole old sender rendering tail through the final rAF call.
import subprocess

subprocess.run([
    "git", "show", "05d9eb9167d7a2d03fd8b6129b7706301c75cc2b:.github/v256_sender_page_workers_patch.py"
], check=True, stdout=open("/tmp/v256.py", "wb"))
text = Path("/tmp/v256.py").read_text()
text = text.replace('const SEND_RUNTIME_BUILD = \\"v0.5.256\\";', 'const SEND_RUNTIME_BUILD = \\"v0.5.257\\";')
text = text.replace('RECEIVER_RUNTIME_BUILD = \\"v0.5.256\\"', 'RECEIVER_RUNTIME_BUILD = \\"v0.5.257\\"')
text = text.replace('APP_BUILD = \\"v0.5.256\\"', 'APP_BUILD = \\"v0.5.257\\"')
text = text.replace("index = index.replace('v0.5.255', 'v0.5.256')", "index = index.replace('v0.5.255', 'v0.5.257')")
text = text.replace("index = index.replace('./main.js?build=v0.5.250', './main.js?build=v0.5.256')", "index = index.replace('./main.js?build=v0.5.250', './main.js?build=v0.5.257')")
text = text.replace("'airgapper-static-js-v210', 'airgapper-static-js-v211'", "'airgapper-static-js-v210', 'airgapper-static-js-v212'")
# Find the complete old tail: the final rAF invocation immediately before startStream closes.
text = text.replace(
    "end_marker = '  requestAnimationFrame(tick);\\n'\nend = send.index(end_marker, start) + len(end_marker)",
    "end_marker = '  };\\n  requestAnimationFrame(tick);\\n'\nend = send.index(end_marker, start) + len(end_marker)"
)
Path('/tmp/v257-apply.py').write_text(text)
subprocess.run(['python3', '/tmp/v257-apply.py'], check=True)
