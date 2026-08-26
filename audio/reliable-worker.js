import { ReliableScanner } from "./reliable-stream.js";

function sendPacket(packet) {
  const block = packet.block.slice();
  postMessage({ type: "packet", packet: { ...packet, block: block.buffer } }, [block.buffer]);
}

const reliable = new ReliableScanner(sendPacket, (quality) => {
  postMessage({ type: "signal", quality });
});

self.onmessage = (event) => {
  const message = event.data;
  if (message?.type === "samples" && message.samples instanceof ArrayBuffer) {
    reliable.append(new Float32Array(message.samples));
  } else if (message?.type === "reset") {
    reliable.reset();
  }
};
