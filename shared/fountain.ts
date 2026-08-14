// Hybrid transport coding for the one-way optical channel.
//
// K=1 is direct. Small transfers use a systematic Cauchy MDS code over
// GF(256): the first K symbols are the source blocks and any K distinct symbol
// IDs in the 0..255 row space recover the payload. Larger transfers retain a
// cheap systematic sparse fountain. Scheduling is shared with the sender so
// physical slots get distinct rows and each slot remains a complete stream.

import { codingMode, type CodingMode } from "./coding-mode";
import { splitmix32 } from "./protocol";

const MDS_SYMBOLS = 256;
const REPAIR_DEGREE_MIN = 4;
const REPAIR_DEGREE_MAX = 24;

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function coprimeStride(k: number, gridCodes: number): number {
  let stride = Math.max(1, gridCodes);
  while (gcd(stride, k) !== 1) stride++;
  return stride;
}

/**
 * Coding symbol ID for one globally ordered sender opportunity.
 *
 * MDS walks its complete 256-row code and then repeats the same IDs, making a
 * repeated optical capture a cheap duplicate. Fountain mode repeats source
 * IDs during each systematic sweep, but allocates every repair a fresh ID.
 * The affine source permutation lets any one physical slot visit every source
 * block while neighboring slots remain distinct.
 */
export function scheduledEsi(
  k: number,
  ordinal: number,
  slotIndex: number,
  gridCodes: number,
): number {
  const mode = codingMode(k);
  if (mode === "direct") return 0;
  if (mode === "mds") return ordinal % MDS_SYMBOLS;

  const state = Math.floor(ordinal / gridCodes);
  const cycle = Math.floor(state / (2 * k));
  const pos = state % (2 * k);
  if (pos < k) return (pos * coprimeStride(k, gridCodes) + slotIndex) % k;

  const repairOrdinal = (cycle * k + pos - k) * gridCodes + slotIndex;
  const repairSpace = 0x01000000 - k;
  return k + (repairOrdinal % repairSpace);
}

function frameSeed(streamSeed: number, esi: number): number {
  let h = (Math.imul(streamSeed + 1, 0x9e3779b1) ^ (esi + 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) | 0;
}

/**
 * Balanced sparse repair support. Consecutive groups of K repair IDs are
 * shifted windows through one affine permutation, so no two equations in a
 * group are identical. Epoch-specific permutations retain the old 4..24
 * mid-degree behavior without the tiny-K full-set collapse.
 */
function repairIndices(k: number, streamSeed: number, esi: number): number[] {
  const repair = esi - k;
  const epoch = Math.floor(repair / k);
  const start = repair % k;
  const rnd = splitmix32(frameSeed(streamSeed, epoch));
  const maximumDegree = Math.min(REPAIR_DEGREE_MAX, k - 1);
  const minimumDegree = Math.min(REPAIR_DEGREE_MIN, maximumDegree);
  const degree = minimumDegree + (splitmix32(frameSeed(streamSeed, esi))() % (maximumDegree - minimumDegree + 1));
  const offset = rnd() % k;
  let stride = 1 + (rnd() % (k - 1));
  while (gcd(stride, k) !== 1) stride = stride === k - 1 ? 1 : stride + 1;
  const out = new Array<number>(degree);
  for (let i = 0; i < degree; i++) out[i] = (offset + (start + i) * stride) % k;
  return out;
}

export function fountainComposition(k: number, streamSeed: number, esi: number): number[] {
  return esi < k ? [esi] : repairIndices(k, streamSeed, esi);
}

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < GF_EXP.length; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function gfInv(value: number): number {
  return GF_EXP[255 - GF_LOG[value]!]!;
}

/** Systematic [I; Cauchy] generator row. Every square Cauchy minor is
 * nonsingular, so any K distinct rows recover all K blocks. */
export function mdsCoefficients(k: number, esi: number): Uint8Array {
  const row = new Uint8Array(k);
  const id = esi % MDS_SYMBOLS;
  if (id < k) {
    row[id] = 1;
    return row;
  }
  // x_i=i and y=id are disjoint. Normalising by C[0,y] makes the k=2
  // sequence A, B, A+aB, A+bB... explicit without changing rank.
  for (let i = 0; i < k; i++) row[i] = gfMul(id, gfInv(id ^ i));
  return row;
}

function xorInto(dst: Uint32Array, src: Uint32Array): void {
  for (let i = 0; i < dst.length; i++) dst[i] = (dst[i]! ^ src[i]!) >>> 0;
}

function addScaled(dst: Uint8Array, src: Uint8Array, factor: number): void {
  if (factor === 0) return;
  if (factor === 1) {
    for (let i = 0; i < dst.length; i++) dst[i] = dst[i]! ^ src[i]!;
    return;
  }
  for (let i = 0; i < dst.length; i++) dst[i] = dst[i]! ^ gfMul(src[i]!, factor);
}

export class TransportEncoder {
  readonly k: number;
  readonly mode: CodingMode;
  private readonly words: number;
  private readonly xorBlocks: Uint32Array;
  private readonly byteBlocks: Uint8Array;

  constructor(
    payload: Uint8Array,
    readonly blockLen: number,
    readonly streamSeed: number,
  ) {
    this.k = Math.max(1, Math.ceil(payload.length / blockLen));
    this.mode = codingMode(this.k);
    this.words = Math.ceil(blockLen / 4);
    this.xorBlocks = new Uint32Array(this.k * this.words);
    this.byteBlocks = new Uint8Array(this.xorBlocks.buffer);
    for (let block = 0; block < this.k; block++) {
      const source = payload.subarray(block * blockLen, Math.min((block + 1) * blockLen, payload.length));
      this.byteBlocks.set(source, block * this.words * 4);
    }
  }

  encode(esi: number): Uint8Array {
    if (this.mode === "direct" || this.mode === "mds") {
      const coefficients = mdsCoefficients(this.k, esi);
      const out = new Uint8Array(this.blockLen);
      for (let block = 0; block < this.k; block++) {
        const factor = coefficients[block]!;
        if (factor === 0) continue;
        const offset = block * this.words * 4;
        addScaled(out, this.byteBlocks.subarray(offset, offset + this.blockLen), factor);
      }
      return out;
    }

    const out = new Uint32Array(this.words);
    for (const block of fountainComposition(this.k, this.streamSeed, esi)) {
      const offset = block * this.words;
      for (let word = 0; word < this.words; word++) {
        out[word] = (out[word]! ^ this.xorBlocks[offset + word]!) >>> 0;
      }
    }
    return new Uint8Array(out.buffer, 0, this.blockLen);
  }
}

interface PendingFrame {
  idx: Set<number>;
  words: Uint32Array;
}

interface MdsRow {
  coefficients: Uint8Array;
  bytes: Uint8Array;
}

export class TransportDecoder {
  readonly mode: CodingMode;
  private readonly words: number;
  private readonly solved: (Uint32Array | null)[];
  private readonly byBlock = new Map<number, Set<PendingFrame>>();
  private readonly seen = new Set<number>();
  private readonly seenCompositions = new Set<string>();
  private readonly mdsBasis: (MdsRow | null)[];
  private mdsBlocks: Uint8Array[] | null = null;
  solvedCount = 0;
  framesNew = 0;
  framesDup = 0;
  framesRedundant = 0;

  constructor(
    readonly k: number,
    readonly blockLen: number,
    readonly streamSeed: number,
    readonly totalLen: number,
  ) {
    this.mode = codingMode(k);
    this.words = Math.ceil(blockLen / 4);
    this.solved = new Array<Uint32Array | null>(k).fill(null);
    this.mdsBasis = new Array<MdsRow | null>(k).fill(null);
  }

  get isComplete(): boolean {
    return this.solvedCount >= this.k;
  }

  get usefulSymbols(): number {
    return this.framesNew - this.framesRedundant;
  }

  addFrame(esi: number, block: Uint8Array): void {
    if (this.seen.has(esi)) {
      this.framesDup++;
      return;
    }
    this.seen.add(esi);
    this.framesNew++;
    if (this.isComplete) return;
    if (this.mode === "direct" || this.mode === "mds") this.addMds(esi, block);
    else this.addFountain(esi, block);
  }

  private addMds(esi: number, block: Uint8Array): void {
    const coefficients = mdsCoefficients(this.k, esi);
    const bytes = new Uint8Array(this.blockLen);
    bytes.set(block.subarray(0, this.blockLen));

    for (let pivot = 0; pivot < this.k; pivot++) {
      const basis = this.mdsBasis[pivot];
      const factor = coefficients[pivot]!;
      if (!basis || factor === 0) continue;
      addScaled(coefficients, basis.coefficients, factor);
      addScaled(bytes, basis.bytes, factor);
    }

    const pivot = coefficients.findIndex((value) => value !== 0);
    if (pivot < 0) {
      this.framesRedundant++;
      return;
    }
    const inverse = gfInv(coefficients[pivot]!);
    if (inverse !== 1) {
      for (let i = pivot; i < coefficients.length; i++) coefficients[i] = gfMul(coefficients[i]!, inverse);
      for (let i = 0; i < bytes.length; i++) bytes[i] = gfMul(bytes[i]!, inverse);
    }
    this.mdsBasis[pivot] = { coefficients, bytes };
    this.solvedCount++;
    if (this.solvedCount === this.k) this.solveMds();
  }

  private solveMds(): void {
    const blocks = new Array<Uint8Array>(this.k);
    for (let pivot = this.k - 1; pivot >= 0; pivot--) {
      const row = this.mdsBasis[pivot]!;
      const bytes = row.bytes.slice();
      for (let column = pivot + 1; column < this.k; column++) {
        addScaled(bytes, blocks[column]!, row.coefficients[column]!);
      }
      blocks[pivot] = bytes;
    }
    this.mdsBlocks = blocks;
  }

  private addFountain(esi: number, block: Uint8Array): void {
    const composition = fountainComposition(this.k, this.streamSeed, esi);
    const signature = [...composition].sort((a, b) => a - b).join(",");
    if (this.seenCompositions.has(signature)) {
      this.framesRedundant++;
      return;
    }
    this.seenCompositions.add(signature);

    const idx = new Set(composition);
    const words = new Uint32Array(this.words);
    new Uint8Array(words.buffer).set(block.subarray(0, this.blockLen));
    for (const source of [...idx]) {
      const known = this.solved[source];
      if (!known) continue;
      xorInto(words, known);
      idx.delete(source);
    }
    if (idx.size === 0) {
      this.framesRedundant++;
      return;
    }
    if (idx.size === 1) {
      this.resolve(idx.values().next().value!, words);
      return;
    }
    const pending: PendingFrame = { idx, words };
    for (const source of idx) {
      let waiting = this.byBlock.get(source);
      if (!waiting) {
        waiting = new Set();
        this.byBlock.set(source, waiting);
      }
      waiting.add(pending);
    }
  }

  private resolve(firstBlock: number, firstWords: Uint32Array): void {
    const queue: [number, Uint32Array][] = [[firstBlock, firstWords]];
    while (queue.length > 0) {
      const [block, words] = queue.pop()!;
      if (this.solved[block]) continue;
      this.solved[block] = words;
      this.solvedCount++;
      const waiting = this.byBlock.get(block);
      if (!waiting) continue;
      this.byBlock.delete(block);
      for (const pending of waiting) {
        xorInto(pending.words, words);
        pending.idx.delete(block);
        if (pending.idx.size === 1) {
          const remaining = pending.idx.values().next().value!;
          this.byBlock.get(remaining)?.delete(pending);
          if (!this.solved[remaining]) queue.push([remaining, pending.words]);
        }
      }
    }
  }

  assemble(): Uint8Array | null {
    if (!this.isComplete) return null;
    const out = new Uint8Array(this.totalLen);
    for (let block = 0; block < this.k; block++) {
      const start = block * this.blockLen;
      const length = Math.min(this.blockLen, this.totalLen - start);
      if (length <= 0) continue;
      const bytes = this.mdsBlocks?.[block] ?? new Uint8Array(this.solved[block]!.buffer, 0, this.blockLen);
      out.set(bytes.subarray(0, length), start);
    }
    return out;
  }
}
