var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
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
    __publicField(this, "native");
    requireReady();
    this.native = Encoder.with_defaults(payload, symbolSize);
    if (this.native.source_blocks() !== 1) {
      this.native.free();
      throw new Error("Transfer needs more than one RaptorQ source block.");
    }
  }
  repair(sequence) {
    return this.native.repair(0, sequence);
  }
  free() {
    this.native.free();
  }
}
class RaptorDecoder {
  constructor(totalLen, symbolSize) {
    __publicField(this, "native");
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
