import subprocess

source = subprocess.check_output([
    "git", "show",
    "b52de0467454fc3c98c034d3fe7b7c3587683187:.github/v268_diagnostics_patch.py"
], text=True)
old_anchor = "old='''      livePipeline.captures++;'''"
new_anchor = "old='''  if (!replayRunning && livePipeline.startedAt) livePipeline.captures++;'''"
old_replacement = "new='''      if (!livePipeline.firstCaptureAt) livePipeline.firstCaptureAt = now;\n      livePipeline.captures++;'''"
new_replacement = "new='''  if (!replayRunning && livePipeline.startedAt) {\n    if (!livePipeline.firstCaptureAt) livePipeline.firstCaptureAt = now;\n    livePipeline.captures++;\n  }'''"
if old_anchor not in source or old_replacement not in source:
    raise SystemExit('capture patch source text missing')
source = source.replace(old_anchor, new_anchor, 1).replace(old_replacement, new_replacement, 1)
exec(compile(source, 'v268_diagnostics_inner.py', 'exec'), {})
