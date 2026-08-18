import subprocess

# Reuse the already-reviewed diagnostics patch from its commit, but repair the
# one captureFrame anchor that production formats as a one-line conditional.
source = subprocess.check_output([
    "git", "show",
    "b52de0467454fc3c98c034d3fe7b7c3587683187:.github/v268_diagnostics_patch.py"
], text=True)
old = '''old='''      livePipeline.captures++;'''\n          new='''      if (!livePipeline.firstCaptureAt) livePipeline.firstCaptureAt = now;\n      livePipeline.captures++;'''\n          if old not in s: raise SystemExit('capture timestamp anchor missing')\n          s=s.replace(old,new,1)'''
new = '''old='''  if (!replayRunning && livePipeline.startedAt) livePipeline.captures++;'''\n          new='''  if (!replayRunning && livePipeline.startedAt) {\n    if (!livePipeline.firstCaptureAt) livePipeline.firstCaptureAt = now;\n    livePipeline.captures++;\n  }'''\n          if old not in s: raise SystemExit('capture timestamp anchor missing')\n          s=s.replace(old,new,1)'''
if old not in source:
    raise SystemExit('old diagnostics capture patch block not found')
source = source.replace(old, new, 1)
exec(compile(source, 'v268_diagnostics_patch2_inner.py', 'exec'), {})
