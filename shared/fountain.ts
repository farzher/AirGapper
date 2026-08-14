// Systematic-carousel fountain code — the trick that makes
// a one-way optical channel practical.
//
// The sender emits an endless carousel: a systematic sweep of all K blocks,
// then K mid-degree repair frames (XORs of pseudorandom block subsets derived
// deterministically from `seq`), then the next cycle. A receiver locking on
// anywhere rebuilds the file from ~K distinct frames at low loss — zero
// fountain overhead — and repair frames patch what loss takes, in any order:
// a dropped frame costs a little time, never correctness. No back-channel,
// no retransmission, and sender and receiver frame rates don't need to match.

import { splitmix32 } from "./protocol";

function frameSeed(sessionId: number, seq: number): number {
  let h = (Math.imul(sessionId + 1, 0x9e3779b1) ^ (seq + 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) | 0;
}

/** Frames per carousel cycle: one systematic sweep of all k blocks, then k
 *  repair frames for whatever the sweep dropped. */
export function cycleLength(k: number): number {
  return 2 * k;
}

const REPAIR_DEGREE_MIN = 4;
const REPAIR_DEGREE_MAX = 24;

/**
 * Repair frames are uniform mid-degree (4–24), NOT robust-soliton. After a
 * sweep the receiver holds most blocks, so a repair frame's effective degree
 * is what remains after XORing the solved ones out — soliton's heavy degree-
 * 1/2 mass just re-sends blocks the sweep already delivered. Measured worst
 * wall-clock (seqs/k, k=179, 20 trials) against sweep + k/2 soliton:
 *
 *     drop            0%    5%    10%   30%   50%
 *     k/2 soliton    1.00  2.31  2.60  3.71  5.40
 *     k uniform4-24  1.00  1.37  1.59  2.11  3.06   ← plain LT: 1.14 at 0%
 */
function repairIndices(k: number, sessionId: number, seq: number): number[] {
  const rnd = splitmix32(frameSeed(sessionId, seq));
  const d = Math.min(k, REPAIR_DEGREE_MIN + (rnd() % (REPAIR_DEGREE_MAX - REPAIR_DEGREE_MIN + 1)));
  const set = new Set<number>();
  while (set.size < d) set.add(rnd() % k);
  return [...set];
}

/**
 * Block subset for frame `seq`: systematic during the sweep, mid-degree
 * repair after. There is no handshake, and none is needed — the carousel
 * repeats forever, so a receiver locking on anywhere in the cycle takes
 * systematic frames whenever their block is still unsolved, and repair
 * frames from ANY cycle patch the sweep's losses. At low loss a receiver
 * that catches a whole sweep completes in exactly k frames — zero fountain
 * overhead.
 *
 * Repair frames seed from the ABSOLUTE seq, so every cycle's repair frames
 * draw different subsets — re-watching the carousel never replays them.
 *
 * Every physical grid slot owns a complete carousel. Systematic frames use an
 * affine permutation whose stride is the first number at least as large as the
 * grid that is coprime with k. A lone slot therefore visits every source block,
 * while a full grid emits distinct neighboring blocks on each display tick.
 */
function coprimeStride(k: number, gridCodes: number): number {
  let stride = Math.max(1, gridCodes);
  const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
  while (gcd(stride, k) !== 1) stride++;
  return stride;
}

export function frameComposition(
  k: number,
  sessionId: number,
  seq: number,
  slotIndex: number,
  gridCodes: number,
): number[] {
  const pos = seq % cycleLength(k);
  const frameKey = ((slotIndex & 15) << 24 | (seq & 0x00ffffff)) >>> 0;
  return pos < k
    ? [(pos * coprimeStride(k, gridCodes) + slotIndex) % k]
    : repairIndices(k, sessionId, frameKey);
}

function xorInto(dst: Uint32Array, src: Uint32Array): void {
  for (let i = 0; i < dst.length; i++) dst[i] = (dst[i]! ^ src[i]!) >>> 0;
}

export class LTEncoder {
  readonly k: number;
  private readonly words: number;
  private readonly blocks: Uint32Array;

  constructor(
    payload: Uint8Array,
    readonly blockLen: number,
    readonly sessionId: number,
  ) {
    this.k = Math.max(1, Math.ceil(payload.length / blockLen));
    this.words = Math.ceil(blockLen / 4);
    this.blocks = new Uint32Array(this.k * this.words);
    const bytes = new Uint8Array(this.blocks.buffer);
    for (let b = 0; b < this.k; b++) {
      const src = payload.subarray(b * blockLen, Math.min((b + 1) * blockLen, payload.length));
      bytes.set(src, b * this.words * 4);
    }
  }

  encode(seq: number, slotIndex: number, gridCodes: number): Uint8Array {
    const idx = frameComposition(this.k, this.sessionId, seq, slotIndex, gridCodes);
    const out = new Uint32Array(this.words);
    for (const b of idx) {
      const off = b * this.words;
      for (let w = 0; w < this.words; w++) out[w] = (out[w]! ^ this.blocks[off + w]!) >>> 0;
    }
    return new Uint8Array(out.buffer, 0, this.blockLen);
  }
}

interface PendingFrame {
  idx: Set<number>;
  words: Uint32Array;
}

export class LTDecoder {
  private readonly words: number;
  private readonly solved: (Uint32Array | null)[];
  private readonly byBlock = new Map<number, Set<PendingFrame>>();
  private readonly seen = new Set<number>();
  solvedCount = 0;
  framesNew = 0;
  framesDup = 0;
  /** Frames with a NEW seq that carried no new information — every block
   *  they cover was already solved. Rare at high catch rates, but a lossy
   *  multi-code receiver sees the carousel re-sweep blocks it has, and a
   *  progress bar fed raw framesNew inflates by exactly that fraction
   *  (measured 96% shown vs ~50% real on a 30%-catch 4-code run). */
  framesRedundant = 0;

  constructor(
    readonly k: number,
    readonly blockLen: number,
    readonly sessionId: number,
    readonly totalLen: number,
  ) {
    this.words = Math.ceil(blockLen / 4);
    this.solved = new Array<Uint32Array | null>(k).fill(null);
  }

  get isComplete(): boolean {
    return this.solvedCount >= this.k;
  }

  addFrame(seq: number, slotIndex: number, gridCodes: number, block: Uint8Array): void {
    const frameKey = ((slotIndex & 15) << 24 | (seq & 0x00ffffff)) >>> 0;
    if (this.seen.has(frameKey)) {
      this.framesDup++;
      return;
    }
    this.seen.add(frameKey);
    this.framesNew++;
    if (this.isComplete) return;

    const idx = new Set(frameComposition(this.k, this.sessionId, seq, slotIndex, gridCodes));
    const words = new Uint32Array(this.words);
    new Uint8Array(words.buffer).set(block.subarray(0, this.blockLen));
    for (const b of [...idx]) {
      const s = this.solved[b];
      if (s) {
        xorInto(words, s);
        idx.delete(b);
      }
    }
    if (idx.size === 0) {
      this.framesRedundant++;
      return;
    }
    if (idx.size === 1) {
      this.resolve(idx.values().next().value!, words);
      return;
    }
    const pf: PendingFrame = { idx, words };
    for (const b of idx) {
      let set = this.byBlock.get(b);
      if (!set) {
        set = new Set();
        this.byBlock.set(b, set);
      }
      set.add(pf);
    }
  }

  /** Peeling cascade: solve a block, reduce every frame waiting on it, repeat.
   * Note for progress UX: this cascade back-loads — blocks solved hockey-
   * sticks near the end while frame ARRIVAL is linear. Show frames collected,
   * not blocks solved, or your progress bar will look stalled then teleport. */
  private resolve(b0: number, w0: Uint32Array): void {
    const queue: [number, Uint32Array][] = [[b0, w0]];
    while (queue.length > 0) {
      const [b, w] = queue.pop()!;
      if (this.solved[b]) continue;
      this.solved[b] = w;
      this.solvedCount++;
      const waiting = this.byBlock.get(b);
      if (!waiting) continue;
      this.byBlock.delete(b);
      for (const pf of waiting) {
        xorInto(pf.words, w);
        pf.idx.delete(b);
        if (pf.idx.size === 1) {
          const r = pf.idx.values().next().value!;
          this.byBlock.get(r)?.delete(pf);
          if (!this.solved[r]) queue.push([r, pf.words]);
        }
      }
    }
  }

  assemble(): Uint8Array | null {
    if (!this.isComplete) return null;
    const out = new Uint8Array(this.totalLen);
    for (let b = 0; b < this.k; b++) {
      const start = b * this.blockLen;
      const len = Math.min(this.blockLen, this.totalLen - start);
      if (len > 0) out.set(new Uint8Array(this.solved[b]!.buffer, 0, len), start);
    }
    return out;
  }
}
