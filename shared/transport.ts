import { codingMode, RAPTOR_PACKET_ID_BYTES, type CodingMode } from "./coding-mode";
import { RaptorDecoder, RaptorEncoder } from "./raptorq";

const MDS_SYMBOLS = 256;
const RAPTOR_ESI_SPACE = 0x00ff0000;

export function scheduledEsi(
  k: number,
  ordinal: number,
  _slotIndex: number,
  _gridCodes: number,
): number {
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

export function mdsCoefficients(k: number, esi: number): Uint8Array {
  const row = new Uint8Array(k);
  const id = esi % MDS_SYMBOLS;
  if (id < k) {
    row[id] = 1;
    return row;
  }
  for (let i = 0; i < k; i++) row[i] = gfMul(id, gfInv(id ^ i));
  return row;
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
  private readonly byteBlocks: Uint8Array;
  private readonly raptor: RaptorEncoder | null;

  constructor(
    payload: Uint8Array,
    readonly blockLen: number,
    readonly streamSeed: number,
    mode: CodingMode,
  ) {
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

  encode(esi: number): Uint8Array {
    if (this.raptor) return this.raptor.repair(esi);
    const coefficients = mdsCoefficients(this.k, esi);
    const out = new Uint8Array(this.blockLen);
    for (let block = 0; block < this.k; block++) {
      const factor = coefficients[block]!;
      if (factor === 0) continue;
      const offset = block * this.blockLen;
      addScaled(out, this.byteBlocks.subarray(offset, offset + this.blockLen), factor);
    }
    return out;
  }

  free(): void {
    this.raptor?.free();
  }
}

interface MdsRow {
  coefficients: Uint8Array;
  bytes: Uint8Array;
}

export class TransportDecoder {
  readonly mode: CodingMode;
  private readonly seen = new Set<number>();
  private readonly mdsBasis: (MdsRow | null)[];
  private mdsBlocks: Uint8Array[] | null = null;
  private readonly raptor: RaptorDecoder | null;
  private raptorPayload: Uint8Array | null = null;
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
    this.mdsBasis = new Array<MdsRow | null>(k).fill(null);
    this.raptor = this.mode === "raptorq"
      ? new RaptorDecoder(totalLen, blockLen - RAPTOR_PACKET_ID_BYTES)
      : null;
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
    if (this.raptor) this.addRaptor(block);
    else this.addMds(esi, block);
  }

  private addRaptor(block: Uint8Array): void {
    const payload = this.raptor!.add(block);
    if (payload) {
      this.raptorPayload = payload;
      this.solvedCount = this.k;
      return;
    }
    if (this.framesNew < this.k) {
      this.solvedCount = this.framesNew;
    } else {
      this.framesRedundant++;
      this.solvedCount = this.k - 1;
    }
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

  assemble(): Uint8Array | null {
    if (!this.isComplete) return null;
    if (this.raptorPayload) return this.raptorPayload;
    const out = new Uint8Array(this.totalLen);
    for (let block = 0; block < this.k; block++) {
      const start = block * this.blockLen;
      const length = Math.min(this.blockLen, this.totalLen - start);
      if (length > 0) out.set(this.mdsBlocks![block]!.subarray(0, length), start);
    }
    return out;
  }

  free(): void {
    this.raptor?.free();
  }
}
