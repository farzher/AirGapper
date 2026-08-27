import { codingMode } from "../shared/coding-mode.js";
import {
  AUDIO_BLOCK_SIZE,
  ReliableScanner
} from "../audio/reliable-stream.js";
import {
  RELIABLE_REPEATS,
  ULTRA_PACKETS_PER_FRAME,
  modulateUltraFrame
} from "../audio/ultra-stream.js";

if (ULTRA_PACKETS_PER_FRAME !== 2) throw new Error(`Unexpected Reliable packet count: ${ULTRA_PACKETS_PER_FRAME}`);
if (RELIABLE_REPEATS < 2) throw new Error("Reliable profile must repeat each Normal frame.");

const totalLen = AUDIO_BLOCK_SIZE * ULTRA_PACKETS_PER_FRAME;
const mode = codingMode(Math.ceil(totalLen / AUDIO_BLOCK_SIZE));
const payloadId = 0x51a9c3e7;
const blocks = Array.from({ length: ULTRA_PACKETS_PER_FRAME }, (_, packet) => {
  const block = new Uint8Array(AUDIO_BLOCK_SIZE);
  for (let i = 0; i < block.length; i++) block[i] = (packet * 73 + i * 19 + 11) & 255;
  return block;
});

const received = [];
const scanner = new ReliableScanner((packet) => received.push(packet));
const waveform = modulateUltraFrame(payloadId, totalLen, mode, 0, blocks);

// Deliberately use awkward chunk boundaries to exercise the streaming scanner.
for (let offset = 0; offset < waveform.length; offset += 997) {
  scanner.append(waveform.subarray(offset, Math.min(waveform.length, offset + 997)));
}
scanner.append(new Float32Array(4096));

function equalBytes(a, b) {
  if (!(a instanceof Uint8Array) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

for (let i = 0; i < blocks.length; i++) {
  const packet = received.find((candidate) =>
    candidate.payloadId === payloadId &&
    candidate.totalLen === totalLen &&
    candidate.mode === mode &&
    candidate.encodingId === i &&
    equalBytes(candidate.block, blocks[i])
  );
  if (!packet) {
    throw new Error(`Reliable loopback failed to recover packet ${i}; decoded ${received.length} packets`);
  }
}

console.log("AIRGAPPER_AUDIO_RELIABLE_LOOPBACK_PASS", {
  repeats: RELIABLE_REPEATS,
  samples: waveform.length,
  decodedPackets: received.length
});
