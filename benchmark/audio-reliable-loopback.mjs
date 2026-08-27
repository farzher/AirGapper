import { codingMode } from "../shared/coding-mode.js";
import {
  ULTRA_AUDIO_BLOCK_SIZE,
  ULTRA_ESTIMATED_KBPS,
  ULTRA_FRAME_MS,
  UltraScanner,
  modulateUltraFrame
} from "../audio/ultra-stream.js";

const usefulBytesPerSecond = ULTRA_ESTIMATED_KBPS * 1024;
if (usefulBytesPerSecond < 15 || usefulBytesPerSecond > 25) {
  throw new Error(`Reliable target rate drifted to ${usefulBytesPerSecond.toFixed(1)} B/s.`);
}

const totalLen = ULTRA_AUDIO_BLOCK_SIZE * 2;
const mode = codingMode(Math.ceil(totalLen / ULTRA_AUDIO_BLOCK_SIZE));
const payloadId = 0x51a9c3e7;
const ordinal = 7;
const block = new Uint8Array(ULTRA_AUDIO_BLOCK_SIZE);
for (let i = 0; i < block.length; i++) block[i] = (i * 19 + 11) & 255;
const waveform = modulateUltraFrame(payloadId, totalLen, mode, ordinal, [block]);

function equalBytes(a, b) {
  if (!(a instanceof Uint8Array) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function decode(input) {
  const packets = [];
  const scanner = new UltraScanner((packet) => packets.push(packet));
  for (let offset = 0; offset < input.length; offset += 997) {
    scanner.append(input.subarray(offset, Math.min(input.length, offset + 997)));
  }
  scanner.append(new Float32Array(4096));
  return packets.find((packet) =>
    packet.payloadId === payloadId &&
    packet.totalLen === totalLen &&
    packet.mode === mode &&
    packet.encodingId === ordinal &&
    equalBytes(packet.block, block)
  );
}

if (!decode(waveform)) throw new Error("Reliable clean loopback failed.");

let seed = 0x12345678;
function noise() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) / 4294967296) * 2 - 1;
}

// A deliberately hostile deterministic channel: ~20 ms leading delay,
// two room-like echoes, strong broadband noise, and severe attenuation.
const delayed = 137;
const degraded = new Float32Array(waveform.length + delayed + 256);
for (let i = 0; i < waveform.length; i++) {
  degraded[i + delayed] += waveform[i] * 0.02;
  if (i + delayed + 53 < degraded.length) degraded[i + delayed + 53] += waveform[i] * 0.007;
  if (i + delayed + 131 < degraded.length) degraded[i + delayed + 131] += waveform[i] * 0.004;
}
for (let i = 0; i < degraded.length; i++) degraded[i] += noise() * 0.10;
if (!decode(degraded)) throw new Error("Reliable low-SNR multipath loopback failed.");

console.log("AIRGAPPER_AUDIO_RELIABLE_LOOPBACK_PASS", {
  frameMs: Math.round(ULTRA_FRAME_MS),
  usefulBytesPerSecond: Number(usefulBytesPerSecond.toFixed(1)),
  samples: waveform.length
});
