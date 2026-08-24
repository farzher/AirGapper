import init, { Decoder, Encoder } from "../vendor/raptorq/raptorq.js";
let ready = false;
let loading;
function prepareRaptorQ() {
  if (ready) return Promise.resolve();
  loading != null ? loading : loading = init().then(() => {
    ready = true;
  });
  return loading;
}
function requireReady() {
  if (!ready) throw new Error("Transport coding is still loading.");
}
class RaptorEncoder {
  constructor(payload, symbolSize) {
    this.native = undefined;
    requireReady();
    this.native = Encoder.with_defaults(payload, symbolSize);
    if (this.native.source_blocks() !== 1) {
      this.native.free();
      throw new Error("Transfer needs more than one RaptorQ source block.");
    }
  }
  repair(requestId) {
    return this.native.repair(0, requestId);
  }
  free() {
    this.native.free();
  }
}
class RaptorDecoder {
  constructor(totalLen, symbolSize) {
    this.native = undefined;
    requireReady();
    this.native = Decoder.with_defaults(totalLen, symbolSize);
  }
  add(packet) {
    return this.native.add(packet);
  }
  free() {
    this.native.free();
  }
}
export {
  RaptorDecoder,
  RaptorEncoder,
  prepareRaptorQ
};
