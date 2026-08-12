// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Evan Crawley (Bash Alarmist)
//
// Correctness + speed benchmark: the Decimen tracked path vs stock detection,
// on crop-sized images matching the receiver's real flow.
// Run: node bench/bench.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import DecimenCodec from "../dist/decimen_codec.js";

const require = createRequire(import.meta.url);
const QRCode = require("qrcode");
// The glue is built web/worker-only (the app is the target); Node runs it by
// handing over the binary directly.
const wasmBinary = readFileSync(fileURLToPath(new URL("../dist/decimen_codec.wasm", import.meta.url)));

const MARGIN = 4;
const SCALE = 3;

function crc32(data) {
  let crc = 0xffffffff;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

function makeCode(payloadBytes, seed, version, withCRC = false) {
  const data = new Uint8Array(payloadBytes);
  const contentLength = data.length - (withCRC ? 4 : 0);
  for (let j = 0; j < contentLength; j++) data[j] = (seed * 37 + j * 131) & 0xff;
  data[0] = seed;
  if (withCRC) new DataView(data.buffer).setUint32(contentLength, crc32(data.subarray(0, contentLength)), true);
  return QRCode.create([{ data, mode: "byte" }], {
    errorCorrectionLevel: "L",
    version,
    maskPattern: 4,
  });
}

/** Rasterize one code at SCALE px/module into RGBA, quiet zone included. */
function rasterize(qr) {
  const modules = qr.modules.size;
  const cells = modules + 2 * MARGIN;
  const size = cells * SCALE;
  const rgba = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      if (!qr.modules.data[y * modules + x]) continue;
      for (let sy = 0; sy < SCALE; sy++) {
        for (let sx = 0; sx < SCALE; sx++) {
          const px = ((y + MARGIN) * SCALE + sy) * size + (x + MARGIN) * SCALE + sx;
          rgba[px * 4] = rgba[px * 4 + 1] = rgba[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { rgba, size, modules };
}

/** Mild barrel distortion around the image center — the field failure mode:
 *  corners pinned, interior bowed. A plain homography from the corner quad
 *  mis-samples the middle of a 177-module code; the alignment-fitted path
 *  must survive this. `strength` = px of displacement at the half-diagonal. */
function barrel(img, strength) {
  const { rgba, size } = img;
  const src = new Uint8ClampedArray(rgba);
  const c = size / 2;
  const R = c * Math.SQRT2; // half-diagonal
  const k = strength / (R * R * R); // displacement(r) = strength · (r/R)³
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      const r2 = dx * dx + dy * dy;
      const f = 1 + k * r2;
      const sx = Math.round(c + dx * f);
      const sy = Math.round(c + dy * f);
      const o = (y * size + x) * 4;
      if (sx >= 0 && sx < size && sy >= 0 && sy < size) {
        const s = (sy * size + sx) * 4;
        rgba[o] = src[s];
        rgba[o + 1] = src[s + 1];
        rgba[o + 2] = src[s + 2];
      } else {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = 255;
      }
    }
  }
  return img;
}

/** Mild 3x3 box blur — capture softness, so the bench isn't a synthetic-clean fantasy. */
function blur(img) {
  const { rgba, size } = img;
  const src = new Uint8ClampedArray(rgba);
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) sum += src[((y + dy) * size + x + dx) * 4 + 1];
      const v = sum / 9;
      const o = (y * size + x) * 4;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
    }
  }
  return img;
}

const zx = await DecimenCodec({
  instantiateWasm(imports, done) {
    WebAssembly.instantiate(wasmBinary, imports).then(({ instance, module }) => done(instance, module));
    return {};
  },
});

function heapImage(rgba) {
  const ptr = zx._malloc(rgba.length);
  zx.HEAPU8.set(rgba, ptr);
  return ptr;
}

function vecToArray(vec) {
  const out = [];
  for (let i = 0; i < vec.size(); i++) out.push(vec.get(i));
  vec.delete();
  return out;
}

function bench(fn, iterations) {
  fn(); // warm
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  return (performance.now() - start) / iterations;
}

for (const [label, payloadBytes, version] of [
  ["V27 1465B", 1465, undefined],
  ["V40 2953B", 2953, undefined],
]) {
  for (const distort of ["clean", "blurred", "barrel2px"]) {
    const img = rasterize(makeCode(payloadBytes, 1, version));
    if (distort === "blurred") blur(img);
    if (distort === "barrel2px") barrel(img, 2);
    const soft = distort !== "clean";
    const { rgba, size } = img;
    const ptr = heapImage(rgba);

    // Acquisition: stock full path on the crop-sized image.
    const full = vecToArray(zx.readFull(ptr, size, size, true, 2, false));
    if (full.length !== 1 || !full[0].valid) {
      console.log(`${label}${soft ? " blurred" : ""}: readFull FAILED (${full.length} results)`);
      zx._free(ptr);
      continue;
    }
    const q = full[0].position;
    const expected = Buffer.from(full[0].bytes);

    // Tracked: same image, cached quad, detection skipped.
    const dim = img.modules;
    const tracked = zx.readTracked(
      ptr, size, size, dim,
      q.topLeft.x, q.topLeft.y, q.topRight.x, q.topRight.y,
      q.bottomRight.x, q.bottomRight.y, q.bottomLeft.x, q.bottomLeft.y,
    );
    const parity = tracked.valid && Buffer.from(tracked.bytes).equals(expected);

    const iters = 30;
    const fullMs = bench(() => vecToArray(zx.readFull(ptr, size, size, true, 2, false)), iters);
    const trackedMs = bench(() => zx.readTracked(
      ptr, size, size, dim,
      q.topLeft.x, q.topLeft.y, q.topRight.x, q.topRight.y,
      q.bottomRight.x, q.bottomRight.y, q.bottomLeft.x, q.bottomLeft.y,
    ), iters);

    void soft;
    console.log(
      `${label} ${distort.padEnd(9)} (${size}x${size}): ` +
        `full ${fullMs.toFixed(2)}ms  tracked ${trackedMs.toFixed(2)}ms  ` +
        `speedup ${(fullMs / trackedMs).toFixed(1)}x  parity ${parity ? "✓" : "✗ MISMATCH"}`,
    );
    zx._free(ptr);
  }
}

function makeBatchFrame(count, columns, payloadBytes, version, scale, mode = "clean") {
  const codes = Array.from({ length: count }, (_, i) => makeCode(payloadBytes, i + 1, version, true));
  const modules = codes[0].modules.size;
  const cell = (modules + 2 * MARGIN) * scale;
  const rows = Math.ceil(count / columns);
  const width = columns * cell;
  const height = rows * cell;
  const y = new Uint8Array(width * height).fill(255);
  const tracks = [];
  for (let i = 0; i < count; i++) {
    const qr = codes[i];
    const ox = (i % columns) * cell + MARGIN * scale;
    const oy = Math.floor(i / columns) * cell + MARGIN * scale;
    for (let my = 0; my < modules; my++)
      for (let mx = 0; mx < modules; mx++) {
        let black = qr.modules.data[my * modules + mx];
        if (mode === "transition" && my < modules / 2)
          black = codes[(i + 1) % count].modules.data[my * modules + mx];
        if (!black) continue;
        for (let sy = 0; sy < scale; sy++)
          y.fill(0, (oy + my * scale + sy) * width + ox + mx * scale,
                    (oy + my * scale + sy) * width + ox + (mx + 1) * scale);
      }
    tracks.push({
      id: i + 1, dim: modules,
      q: [ox, oy, ox + modules * scale, oy,
          ox + modules * scale, oy + modules * scale, ox, oy + modules * scale],
    });
  }
  if (mode === "blur") {
    const src = new Uint8Array(y);
    for (let py = 1; py < height - 1; py++)
      for (let px = 1; px < width - 1; px++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) sum += src[(py + dy) * width + px + dx];
        y[py * width + px] = sum / 9;
      }
  }
  if (mode === "translate") {
    const src = new Uint8Array(y);
    y.fill(255);
    for (let py = 0; py < height - 1; py++)
      y.set(src.subarray(py * width, (py + 1) * width - 1), (py + 1) * width + 1);
  }
  return { y, width, height, tracks, modules };
}

function benchmarkBatch(label, spec, mode = "clean") {
  const frame = makeBatchFrame(spec.count, spec.columns, spec.payload, spec.version, spec.scale, mode);
  const framePtr = heapImage(frame.y);
  const resultsPtr = zx._malloc(spec.count * 32);
  const outputPtr = zx._malloc(spec.count * 3200);
  const metricsPtr = zx._malloc(72);
  const decoder = zx._createTrackedDecoder(spec.count, frame.modules);
  for (let i = 0; i < frame.tracks.length; i++) {
    const t = frame.tracks[i];
    if (!zx._setTrackedDecoderTrack(decoder, i, t.id, t.dim, ...t.q))
      throw new Error(`failed to configure batch track ${i}`);
    zx._setTrackedDecoderTrackCRC32(decoder, i, 1);
  }
  const run = () => zx._decodeTrackedBatchY(
    decoder, framePtr, frame.width, frame.height, frame.width,
    resultsPtr, spec.count, outputPtr, spec.count * 3200, metricsPtr,
  );
  const ms = bench(run, 30);
  const view = new DataView(zx.HEAPU8.buffer);
  let successful = 0;
  for (let i = 0; i < spec.count; i++)
    if (view.getInt32(resultsPtr + i * 32 + 4, true) === 1) successful++;
  const metric = (offset) => view.getFloat64(metricsPtr + offset, true);
  const samples = view.getUint32(metricsPtr + 52, true);
  const fast = view.getUint32(metricsPtr + 64, true);
  const fallbacks = view.getUint32(metricsPtr + 68, true);
  const payloadPerMs = successful * (spec.payload - 4) / ms;
  console.log(
    `${label.padEnd(18)} ${mode.padEnd(10)} ${frame.width}x${frame.height} ` +
    `${successful}/${spec.count}  total ${ms.toFixed(2)}ms  ` +
    `anchor ${metric(0).toFixed(2)}ms sample ${metric(8).toFixed(2)}ms ` +
    `extract ${metric(16).toFixed(2)}ms CRC ${metric(24).toFixed(3)}ms ` +
    `RS ${metric(32).toFixed(2)}ms samples ${samples} fast ${fast} fallback ${fallbacks} ` +
    `${payloadPerMs.toFixed(0)} verified-B/ms`,
  );
  zx._destroyTrackedDecoder(decoder);
  zx._free(framePtr);
  zx._free(resultsPtr);
  zx._free(outputPtr);
  zx._free(metricsPtr);
}

const batchCases = [
  ["4 x V40", { count: 4, columns: 2, payload: 2953, version: 40, scale: 3 }],
  ["6 x V30", { count: 6, columns: 3, payload: 1732, version: 30, scale: 2 }],
  ["12 x V27", { count: 12, columns: 4, payload: 1465, version: 27, scale: 2 }],
  ["12 x V25", { count: 12, columns: 4, payload: 1273, version: 25, scale: 2 }],
  ["12 x V20", { count: 12, columns: 4, payload: 858, version: 20, scale: 3 }],
];
for (const [label, spec] of batchCases) benchmarkBatch(label, spec);
for (const mode of ["translate", "blur", "transition"])
  benchmarkBatch("12 x V27", batchCases[2][1], mode);

// Drift tolerance: how far can the cached quad be off before tracked fails?
// A propped phone wobbles a few px between frames; the quad must absorb that.
{
  const img = rasterize(makeCode(2953, 1, undefined));
  const { rgba, size } = img;
  const ptr = heapImage(rgba);
  const full = vecToArray(zx.readFull(ptr, size, size, true, 2, false));
  const q = full[0].position;
  const expected = Buffer.from(full[0].bytes);
  const offsets = [0, 0.5, 1, 1.5, 2, 3, 4];
  const results = offsets.map((off) => {
    const r = zx.readTracked(
      ptr, size, size, img.modules,
      q.topLeft.x + off, q.topLeft.y + off, q.topRight.x + off, q.topRight.y + off,
      q.bottomRight.x + off, q.bottomRight.y + off, q.bottomLeft.x + off, q.bottomLeft.y + off,
    );
    return r.valid && Buffer.from(r.bytes).equals(expected) ? "✓" : "✗";
  });
  console.log(
    `drift tolerance V40 @ ${SCALE}px/module: ` +
      offsets.map((o, i) => `${o}px ${results[i]}`).join("  "),
  );
  zx._free(ptr);
}
