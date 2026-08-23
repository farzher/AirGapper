import { parseFrame } from "../shared/protocol.js";
import {
  composeTemporalLine,
  composeTemporalLineWithErasures,
  quadDistanceFraction,
  temporalLineCandidates
} from "./temporal-soft-grid.js";

const scope = self;
const scalarCodec = new URL(import.meta.url).searchParams.has("scalar");
let codecPromise;
let syntheticPtr = 0;
let syntheticCapacity = 0;
let modulePtr = 0;
let moduleCapacity = 0;
let erasurePtr = 0;
let erasureCapacity = 0;
let moduleOutputPtr = 0;
let moduleOutputCapacity = 0;
let processing = false;
const models = new Map();

function temporalCodec() {
  if (!codecPromise) {
    codecPromise = import(scalarCodec ? "../codec/scalar/airgapper_codec.js" : "../codec/airgapper_codec.js")
      .then(({ default: AirGapperCodec }) => AirGapperCodec());
  }
  return codecPromise;
}
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

function ensureModuleBuffers(zx, moduleBytes, outputBytes = 16 * 1024, needErasures = false) {
  if (!modulePtr || moduleBytes > moduleCapacity) {
    const next = zx._malloc(moduleBytes);
    if (!next) return false;
    if (modulePtr) zx._free(modulePtr);
    modulePtr = next;
    moduleCapacity = moduleBytes;
  }
  if (needErasures && (!erasurePtr || moduleBytes > erasureCapacity)) {
    const next = zx._malloc(moduleBytes);
    if (!next) return false;
    if (erasurePtr) zx._free(erasurePtr);
    erasurePtr = next;
    erasureCapacity = moduleBytes;
  }
  if (!moduleOutputPtr || outputBytes > moduleOutputCapacity) {
    const next = zx._malloc(outputBytes);
    if (!next) return false;
    if (moduleOutputPtr) zx._free(moduleOutputPtr);
    moduleOutputPtr = next;
    moduleOutputCapacity = outputBytes;
  }
  return true;
}

function parseDirectOutput(zx, length, dim, expectedSlot) {
  if (!(length > 0) || length > moduleOutputCapacity) return null;
  const output = zx.HEAPU8.slice(moduleOutputPtr, moduleOutputPtr + length);
  const packet = parseFrame(output);
  if (!packet || Number(packet.header.slotIndex) !== expectedSlot) return null;
  return { bytes: output, header: packet.header, modules: dim };
}

// undefined means this checked-in codec predates the direct ABI; null means the
// direct decoder exists and rejected this candidate.
function decodeModuleGridDirect(zx, grid, dim, expectedSlot) {
  if (typeof zx._decodeModuleGrid !== "function") return undefined;
  if (!ensureModuleBuffers(zx, grid.byteLength)) return null;
  zx.HEAPU8.set(grid, modulePtr);
  return parseDirectOutput(zx, zx._decodeModuleGrid(
    modulePtr,
    dim,
    moduleOutputPtr,
    moduleOutputCapacity
  ), dim, expectedSlot);
}

function decodeModuleGridErasuresDirect(zx, modules, erasures, dim, expectedSlot) {
  if (typeof zx._decodeModuleGridErasures !== "function") return undefined;
  if (!erasures || erasures.byteLength !== modules.byteLength ||
      !ensureModuleBuffers(zx, modules.byteLength, 16 * 1024, true)) return null;
  zx.HEAPU8.set(modules, modulePtr);
  zx.HEAPU8.set(erasures, erasurePtr);
  return parseDirectOutput(zx, zx._decodeModuleGridErasures(
    modulePtr,
    erasurePtr,
    dim,
    moduleOutputPtr,
    moduleOutputCapacity
  ), dim, expectedSlot);
}

function decodeSyntheticGrid(zx, grid, dim, expectedSlot, scale = 2) {
  const direct = decodeModuleGridDirect(zx, grid, dim, expectedSlot);
  if (direct !== undefined) return direct;

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
  const erasureHalfBand = Math.max(3, Math.min(12, current.dim * 0.055));
  const canErase = typeof zx._decodeModuleGridErasures === "function";
  let attempts = 0;
  let fastAttempts = 0;
  let erasureAttempts = 0;
  let erasureHits = 0;
  let decoded = null;
  let winning = null;
  let usedErasures = false;

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
    if (decoded) {
      winning = candidate;
      break;
    }

    // When the two rolling boundaries cross in the wrong order, a narrow strip
    // contains A in the previous frame and C in the current frame: B literally
    // was not photographed there. Mark that strip as erasures instead of
    // feeding guessed A/C bits into QR RS.
    if (canErase && performance.now() < deadline) {
      const composite = composeTemporalLineWithErasures(
        previous,
        current,
        candidate.centerRow,
        candidate.tiltRows,
        candidate.orientation,
        erasureHalfBand
      );
      if (composite) {
        erasureAttempts++;
        decoded = decodeModuleGridErasuresDirect(
          zx, composite.modules, composite.erasures, current.dim, slot
        );
        if (decoded) {
          erasureHits++;
          usedErasures = true;
          winning = candidate;
          break;
        }
      }
    }
  }

  // Only old cached codecs can reach this raster fallback. With either direct
  // module ABI, retrying a larger fake image cannot add information.
  if (!decoded && typeof zx._decodeModuleGrid !== "function" && performance.now() < deadline) {
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
    return {
      symbol: null, attempts, fastAttempts, erasureAttempts, erasureHits,
      erasureHalfBand, timedOut: performance.now() >= deadline
    };

  noteModel(slot, Number(current.sourceSequence), winning);
  return {
    attempts,
    fastAttempts,
    erasureAttempts,
    erasureHits,
    erasureHalfBand,
    symbol: {
      slot,
      ...decoded,
      centerRow: winning.centerRow,
      tiltRows: winning.tiltRows,
      orientation: winning.orientation,
      candidateSource: winning.source,
      sourceDelta: delta,
      usedErasures
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
    erasureAttempts: 0,
    erasureHits: 0,
    hits: 0,
    skipped: 0,
    timedOut: 0,
    recoverMs: 0,
    centerRow: null,
    tiltRows: null,
    orientation: "",
    candidateSource: "",
    erasureHalfBand: 0,
    usedErasures: 0,
    directGrid: 0,
    directErasures: 0
  };

  let zx;
  try {
    zx = await temporalCodec();
  } catch {
    metrics.skipped++;
    metrics.recoverMs = performance.now() - wallStarted;
    return { symbols, metrics };
  }
  metrics.directGrid = Number(typeof zx._decodeModuleGrid === "function");
  metrics.directErasures = Number(typeof zx._decodeModuleGridErasures === "function");
  const deadline = performance.now() + maxMs;

  for (const pair of Array.isArray(data.pairs) ? data.pairs : []) {
    if (performance.now() >= deadline) {
      metrics.timedOut++;
      break;
    }
    const result = await recoverPair(zx, pair, deadline);
    metrics.attempts += result.attempts || 0;
    metrics.fastAttempts += result.fastAttempts || 0;
    metrics.erasureAttempts += result.erasureAttempts || 0;
    metrics.erasureHits += result.erasureHits || 0;
    metrics.erasureHalfBand = Math.max(metrics.erasureHalfBand, Number(result.erasureHalfBand) || 0);
    metrics.skipped += Number(Boolean(result.skipped));
    metrics.timedOut += Number(Boolean(result.timedOut));
    if (!result.symbol) continue;
    metrics.hits++;
    metrics.centerRow = result.symbol.centerRow;
    metrics.tiltRows = result.symbol.tiltRows;
    metrics.orientation = result.symbol.orientation;
    metrics.candidateSource = result.symbol.candidateSource;
    metrics.usedErasures += Number(Boolean(result.symbol.usedErasures));
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
