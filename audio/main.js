import { formatBytes } from "../shared/format.js";
import { completedGoodputKbs, estimateTransferProgress, formatDuration } from "../shared/progress.js";
import { fnv1a, packFile, unpackFile, verifyFile } from "../shared/protocol.js";
import { codingMode, RAPTOR_PACKET_ID_BYTES } from "../shared/coding-mode.js";
import { prepareRaptorQ } from "../shared/raptorq.js";
import { scheduledEncodingId, TransportDecoder, TransportEncoder } from "../shared/transport.js";
import { isSnippet, packSnippet, snippetText } from "../shared/snippet.js";
import { releaseScreenWakeLock, requestScreenWakeLock } from "../shared/wake-lock.js";
import {
  clearReceivedResult,
  showReceivedFile as showStandardReceivedFile,
  showReceivedSnippet
} from "../receive/result.js";
import {
  AUDIO_BLOCK_SIZE,
  AUDIO_ESTIMATED_KBPS,
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
const legacyProgress = document.getElementById("audio-progress");
const result = document.getElementById("audio-result");
const standardResult = document.getElementById("result");

let currentMode = "send";
let sendSession = null;
let receiveSession = null;

legacyProgress.hidden = true;
receivePane.classList.add("receiver-primary");
result.remove();

const receivePanel = document.createElement("section");
receivePanel.className = "transfer-panel";
receivePanel.setAttribute("aria-live", "polite");

const receiveProgress = document.createElement("div");
receiveProgress.className = "transfer-progress";

const receiveSummary = document.createElement("div");
receiveSummary.className = "transfer-summary";
const receivePrompt = document.createElement("span");
receivePrompt.className = "settings-prompt";
const receiveTitle = document.createElement("b");
receiveTitle.textContent = "Audio";
const receiveState = document.createElement("span");
receiveState.className = "settings-actual";
receivePrompt.append(receiveTitle, receiveState);
const completeLabel = document.createElement("strong");
completeLabel.className = "complete-label";
completeLabel.textContent = "✓ Complete";
const speedFeedback = document.createElement("span");
speedFeedback.className = "speed-feedback";
const speedValue = document.createElement("strong");
speedFeedback.append(speedValue);
receiveSummary.append(receivePrompt, completeLabel, speedFeedback);

const progressTrack = document.createElement("div");
progressTrack.className = "progress";
progressTrack.setAttribute("role", "progressbar");
progressTrack.setAttribute("aria-label", "Audio transfer progress");
progressTrack.setAttribute("aria-valuemin", "0");
progressTrack.setAttribute("aria-valuemax", "100");
const progressBar = document.createElement("div");
progressTrack.append(progressBar);

const receiveMeta = document.createElement("div");
receiveMeta.className = "transfer-meta";
const receiveEstimate = document.createElement("span");
receiveEstimate.className = "transfer-estimate";
const progressLabel = document.createElement("strong");
progressLabel.className = "progress-amount";
const sizeLabel = document.createElement("span");
const etaLabel = document.createElement("span");
receiveEstimate.append(progressLabel, sizeLabel, etaLabel);
const codingLabel = document.createElement("span");
receiveMeta.append(receiveEstimate, codingLabel);
receiveProgress.append(receiveSummary, progressTrack, receiveMeta);
receivePanel.append(receiveProgress);
receivePane.append(result, receivePanel);

function transportName(mode) {
  return mode === "direct" ? "Direct" : mode === "mds" ? "MDS" : "RaptorQ";
}

function sourceBlockSize(mode) {
  return mode === "raptorq" ? AUDIO_BLOCK_SIZE - RAPTOR_PACKET_ID_BYTES : AUDIO_BLOCK_SIZE;
}

function sourceBlockCount(totalLen, mode) {
  return Math.max(1, Math.ceil(totalLen / sourceBlockSize(mode)));
}

function selectAudioTransport(totalLen) {
  return codingMode(Math.max(1, Math.ceil(totalLen / AUDIO_BLOCK_SIZE)));
}

function setStatus(text, error = false) {
  status.textContent = text;
  status.classList.toggle("error", error);
}

function setReceiveState(text, error = false) {
  receiveState.textContent = text;
  receiveState.style.color = error ? "var(--bad)" : "";
}

function resetReceiveUi(state = "Ready") {
  receivePrompt.hidden = false;
  completeLabel.style.display = "";
  speedValue.textContent = "👂";
  progressLabel.hidden = false;
  progressLabel.textContent = "0%";
  sizeLabel.textContent = "";
  etaLabel.textContent = "";
  codingLabel.textContent = "";
  progressBar.classList.remove("finalizing", "error");
  progressBar.style.width = "0%";
  progressTrack.setAttribute("aria-valuenow", "0");
  setReceiveState(state);
}

function clearResult() {
  result.replaceChildren();
  clearReceivedResult();
}

async function showReceivedResult(file) {
  clearResult();
  if (isSnippet(file)) showReceivedSnippet(snippetText(file));
  else await showStandardReceivedFile(file);
  result.replaceChildren(...standardResult.childNodes);
}

function updateReceiveProgress(session) {
  if (!session.identity || !session.startedAt || !session.decoder) return;
  const elapsedSeconds = Math.max(1e-3, (performance.now() - session.startedAt) / 1000);
  const rank = session.decoder.solvedCount;
  const usefulSymbols = session.decoder.usefulSymbols;
  const estimate = estimateTransferProgress(
    session.targetPackets,
    usefulSymbols,
    elapsedSeconds,
    rank
  );
  const percent = Math.min(98, Math.max(0, estimate.fraction * 100));
  progressBar.style.width = `${percent}%`;
  progressTrack.setAttribute("aria-valuenow", String(Math.round(percent)));
  progressLabel.textContent = `${Math.floor(percent)}%`;
  sizeLabel.textContent = formatBytes(session.totalLen);
  etaLabel.textContent = estimate.etaSeconds === undefined ? "" : `${formatDuration(estimate.etaSeconds)} left`;
  const liveKbs = usefulSymbols * session.sourceBlockSize / 1024 / elapsedSeconds;
  speedValue.textContent = usefulSymbols >= 2 ? `${liveKbs.toFixed(liveKbs >= 10 ? 0 : 1)} KB/s` : "👂";
  codingLabel.textContent = transportName(session.mode);
  setReceiveState("Receiving");
}

function completeReceiveUi(session, file) {
  const elapsedSeconds = Math.max(1e-3, (performance.now() - session.startedAt) / 1000);
  const goodput = completedGoodputKbs(file.bytes.length, elapsedSeconds);
  progressBar.classList.add("finalizing");
  progressBar.style.width = "100%";
  progressTrack.setAttribute("aria-valuenow", "100");
  receivePrompt.hidden = true;
  completeLabel.style.display = "block";
  progressLabel.hidden = true;
  sizeLabel.textContent = formatBytes(file.bytes.length);
  etaLabel.textContent = "";
  codingLabel.textContent = transportName(session.mode);
  speedValue.textContent = `${goodput.toFixed(goodput >= 10 ? 0 : 1)} KB/s`;
}

function failReceiveUi(message) {
  progressBar.classList.add("error");
  setReceiveState(message, true);
  speedValue.textContent = "—";
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
    resetReceiveUi();
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
  if (container.length > MAX_AUDIO_BYTES) {
    resetSendUi();
    setStatus(`Audio is limited to ${formatBytes(MAX_AUDIO_BYTES)}.`, true);
    return;
  }
  try {
    const mode = selectAudioTransport(container.length);
    if (mode === "raptorq") await prepareRaptorQ();
    const AudioContextType = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextType) throw new Error("Web Audio is not available in this browser.");
    const context = new AudioContextType({ latencyHint: "playback" });
    await context.resume();
    const encoder = new TransportEncoder(container, AUDIO_BLOCK_SIZE, mode);
    const session = {
      context,
      encoder,
      mode,
      payloadId: fnv1a(container),
      totalLen: container.length,
      ordinal: 0,
      source: null,
      stopped: false
    };
    sendSession = session;
    sendInputs.hidden = true;
    sendActive.hidden = false;
    fileInput.disabled = true;
    sendTextButton.disabled = true;
    setStatus(`Sending ${label} · ${transportName(mode)} · ~${AUDIO_ESTIMATED_KBPS.toFixed(1)} KB/s`);
    void requestScreenWakeLock();

    while (sendSession === session && !session.stopped) {
      const frames = [];
      for (let i = 0; i < 4; i++) {
        const encodingId = scheduledEncodingId(session.encoder.k, session.ordinal++);
        const block = session.encoder.encode(encodingId);
        frames.push(modulateAudioPacket(
          session.payloadId,
          session.totalLen,
          session.mode,
          encodingId,
          block
        ));
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
  setStatus("Preparing…");
  try {
    const packed = await packSnippet(textInput.value);
    await startSending(packed.container, "text");
  } catch (error) {
    setStatus(error?.message || "Could not prepare that text.", true);
  }
}

async function acceptPacket(session, frame) {
  if (receiveSession !== session || session.finishing) return;
  const identity = `${frame.payloadId}:${frame.totalLen}:${frame.blockSize}:${frame.mode}`;
  if (identity !== session.identity) {
    session.decoder?.free?.();
    const k = sourceBlockCount(frame.totalLen, frame.mode);
    if (codingMode(k) !== frame.mode) return;
    if (frame.mode === "raptorq") await prepareRaptorQ();
    if (receiveSession !== session || session.finishing) return;
    session.decoder = new TransportDecoder(k, frame.blockSize, frame.totalLen);
    session.identity = identity;
    session.payloadId = frame.payloadId;
    session.totalLen = frame.totalLen;
    session.mode = frame.mode;
    session.sourceBlockSize = sourceBlockSize(frame.mode);
    session.targetPackets = k;
    session.startedAt = performance.now();
    sizeLabel.textContent = formatBytes(frame.totalLen);
    codingLabel.textContent = transportName(frame.mode);
  }

  session.decoder.addFrame(frame.encodingId, frame.block);
  updateReceiveProgress(session);
  if (!session.decoder.isComplete) return;
  const recovered = session.decoder.assemble();
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
    completeReceiveUi(session, file);
    await showReceivedResult(file);
  } catch (error) {
    session.finishing = false;
    failReceiveUi(error?.message || "Audio receive failed.");
  }
}

async function startListening() {
  stopSender(false);
  await stopReceiver(false);
  clearResult();
  resetReceiveUi("Starting microphone…");
  try {
    const session = {
      receiver: null,
      decoder: null,
      identity: "",
      payloadId: 0,
      totalLen: 0,
      mode: "",
      sourceBlockSize: AUDIO_BLOCK_SIZE,
      targetPackets: 0,
      startedAt: 0,
      finishing: false,
      queue: Promise.resolve()
    };
    const receiver = new AcousticReceiver(
      (frame) => {
        session.queue = session.queue.then(() => acceptPacket(session, frame)).catch((error) => {
          if (receiveSession === session) failReceiveUi(error?.message || "Audio receive failed.");
        });
      },
      () => {
        if (receiveSession === session && !session.identity) setReceiveState("Signal found…");
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
    setReceiveState("Listening…");
    void requestScreenWakeLock();
  } catch (error) {
    if (receiveSession) await stopReceiver(false);
    listenButton.textContent = "Listen";
    failReceiveUi(error?.name === "NotAllowedError" ? "Microphone permission is required." : error?.message || "Could not start the microphone.");
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
  status.hidden = mode === "receive";
  resetSendUi();
  listenButton.textContent = "Listen";
  resetReceiveUi();
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
      resetReceiveUi("Stopped");
    });
  }
});

void setMode("send");
