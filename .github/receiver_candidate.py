from pathlib import Path
import re

def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one occurrence, found {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))

def sub_once(path, pattern, repl):
    p = Path(path)
    text = p.read_text()
    new, count = re.subn(pattern, repl, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"{path}: regex expected one occurrence, found {count}: {pattern[:120]!r}")
    p.write_text(new)

# Build/cache versions.
replace_once("main.js", 'const APP_BUILD = "v0.5.311";', 'const APP_BUILD = "v0.5.312";')
replace_once("send/main.js", 'const SEND_RUNTIME_BUILD = "v0.5.311";', 'const SEND_RUNTIME_BUILD = "v0.5.312";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.309";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.312";')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v259";', 'const CACHE = "airgapper-static-js-v260";')

# Backward-compatible extended grid metadata.
replace_once(
    "shared/protocol.js",
    '''const DIRECT_MAGIC = 211;
const MDS_MAGIC = 212;
const RAPTORQ_MAGIC = 213;
const DIRECT_HEADER_LEN = 7;
const MDS_HEADER_LEN = 11;
const RAPTORQ_HEADER_LEN = 14;
const FRAME_CRC_LEN = 4;
function frameHeaderLength(mode) {
  return mode === "direct" ? DIRECT_HEADER_LEN : mode === "mds" ? MDS_HEADER_LEN : RAPTORQ_HEADER_LEN;
}
function frameOverhead(mode) {
  return frameHeaderLength(mode) + FRAME_CRC_LEN;
}''',
    '''const DIRECT_MAGIC = 211;
const MDS_MAGIC = 212;
const RAPTORQ_MAGIC = 213;
// Extended-grid packets deliberately use new magic bytes. Legacy 5-bit-slot
// captures remain byte-for-byte parseable, while Auto can carry a dynamic
// rectangular wall with up to 128 physical slots.
const EXT_MDS_MAGIC = 214;
const EXT_RAPTORQ_MAGIC = 215;
const DIRECT_HEADER_LEN = 7;
const MDS_HEADER_LEN = 11;
const RAPTORQ_HEADER_LEN = 14;
const EXT_MDS_HEADER_LEN = 12;
const EXT_RAPTORQ_HEADER_LEN = 15;
const FRAME_CRC_LEN = 4;
const EXT_GRID_DIM_BITS = 5;
const EXT_GRID_SLOT_BITS = 7;
const EXT_GRID_MAX_SLOTS = 128;
function frameHeaderLength(mode, extendedGrid = false) {
  if (mode === "direct") return DIRECT_HEADER_LEN;
  if (extendedGrid) return mode === "mds" ? EXT_MDS_HEADER_LEN : EXT_RAPTORQ_HEADER_LEN;
  return mode === "mds" ? MDS_HEADER_LEN : RAPTORQ_HEADER_LEN;
}
function frameOverhead(mode, extendedGrid = false) {
  return frameHeaderLength(mode, extendedGrid) + FRAME_CRC_LEN;
}'''
)

replace_once(
    "shared/protocol.js",
    '''function magicForMode(mode) {
  return mode === "direct" ? DIRECT_MAGIC : mode === "mds" ? MDS_MAGIC : RAPTORQ_MAGIC;
}
function modeForMagic(magic) {
  return magic === DIRECT_MAGIC ? "direct" : magic === MDS_MAGIC ? "mds" : magic === RAPTORQ_MAGIC ? "raptorq" : null;
}''',
    '''function magicForMode(mode, extendedGrid = false) {
  if (mode === "direct") return DIRECT_MAGIC;
  if (extendedGrid) return mode === "mds" ? EXT_MDS_MAGIC : EXT_RAPTORQ_MAGIC;
  return mode === "mds" ? MDS_MAGIC : RAPTORQ_MAGIC;
}
function modeForMagic(magic) {
  if (magic === DIRECT_MAGIC) return "direct";
  if (magic === MDS_MAGIC || magic === EXT_MDS_MAGIC) return "mds";
  if (magic === RAPTORQ_MAGIC || magic === EXT_RAPTORQ_MAGIC) return "raptorq";
  return null;
}
function extendedGridForMagic(magic) {
  return magic === EXT_MDS_MAGIC || magic === EXT_RAPTORQ_MAGIC;
}'''
)

sub_once(
    "shared/protocol.js",
    r'''function packFrame\(h, block\) \{.*?\n\}\nfunction parseFrameBody''',
    '''function packFrame(h, block) {
  const extendedGrid = h.mode !== "direct" && Boolean(h.extendedGrid);
  const headerLen = frameHeaderLength(h.mode, extendedGrid);
  const gridCols = Number(h.gridCols);
  const gridRows = Number(h.gridRows);
  const gridCount = gridCols * gridRows;
  const validExtendedGrid = !extendedGrid || (
    Number.isInteger(gridCols) && gridCols >= 1 && fitsBits(gridCols - 1, EXT_GRID_DIM_BITS) &&
    Number.isInteger(gridRows) && gridRows >= 1 && fitsBits(gridRows - 1, EXT_GRID_DIM_BITS) &&
    Number.isInteger(gridCount) && gridCount >= 2 && gridCount <= EXT_GRID_MAX_SLOTS &&
    fitsBits(h.slotIndex, EXT_GRID_SLOT_BITS) && h.slotIndex < gridCount
  );
  const validLegacyGrid = extendedGrid || h.mode === "direct" ||
    (fitsBits(h.layoutId, 4) && fitsBits(h.slotIndex, 5));
  if (codingMode(h.k) !== h.mode ||
      h.mode === "raptorq" && h.k > RAPTOR_MAX_K ||
      block.length !== h.blockLen ||
      h.blockLen <= (h.mode === "raptorq" ? RAPTOR_PACKET_ID_BYTES : 0) ||
      Math.ceil(h.totalLen / (h.blockLen - (h.mode === "raptorq" ? RAPTOR_PACKET_ID_BYTES : 0))) !== h.k ||
      !fitsBits(h.payloadId, 32) ||
      !fitsBits(h.blockLen - 1, BLOCK_LEN_BITS) ||
      !fitsBits(h.totalLen - 1, h.mode === "direct" ? DIRECT_TOTAL_BITS : h.mode === "mds" ? MDS_TOTAL_BITS : RAPTORQ_TOTAL_BITS) ||
      h.mode === "direct" && (h.seq !== 0 || h.layoutId !== 0 || h.slotIndex !== 0 || h.blockLen !== h.totalLen) ||
      h.mode === "mds" && !fitsBits(h.seq, 8) ||
      h.mode === "raptorq" && !fitsBits(h.seq, 24) ||
      !validExtendedGrid || !validLegacyGrid)
    throw new Error("Frame metadata exceeds its packed field.");

  const out = new Uint8Array(headerLen + block.length + FRAME_CRC_LEN);
  out[0] = magicForMode(h.mode, extendedGrid);
  let bit = 8;
  if (h.mode === "direct") {
    bit = writeBits(out, bit, h.totalLen - 1, DIRECT_TOTAL_BITS);
  } else {
    bit = writeBits(out, bit, h.seq, h.mode === "mds" ? 8 : 24);
    if (extendedGrid) {
      bit = writeBits(out, bit, gridCols - 1, EXT_GRID_DIM_BITS);
      bit = writeBits(out, bit, gridRows - 1, EXT_GRID_DIM_BITS);
      bit = writeBits(out, bit, h.slotIndex, EXT_GRID_SLOT_BITS);
    } else {
      bit = writeBits(out, bit, h.layoutId, 4);
      bit = writeBits(out, bit, h.slotIndex, 5);
    }
    bit = writeBits(out, bit, h.blockLen - 1, BLOCK_LEN_BITS);
    bit = writeBits(out, bit, h.totalLen - 1, h.mode === "mds" ? MDS_TOTAL_BITS : RAPTORQ_TOTAL_BITS);
  }
  writeBits(out, bit, h.payloadId >>> 0, 32);
  out.set(block, headerLen);
  new DataView(out.buffer).setUint32(
    headerLen + block.length,
    crc32(out.subarray(0, headerLen + block.length)),
    true
  );
  return out;
}
function parseFrameBody'''
)

sub_once(
    "shared/protocol.js",
    r'''function parseFrameBody\(bytes, hasCrc\) \{.*?\n\}\nfunction parseFrame\(bytes\)''',
    '''function parseFrameBody(bytes, hasCrc) {
  const magic = bytes[0] ?? -1;
  const mode = modeForMagic(magic);
  if (!mode) return null;
  const extendedGrid = extendedGridForMagic(magic);
  const headerLen = frameHeaderLength(mode, extendedGrid);
  if (bytes.length < headerLen + 1 + (hasCrc ? FRAME_CRC_LEN : 0)) return null;
  let bit = 8;
  let seq = 0;
  let layoutId = 0;
  let gridCols = 1;
  let gridRows = 1;
  let slotIndex = 0;
  let blockLen;
  let totalLen;
  if (mode === "direct") {
    const total = readBits(bytes, bit, DIRECT_TOTAL_BITS);
    bit = total.next;
    totalLen = total.value + 1;
    blockLen = totalLen;
  } else {
    const sequence = readBits(bytes, bit, mode === "mds" ? 8 : 24);
    seq = sequence.value;
    bit = sequence.next;
    if (extendedGrid) {
      const cols = readBits(bytes, bit, EXT_GRID_DIM_BITS);
      gridCols = cols.value + 1;
      const rows = readBits(bytes, cols.next, EXT_GRID_DIM_BITS);
      gridRows = rows.value + 1;
      const slot = readBits(bytes, rows.next, EXT_GRID_SLOT_BITS);
      slotIndex = slot.value;
      bit = slot.next;
    } else {
      const layout = readBits(bytes, bit, 4);
      layoutId = layout.value;
      const slot = readBits(bytes, layout.next, 5);
      slotIndex = slot.value;
      bit = slot.next;
    }
    const block = readBits(bytes, bit, BLOCK_LEN_BITS);
    blockLen = block.value + 1;
    const total = readBits(bytes, block.next, mode === "mds" ? MDS_TOTAL_BITS : RAPTORQ_TOTAL_BITS);
    totalLen = total.value + 1;
    bit = total.next;
  }
  const identity = readBits(bytes, bit, 32);
  bit = identity.next;
  while (bit < headerLen * 8) {
    const reserved = readBits(bytes, bit, 1);
    if (reserved.value !== 0) return null;
    bit = reserved.next;
  }
  const sourceBlockLen = mode === "raptorq" ? blockLen - RAPTOR_PACKET_ID_BYTES : blockLen;
  if (sourceBlockLen < 1) return null;
  const k = Math.ceil(totalLen / sourceBlockLen);
  if (k === 0 || k > RAPTOR_MAX_K || codingMode(k) !== mode) return null;
  if (mode !== "direct") {
    if (extendedGrid) {
      const count = gridCols * gridRows;
      if (gridCols < 1 || gridCols > 32 || gridRows < 1 || gridRows > 32 ||
          count < 2 || count > EXT_GRID_MAX_SLOTS || slotIndex >= count)
        return null;
    } else {
      const layout = gridLayoutById(layoutId);
      if (!layout || slotIndex >= layout.cols * layout.rows) return null;
      gridCols = layout.cols;
      gridRows = layout.rows;
    }
  }
  const packetLength = headerLen + blockLen;
  if (bytes.length !== packetLength + (hasCrc ? FRAME_CRC_LEN : 0)) return null;
  if (hasCrc) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(packetLength, true) !== crc32(bytes.subarray(0, packetLength))) return null;
  }
  const header = {
    mode,
    seq,
    layoutId,
    extendedGrid,
    gridCols,
    gridRows,
    slotIndex,
    k,
    blockLen,
    totalLen,
    payloadId: identity.value >>> 0
  };
  return { header, block: bytes.subarray(headerLen, packetLength) };
}
function parseFrame(bytes)'''
)

# Transport planning needs to account for the extended header bytes.
replace_once(
    "shared/frame-capacity.js",
    '''function blockLength(frameBytes, mode) {
  return frameBytes - frameOverhead(mode);
}''',
    '''function blockLength(frameBytes, mode, extendedGrid = false) {
  return frameBytes - frameOverhead(mode, extendedGrid);
}'''
)
replace_once("shared/frame-capacity.js",
             'function balancedPlan(payload, maximumFrameBytes, mode, minimumK) {\n',
             'function balancedPlan(payload, maximumFrameBytes, mode, minimumK, extendedGrid = false) {\n')
replace_once("shared/frame-capacity.js",
             '  const availableSourceBlock = blockLength(maximumFrameBytes, mode) - packetIdBytes;\n',
             '  const availableSourceBlock = blockLength(maximumFrameBytes, mode, extendedGrid) - packetIdBytes;\n')
replace_once("shared/frame-capacity.js",
             'function sourcePlan(payloadBytes, maximumFrameBytes) {\n',
             'function sourcePlan(payloadBytes, maximumFrameBytes, extendedGrid = false) {\n')
replace_once("shared/frame-capacity.js",
             '  const directCapacity = blockLength(maximumFrameBytes, "direct");\n',
             '  const directCapacity = blockLength(maximumFrameBytes, "direct", false);\n')
replace_once("shared/frame-capacity.js",
             '  const mds = balancedPlan(payload, maximumFrameBytes, "mds", 2);\n',
             '  const mds = balancedPlan(payload, maximumFrameBytes, "mds", 2, extendedGrid);\n')
replace_once("shared/frame-capacity.js",
             '  return { mode: "raptorq", ...balancedPlan(payload, maximumFrameBytes, "raptorq", MDS_MAX_K + 1) };\n',
             '  return { mode: "raptorq", ...balancedPlan(payload, maximumFrameBytes, "raptorq", MDS_MAX_K + 1, extendedGrid) };\n')
replace_once(
    "shared/frame-capacity.js",
    '''function selectTransportPlan(payloadBytes, maximumFrameBytes) {
  const payload = Math.max(1, Math.floor(payloadBytes));
  const { mode, blockLen, k } = sourcePlan(payload, maximumFrameBytes);''',
    '''function selectTransportPlan(payloadBytes, maximumFrameBytes, extendedGrid = false) {
  const payload = Math.max(1, Math.floor(payloadBytes));
  const { mode, blockLen, k } = sourcePlan(payload, maximumFrameBytes, extendedGrid);'''
)
replace_once("shared/frame-capacity.js",
             '  const frameBytes = blockLen + frameOverhead(mode);\n',
             '  const frameBytes = blockLen + frameOverhead(mode, mode === "direct" ? false : extendedGrid);\n')
replace_once("shared/frame-capacity.js",
             '    overheadFraction: (frameOverhead(mode) + (mode === "raptorq" ? RAPTOR_PACKET_ID_BYTES : 0)) / frameBytes\n',
             '    overheadFraction: (frameOverhead(mode, mode === "direct" ? false : extendedGrid) + (mode === "raptorq" ? RAPTOR_PACKET_ID_BYTES : 0)) / frameBytes\n')
replace_once(
    "shared/frame-capacity.js",
    '''function sourceBlockCount(payloadBytes, frameBytes) {
  return sourcePlan(payloadBytes, frameBytes).k;
}
function fitsInOneStream(payloadBytes, frameBytes) {
  return sourceBlockCount(payloadBytes, frameBytes) <= MAX_SOURCE_BLOCKS;
}
function minimumFrameBytes(payloadBytes) {
  const sourceBytes = Math.ceil(Math.ceil(payloadBytes / MAX_SOURCE_BLOCKS) / 8) * 8;
  return sourceBytes + RAPTOR_PACKET_ID_BYTES + frameOverhead("raptorq");
}
function smallestSufficientFrameSize(payloadBytes, options) {
  const minimum = minimumFrameBytes(payloadBytes);''',
    '''function sourceBlockCount(payloadBytes, frameBytes, extendedGrid = false) {
  return sourcePlan(payloadBytes, frameBytes, extendedGrid).k;
}
function fitsInOneStream(payloadBytes, frameBytes, extendedGrid = false) {
  return sourceBlockCount(payloadBytes, frameBytes, extendedGrid) <= MAX_SOURCE_BLOCKS;
}
function minimumFrameBytes(payloadBytes, extendedGrid = false) {
  const sourceBytes = Math.ceil(Math.ceil(payloadBytes / MAX_SOURCE_BLOCKS) / 8) * 8;
  return sourceBytes + RAPTOR_PACKET_ID_BYTES + frameOverhead("raptorq", extendedGrid);
}
function smallestSufficientFrameSize(payloadBytes, options, extendedGrid = false) {
  const minimum = minimumFrameBytes(payloadBytes, extendedGrid);'''
)

# Sender Auto gets dynamic grids up to 128 slots.
replace_once("send/main.js",
             'import { GRID_LAYOUTS, GRID_MARGIN_MODULES, gridLayoutId } from "../shared/grid-layout.js";',
             'import { GRID_MARGIN_MODULES, gridLayoutId } from "../shared/grid-layout.js";')
replace_once(
    "send/main.js",
    '''const AUTO_GRID_FRAGMENTATION_BONUS = 0.18;
const AUTO_GRID_MAX_CHANGES_PER_REFRESH = 3;''',
    '''const AUTO_GRID_FRAGMENTATION_BONUS = 0.18;
const AUTO_GRID_MAX_CODES = 128;
// This is intentionally relaxed for the >32-slot experiment. At 360 Hz and
// 30 sender fps it permits roughly 96 independently changing QR slots.
const AUTO_GRID_MAX_CHANGES_PER_REFRESH = 8;
const AUTO_GRID_LAYOUTS = (() => {
  const layouts = [];
  for (let cols = 1; cols <= 32; cols++) {
    for (let rows = cols; rows <= 32; rows++) {
      const codes = cols * rows;
      if (codes <= 1 || codes > AUTO_GRID_MAX_CODES) continue;
      layouts.push({ id: cols * 64 + rows, cols, rows });
    }
  }
  return layouts;
})();'''
)
replace_once(
    "send/main.js",
    '''  for (const maximumFrameBytes of allowedFrameBytes) {
    if (!fitsInOneStream(payloadBytes, maximumFrameBytes)) continue;
    const plan = selectTransportPlan(payloadBytes, maximumFrameBytes);
    if (plan.mode === "direct") continue;
    for (const layout of GRID_LAYOUTS) {
      const codes = layout.cols * layout.rows;
      if (codes <= 1 || codes > 32) continue;''',
    '''  for (const maximumFrameBytes of allowedFrameBytes) {
    if (!fitsInOneStream(payloadBytes, maximumFrameBytes, true)) continue;
    const plan = selectTransportPlan(payloadBytes, maximumFrameBytes, true);
    if (plan.mode === "direct") continue;
    for (const layout of AUTO_GRID_LAYOUTS) {
      const codes = layout.cols * layout.rows;
      if (codes <= 1 || codes > AUTO_GRID_MAX_CODES) continue;'''
)
replace_once("send/main.js",
             '    const fragmentation = Math.max(0, Math.min(1, (candidate.codes - 8) / 24));\n',
             '    const fragmentation = Math.max(0, Math.min(1, (candidate.codes - 8) / (AUTO_GRID_MAX_CODES - 8)));\n')
replace_once("send/main.js",
             '  if (!fitsInOneStream(payload.length, manualFrameBytes)) {\n',
             '  if (!fitsInOneStream(payload.length, manualFrameBytes, autoMode)) {\n')
replace_once(
    "send/main.js",
    '''    const suggestion = smallestSufficientFrameSize(payload.length, FRAME_BYTES_OPTIONS);
    showSettingsError(
      `${formatBytes(payload.length)} needs ${sourceBlockCount(payload.length, manualFrameBytes).toLocaleString()} blocks. `''',
    '''    const suggestion = smallestSufficientFrameSize(payload.length, FRAME_BYTES_OPTIONS, autoMode);
    showSettingsError(
      `${formatBytes(payload.length)} needs ${sourceBlockCount(payload.length, manualFrameBytes, autoMode).toLocaleString()} blocks. `'''
)
replace_once("send/main.js",
             '    const directProbe = selectTransportPlan(payload.length, maximumFrameBytes);\n',
             '    const directProbe = selectTransportPlan(payload.length, maximumFrameBytes, true);\n')
replace_once(
    "send/main.js",
    '''  const header = {
    mode: encoder.mode,
    layoutId: gridLayoutId(gridCols, gridRows),
    k: encoder.k,
    blockLen,
    totalLen: payload.length,
    payloadId
  };''',
    '''  const extendedGrid = Boolean(autoGrid);
  const header = {
    mode: encoder.mode,
    layoutId: extendedGrid ? 0 : gridLayoutId(gridCols, gridRows),
    extendedGrid,
    gridCols,
    gridRows,
    k: encoder.k,
    blockLen,
    totalLen: payload.length,
    payloadId
  };'''
)

# Grid lattice can consume dimensions carried directly by an extended packet.
replace_once(
    "receive/grid-lattice.js",
    '''function activationReady(layout, observations) {
  // One CRC-verified AirGapper QR is enough to predict every declared slot and
  // begin tracked decoding immediately.
  return observations.length > 0;
}''',
    '''function declaredGridLayout(detection) {
  if (detection?.extendedGrid) {
    const cols = Number(detection.gridCols);
    const rows = Number(detection.gridRows);
    const count = cols * rows;
    if (!Number.isInteger(cols) || cols < 1 || cols > 32 ||
        !Number.isInteger(rows) || rows < 1 || rows > 32 ||
        !Number.isInteger(count) || count < 2 || count > 128)
      return null;
    return { id: `extended:${cols}x${rows}`, cols, rows, extendedGrid: true };
  }
  return gridLayoutById(detection?.layoutId) ?? null;
}
function activationReady(layout, observations) {
  // One CRC-verified AirGapper QR is enough to predict every declared slot and
  // begin tracked decoding immediately.
  return observations.length > 0;
}'''
)
replace_once(
    "receive/grid-lattice.js",
    '''    const declaredLayout = gridLayoutById(detection.layoutId);
    if (!declaredLayout || detection.slotIndex >= declaredLayout.cols * declaredLayout.rows) return null;''',
    '''    const declaredLayout = declaredGridLayout(detection);
    if (!declaredLayout || detection.slotIndex >= declaredLayout.cols * declaredLayout.rows) return null;'''
)

# Receiver slot policy grows to 128; 32-bit salvage masks now address batch lanes.
replace_once("receive/main.js", 'Math.min(32, Math.trunc(parsed))', 'Math.min(128, Math.trunc(parsed))')
replace_once("receive/main.js", 'const SLOT_METRIC_COUNT = 64;', 'const SLOT_METRIC_COUNT = 128;')
replace_once("receive/main.js", 'const GUIDED_FALLBACK_SLOT_COUNT = 32;', 'const GUIDED_FALLBACK_SLOT_COUNT = SLOT_METRIC_COUNT;')

sub_once(
    "receive/main.js",
    r'''function guidedFallbackMaskForTracks\(tracks\) \{.*?\n\}\nfunction noteGuidedFallbackMetrics''',
    '''function guidedFallbackMaskForTracks(tracks) {
  let mask = 0;
  const list = tracks ?? [];
  for (let lane = 0; lane < Math.min(32, list.length); lane++) {
    const track = list[lane];
    const slot = Number(track.slot ?? track.id);
    if (!Number.isInteger(slot) || slot < 0 || slot >= GUIDED_FALLBACK_SLOT_COUNT) continue;
    if (guidedFallbackCooldown[slot]) {
      guidedFallbackCooldown[slot]--;
      continue;
    }
    mask = (mask | ((1 << lane) >>> 0)) >>> 0;
  }
  return mask >>> 0;
}
function noteGuidedFallbackMetrics'''
)
sub_once(
    "receive/main.js",
    r'''function noteGuidedFallbackMetrics\(guided\) \{.*?\n\}\nfunction resetSlotMetrics''',
    '''function noteGuidedFallbackMetrics(guided, trackSlots = []) {
  if (!guided) return;
  const sparseSuccess = Number(guided.sparseSuccessMask) >>> 0;
  const fallbackAttempt = Number(guided.fallbackAttemptMask) >>> 0;
  const fallbackSuccess = Number(guided.fallbackSuccessMask) >>> 0;
  for (let lane = 0; lane < Math.min(32, trackSlots.length); lane++) {
    const slot = Number(trackSlots[lane]);
    if (!Number.isInteger(slot) || slot < 0 || slot >= GUIDED_FALLBACK_SLOT_COUNT) continue;
    const bit = (1 << lane) >>> 0;
    if (sparseSuccess & bit) {
      resetGuidedFallbackSlot(slot);
      continue;
    }
    if (!(fallbackAttempt & bit)) continue;
    if (fallbackSuccess & bit) {
      resetGuidedFallbackSlot(slot);
      continue;
    }
    if (++guidedFallbackMisses[slot] < 4) continue;
    guidedFallbackMisses[slot] = 0;
    guidedFallbackBackoff[slot] = Math.min(3, guidedFallbackBackoff[slot] + 1);
    guidedFallbackCooldown[slot] = guidedFallbackBackoff[slot];
  }
}
function resetSlotMetrics'''
)
sub_once(
    "receive/main.js",
    r'''function noteGuidedRepairMetrics\(guided\) \{.*?\n\}\nfunction guidedRepairValue''',
    '''function noteGuidedRepairMetrics(guided, trackSlots = []) {
  const attempts = Number(guided?.erasureRepairAttemptMask) >>> 0;
  const successes = Number(guided?.erasureRepairSuccessMask) >>> 0;
  const attemptedCount = countMaskBits(attempts);
  const codewordsPerAttempt = attemptedCount
    ? Math.max(1, Number(guided?.erasureRepairCodewords) || 0) / attemptedCount
    : 0;
  for (let lane = 0; lane < Math.min(32, trackSlots.length); lane++) {
    const bit = (1 << lane) >>> 0;
    if (!(attempts & bit)) continue;
    const slot = Number(trackSlots[lane]);
    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_METRIC_COUNT) continue;
    const hit = Boolean(successes & bit);
    const alpha = slotRepairSamples[slot] < 5 ? 0.34 : 0.18;
    slotRepairYield[slot] = slotRepairYield[slot] * (1 - alpha) + Number(hit) * alpha;
    slotRepairCost[slot] = slotRepairCost[slot] * (1 - alpha) + codewordsPerAttempt * alpha;
    slotRepairSamples[slot] = Math.min(65535, slotRepairSamples[slot] + 1);
  }
}
function guidedRepairValue'''
)
sub_once(
    "receive/main.js",
    r'''function guidedRepairMaskForTracks\(tracks, sourceSequence, now = receiverNow\(\)\) \{.*?\n\}\nfunction resetTrackBudgetController''',
    '''function guidedRepairMaskForTracks(tracks, sourceSequence, now = receiverNow()) {
  const items = [];
  let mask = 0;
  const list = tracks ?? [];
  // Native salvage has 32 bits. They address batch lanes, not physical slots.
  // Lanes >=32 still run the cheap tracked/sparse path but cannot enter
  // ambiguity repair or generic SampleQR fallback.
  for (let lane = 0; lane < Math.min(32, list.length); lane++) {
    const track = list[lane];
    const slot = Number(track?.slot ?? track?.id);
    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_METRIC_COUNT) continue;
    const bit = (1 << lane) >>> 0;
    const risk = temporalBandRiskForSlot(slot, sourceSequence, now);
    if (risk >= TEMPORAL_MODEL_RISK_THRESHOLD) {
      guidedRepairTemporalFences++;
      continue;
    }
    items.push({ track, slot, bit, value: guidedRepairValue(track, now) });
  }
  lastGuidedRepairCandidates = list.length;
  if (!recentTrackPressure(now)) {
    for (const item of items) mask = (mask | item.bit) >>> 0;
  } else {
    items.sort((a, b) => b.value - a.value || a.slot - b.slot);
    for (const item of items.slice(0, GUIDED_REPAIR_PRESSURE_LIMIT))
      mask = (mask | item.bit) >>> 0;
    guidedRepairPressureFences += Math.max(0, items.length - GUIDED_REPAIR_PRESSURE_LIMIT);
  }
  lastGuidedRepairAllowed = countMaskBits(mask);
  return mask >>> 0;
}
function resetTrackBudgetController'''
)

replace_once("receive/main.js",
             'const parsed = info?.verifiedPayload && info.header ? { header: info.header, block: bytes.subarray(frameHeaderLength(info.header.mode)) } : parseFrame(bytes);',
             'const parsed = info?.verifiedPayload && info.header ? { header: info.header, block: bytes.subarray(frameHeaderLength(info.header.mode, info.header.extendedGrid)) } : parseFrame(bytes);')
replace_once(
    "receive/main.js",
    '''        layoutId: header.layoutId,
        slotIndex: header.slotIndex,''',
    '''        layoutId: header.layoutId,
        extendedGrid: header.extendedGrid,
        gridCols: header.gridCols,
        gridRows: header.gridRows,
        slotIndex: header.slotIndex,'''
)
replace_once(
    "receive/main.js",
    '''    decoder = new TransportDecoder(header.k, header.blockLen, header.payloadId, header.totalLen);
    usefulFrameTimes.length = 0;''',
    '''    decoder = new TransportDecoder(header.k, header.blockLen, header.payloadId, header.totalLen);
    decoder.extendedGrid = Boolean(header.extendedGrid);
    usefulFrameTimes.length = 0;'''
)
replace_once("receive/main.js",
             '    if (guided && !auditMode?.autoOpticsProbe) noteGuidedFallbackMetrics(guided);',
             '    if (guided && !auditMode?.autoOpticsProbe) noteGuidedFallbackMetrics(guided, auditMode?.trackSlots ?? []);')
replace_once("receive/main.js",
             '      noteGuidedRepairMetrics(guided);\n',
             '      noteGuidedRepairMetrics(guided, auditMode?.trackSlots ?? []);\n')
replace_once("receive/main.js",
             '  const transportMetadataBytes = decoder ? frameOverhead(decoder.mode) + packetInternalBytes : 0;\n',
             '  const transportMetadataBytes = decoder ? frameOverhead(decoder.mode, decoder.extendedGrid) + packetInternalBytes : 0;\n')
replace_once("receive/main.js",
             '  const transportFrameBytes = decoder ? decoder.blockLen + frameOverhead(decoder.mode) : 0;\n',
             '  const transportFrameBytes = decoder ? decoder.blockLen + frameOverhead(decoder.mode, decoder.extendedGrid) : 0;\n')

# Guided worker: 128 cheap tracks; keep older persistent tracked decoder at 32.
replace_once(
    "receive/worker.js",
    '''const NATIVE_BATCH_MAX_TRACKS = 32;
const ROBUST_BATCH_MAX_RESULTS = 8;''',
    '''const NATIVE_BATCH_MAX_TRACKS = 32;
const GUIDED_BATCH_MAX_TRACKS = 128;
const ROBUST_BATCH_MAX_RESULTS = 8;'''
)
replace_once("receive/worker.js", 'const GUIDED_OUTPUT_BYTES = 128 * 1024;', 'const GUIDED_OUTPUT_BYTES = 512 * 1024;')
replace_once(
    "receive/worker.js",
    '''  if (!guidedTracksPtr) guidedTracksPtr = zx._malloc(NATIVE_BATCH_MAX_TRACKS * GUIDED_TRACK_BYTES);
  if (!guidedResultsPtr) guidedResultsPtr = zx._malloc(NATIVE_BATCH_MAX_TRACKS * GUIDED_RESULT_BYTES);''',
    '''  if (!guidedTracksPtr) guidedTracksPtr = zx._malloc(GUIDED_BATCH_MAX_TRACKS * GUIDED_TRACK_BYTES);
  if (!guidedResultsPtr) guidedResultsPtr = zx._malloc(GUIDED_BATCH_MAX_TRACKS * GUIDED_RESULT_BYTES);'''
)
replace_once("receive/worker.js",
             '  if (!ensureGuidedBatch(zx) || !tracks.length || tracks.length > NATIVE_BATCH_MAX_TRACKS) return null;',
             '  if (!ensureGuidedBatch(zx) || !tracks.length || tracks.length > GUIDED_BATCH_MAX_TRACKS) return null;')
replace_once("receive/worker.js",
             '    guidedResultsPtr, NATIVE_BATCH_MAX_TRACKS,\n',
             '    guidedResultsPtr, GUIDED_BATCH_MAX_TRACKS,\n')
replace_once(
    "receive/worker.js",
    '''  const symbols = [];
  let expectedSlotsMask = 0;
  for (const track of tracks) {
    const slot = Number(track.slot);
    if (Number.isInteger(slot) && slot >= 0 && slot < 32)
      expectedSlotsMask = (expectedSlotsMask | ((1 << slot) >>> 0)) >>> 0;
  }
  let decodedSlotsMask = 0;
  const trackBySlot = new Map(tracks.map((track) => [Number(track.slot ?? track.id), track]));
  const wallMotionSamples = [];''',
    '''  const symbols = [];
  const expectedSlots = new Set(
    tracks.map((track) => Number(track.slot ?? track.id))
      .filter((slot) => Number.isInteger(slot) && slot >= 0)
  );
  const decodedSlots = new Set();
  const trackBySlot = new Map(tracks.map((track) => [Number(track.slot ?? track.id), track]));
  const trackIndexBySlot = new Map(tracks.map((track, index) => [Number(track.slot ?? track.id), index]));
  const wallMotionSamples = [];'''
)
replace_once(
    "receive/worker.js",
    '''    const slot = packet?.header.slotIndex;
    if (!packet || !Number.isInteger(slot) || slot < 0 || slot >= 32) continue;
    const slotBit = (1 << slot) >>> 0;
    if (expectedSlotsMask && !(expectedSlotsMask & slotBit) || decodedSlotsMask & slotBit) continue;
    decodedSlotsMask = (decodedSlotsMask | slotBit) >>> 0;
    const decodePath = metrics.fallbackSuccessMask & slotBit
      ? "fallback"
      : metrics.sparseSuccessMask & slotBit
        ? "sparse"
        : "hot";''',
    '''    const slot = packet?.header.slotIndex;
    if (!packet || !Number.isInteger(slot) || slot < 0) continue;
    if (expectedSlots.size && !expectedSlots.has(slot) || decodedSlots.has(slot)) continue;
    decodedSlots.add(slot);
    const trackIndex = trackIndexBySlot.get(slot);
    const slotBit = Number.isInteger(trackIndex) && trackIndex >= 0 && trackIndex < 32
      ? (1 << trackIndex) >>> 0
      : 0;
    const decodePath = slotBit && (metrics.fallbackSuccessMask & slotBit)
      ? "fallback"
      : slotBit && (metrics.sparseSuccessMask & slotBit)
        ? "sparse"
        : "hot";'''
)
replace_once(
    "receive/worker.js",
    '''        return parsed ? [{ quad: seed.quad, modules: seed.modules, layoutId: parsed.header.layoutId, slot: parsed.header.slotIndex }] : [];''',
    '''        return parsed ? [{
          quad: seed.quad,
          modules: seed.modules,
          layoutId: parsed.header.layoutId,
          extendedGrid: parsed.header.extendedGrid,
          gridCols: parsed.header.gridCols,
          gridRows: parsed.header.gridRows,
          slot: parsed.header.slotIndex
        }] : [];'''
)
replace_once(
    "receive/worker.js",
    '''        const layout = gridLayoutById(seed.layoutId);
        if (!layout) continue;''',
    '''        const layout = seed.extendedGrid
          ? { cols: Number(seed.gridCols), rows: Number(seed.gridRows) }
          : gridLayoutById(seed.layoutId);
        if (!layout || !Number.isInteger(layout.cols) || !Number.isInteger(layout.rows) ||
            layout.cols < 1 || layout.rows < 1 || layout.cols * layout.rows > 128)
          continue;'''
)

# Native Guided decoder: 128 physical-slot cache; masks refer to lane i.
replace_once(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''static std::array<GuidedTurboTrack, 64>& guidedTurboTracks()
{
    static std::array<GuidedTurboTrack, 64> tracks;''',
    '''static std::array<GuidedTurboTrack, 128>& guidedTurboTracks()
{
    static std::array<GuidedTurboTrack, 128> tracks;'''
)
replace_once(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''            const int referenceId = tracks[i].id;
            const uint32_t referenceBit = referenceId >= 0 && referenceId < 32 ? (uint32_t(1) << referenceId) : 0;
            if (referenceBit && (repairAllowedMask & referenceBit) == 0)
                continue;''',
    '''            const int referenceId = tracks[i].id;
            const uint32_t referenceBit = i < 32 ? (uint32_t(1) << i) : 0;
            if (referenceBit && (repairAllowedMask & referenceBit) == 0)
                continue;'''
)
replace_once(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''            const auto& track = tracks[i];
            const uint32_t trackBit = track.id >= 0 && track.id < 32 ? (uint32_t(1) << track.id) : 0;
            const bool repairMaskAllowed = !trackBit || (repairAllowedMask & trackBit) != 0;''',
    '''            const auto& track = tracks[i];
            const uint32_t trackBit = i < 32 ? (uint32_t(1) << i) : 0;
            const bool repairMaskAllowed = trackBit && (repairAllowedMask & trackBit) != 0;'''
)
replace_once(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''                if (decodedTrack) {
                    ++metrics->fastDecodeSuccesses;
                    if (track.id >= 0 && track.id < 32)
                        metrics->sparseSuccessMask |= uint32_t(1) << track.id;
                }''',
    '''                if (decodedTrack) {
                    ++metrics->fastDecodeSuccesses;
                    if (trackBit)
                        metrics->sparseSuccessMask |= trackBit;
                }'''
)
replace_once(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''            if (!decodedTrack) {
                const bool fallbackAllowed = track.id < 0 || track.id >= 32 ||
                    (fallbackAllowedMask & (uint32_t(1) << track.id)) != 0;
                if (!fallbackAllowed) {
                    ++metrics->genericFallbackSkipped;
                } else {
                    ++metrics->genericFallbackTracks;
                    if (track.id >= 0 && track.id < 32)
                        metrics->fallbackAttemptMask |= uint32_t(1) << track.id;''',
    '''            if (!decodedTrack) {
                const bool fallbackAllowed = trackBit && (fallbackAllowedMask & trackBit) != 0;
                if (!fallbackAllowed) {
                    ++metrics->genericFallbackSkipped;
                } else {
                    ++metrics->genericFallbackTracks;
                    metrics->fallbackAttemptMask |= trackBit;'''
)
replace_once(
    "vendor/decimen-codec/source/wrapper/decimen_codec.cpp",
    '''                            if (track.id >= 0 && track.id < 32)
                                metrics->fallbackSuccessMask |= uint32_t(1) << track.id;''',
    '''                            if (trackBit)
                                metrics->fallbackSuccessMask |= trackBit;'''
)

# Extended-grid lattice regression.
p = Path("benchmark/grid-lattice-regression.mjs")
text = p.read_text()
marker = '\nconsole.log("grid-lattice regression: ok");\n'
if marker not in text:
    raise SystemExit("benchmark/grid-lattice-regression.mjs: completion marker missing")
extended_test = r'''
// Extended-grid regression: Auto can declare a wall above the old 32-slot
// ceiling and the lattice must expose every physical slot.
const extended = new GridLattice();
const extCols = 8;
const extRows = 12;
const extModules = 77;
const extStride = extModules + 1;
const extSlot = 95;
const extCol = extSlot % extCols;
const extRow = Math.floor(extSlot / extCols);
const extScale = 1.3;
const extX = 80 + extCol * extStride * extScale;
const extY = 120 + extRow * extStride * extScale;
const extEdge = extModules * extScale;
const extSnapshot = extended.accept({
  identity: "extended-grid-regression",
  layoutId: 0,
  extendedGrid: true,
  gridCols: extCols,
  gridRows: extRows,
  slotIndex: extSlot,
  modules: extModules,
  at: 1,
  scanId: 1,
  quad: {
    topLeft: { x: extX, y: extY },
    topRight: { x: extX + extEdge, y: extY },
    bottomRight: { x: extX + extEdge, y: extY + extEdge },
    bottomLeft: { x: extX, y: extY + extEdge }
  },
  box: { x: extX, y: extY, w: extEdge, h: extEdge }
}, 1600, 2600);
assert(extSnapshot, "extended grid should lock from one verified QR");
assert.equal(extSnapshot.layout.cols, extCols);
assert.equal(extSnapshot.layout.rows, extRows);
assert.equal(extSnapshot.slots.length, 96, "extended grid must expose slots above 31");
assert.equal(extSnapshot.slots[95].index, 95);
'''
p.write_text(text.replace(marker, extended_test + marker, 1))
