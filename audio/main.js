import { formatBytes } from "../shared/format.js";
import { fnv1a, packFile, unpackFile, verifyFile } from "../shared/protocol.js";
import { RaptorDecoder, RaptorEncoder, prepareRaptorQ } from "../shared/raptorq.js";
import { raptorPacketEsi } from "../shared/coding-mode.js";
import { isSnippet, packSnippet, snippetText } from "../shared/snippet.js";
import { releaseScreenWakeLock, requestScreenWakeLock } from "../shared/wake-lock.js";
import {
  AUDIO_ESTIMATED_KBPS,
  AUDIO_SYMBOL_SIZE,
  AcousticReceiver,
  MAX_AUDIO_BYTES,
  SAMPLE_RATE,
  modulateAudioPacket
} from "./modem.js";

const audioView = document.getElementById("audioView");
const sendModeButton = document.getElementById("audio-mode-send");
const receiveModeButton = document.getElementById("audio-mode-receive");
const sendPane = document.getElementById("audio-send-pane");
const receivePane = document.getElementById("audio-receive-pane");
const sendInputs = document.getElementById("audio-send-inputs");
const sendActive = document.getElementById("audio-send-active");
const fileInput = document.getElementById("audio-file");
const filePicker = document.getElementById("audio-file-picker");
const textInput = document.getElementById("audio-text");
const sendTextButton = document.getElementById("audio-send-text");
const stopSendButton = document.getElementById("audio-stop-send");
const listenButton = document.getElementById("audio-listen");
const status = document.getElementById("audio-status");
const progress = document.getElementById("audio-progress");
const progressBar = document.getElementById("audio-progress-bar");
const result = document.getElementById("audio-result");

let currentMode = "send";
let sendSession = null;
let receiveSession = null;
let resultUrl = null;

function setStatus(text, error = false) {
  status.textContent = text;
  status.classList.toggle("error", error);
}

function setProgress(value, visible = value > 0) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  progress.hidden = !visible;
  progress.setAttribute("aria-valuenow", String(Math.round(percent)));
  progressBar.style.width = `${percent}%`;
}

function clearResult() {
  result.replaceChildren();
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = null;
}

function resetSendUi() {
  sendInputs.hidden = false;
  sendActive.hidden = true;
  fileInput.disabled = false;
  sendTextButton.disabled = false;
}

function cleanupSendSession(session) {
  if (!session) return;
  session.stopped = true;
  try { session.source?.stop(); } catch {}
  try { session.source?.disconnect(); } catch {}
  try { session.encoder?.free(); } catch {}
  if (session.context?.state !== "closed") void session.context?.close().catch(() => void 0);
}

function stopSender(reset = true) {
  const session = sendSession;
  sendSession = null;
  cleanupSendSession(session);
  if (reset) {
    resetSendUi();
    if (currentMode === "send") setStatus("");
  }
  releaseScreenWakeLock();
}

async function stopReceiver(reset = true) {
  const session = receiveSession;
  receiveSession = null;
  if (session) {
    session.decoder?.free?.();
    await session.receiver.stop();
  }
  if (reset) {
    listenButton.textContent = "Listen";
    setProgress(0, false);
    if (currentMode === "receive") setStatus("");
  }
  releaseScreenWakeLock();
}

async function stopAll(reset = true) {
  stopSender(reset);
  await stopReceiver(reset);
}

function joinedWaveform(frames) {
  let length = 0;
  for (const frame of frames) length += frame.length;
  const joined = new Float32Array(length);
  let offset = 0;
  for (const frame of frames) {
    joined.set(frame, offset);
    offset += frame.length;
  }
  return joined;
}

async function playWaveform(session, waveform) {
  if (sendSession !== session || session.stopped) return;
  const buffer = session.context.createBuffer(1, waveform.length, SAMPLE_RATE);
  buffer.copyToChannel(waveform, 0);
  const source = session.context.createBufferSource();
  source.buffer = buffer;
  source.connect(session.context.destination);
  session.source = source;
  await new Promise((resolve) => {
    source.onended = resolve;
    source.start();
  });
  try { source.disconnect(); } catch {}
  if (session.source === source) session.source = null;
}

async function startSending(container, label) {
  await stopReceiver(false);
  stopSender(false);
  clearResult();
  setProgress(0, false);
  if (container.length > MAX_AUDIO_BYTES) {
    resetSendUi();
    setStatus(`Audio is limited to ${formatBytes(MAX_AUDIO_BYTES)}.`, true);
    return;
  }
  try {
    await prepareRaptorQ();
    const AudioContextType = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextType) throw new Error("Web Audio is not available in this browser.");
    const context = new AudioContextType({ latencyHint: "playback" });
    await context.resume();
    const session = {
      context,
      encoder: new RaptorEncoder(container, AUDIO_SYMBOL_SIZE),
      payloadId: fnv1a(container),
      totalLen: container.length,
      esi: 0,
      source: null,
      stopped: false
    };
    sendSession = session;
    sendInputs.hidden = true;
    sendActive.hidden = false;
    fileInput.disabled = true;
    sendTextButton.disabled = true;
    setStatus(`Sending ${label} · ~${AUDIO_ESTIMATED_KBPS.toFixed(1)} KB/s`);
    void requestScreenWakeLock();

    while (sendSession === session && !session.stopped) {
      const frames = [];
      for (let i = 0; i < 4; i++) {
        const packet = session.encoder.repair(session.esi);
        session.esi = (session.esi + 1) % 0x00ff0000;
        frames.push(modulateAudioPacket(session.payloadId, session.totalLen, packet));
      }
      await playWaveform(session, joinedWaveform(frames));
    }
  } catch (error) {
    if (sendSession) stopSender(false);
    resetSendUi();
    setStatus(error?.message || "Audio send failed.", true);
  }
}

async function sendFile(file) {
  if (!file) return;
  if (file.size > MAX_AUDIO_BYTES) {
    setStatus(`Audio is limited to ${formatBytes(MAX_AUDIO_BYTES)}.`, true);
    return;
  }
  setStatus("Preparing…");
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const packed = await packFile(file.name, file.type, bytes);
    await startSending(packed.container, file.name);
  } catch (error) {
    setStatus(error?.message || "Could not prepare that file.", true);
  } finally {
    fileInput.value = "";
  }
}

async function sendText() {
  const text = textInput.value;
  setStatus("Preparing…");
  try {
    const packed = await packSnippet(text);
    await startSending(packed.container, "text");
  } catch (error) {
    setStatus(error?.message || "Could not prepare that text.", true);
  }
}

function showReceivedFile(file) {
  clearResult();
  if (isSnippet(file)) {
    const text = snippetText(file);
    const body = document.createElement("p");
    body.className = "received-note";
    body.textContent = text;
    const actions = document.createElement("div");
    actions.className = "note-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "download";
    copy.textContent = "Copy";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy"; }, 1500);
      } catch {
        copy.textContent = "Copy failed";
      }
    });
    actions.append(copy);
    result.append(body, actions);
    return;
  }
  resultUrl = URL.createObjectURL(new Blob([file.bytes], { type: file.type }));
  const card = document.createElement("div");
  card.className = "audio-file-result";
  const link = document.createElement("a");
  link.className = "download";
  link.href = resultUrl;
  link.download = file.name;
  link.textContent = file.name;
  const size = document.createElement("span");
  size.className = "hint";
  size.textContent = formatBytes(file.bytes.length);
  card.append(link, size);
  result.append(card);
}

async function acceptPacket(session, frame) {
  if (receiveSession !== session || session.finishing) return;
  const identity = `${frame.payloadId}:${frame.totalLen}:${frame.symbolSize}`;
  if (identity !== session.identity) {
    session.decoder?.free?.();
    session.decoder = new RaptorDecoder(frame.totalLen, frame.symbolSize);
    session.identity = identity;
    session.payloadId = frame.payloadId;
    session.totalLen = frame.totalLen;
    session.seen.clear();
    session.targetPackets = Math.max(1, Math.ceil(frame.totalLen / frame.symbolSize));
  }
  const esi = raptorPacketEsi(frame.packet);
  if (esi < 0 || session.seen.has(esi)) return;
  session.seen.add(esi);
  const recovered = session.decoder.add(frame.packet);
  const percent = Math.min(99, session.seen.size / session.targetPackets * 100);
  setProgress(percent, true);
  setStatus(`Receiving · ${Math.floor(percent)}%`);
  if (!recovered) return;

  session.finishing = true;
  try {
    if (fnv1a(recovered) !== session.payloadId) throw new Error("Recovered audio data did not verify.");
    const file = await unpackFile(recovered);
    if (!await verifyFile(file)) throw new Error("Received file did not verify.");
    await session.receiver.stop();
    session.decoder.free();
    if (receiveSession === session) receiveSession = null;
    releaseScreenWakeLock();
    listenButton.textContent = "Listen again";
    setProgress(100, true);
    setStatus("Complete");
    showReceivedFile(file);
  } catch (error) {
    session.finishing = false;
    setStatus(error?.message || "Audio receive failed.", true);
  }
}

async function startListening() {
  stopSender(false);
  await stopReceiver(false);
  clearResult();
  setProgress(0, false);
  setStatus("Starting microphone…");
  try {
    await prepareRaptorQ();
    const session = {
      receiver: null,
      decoder: null,
      identity: "",
      payloadId: 0,
      totalLen: 0,
      targetPackets: 0,
      seen: new Set(),
      finishing: false
    };
    const receiver = new AcousticReceiver(
      (frame) => void acceptPacket(session, frame),
      () => {
        if (receiveSession === session && !session.identity) setStatus("Signal found…");
      }
    );
    session.receiver = receiver;
    receiveSession = session;
    await receiver.start();
    if (receiveSession !== session) {
      await receiver.stop();
      return;
    }
    listenButton.textContent = "Stop";
    setStatus("Listening…");
    void requestScreenWakeLock();
  } catch (error) {
    if (receiveSession) await stopReceiver(false);
    listenButton.textContent = "Listen";
    setStatus(error?.name === "NotAllowedError" ? "Microphone permission is required." : error?.message || "Could not start the microphone.", true);
  }
}

async function setMode(mode) {
  if (mode !== "send" && mode !== "receive") return;
  await stopAll(false);
  currentMode = mode;
  sendModeButton.classList.toggle("active", mode === "send");
  receiveModeButton.classList.toggle("active", mode === "receive");
  sendModeButton.setAttribute("aria-selected", String(mode === "send"));
  receiveModeButton.setAttribute("aria-selected", String(mode === "receive"));
  sendPane.hidden = mode !== "send";
  receivePane.hidden = mode !== "receive";
  resetSendUi();
  listenButton.textContent = "Listen";
  setProgress(0, false);
  clearResult();
  setStatus("");
  if (mode === "send" && !matchMedia("(pointer: coarse)").matches) textInput.focus({ preventScroll: true });
}

sendModeButton.addEventListener("click", () => void setMode("send"));
receiveModeButton.addEventListener("click", () => void setMode("receive"));
sendTextButton.addEventListener("click", () => void sendText());
fileInput.addEventListener("change", () => void sendFile(fileInput.files?.[0]));
stopSendButton.addEventListener("click", () => stopSender(true));
listenButton.addEventListener("click", () => {
  if (receiveSession) void stopReceiver(true);
  else void startListening();
});

for (const type of ["dragenter", "dragover"]) {
  filePicker.addEventListener(type, (event) => {
    event.preventDefault();
    filePicker.classList.add("dragging");
  });
}
for (const type of ["dragleave", "drop"]) {
  filePicker.addEventListener(type, (event) => {
    event.preventDefault();
    filePicker.classList.remove("dragging");
  });
}
filePicker.addEventListener("drop", (event) => void sendFile(event.dataTransfer?.files?.[0]));

window.addEventListener("airgapper:leave-mode", () => {
  if (audioView.classList.contains("active") || sendSession || receiveSession) void stopAll(true);
});
window.addEventListener("airgapper:pause-mode", () => {
  if (audioView.classList.contains("active") && (sendSession || receiveSession)) {
    void stopAll(false).then(() => {
      resetSendUi();
      listenButton.textContent = "Listen";
      setProgress(0, false);
      setStatus("Stopped");
    });
  }
});

void setMode("send");
