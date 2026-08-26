import { FastScanner } from "./fast-modem.js";

const HOLD_SAMPLES = 4096;
let pending = new Float32Array(0);

const scanner = new FastScanner((packets) => {
  const transfers = [];
  const serialized = packets.map((packet) => {
    const block = packet.block.slice();
    transfers.push(block.buffer);
    return { ...packet, block: block.buffer };
  });
  postMessage({ type: "packets", packets: serialized }, transfers);
});

function appendWithMargin(chunk) {
  const joined = new Float32Array(pending.length + chunk.length);
  joined.set(pending, 0);
  joined.set(chunk, pending.length);
  if (joined.length <= HOLD_SAMPLES) {
    pending = joined;
    return;
  }
  const sendLength = joined.length - HOLD_SAMPLES;
  scanner.append(joined.subarray(0, sendLength));
  pending = joined.slice(sendLength);
}

self.onmessage = (event) => {
  const message = event.data;
  if (message?.type === "samples" && message.samples instanceof ArrayBuffer) {
    appendWithMargin(new Float32Array(message.samples));
  } else if (message?.type === "reset") {
    pending = new Float32Array(0);
    scanner.reset();
  }
};
