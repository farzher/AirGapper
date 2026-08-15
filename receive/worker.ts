// QR decode worker: the decimen-codec engine (a custom zxing-cpp build)
// compiled to WASM. (Safari has
// never shipped BarcodeDetector — WebKit bug 281848 — so WASM is the only
// portable way.) One frame in flight per worker; the main thread drops frames
// when all workers are busy. Frames are disposable — the transport does not care.
//
// Decode paths (see ../vendor/decimen-codec/source/wrapper/decimen_codec.cpp):
//  - readFull: generic QR acquisition. Use it to discover/reacquire geometry.
//  - readTracked: one cached QR, used for sparse/single-code fallback work.
//  - decodeTrackedBatchRGBA: the locked-grid hot path. It caches module sample
//    positions for every known QR, skips global finder detection, samples all
//    tracks in one native call, and uses CRC-fast decoding before bounded RS.

import wasmUrl from "../vendor/decimen-codec/decimen_codec.wasm?url";
import { shouldRunFullDecode } from "../shared/decode-policy";
import { crc32, parseFrame } from "../shared/protocol";
import { gridLayoutById } from "../shared/grid-layout";
import DecimenCodec, { type DecimenModule, type DecimenQuad } from "../vendor/decimen-codec/decimen_codec.js";

const ready: Promise<DecimenModule> = DecimenCodec({
  locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path),
});

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

/** Axis-aligned bounds of a symbol quad, shifted into capture coordinates by
 *  the crop offset — the receiver uses these to crop the next frames. */
function boundsOf(p: DecimenQuad, ox: number, oy: number) {
  const xs = [p.topLeft.x, p.topRight.x, p.bottomRight.x, p.bottomLeft.x];
  const ys = [p.topLeft.y, p.topRight.y, p.bottomRight.y, p.bottomLeft.y];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x: ox + x, y: oy + y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** The full quad in capture coordinates — the tracked path's anchor. */
function shifted(p: DecimenQuad, ox: number, oy: number): DecimenQuad {
  const s = (pt: { x: number; y: number }) => ({ x: pt.x + ox, y: pt.y + oy });
  return {
    topLeft: s(p.topLeft),
    topRight: s(p.topRight),
    bottomRight: s(p.bottomRight),
    bottomLeft: s(p.bottomLeft),
  };
}

// Keep one input allocation for this worker's lifetime. Camera crops are
// similarly sized from frame to frame; malloc/free on every decode only adds
// allocator churn to the hottest path.
let inputPtr = 0;
let inputCapacity = 0;
function inputBuffer(zx: DecimenModule, bytes: number): number {
  if (bytes <= inputCapacity) return inputPtr;
  if (inputPtr) zx._free(inputPtr);
  inputPtr = zx._malloc(bytes);
  inputCapacity = bytes;
  return inputPtr;
}

interface BatchTrack {
  id: number;
  slot?: number;
  misses: number;
  quad: DecimenQuad;
  dim: number;
  crc32: boolean;
}

const NATIVE_BATCH_MAX_TRACKS = 16;
const NATIVE_TRACK_RESULT_BYTES = 32;
const NATIVE_BATCH_METRICS_BYTES = 72;
const NATIVE_BATCH_OUTPUT_BYTES = 128 * 1024;
const NATIVE_TRACK_OK = 1;

interface NativeConfiguredTrack {
  id: number;
  dim: number;
  crc32: boolean;
  baseQuad: DecimenQuad;
}

let nativeBatchHandle = 0;
let nativeResultsPtr = 0;
let nativeOutputPtr = 0;
let nativeMetricsPtr = 0;
let nativeConfigured: NativeConfiguredTrack[] = [];
let nativeCropOrigin = "";
let nativeFallbackBudget = 4;
const nativeRefresh = new Set<number>();

function ensureNativeBatch(zx: DecimenModule): boolean {
  if (nativeBatchHandle) return true;
  nativeBatchHandle = zx._createTrackedDecoder(NATIVE_BATCH_MAX_TRACKS, 177);
  if (!nativeBatchHandle) return false;
  nativeResultsPtr = zx._malloc(NATIVE_BATCH_MAX_TRACKS * NATIVE_TRACK_RESULT_BYTES);
  nativeOutputPtr = zx._malloc(NATIVE_BATCH_OUTPUT_BYTES);
  nativeMetricsPtr = zx._malloc(NATIVE_BATCH_METRICS_BYTES);
  zx._setTrackedDecoderFallbackBudget(nativeBatchHandle, nativeFallbackBudget);
  return Boolean(nativeResultsPtr && nativeOutputPtr && nativeMetricsPtr);
}

function translatedQuad(q: DecimenQuad, dx: number, dy: number): DecimenQuad {
  const move = (p: { x: number; y: number }) => ({ x: p.x + dx, y: p.y + dy });
  return {
    topLeft: move(q.topLeft),
    topRight: move(q.topRight),
    bottomRight: move(q.bottomRight),
    bottomLeft: move(q.bottomLeft),
  };
}

function frameWithCRC(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(payload.length + 4);
  frame.set(payload);
  new DataView(frame.buffer).setUint32(payload.length, crc32(payload), true);
  return frame;
}

function configureNativeBatch(
  zx: DecimenModule, tracks: readonly BatchTrack[], ox: number, oy: number,
): Map<number, { input: BatchTrack; configured: NativeConfiguredTrack }> | undefined {
  if (!ensureNativeBatch(zx) || tracks.length > NATIVE_BATCH_MAX_TRACKS) return undefined;
  const origin = `${ox},${oy}`;
  const originChanged = origin !== nativeCropOrigin;
  const byId = new Map<number, { input: BatchTrack; configured: NativeConfiguredTrack }>();

  for (let slot = 0; slot < tracks.length; slot++) {
    const track = tracks[slot]!;
    const id = track.slot ?? track.id;
    const previous = nativeConfigured[slot];
    const mustConfigure = originChanged || nativeRefresh.has(slot) || !previous ||
      previous.id !== id || previous.dim !== track.dim || previous.crc32 !== track.crc32;
    if (mustConfigure) {
      const q = track.quad;
      const accepted = zx._setTrackedDecoderTrack(
        nativeBatchHandle, slot, id, track.dim,
        q.topLeft.x - ox, q.topLeft.y - oy,
        q.topRight.x - ox, q.topRight.y - oy,
        q.bottomRight.x - ox, q.bottomRight.y - oy,
        q.bottomLeft.x - ox, q.bottomLeft.y - oy,
      );
      if (!accepted) return undefined;
      zx._setTrackedDecoderTrackCRC32(nativeBatchHandle, slot, track.crc32 ? 1 : 0);
      nativeConfigured[slot] = { id, dim: track.dim, crc32: track.crc32, baseQuad: track.quad };
      nativeRefresh.delete(slot);
    }
    byId.set(id, { input: track, configured: nativeConfigured[slot]! });
  }
  for (let slot = tracks.length; slot < nativeConfigured.length; slot++) {
    if (nativeConfigured[slot]) zx._clearTrackedDecoderTrack(nativeBatchHandle, slot);
  }
  nativeConfigured.length = tracks.length;
  nativeCropOrigin = origin;
  return byId;
}

function decodeNativeBatch(
  zx: DecimenModule, ptr: number, width: number, height: number, ox: number, oy: number, tracks: readonly BatchTrack[],
): { symbols: { bytes: Uint8Array; box: object; quad: DecimenQuad; modules: number; tracked: boolean; crc32?: boolean }[]; attempted: boolean } | undefined {
  const byId = configureNativeBatch(zx, tracks, ox, oy);
  if (!byId) return undefined;
  // malloc may grow memory; always create views only after all persistent buffers exist.
  const count = zx._decodeTrackedBatchRGBA(
    nativeBatchHandle, ptr, width, height, width * 4,
    nativeResultsPtr, tracks.length, nativeOutputPtr, NATIVE_BATCH_OUTPUT_BYTES, nativeMetricsPtr,
  );
  if (count < 0) return undefined;

  const view = new DataView(zx.HEAPU8.buffer);
  // Spend RS only where the cheap CRC-fast path was insufficient. The native
  // decoder rotates this bounded budget across tracks, so weak cells get ECC
  // without making every clean QR pay Reed-Solomon on every camera frame.
  const successful = view.getUint32(nativeMetricsPtr + 56, true);
  const crcFastSuccesses = view.getUint32(nativeMetricsPtr + 64, true);
  const desiredFallbackBudget = successful < Math.ceil(tracks.length * 0.55)
    ? Math.min(tracks.length, nativeFallbackBudget + 2)
    : crcFastSuccesses >= Math.max(1, Math.floor(successful * 0.75))
      ? Math.max(2, nativeFallbackBudget - 1)
      : nativeFallbackBudget;
  if (desiredFallbackBudget !== nativeFallbackBudget) {
    nativeFallbackBudget = desiredFallbackBudget;
    zx._setTrackedDecoderFallbackBudget(nativeBatchHandle, nativeFallbackBudget);
  }

  const symbols: { bytes: Uint8Array; box: object; quad: DecimenQuad; modules: number; tracked: boolean; crc32?: boolean }[] = [];
  for (let index = 0; index < count; index++) {
    const at = nativeResultsPtr + index * NATIVE_TRACK_RESULT_BYTES;
    const id = view.getInt32(at, true);
    const status = view.getInt32(at + 4, true);
    const bytesOffset = view.getInt32(at + 8, true);
    const bytesLength = view.getInt32(at + 12, true);
    const misses = view.getInt32(at + 16, true);
    const dx = view.getFloat32(at + 24, true);
    const dy = view.getFloat32(at + 28, true);
    const mapped = byId.get(id);
    if (!mapped) continue;
    const slot = tracks.indexOf(mapped.input);
    if (misses >= 3 && slot >= 0) nativeRefresh.add(slot);
    if (status !== NATIVE_TRACK_OK || bytesOffset < 0 || bytesLength <= 0) continue;

    const rawBytes = zx.HEAPU8.slice(nativeOutputPtr + bytesOffset, nativeOutputPtr + bytesOffset + bytesLength);
    const bytes: Uint8Array<ArrayBufferLike> = mapped.input.crc32 ? frameWithCRC(rawBytes) : rawBytes;
    const packet = parseFrame(bytes);
    if (!packet || (mapped.input.slot !== undefined && packet.header.slotIndex !== mapped.input.slot)) {
      if (slot >= 0) nativeRefresh.add(slot);
      continue;
    }
    const quad = translatedQuad(mapped.configured.baseQuad, dx, dy);
    symbols.push({ bytes, box: boundsOf(quad, 0, 0), quad, modules: mapped.input.dim, tracked: true, crc32: mapped.input.crc32 });
  }
  return { symbols, attempted: true };
}

function projectedNeighbor(q: DecimenQuad, dx: number, dy: number, stride: number): DecimenQuad {
  const p0 = q.topLeft, p1 = q.topRight, p2 = q.bottomRight, p3 = q.bottomLeft;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  const dx1x = p1.x - p2.x, dx1y = p1.y - p2.y;
  const dx2x = p3.x - p2.x, dx2y = p3.y - p2.y;
  const denominator = dx1x * dx2y - dx2x * dx1y;
  const g = Math.abs(denominator) < 1e-8 ? 0 : (sx * dx2y - dx2x * sy) / denominator;
  const h = Math.abs(denominator) < 1e-8 ? 0 : (dx1x * sy - sx * dx1y) / denominator;
  const a = p1.x - p0.x + g * p1.x;
  const b = p3.x - p0.x + h * p3.x;
  const c = p0.x;
  const d = p1.y - p0.y + g * p1.y;
  const e = p3.y - p0.y + h * p3.y;
  const f = p0.y;
  const project = (x: number, y: number) => {
    const z = g * x + h * y + 1;
    return { x: (a * x + b * y + c) / z, y: (d * x + e * y + f) / z };
  };
  const x = dx * stride, y = dy * stride;
  return { topLeft: project(x, y), topRight: project(x + 1, y), bottomRight: project(x + 1, y + 1), bottomLeft: project(x, y + 1) };
}

ctx.onmessage = async (e: MessageEvent) => {
  const startedAt = performance.now();
  const { id, buf, w = 0, h = 0, ox = 0, oy = 0, full = true, quad, dim, tracks, isolated = false, oracle = false, oracleSeeds = [], sentAt } = e.data as {
    id: number;
    buf: ArrayBuffer;
    w?: number;
    h?: number;
    ox?: number;
    oy?: number;
    full?: boolean;
    quad?: DecimenQuad;
    dim?: number;
    tracks?: BatchTrack[];
    optimizerProbe?: boolean;
    /** True when the input is already one QR with a synthetic white quiet zone. */
    isolated?: boolean;
    oracle?: boolean;
    oracleSeeds?: { quad: DecimenQuad; modules: number; layoutId: number; slot: number }[];
    sentAt?: number;
  }; 
  const workerWaitMs = sentAt === undefined ? 0 : Math.max(0, startedAt - sentAt);
  let readFullAttempts = 0;
  try {
    const pixels = new Uint8Array(buf);
    const zx = await ready;
    const ptr = inputBuffer(zx, pixels.byteLength);
    zx.HEAPU8.set(pixels, ptr);
    const pw = w;
    const ph = h;
    const symbols: { bytes: Uint8Array; box: object; quad: DecimenQuad; modules: number; tracked: boolean; crc32?: boolean }[] = [];
    const sightings: object[] = [];

    if (oracle) {
      const seen = new Set<string>();
      const valid: typeof symbols = [];
      const appendValid = (vec: ReturnType<DecimenModule["readFull"]>) => {
        readFullAttempts++;
        try {
          for (let i = 0; i < vec.size(); i++) {
            const result = vec.get(i);
            if (!result.valid || !result.bytes.length || !parseFrame(result.bytes)) continue;
            const key = Array.from(result.bytes as Uint8Array).join(",");
            if (seen.has(key)) continue;
            seen.add(key);
            valid.push({
              bytes: result.bytes, box: boundsOf(result.position, 0, 0),
              quad: shifted(result.position, 0, 0), modules: result.modules, tracked: false,
            });
          }
        } finally { vec.delete(); }
      };
      // Best-known reference: the codec's broad native detector passes first.
      appendValid(zx.readFull(ptr, pw, ph, true, 128, false));
      appendValid(zx.readFull(ptr, pw, ph, true, 128, true));
      // A valid packet identifies the complete lattice. Seeds from this frame
      // are supplemented by the nearest successful frame in the corpus, so a
      // weak full-frame detector does not erase otherwise recoverable slots.
      const seeds = [...valid].flatMap((seed) => {
        const parsed = parseFrame(seed.bytes);
        return parsed
          ? [{ quad: seed.quad, modules: seed.modules, layoutId: parsed.header.layoutId, slot: parsed.header.slotIndex }]
          : [];
      });
      seeds.push(...oracleSeeds);
      for (const seed of seeds) {
        const layout = gridLayoutById(seed.layoutId);
        if (!layout) continue;
        const sx = seed.slot % layout.cols;
        const sy = Math.floor(seed.slot / layout.cols);
        const ratio = (seed.modules + 1) / seed.modules;
        for (let slot = 0; slot < layout.cols * layout.rows; slot++) {
          const dx = slot % layout.cols - sx;
          const dy = Math.floor(slot / layout.cols) - sy;
          const predicted = projectedNeighbor(seed.quad, dx, dy, ratio);
          const result = zx.readTracked(
            ptr, pw, ph, seed.modules,
            predicted.topLeft.x, predicted.topLeft.y, predicted.topRight.x, predicted.topRight.y,
            predicted.bottomRight.x, predicted.bottomRight.y, predicted.bottomLeft.x, predicted.bottomLeft.y,
          );
          const packet = result.valid && result.bytes.length ? parseFrame(result.bytes) : null;
          if (packet?.header.layoutId === layout.id && packet.header.slotIndex === slot) {
            const key = Array.from(result.bytes as Uint8Array).join(",");
            if (!seen.has(key)) {
              seen.add(key);
              valid.push({ bytes: result.bytes, box: boundsOf(result.position, 0, 0), quad: shifted(result.position, 0, 0), modules: result.modules, tracked: true });
            }
            continue;
          }

          // Adjacent grid symbols have only a one-module shared gutter. A wide
          // crop feeds several finder-pattern sets back to the generic detector.
          // Isolate exactly one predicted cell and synthesize a clean quiet zone.
          const expected = boundsOf(predicted, 0, 0);
          const moduleSize = Math.max(expected.w, expected.h) / seed.modules;
          const sourcePad = Math.max(2, Math.round(moduleSize));
          const quiet = Math.max(8, Math.round(moduleSize * 5));
          const cx = Math.max(0, Math.floor(expected.x - sourcePad));
          const cy = Math.max(0, Math.floor(expected.y - sourcePad));
          const cr = Math.min(pw, Math.ceil(expected.x + expected.w + sourcePad));
          const cb = Math.min(ph, Math.ceil(expected.y + expected.h + sourcePad));
          const sw = cr - cx, sh = cb - cy;
          const cw = sw + quiet * 2, ch = sh + quiet * 2;
          if (sw < 24 || sh < 24) continue;
          const crop = new Uint8Array(cw * ch * 4);
          crop.fill(255);
          for (let row = 0; row < sh; row++) {
            crop.set(
              pixels.subarray(((cy + row) * pw + cx) * 4, ((cy + row) * pw + cr) * 4),
              ((row + quiet) * cw + quiet) * 4,
            );
          }
          const cropPtr = zx._malloc(crop.length);
          zx.HEAPU8.set(crop, cropPtr);
          readFullAttempts++;
          const fallback = zx.readFull(cropPtr, cw, ch, true, 4, false);
          try {
            for (let i = 0; i < fallback.size(); i++) {
              const candidate = fallback.get(i);
              if (!candidate.valid || !candidate.bytes.length) continue;
              const candidatePacket = parseFrame(candidate.bytes);
              if (candidatePacket?.header.layoutId !== layout.id || candidatePacket.header.slotIndex !== slot) continue;
              const key = Array.from(candidate.bytes as Uint8Array).join(",");
              if (seen.has(key)) continue;
              seen.add(key);
              const shiftX = cx - quiet, shiftY = cy - quiet;
              valid.push({ bytes: candidate.bytes, box: boundsOf(candidate.position, shiftX, shiftY), quad: shifted(candidate.position, shiftX, shiftY), modules: candidate.modules, tracked: false });
            }
          } finally {
            fallback.delete();
            zx._free(cropPtr);
          }
        }
      }
      ctx.postMessage({
        id, symbols: valid, sightings: [], full: true, oracle: true,
        trackedAttempted: true, trackedHit: valid.some((symbol) => symbol.tracked),
        fallbackAttempted: true, readFullAttempts, workerWaitMs,
        latencyMs: performance.now() - startedAt,
      });
      return;
    }

    if (!full && tracks?.length) {
      // Healthy locked grids already provide exact QR quads. Use the codec's
      // persistent native batch sampler: one shared input buffer, cached module
      // maps, no global finder detection, CRC-fast decode, and a bounded RS
      // fallback budget. Generic readFull is reserved for acquisition/recovery.
      const native = decodeNativeBatch(zx, ptr, pw, ph, ox, oy, tracks);
      if (native) {
        ctx.postMessage({
          id, symbols: native.symbols, sightings, full: false,
          trackedAttempted: native.attempted, trackedHit: native.symbols.length > 0,
          fallbackAttempted: false, fallbackSucceeded: false, readFullAttempts: 0,
          workerWaitMs, targetedAttempts: 0, targetedPixels: 0, targetedSuccesses: 0,
          latencyMs: performance.now() - startedAt,
        });
        return;
      }
      // Extremely defensive compatibility fallback: an old/mismatched codec
      // should still scan rather than fail the receiver. This path should not
      // run with the shipped v0.5.37+ WASM, which already exports batch decode.
      readFullAttempts++;
      const decoded = zx.readFull(ptr, pw, ph, true, Math.min(16, Math.max(1, tracks.length)), false);
      try {
        const expectedSlots = new Set(tracks.flatMap((track) => track.slot === undefined ? [] : [track.slot]));
        const decodedSlots = new Set<number>();
        for (let i = 0; i < decoded.size(); i++) {
          const result = decoded.get(i);
          if (!result.valid || !result.bytes.length) continue;
          const packet = parseFrame(result.bytes);
          const slot = packet?.header.slotIndex;
          if (!packet || (slot !== undefined && expectedSlots.size && !expectedSlots.has(slot)) ||
              (slot !== undefined && decodedSlots.has(slot))) continue;
          if (slot !== undefined) decodedSlots.add(slot);
          symbols.push({ bytes: result.bytes, box: boundsOf(result.position, ox, oy),
            quad: shifted(result.position, ox, oy), modules: result.modules, tracked: false });
        }
      } finally {
        decoded.delete();
      }
      ctx.postMessage({ id, symbols, sightings, full: false, trackedAttempted: true, trackedHit: false,
        fallbackAttempted: true, fallbackSucceeded: symbols.length > 0, readFullAttempts, workerWaitMs,
        latencyMs: performance.now() - startedAt });
      return;
    }

    let trackedHit = false;
    let trackedAttempted = false;
    let fallbackAttempted = false;
    if (!full && quad && dim) {
      trackedAttempted = true;
      const r = zx.readTracked(
        ptr, pw, ph, dim,
        quad.topLeft.x - ox, quad.topLeft.y - oy,
        quad.topRight.x - ox, quad.topRight.y - oy,
        quad.bottomRight.x - ox, quad.bottomRight.y - oy,
        quad.bottomLeft.x - ox, quad.bottomLeft.y - oy,
      );
      if (r.valid && r.bytes.length > 0) {
        symbols.push({
          bytes: r.bytes,
          box: boundsOf(r.position, ox, oy),
          quad: shifted(r.position, ox, oy),
          modules: r.modules,
          tracked: true,
        });
        trackedHit = true;
      }
    }

    if (shouldRunFullDecode(full, trackedAttempted, trackedHit)) {
      fallbackAttempted = !full;
      const appendResults = (vec: ReturnType<DecimenModule["readFull"]>, includeErrors: boolean) => {
        try {
          for (let i = 0; i < vec.size(); i++) {
            const r = vec.get(i);
            if (r.valid && r.bytes.length > 0) {
              symbols.push({
                bytes: r.bytes,
                box: boundsOf(r.position, ox, oy),
                quad: shifted(r.position, ox, oy),
                modules: r.modules,
                tracked: false,
              });
            } else if (includeErrors) {
              // A symbol zxing DETECTED but could not decode (glare or noise
              // past ECC) still supplies a useful crop position.
              const box = boundsOf(r.position, ox, oy);
              if (box.w > 0 && box.h > 0) sightings.push(box);
            }
          }
        } finally {
          vec.delete();
        }
      };
      if (full) {
        // Error results count against ZXing's symbol limit. Dense neighboring
        // QRs can produce dozens of plausible finder triples, previously
        // filling all 16 entries before obvious valid codes were considered.
        // Decode valid symbols without error noise first. Only a total miss
        // pays for a high-capacity detector pass to seed recovery crops.
        readFullAttempts++;
        appendResults(zx.readFull(ptr, pw, ph, true, 16, false), false);
        // Acquisition only needs a plausible seed crop, not every bad finder
        // triple in a dense frame. Bounding error output prevents a no-decode
        // capture from monopolizing an older phone's worker for seconds.
        if (symbols.length === 0) {
          readFullAttempts++;
          appendResults(zx.readFull(ptr, pw, ph, true, 24, true), true);
        }
      } else {
        // Isolated locked-grid jobs already contain exactly one QR plus a
        // synthetic quiet zone. Stop after one result so several workers can
        // chew through different cells from the same camera frame in parallel.
        readFullAttempts++;
        appendResults(zx.readFull(ptr, pw, ph, true, isolated ? 1 : 2, false), false);
      }
    }
    ctx.postMessage({
      id, symbols, sightings, full, trackedAttempted, trackedHit, fallbackAttempted,
      fallbackSucceeded: fallbackAttempted && symbols.some((symbol) => !symbol.tracked),
      readFullAttempts, workerWaitMs, latencyMs: performance.now() - startedAt,
    });
  } catch (error) {
    ctx.postMessage({
      id, symbols: [], sightings: [], full,
      workerWaitMs, readFullAttempts, latencyMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// Warm the WASM (instantiation + first-call JIT) so the first real frame
// doesn't pay for it; the pool ignores the {id: -1} ping.
void (async () => {
  try {
    const zx = await ready;
    const ptr = zx._malloc(8 * 8 * 4);
    zx.HEAPU8.set(new Uint8Array(8 * 8 * 4).fill(255), ptr);
    zx.readFull(ptr, 8, 8, false, 1, false).delete();
    zx._free(ptr);
  } catch {
    // a failed warm-up is a slow first frame, not an error
  }
  ctx.postMessage({ id: -1, bytes: null });
})();
