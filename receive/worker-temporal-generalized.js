import { parseFrame } from "../shared/protocol.js";
import {
  composeTemporalLine,
  quadDistanceFraction,
  temporalLineCandidates
} from "./temporal-soft-grid.js";

const scope = self;
const scalarCodec = new URL(import.meta.url).searchParams.has("scalar");
let codecPromise;
let syntheticPtr = 0;
let syntheticCapacity = 0;
let processing = false;
const models = new Map();

function temporalCodec() {
  if (!codecPromise) {
    codecPromise = import(scalarCodec ? "../codec/scalar/airgapper_codec.js" : "../codec/airgapper_codec.js")
      .then(({ default: AirGapperCodec }) => AirGapperCodec());
  }
  return codecPromise;
}
// Start module fetch/instantiation as soon as this tiny worker boots. This is
// intentionally not represented as a command: the real recovery message must
// never race a warm-up message against the worker's one-command safety guard.
void temporalCodec().catch(() => {});

function ensureSyntheticBuffer(zx, bytes) {
  if (syntheticPtr && bytes <= syntheticCapacity) return syntheticPtr;
  const next = zx._malloc(bytes);
  if (!next) return 0;
  if (syntheticPtr) zx._free(syntheticPtr);
  syntheticPtr = next;
  syntheticCapacity = bytes;
  return syntheticPtr;
}

function decodeSyntheticGrid(zx, grid, dim, expectedSlot, scale = 2) {
  const quietModules = 4;
  const quiet = quietModules * scale;
  const size = (dim + quietModules * 2) * scale;
  const bytes = size * size;
  const ptr = ensureSyntheticBuffer(zx, bytes);
  if (!ptr) return null;
  zx.HEAPU8.fill(255, ptr, ptr + bytes);

  for (let my = 0; my < dim; my++) {
    const sourceRow = my * dim;
    const y = quiet + my * scale;
    for (let mx = 0; mx < dim; mx++) {
      const value = grid[sourceRow + mx];
      const x = quiet + mx * scale;
      for (let sy = 0; sy < scale; sy++) {
        const row = ptr + (y + sy) * size + x;
        if (scale === 2) {
          zx.HEAPU8[row] = value;
          zx.HEAPU8[row + 1] = value;
        } else {
          zx.HEAPU8.fill(value, row, row + scale);
        }
      }
    }
  }

  const decoded = zx.readDenseY(ptr, size, size, size, 1);
  try {
    for (let i = 0; i < decoded.size(); i++) {
      const result = decoded.get(i);
      if (!result.valid || !result.bytes?.length) continue;
      const output = Uint8Array.from(result.bytes);
      const packet = parseFrame(output);
      if (!packet || Number(packet.header.slotIndex) !== expectedSlot) continue;
      return { bytes: output, header: packet.header, modules: result.modules || dim };
    }
  } finally {
    decoded.delete();
  }
  return null;
}

function predictedHint(slot, currentSequence) {
  const model = models.get(slot);
  if (!model) return null;
  const delta = Math.max(0, Math.min(3, currentSequence - model.sourceSequence));
  return {
    centerRow: model.centerRow + model.centerVelocity * delta,
    tiltRows: model.tiltRows + model.tiltVelocity * delta,
    orientation: model.orientation
  };
}

function noteModel(slot, sourceSequence, candidate) {
  const prior = models.get(slot);
  const centerVelocity = prior && sourceSequence > prior.sourceSequence
    ? Math.max(-12, Math.min(12, (candidate.centerRow - prior.centerRow) / (sourceSequence - prior.sourceSequence)))
    : 0;
  const tiltVelocity = prior && sourceSequence > prior.sourceSequence
    ? Math.max(-8, Math.min(8, (candidate.tiltRows - prior.tiltRows) / (sourceSequence - prior.sourceSequence)))
    : 0;
  models.set(slot, {
    centerRow: candidate.centerRow,
    tiltRows: candidate.tiltRows,
    orientation: candidate.orientation,
    centerVelocity: prior ? prior.centerVelocity * 0.55 + centerVelocity * 0.45 : centerVelocity,
    tiltVelocity: prior ? prior.tiltVelocity * 0.65 + tiltVelocity * 0.35 : tiltVelocity,
    sourceSequence
  });
}

function transferableBuffers(symbols) {
  const seen = new Set();
  const out = [];
  for (const symbol of symbols) {
    const buffer = symbol.bytes?.buffer;
    if (buffer instanceof ArrayBuffer && !seen.has(buffer)) {
      seen.add(buffer);
      out.push(buffer);
    }
  }
  return out;
}

async function recoverPair(zx, pair, deadline) {
  const slot = Number(pair?.slot);
  const previous = pair?.previous;
  const current = pair?.current;
  if (!Number.isInteger(slot) || !previous?.luma || !current?.luma || previous.dim !== current.dim)
    return { symbol: null, attempts: 0, skipped: "bad-pair" };
  const delta = Number(current.sourceSequence) - Number(previous.sourceSequence);
  if (delta !== 1)
    return { symbol: null, attempts: 0, skipped: `delta-${delta}` };
  if (quadDistanceFraction(previous.quad, current.quad) > 0.085)
    return { symbol: null, attempts: 0, skipped: "geometry-moved" };

  const hint = pair.hint ?? predictedHint(slot, Number(current.sourceSequence));
  const candidates = temporalLineCandidates(previous, current, hint, 128);
  let attempts = 0;
  let fastAttempts = 0;
  let decoded = null;
  let winning = null;

  for (const candidate of candidates) {
    if (performance.now() >= deadline) break;
    const grid = composeTemporalLine(
      previous,
      current,
      candidate.centerRow,
      candidate.tiltRows,
      candidate.orientation
    );
    if (!grid) continue;
    attempts++;
    if (candidate.source?.startsWith("learned")) fastAttempts++;
    decoded = decodeSyntheticGrid(zx, grid, current.dim, slot, 2);
    if (!decoded) continue;
    winning = candidate;
    break;
  }

  if (!decoded && performance.now() < deadline) {
    for (const candidate of candidates.slice(0, 10)) {
      if (performance.now() >= deadline) break;
      const grid = composeTemporalLine(
        previous,
        current,
        candidate.centerRow,
        candidate.tiltRows,
        candidate.orientation
      );
      if (!grid) continue;
      attempts++;
      decoded = decodeSyntheticGrid(zx, grid, current.dim, slot, 3);
      if (!decoded) continue;
      winning = candidate;
      break;
    }
  }

  if (!decoded || !winning)
    return { symbol: null, attempts, fastAttempts, timedOut: performance.now() >= deadline };

  noteModel(slot, Number(current.sourceSequence), winning);
  return {
    attempts,
    fastAttempts,
    symbol: {
      slot,
      ...decoded,
      centerRow: winning.centerRow,
      tiltRows: winning.tiltRows,
      orientation: winning.orientation,
      candidateSource: winning.source,
      sourceDelta: delta
    }
  };
}

async function recover(data) {
  const wallStarted = performance.now();
  const maxMs = Math.max(4, Math.min(160, Number(data.maxMs) || 70));
  const symbols = [];
  const metrics = {
    attempts: 0,
    fastAttempts: 0,
    hits: 0,
    skipped: 0,
    timedOut: 0,
    recoverMs: 0,
    centerRow: null,
    tiltRows: null,
    orientation: "",
    candidateSource: ""
  };

  let zx;
  try {
    zx = await temporalCodec();
  } catch {
    metrics.skipped++;
    metrics.recoverMs = performance.now() - wallStarted;
    return { symbols, metrics };
  }
  const deadline = performance.now() + maxMs;

  for (const pair of Array.isArray(data.pairs) ? data.pairs : []) {
    if (performance.now() >= deadline) {
      metrics.timedOut++;
      break;
    }
    const result = await recoverPair(zx, pair, deadline);
    metrics.attempts += result.attempts || 0;
    metrics.fastAttempts += result.fastAttempts || 0;
    metrics.skipped += Number(Boolean(result.skipped));
    metrics.timedOut += Number(Boolean(result.timedOut));
    if (!result.symbol) continue;
    metrics.hits++;
    metrics.centerRow = result.symbol.centerRow;
    metrics.tiltRows = result.symbol.tiltRows;
    metrics.orientation = result.symbol.orientation;
    metrics.candidateSource = result.symbol.candidateSource;
    symbols.push(result.symbol);
  }
  metrics.recoverMs = performance.now() - wallStarted;
  return { symbols, metrics };
}

async function processMessage(data) {
  if (data?.action === "reset") {
    models.clear();
    return { symbols: [], metrics: { reset: 1, recoverMs: 0 } };
  }
  if (data?.action === "warm") {
    // Compatibility no-op for wrapper versions that still send a warm marker.
    // Codec loading already started at module evaluation, so this must not hold
    // the one-command processing guard while WASM instantiates.
    return { symbols: [], metrics: { warm: 1, recoverMs: 0 } };
  }
  return recover(data ?? {});
}

scope.onmessage = async (event) => {
  const data = event.data ?? {};
  if (processing) {
    scope.postMessage({
      temporalGeneralized: true,
      token: data.token,
      sourceSequence: data.sourceSequence,
      symbols: [],
      metrics: { rejectedBusy: 1, recoverMs: 0 }
    });
    return;
  }
  processing = true;
  try {
    const result = await processMessage(data);
    scope.postMessage({
      temporalGeneralized: true,
      token: data.token,
      sourceSequence: data.sourceSequence,
      symbols: result.symbols,
      metrics: result.metrics
    }, transferableBuffers(result.symbols));
  } catch (error) {
    scope.postMessage({
      temporalGeneralized: true,
      token: data.token,
      sourceSequence: data.sourceSequence,
      symbols: [],
      metrics: { recoverMs: 0 },
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    processing = false;
  }
};
