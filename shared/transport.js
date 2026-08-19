import { codingMode, RAPTOR_PACKET_ID_BYTES } from "./coding-mode.js";
import { RaptorDecoder, RaptorEncoder } from "./raptorq.js";
const MDS_SYMBOLS = 256;
const RAPTOR_ESI_SPACE = 16711680;
function scheduledEsi(k, ordinal) {
  const mode = codingMode(k);
  if (mode === "direct") return 0;
  if (mode === "mds") return ordinal % MDS_SYMBOLS;
  return ordinal % RAPTOR_ESI_SPACE;
}
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if (value & 256) value ^= 285;
  }
  for (let i = 255; i < GF_EXP.length; i++) GF_EXP[i] = GF_EXP[i - 255];
}
function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}
function gfInv(value) {
  return GF_EXP[255 - GF_LOG[value]];
}
function mdsCoefficients(k, esi) {
  const row = new Uint8Array(k);
  const id = esi % MDS_SYMBOLS;
  if (id < k) {
    row[id] = 1;
    return row;
  }
  for (let i = 0; i < k; i++) row[i] = gfMul(id, gfInv(id ^ i));
  return row;
}
function addScaled(dst, src, factor) {
  if (factor === 0) return;
  if (factor === 1) {
    for (let i = 0; i < dst.length; i++) dst[i] = dst[i] ^ src[i];
    return;
  }
  for (let i = 0; i < dst.length; i++) dst[i] = dst[i] ^ gfMul(src[i], factor);
}
class TransportEncoder {
  constructor(payload, blockLen, streamSeed, mode) {
    this.blockLen = blockLen;
    this.streamSeed = streamSeed;
    this.k = undefined;
    this.mode = undefined;
    this.byteBlocks = undefined;
    this.raptor = undefined;
    this.mode = mode;
    const actualSourceLen = mode === "raptorq" ? blockLen - RAPTOR_PACKET_ID_BYTES : blockLen;
    this.k = Math.max(1, Math.ceil(payload.length / actualSourceLen));
    if (codingMode(this.k) !== mode) throw new Error("Transport mode does not match its source block count.");
    this.byteBlocks = new Uint8Array(this.mode === "raptorq" ? 0 : this.k * blockLen);
    if (this.mode === "raptorq") {
      this.raptor = new RaptorEncoder(payload, actualSourceLen);
    } else {
      this.raptor = null;
      this.byteBlocks.set(payload);
    }
  }
  encode(esi) {
    if (this.raptor) return this.raptor.repair(esi);
    const coefficients = mdsCoefficients(this.k, esi);
    const out = new Uint8Array(this.blockLen);
    for (let block = 0; block < this.k; block++) {
      const factor = coefficients[block];
      if (factor === 0) continue;
      const offset = block * this.blockLen;
      addScaled(out, this.byteBlocks.subarray(offset, offset + this.blockLen), factor);
    }
    return out;
  }
  free() {
    var _a;
    (_a = this.raptor) == null ? void 0 : _a.free();
  }
}
class TransportDecoder {
  constructor(k, blockLen, streamSeed, totalLen) {
    this.k = k;
    this.blockLen = blockLen;
    this.streamSeed = streamSeed;
    this.totalLen = totalLen;
    this.mode = undefined;
    this.seen = /* @__PURE__ */ new Set();
    this.mdsBasis = undefined;
    this.mdsBlocks = null;
    this.raptor = undefined;
    this.raptorPayload = null;
    this.solvedCount = 0;
    this.framesNew = 0;
    this.framesDup = 0;
    this.framesRedundant = 0;
    this.mode = codingMode(k);
    this.mdsBasis = new Array(k).fill(null);
    this.raptor = this.mode === "raptorq" ? new RaptorDecoder(totalLen, blockLen - RAPTOR_PACKET_ID_BYTES) : null;
  }
  get isComplete() {
    return this.solvedCount >= this.k;
  }
  get usefulSymbols() {
    return this.framesNew - this.framesRedundant;
  }
  addFrame(esi, block) {
    if (this.seen.has(esi)) {
      this.framesDup++;
      return;
    }
    this.seen.add(esi);
    this.framesNew++;
    if (this.isComplete) return;
    if (this.raptor) this.addRaptor(block);
    else this.addMds(esi, block);
  }
  addRaptor(block) {
  const payload = this.raptor.add(block);
  if (payload) {
    this.raptorPayload = payload;
    this.solvedCount = this.k;
    return;
  }
  // The streaming RaptorQ API only reports completion, not whether an
  // individual fresh repair symbol was algebraically redundant. Fresh
  // ESIs can be the coding overhead that completes the transfer, so do
  // not mark every post-k symbol redundant and make live KB/s drop to 0.
  this.solvedCount = Math.min(this.framesNew, this.k - 1);
}
  addMds(esi, block) {
    const coefficients = mdsCoefficients(this.k, esi);
    const bytes = new Uint8Array(this.blockLen);
    bytes.set(block.subarray(0, this.blockLen));
    for (let pivot2 = 0; pivot2 < this.k; pivot2++) {
      const basis = this.mdsBasis[pivot2];
      const factor = coefficients[pivot2];
      if (!basis || factor === 0) continue;
      addScaled(coefficients, basis.coefficients, factor);
      addScaled(bytes, basis.bytes, factor);
    }
    const pivot = coefficients.findIndex((value) => value !== 0);
    if (pivot < 0) {
      this.framesRedundant++;
      return;
    }
    const inverse = gfInv(coefficients[pivot]);
    if (inverse !== 1) {
      for (let i = pivot; i < coefficients.length; i++) coefficients[i] = gfMul(coefficients[i], inverse);
      for (let i = 0; i < bytes.length; i++) bytes[i] = gfMul(bytes[i], inverse);
    }
    this.mdsBasis[pivot] = { coefficients, bytes };
    this.solvedCount++;
    if (this.solvedCount === this.k) this.solveMds();
  }
  solveMds() {
    const blocks = new Array(this.k);
    for (let pivot = this.k - 1; pivot >= 0; pivot--) {
      const row = this.mdsBasis[pivot];
      const bytes = row.bytes.slice();
      for (let column = pivot + 1; column < this.k; column++) {
        addScaled(bytes, blocks[column], row.coefficients[column]);
      }
      blocks[pivot] = bytes;
    }
    this.mdsBlocks = blocks;
  }
  assemble() {
    if (!this.isComplete) return null;
    if (this.raptorPayload) return this.raptorPayload;
    const out = new Uint8Array(this.totalLen);
    for (let block = 0; block < this.k; block++) {
      const start = block * this.blockLen;
      const length = Math.min(this.blockLen, this.totalLen - start);
      if (length > 0) out.set(this.mdsBlocks[block].subarray(0, length), start);
    }
    return out;
  }
  free() {
    var _a;
    (_a = this.raptor) == null ? void 0 : _a.free();
  }
}
export {
  TransportDecoder,
  TransportEncoder,
  mdsCoefficients,
  scheduledEsi
};
