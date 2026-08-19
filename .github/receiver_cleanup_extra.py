from pathlib import Path
import re

ROOT = Path('.')


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'missing cleanup anchor in {path}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1))


# This script runs after receiver_candidate.py, so the codec migration and the
# first cleanup layer have already produced the post-v349 tree.
if not Path('codec/source').is_dir():
    raise SystemExit('AirGapper codec migration did not run before source cleanup')
if Path('vendor/decimen-codec').exists() or Path('vendor/decimen-codec-android').exists():
    raise SystemExit('historical codec directories still exist')

# First-party browser source was accumulated through several transpiled edits
# even though AirGapper runs source ESM directly. Remove the generated class
# field runtime and write the assignments plainly.
first_party = [Path('main.js')]
for folder in ('send', 'receive', 'shared'):
    first_party.extend(sorted(Path(folder).glob('*.js')))

helper_preamble = (
    'var __defProp = Object.defineProperty;\n'
    'var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;\n'
    'var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);\n'
)
field_line = re.compile(r'^(\s*)__publicField\((this|[A-Za-z_$][\w$]*), "([^"]+)"(?:, (.*))?\);(\r?\n)?$')
for path in first_party:
    if not path.exists():
        continue
    text = path.read_text()
    if text.startswith(helper_preamble):
        text = text[len(helper_preamble):]
    out = []
    for line in text.splitlines(keepends=True):
        match = field_line.match(line)
        if not match:
            out.append(line)
            continue
        indent, target, name, value, ending = match.groups()
        if not re.fullmatch(r'[A-Za-z_$][\w$]*', name):
            raise SystemExit(f'cannot simplify generated field {name!r} in {path}')
        out.append(f'{indent}{target}.{name} = {value if value is not None else "undefined"};{ending or ""}')
    text = ''.join(out)
    if '__publicField' in text or '__defNormalProp' in text or '__defProp' in text:
        raise SystemExit(f'generated class-field helper remains in {path}')
    path.write_text(text)

# dialog.js is a one-call wrapper. Keep the exact backdrop behavior at its one
# callsite instead of carrying a module and a service-worker entry for it.
main = Path('main.js')
text = main.read_text()
replace_import = 'import { closeOnBackdropClick } from "./shared/dialog.js";\n'
if text.count(replace_import) != 1 or text.count('closeOnBackdropClick(receiverLinkDialog);') != 1:
    raise SystemExit('dialog helper is no longer the expected one-use wrapper')
text = text.replace(replace_import, '')
text = text.replace(
    'closeOnBackdropClick(receiverLinkDialog);',
    '''receiverLinkDialog.addEventListener("click", (event) => {
  if (event.target !== receiverLinkDialog) return;
  const rect = receiverLinkDialog.getBoundingClientRect();
  const inside = event.clientX >= rect.left && event.clientX <= rect.right &&
    event.clientY >= rect.top && event.clientY <= rect.bottom;
  if (!inside) receiverLinkDialog.close();
});'''
)
# One obvious top-level transpiler temporary has only one purpose.
text = text.replace('const receiverUrl = (_a = headerQr.dataset.receiverUrl) != null ? _a : "";',
                    'const receiverUrl = headerQr.dataset.receiverUrl ?? "";')
if not re.search(r'\b_a\b', text.replace('var _a;\n', '')):
    text = text.replace('var _a;\n', '', 1)
main.write_text(text)
Path('shared/dialog.js').unlink()

# send-settings.js only existed to export one array to send/main.js; its other
# constants are stale pre-current-UI defaults/hints. Verify that it truly has a
# single consumer before folding that array into the sender.
refs = []
for path in first_party:
    if path.exists() and 'send-settings.js' in path.read_text():
        refs.append(path.as_posix())
if refs != ['send/main.js']:
    raise SystemExit(f'unexpected send-settings consumers: {refs}')
sender = Path('send/main.js')
text = sender.read_text()
import_line = 'import { FRAME_BYTES_OPTIONS } from "../shared/send-settings.js";\n'
if text.count(import_line) != 1:
    raise SystemExit('send settings import changed')
text = text.replace(import_line, '')
anchor = 'import { GRID_MARGIN_MODULES, gridLayoutId } from "../shared/grid-layout.js";\n'
if anchor not in text:
    raise SystemExit('sender settings insertion anchor missing')
text = text.replace(anchor, anchor + 'const FRAME_BYTES_OPTIONS = [500, 1000, 1465, 1850, 2331, 2953];\n', 1)
Path('shared/send-settings.js').unlink()

# Do not preserve UI-layout compatibility with old development builds. The
# current UI exposes only auto-1..4 and the current fixed layouts.
if text.count('mode === "auto" || ') != 2:
    raise SystemExit('unexpected legacy Auto alias count')
text = text.replace('mode === "auto" || ', '')
if text.count('  if (mode === "auto") return 2;\n') != 1:
    raise SystemExit('legacy Auto density alias changed')
text = text.replace('  if (mode === "auto") return 2;\n', '')
legacy_layouts = '''    if (saved.layout === "auto") {
      // v0.5.307 Auto used a 2 px/module floor. Preserve that behavior when
      // migrating saved settings into the explicit Auto density family.
      cfgLayout.value = "auto-2";
    } else if (saved.layout === "auto-1" || saved.layout === "auto-2" || saved.layout === "auto-3" || saved.layout === "auto-4" || saved.layout === "single" || saved.layout === "one-two" || saved.layout === "two-two" || saved.layout === "two-three" || saved.layout === "four-three" || saved.layout === "three-five" || saved.layout === "three-six" || saved.layout === "four-six" || saved.layout === "four-seven" || saved.layout === "four-eight") {
      cfgLayout.value = saved.layout;
    } else if (saved.layout === "five-three") {
      cfgLayout.value = "three-five";
      cfgOrientation.value = "landscape";
    }
'''
current_layouts = '''    if (saved.layout === "auto-1" || saved.layout === "auto-2" || saved.layout === "auto-3" || saved.layout === "auto-4" || saved.layout === "single" || saved.layout === "one-two" || saved.layout === "two-two" || saved.layout === "two-three" || saved.layout === "four-three" || saved.layout === "three-five" || saved.layout === "three-six" || saved.layout === "four-six" || saved.layout === "four-seven" || saved.layout === "four-eight") {
      cfgLayout.value = saved.layout;
    }
'''
if legacy_layouts not in text:
    raise SystemExit('saved-layout compatibility block changed')
text = text.replace(legacy_layouts, current_layouts, 1)
sender.write_text(text)

# v348 already guarantees that the transport planner sends an exact QR version
# to every page worker. Make that contract explicit and delete the old fallback
# which let each worker rediscover a version independently.
render_worker = Path('send/render-worker.js')
text = render_worker.read_text()
replace_once('send/render-worker.js', '    let version = job.version;\n',
             '    const version = Number(job.version);\n    if (!Number.isInteger(version) || version < 1 || version > 40) throw new Error("Render page needs a QR version");\n')
text = render_worker.read_text()
if text.count('      if (version === undefined) version = qr.version;\n') != 1:
    raise SystemExit('render-worker version fallback changed')
text = text.replace('      if (version === undefined) version = qr.version;\n', '')
render_worker.write_text(text)

# Keep the actual bootstrap query synchronized with the runtime build. This was
# stale even though main/send/receive already reported newer versions.
index = Path('index.html')
text = index.read_text()
text, count = re.subn(r'(src="\./main\.js\?build=)v0\.5\.\d+("[^>]*></script>)', r'\1v0.5.349\2', text, count=1)
if count != 1:
    raise SystemExit('could not synchronize index bootstrap build')
index.write_text(text)

# Deleted modules must also disappear from offline precache.
sw = Path('sw.js')
text = sw.read_text()
for deleted in ('./shared/dialog.js', './shared/send-settings.js'):
    line = f'    "{deleted}",\n'
    if line not in text:
        raise SystemExit(f'missing service-worker entry for deleted module {deleted}')
    text = text.replace(line, '')
sw.write_text(text)

# Remove declaration-only simple constants that have accumulated in first-party
# files. Restrict this to literal/numeric one-line constants so deleting one can
# never discard an initializer with side effects.
literal_const = re.compile(r'(?m)^const ([A-Z][A-Z0-9_]*) = (?:-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|true|false|null|"[^"\n]*"|\'[^\'\n]*\');\n', re.I)
for path in [Path('main.js'), *sorted(Path('send').glob('*.js')), *sorted(Path('receive').glob('*.js')), *sorted(Path('shared').glob('*.js'))]:
    if not path.exists():
        continue
    text = path.read_text()
    changed = True
    while changed:
        changed = False
        for match in list(literal_const.finditer(text)):
            name = match.group(1)
            if len(re.findall(rf'\b{re.escape(name)}\b', text)) == 1:
                text = text[:match.start()] + text[match.end():]
                changed = True
                break
    path.write_text(text)

# Hygiene assertions for the maintained source tree.
for path in [Path('main.js'), *sorted(Path('send').glob('*.js')), *sorted(Path('receive').glob('*.js')), *sorted(Path('shared').glob('*.js'))]:
    if not path.exists():
        continue
    text = path.read_text()
    if '__publicField' in text or '__defNormalProp' in text or '__defProp' in text:
        raise SystemExit(f'generated class helper remains in {path}')
    if 'decimen' in text.lower():
        raise SystemExit(f'historical codec name returned in {path}')
if Path('shared/dialog.js').exists() or Path('shared/send-settings.js').exists() or Path('shared/decode-policy.js').exists():
    raise SystemExit('deleted one-use modules still exist')
if 'mode === "auto"' in Path('send/main.js').read_text() or 'saved.layout === "auto"' in Path('send/main.js').read_text() or 'five-three' in Path('send/main.js').read_text():
    raise SystemExit('obsolete sender layout compatibility remains')
if 'src="./main.js?build=v0.5.349"' not in Path('index.html').read_text():
    raise SystemExit('index bootstrap build is stale')
for path, marker in (('main.js', 'const APP_BUILD = "v0.5.349";'), ('send/main.js', 'const SEND_RUNTIME_BUILD = "v0.5.349";'), ('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.349";')):
    if marker not in Path(path).read_text():
        raise SystemExit(f'build marker mismatch in {path}')

# This is a staging helper, not repository source.
Path(__file__).unlink(missing_ok=True)
print('v0.5.349 source cleanup layer applied')
