import init, { Decoder, Encoder } from "../vendor/raptorq/raptorq";
import wasmUrl from "../vendor/raptorq/raptorq_bg.wasm?url";

let ready = false;
let loading: Promise<void> | undefined;

export function prepareRaptorQ(): Promise<void> {
  if (ready) return Promise.resolve();
  loading ??= init(wasmUrl).then(() => { ready = true; });
  return loading;
}

function requireReady(): void {
  if (!ready) throw new Error("Transport coding is still loading.");
}

export class RaptorEncoder {
  private readonly native: Encoder;

  constructor(payload: Uint8Array, symbolSize: number) {
    requireReady();
    this.native = Encoder.with_defaults(payload, symbolSize);
    if (this.native.source_blocks() !== 1) {
      this.native.free();
      throw new Error("Transfer needs more than one RaptorQ source block.");
    }
  }

  repair(sequence: number): Uint8Array {
    return this.native.repair(0, sequence);
  }

  free(): void {
    this.native.free();
  }
}

export class RaptorDecoder {
  private readonly native: Decoder;

  constructor(totalLen: number, symbolSize: number) {
    requireReady();
    this.native = Decoder.with_defaults(totalLen, symbolSize);
  }

  add(packet: Uint8Array): Uint8Array | undefined {
    return this.native.add(packet);
  }

  free(): void {
    this.native.free();
  }
}
