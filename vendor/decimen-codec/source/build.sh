#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Evan Crawley (Bash Alarmist)
#
# Build the Decimen codec WASM module into dist/.
set -euo pipefail
cd "$(dirname "$0")"

# Pinned toolchain: same source + same emsdk = the same binary the parity and
# drift gates were run against. Bump deliberately, then re-run the bench.
EMSDK_VERSION=6.0.6
ZXING_COMMIT=$(tr -d '[:space:]' < zxing-cpp.commit)

# Keep the pinned compiler and ZXing checkout local. Neither belongs in the
# application repository or release artifact.
if [ ! -d third_party/zxing-cpp/.git ]; then
  mkdir -p third_party
  git clone --filter=blob:none https://github.com/zxing-cpp/zxing-cpp.git third_party/zxing-cpp
fi
git -C third_party/zxing-cpp fetch --depth 1 origin "$ZXING_COMMIT"
git -C third_party/zxing-cpp checkout --detach "$ZXING_COMMIT" >/dev/null

# Version comes from package.json — the single place to bump. The build id
# names the exact git state, "-dirty" when the tree has uncommitted work
# (mirrors the app's footer stamp).
VERSION=$(node -p "require('./package.json').version")
if GIT_HASH=$(git rev-parse --short HEAD 2>/dev/null); then
  [ -z "$(git status --porcelain)" ] || GIT_HASH="${GIT_HASH}-dirty"
else
  GIT_HASH="unreleased"
fi

if [ ! -d emsdk ]; then
  git clone https://github.com/emscripten-core/emsdk.git
fi
./emsdk/emsdk install "$EMSDK_VERSION" >/dev/null
./emsdk/emsdk activate "$EMSDK_VERSION" >/dev/null
source ./emsdk/emsdk_env.sh >/dev/null 2>&1

emcmake cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DDECIMEN_CODEC_VERSION="$VERSION" -DDECIMEN_CODEC_BUILD="$GIT_HASH" >/dev/null
cmake --build build

# The glue carries the same banner the app stamps on its own artifacts, so
# every copy names its version, license, and source. The wasm can't carry a
# comment — its version() export answers instead.
BANNER="/*! decimen-codec v${VERSION} — build ${GIT_HASH} — (c) 2026 Evan Crawley (Bash Alarmist) — SPDX-License-Identifier: AGPL-3.0-or-later — https://github.com/bashalarmistalt/decimen-codec */"
mkdir -p dist
{ printf '%s\n' "$BANNER"; cat build/decimen_codec.js; } > dist/decimen_codec.js
cp build/decimen_codec.wasm dist/
cp dist/decimen_codec.js dist/decimen_codec.wasm ..
ls -la dist/
