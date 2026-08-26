import {
  AUDIO_BLOCK_SIZE,
  AUDIO_ESTIMATED_KBPS,
  MAX_AUDIO_BYTES,
  SAMPLE_RATE,
  modulateReliablePacket
} from "./reliable-stream.js";
import { modulateQuietPacket } from "./quiet-stream.js";

const PROFILE_KEY = "airgapper:audio-profile:v1";

function modulateAudioPacket(payloadId, totalLen, mode, encodingId, block) {
  let quiet = false;
  try { quiet = localStorage.getItem(PROFILE_KEY) === "quiet"; } catch {}
  return quiet
    ? modulateQuietPacket(payloadId, totalLen, mode, encodingId, block)
    : modulateReliablePacket(payloadId, totalLen, mode, encodingId, block);
}

class StreamingResampler {
  constructor(inputRate) {
    this.ratio = inputRate / SAMPLE_RATE;
    this.position = 0;
    this.last = 0;
    this.started = false;
  }
  push(chunk) {
    if (this.ratio === 1) return new Float32Array(chunk);
    const source = new Float32Array(chunk.length + 1);
    source[0] = this.started ? this.last : chunk[0] || 0;
    source.set(chunk, 1);
    this.started = true;
    this.last = source[source.length - 1];
    const values = [];
    let position = this.position;
    while (position < source.length - 1) {
      const index = Math.floor(position);
      const fraction = position - index;
      values.push(source[index] + (source[index + 1] - source[index]) * fraction);
      position += this.ratio;
    }
    this.position = position - (source.length - 1);
    return Float32Array.from(values);
  }
}

class AcousticReceiver {
  constructor(onPacket, onSignal = () => void 0) {
    this.onPacket = onPacket;
    this.onSignal = onSignal;
    this.stream = null;
    this.context = null;
    this.source = null;
    this.processor = null;
    this.silent = null;
    this.resampler = null;
    this.worker = null;
    this.quietWorker = null;
    this.running = false;
  }
  async start() {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access is not available in this browser.");
    const audio = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
      sampleRate: SAMPLE_RATE
    };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    } catch (error) {
      if (error?.name === "NotAllowedError" || error?.name === "SecurityError") throw error;
      const { sampleRate, ...withoutRate } = audio;
      stream = await navigator.mediaDevices.getUserMedia({ audio: withoutRate, video: false });
    }
    const AudioContextType = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextType) {
      for (const track of stream.getTracks()) track.stop();
      throw new Error("Web Audio is not available in this browser.");
    }
    const context = new AudioContextType({ latencyHint: "interactive", sampleRate: SAMPLE_RATE });
    if (!context.createScriptProcessor) {
      for (const track of stream.getTracks()) track.stop();
      await context.close();
      throw new Error("Audio receive is not supported in this browser.");
    }

    const reliableUrl = new URL("./reliable-worker.js", import.meta.url);
    reliableUrl.search = new URL(import.meta.url).search;
    const quietUrl = new URL("./quiet-worker.js", import.meta.url);
    quietUrl.search = new URL(import.meta.url).search;
    const worker = new Worker(reliableUrl, { type: "module" });
    const quietWorker = new Worker(quietUrl, { type: "module" });
    const handlePacket = (event) => {
      if (!this.running) return;
      const packet = event.data?.packet;
      if (!packet || !(packet.block instanceof ArrayBuffer)) return;
      this.onPacket({ ...packet, block: new Uint8Array(packet.block) });
    };
    worker.onmessage = (event) => {
      if (!this.running) return;
      if (event.data?.type === "signal") {
        this.onSignal(Number(event.data.quality) || 0);
        return;
      }
      handlePacket(event);
    };
    quietWorker.onmessage = handlePacket;

    await context.resume();
    this.stream = stream;
    this.context = context;
    this.worker = worker;
    this.quietWorker = quietWorker;
    this.resampler = new StreamingResampler(context.sampleRate);
    this.source = context.createMediaStreamSource(stream);
    this.processor = context.createScriptProcessor(1024, 1, 1);
    this.silent = context.createGain();
    this.silent.gain.value = 0;
    this.running = true;
    this.processor.onaudioprocess = (event) => {
      if (!this.running) return;
      this.append(this.resampler.push(event.inputBuffer.getChannelData(0)));
    };
    this.source.connect(this.processor);
    this.processor.connect(this.silent);
    this.silent.connect(context.destination);
  }
  append(chunk) {
    if (!chunk?.length) return;
    if (this.worker) {
      const copy = new Float32Array(chunk);
      this.worker.postMessage({ type: "samples", samples: copy.buffer }, [copy.buffer]);
    }
    if (this.quietWorker) {
      const copy = new Float32Array(chunk);
      this.quietWorker.postMessage({ type: "samples", samples: copy.buffer }, [copy.buffer]);
    }
  }
  async stop() {
    if (!this.running && !this.stream && !this.context && !this.worker && !this.quietWorker) return;
    this.running = false;
    if (this.processor) this.processor.onaudioprocess = null;
    try { this.source?.disconnect(); } catch {}
    try { this.processor?.disconnect(); } catch {}
    try { this.silent?.disconnect(); } catch {}
    for (const track of this.stream?.getTracks?.() ?? []) track.stop();
    this.worker?.terminate();
    this.quietWorker?.terminate();
    const context = this.context;
    this.stream = this.context = this.source = this.processor = this.silent = this.resampler = this.worker = this.quietWorker = null;
    if (context && context.state !== "closed") await context.close().catch(() => void 0);
  }
}

export {
  AUDIO_BLOCK_SIZE,
  AUDIO_ESTIMATED_KBPS,
  AcousticReceiver,
  MAX_AUDIO_BYTES,
  SAMPLE_RATE,
  modulateAudioPacket,
  modulateReliablePacket
};
