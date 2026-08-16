#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Evan Crawley (Bash Alarmist)
set -euo pipefail
cd "$(dirname "$0")"

EMSDK_VERSION=6.0.6
ZXING_COMMIT=$(tr -d '[:space:]' < zxing-cpp.commit)
SIMD=${DECIMEN_SIMD:-1}
OUTPUT_DIR=${DECIMEN_OUTPUT_DIR:-..}
if [ "$SIMD" = "0" ]; then
  BUILD_DIR=build-scalar
  SIMD_CMAKE=OFF
else
  BUILD_DIR=build-simd
  SIMD_CMAKE=ON
fi

if [ ! -d third_party/zxing-cpp/.git ]; then
  mkdir -p third_party
  git clone --filter=blob:none https://github.com/zxing-cpp/zxing-cpp.git third_party/zxing-cpp
fi
git -C third_party/zxing-cpp fetch --depth 1 origin "$ZXING_COMMIT"
git -C third_party/zxing-cpp checkout --detach "$ZXING_COMMIT" >/dev/null
git -C third_party/zxing-cpp reset --hard "$ZXING_COMMIT" >/dev/null
git -C third_party/zxing-cpp clean -fd >/dev/null
python3 patches/apply_exact_sample_map.py

VERSION=$(tr -d '[:space:]' < VERSION)
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

emcmake cmake -S . -B "$BUILD_DIR" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DDECIMEN_SIMD="$SIMD_CMAKE" \
  -DDECIMEN_CODEC_VERSION="$VERSION" -DDECIMEN_CODEC_BUILD="$GIT_HASH" >/dev/null
cmake --build "$BUILD_DIR"

BANNER="/*! decimen-codec v${VERSION} — build ${GIT_HASH} — (c) 2026 Evan Crawley (Bash Alarmist) — SPDX-License-Identifier: AGPL-3.0-or-later — https://github.com/bashalarmistalt/decimen-codec */"
mkdir -p dist "$OUTPUT_DIR"
{ printf '%s\n' "$BANNER"; cat "$BUILD_DIR/decimen_codec.js"; } > dist/decimen_codec.js
cp "$BUILD_DIR/decimen_codec.wasm" dist/decimen_codec.wasm
cp dist/decimen_codec.js dist/decimen_codec.wasm "$OUTPUT_DIR"/
