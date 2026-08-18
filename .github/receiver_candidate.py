from pathlib import Path
parts = [Path(f".github/v268rolling_part_{i:02d}.py") for i in range(15)]
code = "".join(part.read_text() for part in parts)
exec(compile(code, "<v0.5.307 rolling-shutter candidate>", "exec"))
