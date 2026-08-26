import { ReliableScanner } from "./modem.js";
import { QuietScanner } from "./quiet-modem.js";

function sendPacket(packet) {
  const block = packet.block.slice();
  postMessage({ type: "packet", packet: { ...packet, block: block.buffer } }, [block.buffer]);
}

const reliable = new ReliableScanner(sendPacket, (quality) => {
  postMessage({ type: "signal", quality });
});
const quiet = new QuietScanner(sendPacket);

self.onmessage = (event) => {
  const message = event.data;
  if (message?.type === "samples" && message.samples instanceof ArrayBuffer) {
    const samples = new Float32Array(message.samples);
    reliable.append(samples);
    quiet.append(samples);
  } else if (message?.type === "reset") {
    reliable.reset();
    quiet.reset();
  }
};
