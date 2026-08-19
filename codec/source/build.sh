#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Evan Crawley (Bash Alarmist)
set -euo pipefail
cd "$(dirname "$0")"

EMSDK_VERSION=6.0.6
ZXING_COMMIT=$(tr -d '[:space:]' < zxing-cpp.commit)
SIMD=${AIRGAPPER_CODEC_SIMD:-1}
OUTPUT_DIR=${AIRGAPPER_CODEC_OUTPUT_DIR:-..}
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
  -DAIRGAPPER_CODEC_SIMD="$SIMD_CMAKE" \
  -DAIRGAPPER_CODEC_VERSION="$VERSION" -DAIRGAPPER_CODEC_BUILD="$GIT_HASH" >/dev/null
cmake --build "$BUILD_DIR"

BANNER="/*! AirGapper QR codec v${VERSION} — build ${GIT_HASH} — wrapper copyright (c) 2026 Evan Crawley (Bash Alarmist), modified for AirGapper — SPDX-License-Identifier: AGPL-3.0-or-later */"
mkdir -p dist "$OUTPUT_DIR"
{ printf '%s\n' "$BANNER"; cat "$BUILD_DIR/airgapper_codec.js"; } > dist/airgapper_codec.js
cp "$BUILD_DIR/airgapper_codec.wasm" dist/airgapper_codec.wasm
cp dist/airgapper_codec.js dist/airgapper_codec.wasm "$OUTPUT_DIR"/
