// Fixed-slot pool of decode workers.
//
// The subtle part is slot identity: every worker's message handler closes over
// its own index, so growing and shrinking the pool has to leave the surviving
// workers' indices alone. Shrinking from the end is what makes that true, and
// it is why this is worth having on its own rather than inline in the receiver.
//
// Each worker holds its own ~940 KB zxing WASM instance, so the pool is also
// how the receiver reclaims that memory the moment the last frame is in.

export interface PoolWorker {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror?: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

/** Where a symbol sat in the capture, in capture coordinates. */
export interface SymbolBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A symbol's corner quad in capture coordinates — the tracked decode path
 *  rebuilds its sampling transform from this, so unlike the axis-aligned box
 *  it must survive the round trip un-flattened. */
export interface SymbolQuad {
  topLeft: { x: number; y: number };
  topRight: { x: number; y: number };
  bottomRight: { x: number; y: number };
  bottomLeft: { x: number; y: number };
}

/** Decode metadata that rides along with the bytes. */
export interface SymbolInfo {
  /** Worker submission that produced this symbol. Symbols sharing this id came
   * from one camera scan and must not count as repeated observations. */
  scanId?: number;
  quad?: SymbolQuad;
  /** QR dimension in modules; feeds the next tracked decode. */
  modules?: number;
  /** True when the tracked fast path produced this decode. */
  tracked?: boolean;
  /** Application packet ends in the CRC32 consumed by the fast path. */
  crc32?: boolean;
}

interface DecodeMessage {
  id: number;
  /** Every QR found in the frame. The grid sender shows several codes at
   *  once; each one is an independent fountain frame. Empty means a miss. */
  symbols: { bytes: Uint8Array; box?: SymbolBox; quad?: SymbolQuad; modules?: number; tracked?: boolean; crc32?: boolean }[];
  /** Codes DETECTED but not decoded — no bytes, but the position is real.
   *  The receiver uses these to aim crops at codes the full frame lost. */
  sightings?: SymbolBox[];
  /** True when this reply's crop went through the tracked fast path first —
   *  paired with per-symbol `tracked`, the receiver derives the hit rate. */
  trackedAttempted?: boolean;
  trackedHit?: boolean;
  fallbackAttempted?: boolean;
  full?: boolean;
  latencyMs?: number;
  error?: string;
}

export interface DecodeCompletion {
  full: boolean;
  symbolCount: number;
  sightingCount: number;
  trackedAttempted: boolean;
  trackedHit: boolean;
  fallbackAttempted: boolean;
  latencyMs: number;
  error?: string;
}

export class DecodeWorkerPool {
  private readonly workers: PoolWorker[] = [];
  private readonly busy: boolean[] = [];
  private readonly activeIds: (number | undefined)[] = [];

  constructor(
    private readonly create: () => PoolWorker,
    private readonly onDecoded: (bytes: Uint8Array, box?: SymbolBox, info?: SymbolInfo) => void,
    private readonly onSighted?: (box: SymbolBox) => void,
    private readonly onTrackedAttempt?: () => void,
    private readonly onCompleted?: (id: number, completion: DecodeCompletion) => void,
  ) {}

  get size(): number {
    return this.workers.length;
  }

  get busyCount(): number {
    return this.busy.filter(Boolean).length;
  }

  private configureWorker(slot: number, worker: PoolWorker): void {
    worker.onmessage = (event: MessageEvent) => {
      if (this.workers[slot] !== worker) return;
      const message = event.data as DecodeMessage;
      if (message.id === -1) return;
      const symbols = message.symbols ?? [];
      const sightings = message.sightings ?? [];
      this.busy[slot] = false;
      this.activeIds[slot] = undefined;
      const completion: DecodeCompletion = {
        full: Boolean(message.full),
        symbolCount: symbols.length,
        sightingCount: sightings.length,
        trackedAttempted: Boolean(message.trackedAttempted),
        trackedHit: Boolean(message.trackedHit),
        fallbackAttempted: Boolean(message.fallbackAttempted),
        latencyMs: message.latencyMs ?? 0,
        error: message.error,
      };
      try {
        if (message.trackedAttempted) this.onTrackedAttempt?.();
        for (const symbol of symbols) {
          this.onDecoded(symbol.bytes, symbol.box, {
            scanId: message.id,
            quad: symbol.quad,
            modules: symbol.modules,
            tracked: symbol.tracked,
            crc32: symbol.crc32,
          });
        }
        if (this.onSighted) for (const box of sightings) this.onSighted(box);
      } finally {
        this.onCompleted?.(message.id, completion);
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      if (this.workers[slot] !== worker) return;
      const id = this.activeIds[slot];
      this.busy[slot] = false;
      this.activeIds[slot] = undefined;
      if (id !== undefined) {
        this.onCompleted?.(id, {
          full: false,
          symbolCount: 0,
          sightingCount: 0,
          trackedAttempted: false,
          trackedHit: false,
          fallbackAttempted: false,
          latencyMs: 0,
          error: event.message || "Decode worker failed",
        });
      }
      worker.terminate();
      const replacement = this.create();
      this.workers[slot] = replacement;
      this.configureWorker(slot, replacement);
    };
  }

  /** Grow or shrink in place. Terminating a busy worker drops its disposable
   * frame during teardown; active operation always receives a completion. */
  resize(count: number): void {
    while (this.workers.length > Math.max(0, count)) {
      this.workers.pop()!.terminate();
      this.busy.pop();
      this.activeIds.pop();
    }
    while (this.workers.length < count) {
      const slot = this.workers.length;
      const worker = this.create();
      this.workers.push(worker);
      this.busy.push(false);
      this.activeIds.push(undefined);
      this.configureWorker(slot, worker);
    }
  }

  /** Hand a frame to a free worker. False when every worker is busy — the
   *  caller drops the frame rather than queueing it, because a stale frame is
   *  worth less than the next one. */
  submit(message: unknown, transfer: Transferable[]): boolean {
    const slot = this.busy.indexOf(false);
    if (slot === -1) return false;
    const id = (message as { id?: unknown }).id;
    this.busy[slot] = true;
    this.activeIds[slot] = typeof id === "number" ? id : undefined;
    try {
      this.workers[slot]!.postMessage(message, transfer);
      return true;
    } catch {
      this.busy[slot] = false;
      this.activeIds[slot] = undefined;
      return false;
    }
  }
}
