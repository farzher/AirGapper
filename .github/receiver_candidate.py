from pathlib import Path
import re
import shutil

ROOT = Path('.')
CANDIDATE = Path('.github/receiver_candidate.py')
TEXT_SUFFIXES = {'.js', '.mjs', '.html', '.css', '.md', '.yml', '.yaml', '.gradle', '.java', '.cpp', '.h', '.txt', '.sh'}


def rewrite(path, fn):
    p = Path(path)
    p.write_text(fn(p.read_text()))


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'missing anchor in {path}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1))


# Move the heavily modified QR codec out of vendor/ and give it an AirGapper
# identity. The original copyright/SPDX notices in the source remain intact.
codec = Path('codec')
if codec.exists():
    raise SystemExit('codec/ already exists')
codec.mkdir()
(codec / 'scalar').mkdir()
old_simd = Path('vendor/decimen-codec')
old_scalar = Path('vendor/decimen-codec-android')
if not (old_simd / 'source').is_dir():
    raise SystemExit('old codec source missing')
shutil.move(str(old_simd / 'source'), str(codec / 'source'))
for name in ('decimen_codec.js', 'decimen_codec.wasm'):
    shutil.move(str(old_simd / name), str(codec / name))
    shutil.move(str(old_scalar / name), str(codec / 'scalar' / name))
shutil.rmtree(old_simd)
shutil.rmtree(old_scalar)

wrapper = codec / 'source' / 'wrapper'
(wrapper / 'decimen_codec.cpp').rename(wrapper / 'airgapper_codec.cpp')
(wrapper / 'decimen_codec.h').rename(wrapper / 'airgapper_codec.h')
(codec / 'decimen_codec.js').rename(codec / 'airgapper_codec.js')
(codec / 'decimen_codec.wasm').rename(codec / 'airgapper_codec.wasm')
(codec / 'scalar' / 'decimen_codec.js').rename(codec / 'scalar' / 'airgapper_codec.js')
(codec / 'scalar' / 'decimen_codec.wasm').rename(codec / 'scalar' / 'airgapper_codec.wasm')

replacements = [
    ('vendor/decimen-codec-android/decimen_codec', 'codec/scalar/airgapper_codec'),
    ('vendor/decimen-codec/decimen_codec', 'codec/airgapper_codec'),
    ('vendor/decimen-codec-android', 'codec/scalar'),
    ('vendor/decimen-codec', 'codec'),
    ('DECIMEN_CODEC_VERSION', 'AIRGAPPER_CODEC_VERSION'),
    ('DECIMEN_CODEC_BUILD', 'AIRGAPPER_CODEC_BUILD'),
    ('DECIMEN_OUTPUT_DIR', 'AIRGAPPER_CODEC_OUTPUT_DIR'),
    ('DECIMEN_SIMD', 'AIRGAPPER_CODEC_SIMD'),
    ('DECIMEN_TRACK_', 'AIRGAPPER_TRACK_'),
    ('DecimenCodec', 'AirGapperCodec'),
    ('Decimen', 'AirGapper'),
    ('decimen_codec', 'airgapper_codec'),
    ('decimen-codec', 'airgapper-codec'),
    ('decimen', 'airgapper'),
]
for p in ROOT.rglob('*'):
    if not p.is_file() or p == CANDIDATE or '.git' in p.parts:
        continue
    if p.suffix.lower() not in TEXT_SUFFIXES and p.name not in {'.gitignore', 'CMakeLists.txt'}:
        continue
    try:
        text = p.read_text()
    except UnicodeDecodeError:
        continue
    new = text
    for old, replacement in replacements:
        new = new.replace(old, replacement)
    if new != text:
        p.write_text(new)

# New codec project/build identity. Keep the complete existing ABI in this pass:
# buffered RGBA/corpus input still exercises the persistent tracker, so deleting
# it before replacing that path would be behavior loss rather than cleanup.
(codec / 'source' / 'VERSION').write_text('0.2.0\n')
build = codec / 'source' / 'build.sh'
text = build.read_text()
text = re.sub(
    r'BANNER="/\*!.*?\*/"',
    'BANNER="/*! AirGapper QR codec v${VERSION} — build ${GIT_HASH} — wrapper copyright (c) 2026 Evan Crawley (Bash Alarmist), modified for AirGapper — SPDX-License-Identifier: AGPL-3.0-or-later */"',
    text,
    count=1,
)
build.write_text(text)
rewrite(codec / 'source' / 'wrapper' / 'airgapper_codec.cpp', lambda s: s.replace(
    '// source of truth is package.json). The defaults only appear in by-hand\n// compiles.',
    '// source of truth is VERSION). The defaults only appear in by-hand\n// compiles.'
))

# Tiny one-use policy wrapper adds indirection without state or policy surface.
worker = Path('receive/worker.js')
text = worker.read_text()
text = text.replace('import { shouldRunFullDecode } from "../shared/decode-policy.js";\n', '')
text = text.replace('shouldRunFullDecode(full, trackedAttempted, trackedHit)', '(full || !trackedAttempted || !trackedHit)')
worker.write_text(text)
Path('shared/decode-policy.js').unlink(missing_ok=True)

# These three files were checked in after transpilation despite being browser
# source. Convert the generated class-field helper calls back to plain JS.
def clean_class_fields(path):
    p = Path(path)
    text = p.read_text()
    text = re.sub(r'^var __defProp = .*?;\nvar __defNormalProp = .*?;\nvar __publicField = .*?;\n', '', text, count=1)
    text = re.sub(r'__publicField\(this, "([^"]+)", ([^\n]+?)\);', r'this.\1 = \2;', text)
    text = re.sub(r'__publicField\(this, "([^"]+)"\);', r'this.\1 = undefined;', text)
    if '__publicField' in text or '__defNormalProp' in text:
        raise SystemExit(f'generated class helper remains in {path}')
    p.write_text(text)

for path in ('shared/worker-pool.js', 'shared/transport.js', 'shared/raptorq.js'):
    clean_class_fields(path)

rewrite('shared/worker-pool.js', lambda s: s.replace('per-worker native tracking affinity', 'per-worker decoder-cache affinity').replace('warm native geometry cache', 'warm decoder geometry cache'))

# Remove sender constants only when they are provably declaration-only.
send = Path('send/main.js')
text = send.read_text()
for name in ('HEADER_MARGIN', 'DEFAULT_GRID_CODES'):
    if text.count(name) == 1:
        text = re.sub(rf'^const {name} = .*?;\n', '', text, count=1, flags=re.M)
send.write_text(text)

# Runtime and packaged-app references.
for path in ('main.js', 'send/main.js', 'receive/main.js', 'index.html'):
    rewrite(path, lambda s: s.replace('v0.5.348', 'v0.5.349'))
replace_once('android/app/build.gradle', 'versionCode 98', 'versionCode 349')
replace_once('android/app/build.gradle', 'versionName "0.5.40"', 'versionName "0.5.349"')

sw = Path('sw.js')
text = sw.read_text().replace('airgapper-static-js-v296', 'airgapper-static-js-v297')
text = text.replace('    "./shared/decode-policy.js",\n', '')
sw.write_text(text)

# Root ignore rules followed the old vendor layout and are now redundant with
# codec/source/.gitignore; keep explicit build-dir guards at the new location.
gitignore = Path('.gitignore')
text = gitignore.read_text()
text = re.sub(r'(?m)^vendor/[^\n]*codec/source/build-(?:scalar|simd)/\n?', '', text)
text = re.sub(r'(?m)^codec/source/build-(?:scalar|simd)/\n?', '', text)
text += 'codec/source/build-scalar/\ncodec/source/build-simd/\n'
gitignore.write_text(text)

# Historical one-off CI snapshots are not source. Keep reproducible scripts,
# corpora and benchmark/latest-result.json as the maintained benchmark surface.
for p in Path('benchmark').glob('v*-ci.log'):
    p.unlink()
for p in Path('benchmark').glob('v*-result.json'):
    p.unlink()
for name in ('camera-regression-ci.log', 'median-trials-ci.log', 'receiver-candidate-ci.log'):
    Path('benchmark', name).unlink(missing_ok=True)
Path('.github/workflows/quick-v281-completion-paint.yml').unlink(missing_ok=True)

# Replace the historically named workflow with the current workflow only. The
# parent commit already taught the running migration workflow the codec/ path.
final_workflow = '''name: fast regression

on:
  push:
    paths:
      - receive/**
      - shared/**
      - codec/**
      - send/**
      - main.js
      - index.html
      - sw.js
      - android/app/build.gradle
      - benchmark/offline-runner.mjs
      - benchmark/grid-lattice-regression.mjs
      - benchmark/run-agcap.mjs
      - benchmark/corpus-suite.mjs
      - benchmark/corpora/**
      - .github/receiver_candidate.py
      - .github/receiver_candidate_message.txt
      - .github/workflows/fast-regression.yml
  workflow_dispatch:

permissions: { contents: write }

concurrency:
  group: fast-regression-${{ github.ref }}
  cancel-in-progress: true

jobs:
  regression:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }

      - name: Apply candidate
        id: candidate
        run: |
          set -euo pipefail
          if [ -f .github/receiver_candidate.py ]; then
            python3 .github/receiver_candidate.py 2>&1 | tee /tmp/candidate-patch.log
            echo 'changed=true' >> "$GITHUB_OUTPUT"
            if git diff --quiet -- codec/source; then
              echo 'codec_changed=false' >> "$GITHUB_OUTPUT"
            else
              echo 'codec_changed=true' >> "$GITHUB_OUTPUT"
            fi
          else
            echo 'changed=false' >> "$GITHUB_OUTPUT"
            echo 'codec_changed=false' >> "$GITHUB_OUTPUT"
          fi
          git diff --check

      - name: Cache codec toolchain
        if: steps.candidate.outputs.codec_changed == 'true'
        uses: actions/cache@v4
        with:
          path: |
            codec/source/emsdk
            codec/source/third_party
            codec/source/build-simd
            codec/source/build-scalar
          key: airgapper-codec-emsdk-6.0.6-zxing-${{ hashFiles('codec/source/zxing-cpp.commit') }}

      - name: Build codecs
        if: steps.candidate.outputs.codec_changed == 'true'
        run: |
          set -euo pipefail
          AIRGAPPER_CODEC_SIMD=1 AIRGAPPER_CODEC_OUTPUT_DIR=.. codec/source/build.sh 2>&1 | tee /tmp/build-simd.log
          AIRGAPPER_CODEC_SIMD=0 AIRGAPPER_CODEC_OUTPUT_DIR=../scalar codec/source/build.sh 2>&1 | tee /tmp/build-scalar.log

      - uses: actions/setup-node@v4
        with: { node-version: 22 }

      - name: Run grid lattice regression
        run: node benchmark/grid-lattice-regression.mjs

      - name: Prepare Chrome
        run: npm install --no-save --package-lock=false playwright@1.55.0

      - name: Run production regression
        run: |
          set -euo pipefail
          python3 -m http.server 8080 >/tmp/airgapper-http.log 2>&1 &
          SERVER_PID=$!
          trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
          AIRGAPPER_TRIALS=3 node benchmark/offline-runner.mjs 2>&1 | tee /tmp/regression.log
          node benchmark/corpus-suite.mjs 2>&1 | tee /tmp/corpus.log

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: airgapper-fast-regression-${{ github.sha }}
          path: |
            benchmark/offline-summary.json
            benchmark/hardware-corpus-summary.json
          if-no-files-found: ignore
          retention-days: 14

      - name: Promote passing candidate
        if: success() && steps.candidate.outputs.changed == 'true'
        run: |
          set -euo pipefail
          git config user.name "AirGapper Agent"
          git config user.email "actions@github.com"
          cp benchmark/offline-summary.json benchmark/latest-result.json
          rm -rf node_modules benchmark/offline-summary.json benchmark/hardware-corpus-summary.json
          MESSAGE="$(cat .github/receiver_candidate_message.txt 2>/dev/null || echo 'promote candidate')"
          rm -f .github/receiver_candidate.py .github/receiver_candidate_message.txt
          git add -A
          git commit -m "$MESSAGE"
          git pull --rebase origin master
          git push origin HEAD:master

      - name: Record normal regression
        if: success() && steps.candidate.outputs.changed != 'true'
        run: |
          set -euo pipefail
          git config user.name "AirGapper Agent"
          git config user.email "actions@github.com"
          cp benchmark/offline-summary.json benchmark/latest-result.json
          rm -rf node_modules benchmark/offline-summary.json benchmark/hardware-corpus-summary.json
          git add benchmark/latest-result.json
          if ! git diff --cached --quiet; then
            git commit -m "record latest fast regression"
            git pull --rebase origin master
            git push origin HEAD:master
          fi

      - name: Record candidate rejection
        if: failure() && steps.candidate.outputs.changed == 'true'
        run: |
          set -euo pipefail
          git reset --hard HEAD
          {
            echo "candidate rejected at $(date -u +%FT%TZ)"
            cat /tmp/candidate-patch.log 2>/dev/null || true
            tail -n 180 /tmp/build-simd.log 2>/dev/null || true
            tail -n 180 /tmp/build-scalar.log 2>/dev/null || true
            tail -n 500 /tmp/regression.log 2>/dev/null || true
            tail -n 300 /tmp/corpus.log 2>/dev/null || true
          } > benchmark/receiver-candidate-ci.log
          git config user.name "AirGapper Agent"
          git config user.email "actions@github.com"
          rm -f .github/receiver_candidate.py .github/receiver_candidate_message.txt
          git add -A benchmark/receiver-candidate-ci.log .github
          git commit -m "record candidate rejection"
          git pull --rebase origin master
          git push origin HEAD:master
          exit 1
'''
Path('.github/workflows/fast-regression.yml').write_text(final_workflow)
Path('.github/workflows/apply-v217-offline-benchmark.yml').unlink(missing_ok=True)

# Exact runtime import after the broad rename.
expected = 'const ready = import(scalarCodec ? "../codec/scalar/airgapper_codec.js" : "../codec/airgapper_codec.js").then(({ default: AirGapperCodec }) => AirGapperCodec());'
if expected not in Path('receive/worker.js').read_text():
    raise SystemExit('new codec import is not exact')

# No historical codec identity should remain in maintained text or paths. The
# WASM files are rebuilt immediately after this script by the regression job.
for p in ROOT.rglob('*'):
    if not p.is_file() or p == CANDIDATE or '.git' in p.parts:
        continue
    if p.suffix.lower() not in TEXT_SUFFIXES and p.name not in {'.gitignore', 'CMakeLists.txt'}:
        continue
    try:
        text = p.read_text()
    except UnicodeDecodeError:
        continue
    if 'decimen' in text.lower():
        raise SystemExit(f'historical codec name remains in {p}')
for p in ROOT.rglob('*'):
    if '.git' not in p.parts and 'decimen' in p.as_posix().lower():
        raise SystemExit(f'historical codec path remains: {p}')

print('v0.5.349 ownership cleanup applied')
