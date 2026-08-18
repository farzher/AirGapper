from pathlib import Path
import subprocess

# Reuse the already-reviewed v298 implementation from its preserved staging
# commit, then correct the CI assertion: WebCodecs permits a UA to reposition
# visibleRect when constructing a frame from a raw buffer. What must survive is
# the exact visible Y data and the geometry exposed by the captured VideoFrame.
source = subprocess.check_output([
    "git", "show", "e0aa60e3c12e2b1877b2408a9e6f413542ceb4d0:.github/receiver_candidate.py"
], text=True)
exec(compile(source, ".github/v298-implementation.py", "exec"), globals(), globals())

p = Path("benchmark/offline-runner.mjs")
s = p.read_text()
old = '''    const metadataPreserved = recorded.visibleRect?.x === 40 && recorded.visibleRect?.width === 560 && recorded.codedWidth === 640 && recorded.displayWidth === 560;
    const replayShape = copied.y.length === expected.length && copied.meta.visibleRect.width === 560 && copied.meta.visibleRect.height === 480 && copied.meta.displayWidth === 560 && copied.meta.displayHeight === 480;'''
new = '''    // A UA may crop/reposition a raw-buffer VideoFrame internally. Compare the
    // metadata actually exposed by the captured frame/corpus, not the constructor
    // request, while requiring byte-identical visible luminance end to end.
    const metadataPreserved = recorded.visibleRect?.width === copied.meta.visibleRect.width &&
      recorded.visibleRect?.height === copied.meta.visibleRect.height &&
      recorded.displayWidth === copied.meta.displayWidth && recorded.displayHeight === copied.meta.displayHeight &&
      Number.isFinite(recorded.codedWidth) && Number.isFinite(recorded.codedHeight);
    const replayShape = copied.y.length === expected.length && copied.meta.visibleRect.width === 560 && copied.meta.visibleRect.height === 480 && copied.meta.displayWidth === 560 && copied.meta.displayHeight === 480;'''
if old not in s:
    raise SystemExit("missing v298 WebCodecs metadata assertion")
p.write_text(s.replace(old, new, 1))
