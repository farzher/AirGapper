from pathlib import Path
import subprocess

# Reapply the previous v0.5.312 retry, then fix the legacy-only observation
# filter exposed by the new extended-grid lattice regression.
# Retriggered unchanged after the preceding Actions job exceeded its job timeout
# without reaching either promotion or rejection cleanup.
source = subprocess.check_output([
    "git", "show",
    "6f358e26f99308b558979a7633282c4543bc3534:.github/receiver_candidate.py"
], text=True)
ns = {}
exec(compile(source, "v0.5.312-retry-2", "exec"), ns)

ns["replace_once"](
    "receive/grid-lattice.js",
    '''      const declared = gridLayoutById(observation.layoutId);
      if (!declared || declared.cols !== layout.cols || declared.rows !== layout.rows) continue;''',
    '''      const declared = declaredGridLayout(observation);
      if (!declared || declared.cols !== layout.cols || declared.rows !== layout.rows) continue;'''
)

Path("benchmark/receiver-candidate-ci.log").unlink(missing_ok=True)
