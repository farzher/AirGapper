/* tslint:disable */
/* eslint-disable */
/**
*/
export class Decoder {
  free(): void;
/**
* @param {number} transfer_length
* @param {number} maximum_transmission_unit
* @returns {Decoder}
*/
  static with_defaults(transfer_length: number, maximum_transmission_unit: number): Decoder;
/**
* @param {Uint8Array} packet
* @returns {Uint8Array | undefined}
*/
  decode(packet: Uint8Array): Uint8Array | undefined;
/**
* @param {Uint8Array} packet
* @returns {Uint8Array | undefined}
*/
  add(packet: Uint8Array): Uint8Array | undefined;
}
/**
*/
export class Encoder {
  free(): void;
/**
* @param {Uint8Array} data
* @param {number} maximum_transmission_unit
* @returns {Encoder}
*/
  static with_defaults(data: Uint8Array, maximum_transmission_unit: number): Encoder;
/**
* @param {number} repair_packets_per_block
* @returns {(Uint8Array)[]}
*/
  encode(repair_packets_per_block: number): (Uint8Array)[];
/**
* @returns {number}
*/
  source_blocks(): number;
/**
* @param {number} source_block
* @param {number} repair_symbol_id
* @returns {Uint8Array}
*/
  repair(source_block: number, repair_symbol_id: number): Uint8Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_decoder_free: (a: number) => void;
  readonly decoder_with_defaults: (a: number, b: number) => number;
  readonly decoder_decode: (a: number, b: number, c: number, d: number) => void;
  readonly decoder_add: (a: number, b: number, c: number, d: number) => void;
  readonly __wbg_encoder_free: (a: number) => void;
  readonly encoder_with_defaults: (a: number, b: number, c: number) => number;
  readonly encoder_encode: (a: number, b: number, c: number) => void;
  readonly encoder_source_blocks: (a: number) => number;
  readonly encoder_repair: (a: number, b: number, c: number) => number;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {SyncInitInput} module
*
* @returns {InitOutput}
*/
export function initSync(module: SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {InitInput | Promise<InitInput>} module_or_path
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: InitInput | Promise<InitInput>): Promise<InitOutput>;
