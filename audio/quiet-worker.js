import { QuietScanner } from "./quiet-modem.js";

function sendPacket(packet) {
  const block = packet.block.slice();
  postMessage({ type: "packet", packet: { ...packet, block: block.buffer } }, [block.buffer]);
}

const quiet = new QuietScanner(sendPacket);

self.onmessage = (event) => {
  const message = event.data;
  if (message?.type === "samples" && message.samples instanceof ArrayBuffer) {
    quiet.append(new Float32Array(message.samples));
  } else if (message?.type === "reset") {
    quiet.reset();
  }
};
