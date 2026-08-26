import { FastScanner } from "./fast-stream.js";

const scanner = new FastScanner((packets) => {
  const transfers = [];
  const serialized = packets.map((packet) => {
    const block = packet.block.slice();
    transfers.push(block.buffer);
    return { ...packet, block: block.buffer };
  });
  postMessage({ type: "packets", packets: serialized }, transfers);
});

self.onmessage = (event) => {
  const message = event.data;
  if (message?.type === "samples" && message.samples instanceof ArrayBuffer) {
    scanner.append(new Float32Array(message.samples));
  } else if (message?.type === "reset") {
    scanner.reset();
  }
};
