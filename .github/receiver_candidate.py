from pathlib import Path
import re
import shutil

ROOT = Path('.')


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:160]!r}")
    p.write_text(text.replace(old, new, 1))


def rewrite(path, transform):
    p = Path(path)
    p.write_text(transform(p.read_text()))


# ---------------------------------------------------------------------------
# Own the QR codec as an AirGapper component instead of carrying the heavily
# modified wrapper under its historical Decimen vendor name.
# ---------------------------------------------------------------------------
codec = Path('codec')
if codec.exists():
    raise SystemExit('codec/ already exists; cleanup candidate expects the old layout')
codec.mkdir()
(codec / 'scalar').mkdir()

old_simd = Path('vendor/decimen-codec')
old_scalar = Path('vendor/decimen-codec-android')
if not (old_simd / 'source').is_dir():
    raise SystemExit('missing old codec source')
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

# Rename project/API terminology everywhere it can legitimately appear. This
# intentionally preserves author/license notices; only the project identity is
# changing.
TEXT_SUFFIXES = {'.js', '.mjs', '.html', '.css', '.md', '.yml', '.yaml', '.gradle', '.java', '.cpp', '.h', '.txt', '.sh', '.gitignore'}
REPLACEMENTS = [
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
    if not p.is_file() or p == Path('.github/receiver_candidate.py'):
        continue
    if '.git' in p.parts or p.suffix.lower() not in TEXT_SUFFIXES:
        continue
    try:
        text = p.read_text()
    except UnicodeDecodeError:
        continue
    changed = text
    for old, new in REPLACEMENTS:
        changed = changed.replace(old, new)
    if changed != text:
        p.write_text(changed)

# Codec source/build names and ABI.
(codec / 'source' / 'VERSION').write_text('0.2.0\n')
cmake = codec / 'source' / 'CMakeLists.txt'
text = cmake.read_text()
text = text.replace('project(airgapper-codec CXX)', 'project(airgapper-codec CXX)')
# The production worker only calls the Guided C ABI. readFull/readTracked are
# embind methods and do not need explicit C exports. Stop shipping the obsolete
# persistent batch-tracker ABI to JS.
text = re.sub(
    r'-s EXPORTED_FUNCTIONS=\\"\[[^\n]+\]\\" \\\\n',
    '-s EXPORTED_FUNCTIONS=\\"[\'_malloc\', \'_free\', \'_decodeGuidedBatchY\']\\" \\\n',
    text,
    count=1,
)
text = text.replace('add_executable(airgapper_codec wrapper/airgapper_codec.cpp)', 'add_executable(airgapper_codec wrapper/airgapper_codec.cpp)')
cmake.write_text(text)

build = codec / 'source' / 'build.sh'
text = build.read_text()
# Replace the historical upstream-project banner with an accurate ownership
# statement while retaining the original wrapper copyright and AGPL license.
text = re.sub(
    r'BANNER="/\*!.*?\*/"',
    'BANNER="/*! AirGapper QR codec v${VERSION} — build ${GIT_HASH} — wrapper copyright (c) 2026 Evan Crawley (Bash Alarmist), modified for AirGapper — SPDX-License-Identifier: AGPL-3.0-or-later */"',
    text,
    count=1,
)
build.write_text(text)

cpp = wrapper / 'airgapper_codec.cpp'
text = cpp.read_text()
text = text.replace(
    '// source of truth is package.json). The defaults only appear in by-hand\n// compiles.',
    '// source of truth is VERSION). The defaults only appear in by-hand\n// compiles.'
)
cpp.write_text(text)

# ---------------------------------------------------------------------------
# Receiver: delete the obsolete second multi-QR tracker. Guided is the one
# production tracked decoder for camera and replay input; non-Y8 paths use the
# existing robust finder fallback instead of maintaining a second cache/ABI.
# ---------------------------------------------------------------------------
worker = Path('receive/worker.js')
text = worker.read_text()
text = text.replace('import { shouldRunFullDecode } from "../shared/decode-policy.js";\n', '')
text = text.replace('import { parseFrame, parseVerifiedFramePayload } from "../shared/protocol.js";', 'import { parseFrame } from "../shared/protocol.js";')
text = text.replace(
    'const ready = import(scalarCodec ? "../codec/scalar/airgapper_codec.js" : "../codec/airgapper_codec.js").then(({ default: AirGapperCodec }) => AirGapperCodec());',
    'const ready = import(scalarCodec ? "../codec/scalar/airgapper_codec.js" : "../codec/airgapper_codec.js").then(({ default: AirGapperCodec }) => AirGapperCodec());'
)
for line in [
    'const NATIVE_BATCH_MAX_TRACKS = 32;\n',
    'const NATIVE_TRACK_RESULT_BYTES = 32;\n',
    'const NATIVE_BATCH_METRICS_BYTES = 128;\n',
    'const NATIVE_BATCH_OUTPUT_BYTES = 128 * 1024;\n',
]:
    text = text.replace(line, '')
text = text.replace('const NATIVE_TRACK_OK = 1;', 'const GUIDED_TRACK_MEASURED = 1;')
for line in [
    'let nativeBatchHandle = 0;\n',
    'let nativeResultsPtr = 0;\n',
    'let nativeOutputPtr = 0;\n',
    'let nativeMetricsPtr = 0;\n',
    'let nativeConfigured = [];\n',
    'let nativeCropOrigin = "";\n',
    'const nativeRefresh = /* @__PURE__ */ new Set();\n',
]:
    text = text.replace(line, '')
text = text.replace('NATIVE_TRACK_OK', 'GUIDED_TRACK_MEASURED')

# Remove native batch setup helpers but retain quadModuleSize, which Guided uses
# for metrics and density decisions.
start = text.find('function ensureNativeBatch(zx) {')
end = text.find('function translatedQuad(', start)
if start < 0 or end < 0:
    raise SystemExit('could not locate native batch setup block')
text = text[:start] + text[end:]
start = text.find('function translatedQuad(')
end = text.find('function quadModuleSize(', start)
if start < 0 or end < 0:
    raise SystemExit('could not locate native geometry helper block')
text = text[:start] + text[end:]
start = text.find('function configureNativeBatch(')
end = text.find('function localQuad(', start)
if start < 0 or end < 0:
    raise SystemExit('could not locate native batch decoder block')
text = text[:start] + text[end:]

# Direct VideoFrames used to select Guided while buffered replay selected the
# now-dead native tracker. Remove that split: input format/capability decides.
start = text.find('    const usedDirectFrame = Boolean(ownedVideoFrame);')
end = text.find('    let frameCopyMs = 0;', start)
if start < 0 or end < 0:
    raise SystemExit('could not locate legacy lane selection block')
text = text[:start] + '    let frameCopyMs = 0;\n' + text[end + len('    let frameCopyMs = 0;\n'):]

start_marker = '    if (!full && tracks?.length && robustLaneFirst) {'
end_marker = '    let trackedHit = false;'
start = text.find(start_marker)
end = text.find(end_marker, start)
if start < 0 or end < 0:
    raise SystemExit('could not locate multi-track legacy branch')
new_multitrack = '''    if (!full && tracks?.length) {
      // Guided is the sole multi-QR tracked decoder. Camera and replay Y8 now
      // exercise the same cache/sampling path instead of maintaining a second,
      // stale tracker implementation for buffered frames.
      if (guidedDecode && decodePixelFormat === "y8" && tracks.length >= 2) {
        const guided = decodeGuidedBatch(
          zx, ptr + inputOffset, pw, ph, inputStride, ox, oy, tracks, guidedFallbackMask, guidedRepairMask
        );
        if (guided) symbols.push(...guided.symbols);
        mapOutputToDisplay();
        ctx.postMessage({
          id,
          symbols,
          sightings,
          full: false,
          trackedAttempted: true,
          trackedHit: symbols.length > 0,
          fallbackAttempted: false,
          fallbackSucceeded: false,
          readFullAttempts: 0,
          workerWaitMs,
          frameCopyMs,
          guidedMetrics: guided?.metrics,
          guidedAssistTracks: Math.max(0, tracks.length - (guided?.metrics?.turboSuccesses ?? 0)),
          pixelPath: guided?.metrics?.turboSuccesses === tracks.length
            ? "y8-turbo"
            : guided?.metrics?.turboSuccesses
              ? "y8-turbo+guided"
              : "y8-guided",
          guidedError: guided?.error,
          latencyMs: performance.now() - startedAt
        });
        return;
      }

      // Non-Y8/unsupported tracked input keeps one simple robust path instead
      // of a persistent second tracker. This is primarily dev/oracle/canvas
      // input and is not the live camera hot path.
      readFullAttempts++;
      const robustMax = Math.min(ROBUST_BATCH_MAX_RESULTS, Math.max(1, tracks.length));
      const singleLocalQr = tracks.length === 1;
      const decoded = decodePixelFormat === "y8"
        ? singleLocalQr
          ? zx.readFullY(ptr + inputOffset, pw, ph, inputStride, false, 1, false)
          : zx.readDenseY(ptr + inputOffset, pw, ph, inputStride, robustMax)
        : zx.readFull(ptr + inputOffset, pw, ph, !singleLocalQr, robustMax, false);
      try {
        const expectedSlots = new Set(tracks.flatMap((track) => track.slot === void 0 ? [] : [track.slot]));
        for (let i = 0; i < decoded.size(); i++) {
          const result = decoded.get(i);
          if (!result.valid || !result.bytes.length || !validQuad(result.position)) continue;
          const packet = parseFrame(result.bytes);
          const slot = packet?.header.slotIndex;
          if (!packet || slot !== void 0 && expectedSlots.size && !expectedSlots.has(slot)) continue;
          symbols.push({
            bytes: result.bytes,
            box: boundsOf(result.position, ox, oy),
            quad: shifted(result.position, ox, oy),
            modules: result.modules,
            tracked: false,
            decodePath: "robust",
            header: packet.header
          });
        }
      } finally {
        decoded.delete();
      }
      mapOutputToDisplay();
      ctx.postMessage({
        id,
        symbols,
        sightings,
        full: false,
        trackedAttempted: false,
        trackedHit: false,
        fallbackAttempted: true,
        fallbackSucceeded: symbols.length > 0,
        readFullAttempts,
        workerWaitMs,
        frameCopyMs,
        pixelPath: decodePixelFormat,
        robustFirst: true,
        latencyMs: performance.now() - startedAt
      });
      return;
    }
'''
text = text[:start] + new_multitrack + text[end:]
text = text.replace('shouldRunFullDecode(full, trackedAttempted, trackedHit)', '(full || !trackedAttempted || !trackedHit)')
worker.write_text(text)

if '_createTrackedDecoder' in text or 'decodeNativeBatch' in text or 'nativeBatchHandle' in text:
    raise SystemExit('old native batch tracker still referenced by receive/worker.js')
if 'parseVerifiedFramePayload' in text or 'shouldRunFullDecode' in text:
    raise SystemExit('dead worker imports survived cleanup')

Path('shared/decode-policy.js').unlink(missing_ok=True)

# ---------------------------------------------------------------------------
# Remove checked-in transpiler scaffolding from browser-native source. These
# files are authored directly; plain assignments are clearer and smaller.
# ---------------------------------------------------------------------------
def clean_public_fields(path):
    p = Path(path)
    text = p.read_text()
    text = re.sub(r'^var __defProp = .*?;\nvar __defNormalProp = .*?;\nvar __publicField = .*?;\n', '', text, count=1)
    text = re.sub(r'__publicField\(this, "([^"]+)", ([^\n]+?)\);', r'this.\1 = \2;', text)
    text = re.sub(r'__publicField\(this, "([^"]+)"\);', r'this.\1 = undefined;', text)
    if '__publicField' in text or '__defNormalProp' in text:
        raise SystemExit(f'generated class-field scaffolding remains in {path}')
    p.write_text(text)

for path in ('shared/worker-pool.js', 'shared/transport.js', 'shared/raptorq.js'):
    clean_public_fields(path)

# Update stale comments now that Guided owns worker-local affinity.
rewrite('shared/worker-pool.js', lambda s: s.replace('per-worker native tracking affinity', 'per-worker Guided cache affinity').replace('warm native geometry cache', 'warm Guided geometry cache'))
rewrite('receive/main.js', lambda s: s.replace('Worker-local native geometry and direct pixel-mode adaptation are session state.', 'Worker-local Guided geometry and direct pixel-mode adaptation are session state.'))

# Remove a couple of sender constants left behind by older renderers when they
# truly have no references.
send = Path('send/main.js')
text = send.read_text()
for name in ('HEADER_MARGIN', 'DEFAULT_GRID_CODES'):
    if text.count(name) == 1:
        text = re.sub(rf'^const {name} = .*?;\n', '', text, count=1, flags=re.M)
send.write_text(text)

# ---------------------------------------------------------------------------
# App/assets/version references.
# ---------------------------------------------------------------------------
replace_once('android/app/build.gradle', 'versionCode 98', 'versionCode 349')
replace_once('android/app/build.gradle', 'versionName "0.5.40"', 'versionName "0.5.349"')
rewrite('android/app/build.gradle', lambda s: s.replace('        include "vendor/airgapper-codec/airgapper_codec.js"\n        include "vendor/airgapper-codec/airgapper_codec.wasm"\n        include "vendor/airgapper-codec-android/airgapper_codec.js"\n        include "vendor/airgapper-codec-android/airgapper_codec.wasm"\n', '        include "codec/airgapper_codec.js"\n        include "codec/airgapper_codec.wasm"\n        include "codec/scalar/airgapper_codec.js"\n        include "codec/scalar/airgapper_codec.wasm"\n'))

# The broad rename above may already have produced the desired include paths;
# normalize either form explicitly.
rewrite('android/app/build.gradle', lambda s: s.replace('        include "codec-android/airgapper_codec.js"\n        include "codec-android/airgapper_codec.wasm"\n', '        include "codec/scalar/airgapper_codec.js"\n        include "codec/scalar/airgapper_codec.wasm"\n'))

for path in ('main.js', 'send/main.js', 'receive/main.js', 'index.html'):
    rewrite(path, lambda s: s.replace('v0.5.348', 'v0.5.349'))

sw = Path('sw.js')
text = sw.read_text().replace('airgapper-static-js-v296', 'airgapper-static-js-v297')
text = text.replace('    "./shared/decode-policy.js",\n', '')
# Normalize codec precache entries after the repository-wide path rename.
text = re.sub(r'    "\./codec(?:/scalar)?/airgapper_codec\.(?:js|wasm)",\n', '', text)
anchor = '    "./shared/zip.js",\n'
if anchor not in text:
    raise SystemExit('missing service-worker codec insertion anchor')
text = text.replace(anchor, anchor + '    "./codec/airgapper_codec.js",\n    "./codec/airgapper_codec.wasm",\n    "./codec/scalar/airgapper_codec.js",\n    "./codec/scalar/airgapper_codec.wasm",\n')
sw.write_text(text)

# ---------------------------------------------------------------------------
# Repository hygiene: old benchmark snapshots served their purpose; current
# latest-result + reproducible corpora/scripts are the source of truth.
# ---------------------------------------------------------------------------
for p in Path('benchmark').glob('v*-ci.log'):
    p.unlink()
for p in Path('benchmark').glob('v*-result.json'):
    p.unlink()
for name in ('camera-regression-ci.log', 'median-trials-ci.log', 'receiver-candidate-ci.log'):
    Path('benchmark', name).unlink(missing_ok=True)
Path('.github/workflows/quick-v281-completion-paint.yml').unlink(missing_ok=True)

# Final workflow has only current paths/tooling; the currently running migration
# workflow was prepared in the parent commit and can safely promote this rename.
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
    timeout-minutes: 15
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

      - name: Build SIMD and scalar codecs
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
old_workflow = Path('.github/workflows/apply-v217-offline-benchmark.yml')
new_workflow = Path('.github/workflows/fast-regression.yml')
new_workflow.write_text(final_workflow)
old_workflow.unlink(missing_ok=True)

# Root ignore rules now match the owned codec location.
gitignore = Path('.gitignore')
text = gitignore.read_text()
text = re.sub(r'(?m)^.*airgapper-codec/source/build-(?:scalar|simd)/\n?', '', text)
text = re.sub(r'(?m)^vendor/.*codec/source/build-(?:scalar|simd)/\n?', '', text)
if 'codec/source/build-scalar/' not in text:
    text += 'codec/source/build-scalar/\ncodec/source/build-simd/\n'
gitignore.write_text(text)

# Normalize any remaining new-path references produced by the broad rename.
for p in ROOT.rglob('*'):
    if not p.is_file() or p == Path('.github/receiver_candidate.py') or '.git' in p.parts:
        continue
    if p.suffix.lower() not in TEXT_SUFFIXES:
        continue
    try:
        text = p.read_text()
    except UnicodeDecodeError:
        continue
    text = text.replace('vendor/airgapper-codec-android', 'codec/scalar')
    text = text.replace('vendor/airgapper-codec', 'codec')
    text = text.replace('codec-android', 'codec/scalar')
    p.write_text(text)

# Ensure runtime import and build output paths are exact after normalization.
worker_text = Path('receive/worker.js').read_text()
expected_import = 'const ready = import(scalarCodec ? "../codec/scalar/airgapper_codec.js" : "../codec/airgapper_codec.js").then(({ default: AirGapperCodec }) => AirGapperCodec());'
if expected_import not in worker_text:
    raise SystemExit('receiver codec import did not normalize to codec/')

# No historical project name may survive in the maintained text tree. Generated
# WASM is rebuilt immediately after this candidate by the workflow.
for p in ROOT.rglob('*'):
    if not p.is_file() or p == Path('.github/receiver_candidate.py') or '.git' in p.parts:
        continue
    if p.suffix.lower() not in TEXT_SUFFIXES:
        continue
    try:
        text = p.read_text()
    except UnicodeDecodeError:
        continue
    if 'decimen' in text.lower():
        raise SystemExit(f'historical codec name remains in {p}')

for path in ROOT.rglob('*'):
    if 'decimen' in path.as_posix().lower():
        raise SystemExit(f'historical codec path remains: {path}')

print('v0.5.349 cleanup candidate applied')
