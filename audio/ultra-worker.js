import { UltraScanner } from "./ultra-stream.js";

function sendPacket(packet) {
  const block = packet.block.slice();
  postMessage({ type: "packet", packet: { ...packet, block: block.buffer } }, [block.buffer]);
}

const ultra = new UltraScanner(sendPacket, (quality) => {
  postMessage({ type: "signal", quality });
});

self.onmessage = (event) => {
  const message = event.data;
  if (message?.type === "samples" && message.samples instanceof ArrayBuffer) {
    ultra.append(new Float32Array(message.samples));
  } else if (message?.type === "reset") {
    ultra.reset();
  }
};
