import QRCode from "../vendor/qrcode.js";
import { rasterizeQr } from "../shared/qr-raster.js";
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
const directionChooser = document.querySelector(".audio-mode-switch");
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
const receiverLinkDialog = document.getElementById("receiver-link-dialog");
const receiverLinkQrLarge = document.getElementById("receiver-link-qr-large");
const receiverLinkUrl = document.getElementById("receiver-link-url");
const headerReceiverQr = document.getElementById("receiver-link-qr");

let currentMode = null;
let sendSession = null;
let receiveSession = null;
let visualizerFrame = 0;
let visualizerCanvas = null;
let visualizerAnalyser = null;
let visualizerSignal = false;
let smoothedBars = new Float32Array(48);
let audioDialogActive = false;

audioView.classList.remove("audio-shell");
audioView.style.width = "100%";
directionChooser.hidden = true;
legacyProgress.hidden = true;
status.hidden = true;
sendPane.hidden = true;
receivePane.hidden = true;
result.remove();

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
  status.hidden = currentMode !== "send" || !text;
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

function receiverUrl(audio = false) {
  const fallback = audio ? "https://farzher.github.io/AirGapper/?a" : "https://farzher.github.io/AirGapper/?r";
  try {
    const url = new URL(headerReceiverQr?.dataset.receiverUrl || fallback);
    url.search = audio ? "?a" : "?r";
    url.hash = "";
    return url.href;
  } catch {
    return fallback;
  }
}
function renderDialogQr(url) {
  const qr = QRCode.create(url, { errorCorrectionLevel: "L" });
  const raster = rasterizeQr(qr.modules.size, qr.modules.data, 4);
  const dpr = window.devicePixelRatio || 1;
  const scale = Math.max(1, Math.round(240 * dpr / raster.size));
  const source = document.createElement("canvas");
  source.width = source.height = raster.size;
  source.getContext("2d").putImageData(
    new ImageData(new Uint8ClampedArray(raster.pixels.buffer), raster.size, raster.size),
    0,
    0
  );
  receiverLinkQrLarge.width = receiverLinkQrLarge.height = raster.size * scale;
  receiverLinkQrLarge.style.width = receiverLinkQrLarge.style.height = `${receiverLinkQrLarge.width / dpr}px`;
  receiverLinkQrLarge.style.imageRendering = "pixelated";
  const ctx = receiverLinkQrLarge.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, receiverLinkQrLarge.width, receiverLinkQrLarge.height);
  ctx.drawImage(source, 0, 0, receiverLinkQrLarge.width, receiverLinkQrLarge.height);
  receiverLinkUrl.href = url;
  try {
    const parsed = new URL(url);
    receiverLinkUrl.textContent = `${parsed.host}${parsed.pathname.replace(/\/$/, "")}${parsed.search}`;
  } catch {
    receiverLinkUrl.textContent = url.replace(/^https?:\/\//, "");
  }
}
function openAudioReceiverQr() {
  audioDialogActive = true;
  renderDialogQr(receiverUrl(true));
  receiverLinkDialog.showModal();
}
receiverLinkDialog.addEventListener("close", () => {
  if (!audioDialogActive) return;
  audioDialogActive = false;
  renderDialogQr(receiverUrl(false));
});

function makePreviewCanvas(label) {
  const zone = document.createElement("div");
  zone.className = "preview-zone";
  const preview = document.createElement("div");
  preview.className = "preview receive-card";
  preview.style.minHeight = "clamp(220px, 45dvh, 440px)";
  preview.style.background = "var(--card)";
  preview.style.border = "1px solid var(--line)";
  preview.style.borderRadius = "14px";
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", label);
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  preview.append(canvas);
  zone.append(preview);
  return { zone, canvas };
}
function resizeVisualizer(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    smoothedBars = new Float32Array(48);
  }
  return { width, height, dpr };
}
function drawVisualizer(canvas, analyser = null, signal = false, idle = false) {
  if (!canvas?.isConnected) return;
  const { width, height, dpr } = resizeVisualizer(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const styles = getComputedStyle(document.documentElement);
  const ink = styles.getPropertyValue(signal ? "--good" : "--ink").trim() || "#171717";
  const muted = styles.getPropertyValue("--line").trim() || "#e7e7e3";
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = styles.getPropertyValue("--card").trim() || "#fff";
  ctx.fillRect(0, 0, width, height);
  const bars = smoothedBars.length;
  let bins = null;
  if (analyser) {
    bins = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(bins);
  }
  const padding = 24 * dpr;
  const availableWidth = Math.max(1, width - padding * 2);
  const gap = Math.max(2 * dpr, availableWidth / bars * 0.26);
  const barWidth = Math.max(2 * dpr, (availableWidth - gap * (bars - 1)) / bars);
  const center = height * 0.5;
  const maxHalf = Math.max(12 * dpr, height * 0.34);
  ctx.fillStyle = muted;
  ctx.globalAlpha = 0.65;
  ctx.fillRect(padding, center - 0.5 * dpr, availableWidth, dpr);
  ctx.globalAlpha = 1;
  for (let i = 0; i < bars; i++) {
    let target = idle ? 0.025 + 0.012 * Math.sin(performance.now() / 700 + i * 0.55) : 0.018;
    if (bins?.length) {
      const t = i / Math.max(1, bars - 1);
      const index = Math.min(bins.length - 1, Math.round((0.025 + Math.pow(t, 1.45) * 0.86) * bins.length));
      target = Math.pow(bins[index] / 255, 1.3);
    }
    smoothedBars[i] = smoothedBars[i] * 0.77 + target * 0.23;
    const half = Math.max(1.2 * dpr, smoothedBars[i] * maxHalf);
    const x = padding + i * (barWidth + gap);
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.22 + Math.min(0.78, smoothedBars[i] * 1.7);
    const radius = Math.min(barWidth / 2, 3 * dpr);
    ctx.beginPath();
    ctx.roundRect(x, center - half, barWidth, half * 2, radius);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
function stopVisualizer() {
  cancelAnimationFrame(visualizerFrame);
  visualizerFrame = 0;
  visualizerCanvas = null;
  visualizerAnalyser = null;
  visualizerSignal = false;
}
function startVisualizer(canvas, analyser = null, signal = false) {
  stopVisualizer();
  visualizerCanvas = canvas;
  visualizerAnalyser = analyser;
  visualizerSignal = signal;
  const tick = () => {
    if (!visualizerCanvas?.isConnected) return;
    drawVisualizer(visualizerCanvas, visualizerAnalyser, visualizerSignal, !visualizerAnalyser);
    visualizerFrame = requestAnimationFrame(tick);
  };
  tick();
}
function setVisualizerAnalyser(analyser) {
  visualizerAnalyser = analyser;
}
function setVisualizerSignal(active) {
  visualizerSignal = active;
}

// Receive -------------------------------------------------------------------
const STATS_WINDOW_MS = 1000;
const STATS_TICK_MS = 200;
function pruneTimestampSamples(samples, cutoff) {
  let count = 0;
  while (count < samples.length && samples[count] < cutoff) count++;
  if (count) samples.splice(0, count);
}
function stopReceiveStats(session) {
  if (!session?.statsTimer) return;
  clearInterval(session.statsTimer);
  session.statsTimer = 0;
}
function liveGoodputKbs(session, now) {
  pruneTimestampSamples(session.usefulFrameTimes, now - STATS_WINDOW_MS);
  if (!session.decoder || !session.usefulFrameTimes.length) return 0;
  return session.usefulFrameTimes.length * session.sourceBlockSize / 1024 / (STATS_WINDOW_MS / 1000);
}

receivePane.replaceChildren();
receivePane.className = "receiver-primary";
listenButton.textContent = "Enable microphone";
listenButton.className = "enable-camera";
listenButton.hidden = false;
const receivePreview = makePreviewCanvas("Live audio level visualizer");
const receivePanel = document.createElement("section");
receivePanel.className = "transfer-panel";
receivePanel.setAttribute("aria-live", "polite");
receivePanel.hidden = false;
const receiveProgress = document.createElement("div");
receiveProgress.className = "transfer-progress";
const receiveSummary = document.createElement("div");
receiveSummary.className = "transfer-summary";
const receivePrompt = document.createElement("span");
receivePrompt.className = "settings-prompt";
receivePrompt.style.paddingLeft = "0";
receivePrompt.hidden = true;
const receiveState = document.createElement("span");
receivePrompt.append(receiveState);
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
receiveMeta.append(receiveEstimate);
receiveProgress.append(receiveSummary, progressTrack, receiveMeta);
receivePanel.append(receiveProgress);
receivePane.append(listenButton, receivePreview.zone, result, receivePanel);

function resetReceiveUi() {
  receivePanel.hidden = false;
  receivePrompt.hidden = true;
  receiveState.textContent = "";
  completeLabel.style.display = "";
  speedValue.textContent = "👂";
  progressLabel.hidden = false;
  progressLabel.textContent = "0%";
  sizeLabel.textContent = "";
  etaLabel.textContent = "";
  progressBar.classList.remove("finalizing", "error");
  progressBar.style.width = "0%";
  progressTrack.setAttribute("aria-valuenow", "0");
  listenButton.textContent = "Enable microphone";
  listenButton.hidden = false;
  receivePreview.zone.hidden = false;
  drawVisualizer(receivePreview.canvas, null, false, true);
}
function updateReceiveProgress(session, now = performance.now()) {
  if (receiveSession !== session || session.finishing || !session.identity || !session.startedAt || !session.decoder) return;
  const elapsedSeconds = Math.max(1e-3, (now - session.startedAt) / 1000);
  const rank = session.decoder.solvedCount;
  const usefulSymbols = session.decoder.usefulSymbols;
  const estimate = estimateTransferProgress(session.targetPackets, usefulSymbols, elapsedSeconds, rank);
  const percent = Math.min(98, Math.max(0, estimate.fraction * 100));
  progressBar.style.width = `${percent}%`;
  progressTrack.setAttribute("aria-valuenow", String(Math.round(percent)));
  progressLabel.textContent = `${Math.floor(percent)}%`;
  const remainingBytes = Math.max(1, Math.ceil(session.totalLen * (1 - estimate.fraction)));
  sizeLabel.textContent = formatBytes(remainingBytes);
  const liveKbs = liveGoodputKbs(session, now);
  const liveUsefulFps = liveKbs > 0 ? liveKbs * 1024 / session.sourceBlockSize : 0;
  etaLabel.textContent = liveUsefulFps > 0 && usefulSymbols >= 3
    ? `${formatDuration(estimate.remainingFrames / liveUsefulFps)} left`
    : "";
  speedValue.textContent = `${liveKbs.toFixed(1)} KB/s`;
}
function completeReceiveUi(session, file) {
  receivePanel.hidden = false;
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
  speedValue.textContent = `${goodput.toFixed(1)} KB/s`;
  receivePreview.zone.hidden = true;
  stopVisualizer();
}
async function failReceiveSession(session, message) {
  stopReceiveStats(session);
  if (receiveSession === session) receiveSession = null;
  try { session.decoder?.free?.(); } catch {}
  try { session.analyser?.disconnect(); } catch {}
  try { await session.receiver?.stop?.(); } catch {}
  releaseScreenWakeLock();
  showReceiveError(message);
}
function showReceiveError(message) {
  clearResult();
  const error = document.createElement("p");
  error.className = "failed";
  error.textContent = message;
  result.append(error);
  listenButton.textContent = "Enable microphone";
  listenButton.hidden = false;
  receivePanel.hidden = false;
  speedValue.textContent = "—";
  setVisualizerAnalyser(null);
  setVisualizerSignal(false);
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
    session.usefulFrameTimes.length = 0;
    sizeLabel.textContent = formatBytes(frame.totalLen);
  }
  const usefulBefore = session.decoder.usefulSymbols;
  session.decoder.addFrame(frame.encodingId, frame.block);
  const now = performance.now();
  if (session.decoder.usefulSymbols > usefulBefore) session.usefulFrameTimes.push(now);
  updateReceiveProgress(session, now);
  if (!session.decoder.isComplete) return;
  const recovered = session.decoder.assemble();
  if (!recovered) return;
  session.finishing = true;
  stopReceiveStats(session);
  try {
    if (fnv1a(recovered) !== session.payloadId) throw new Error("Recovered audio data did not verify.");
    const file = await unpackFile(recovered);
    if (!await verifyFile(file)) throw new Error("Received file did not verify.");
    await session.receiver.stop();
    session.decoder.free();
    if (receiveSession === session) receiveSession = null;
    releaseScreenWakeLock();
    completeReceiveUi(session, file);
    await showReceivedResult(file);
  } catch (error) {
    session.finishing = false;
    await failReceiveSession(session, error?.message || "Audio receive failed.");
  }
}
async function stopReceiver(reset = true) {
  const session = receiveSession;
  receiveSession = null;
  if (session) {
    stopReceiveStats(session);
    session.decoder?.free?.();
    try { session.analyser?.disconnect(); } catch {}
    await session.receiver.stop();
  }
  if (reset) resetReceiveUi();
  releaseScreenWakeLock();
}
async function startListening() {
  stopSender(false);
  await stopReceiver(false);
  clearResult();
  receivePanel.hidden = false;
  listenButton.hidden = true;
  startVisualizer(receivePreview.canvas, null, false);
  try {
    const session = {
      receiver: null,
      analyser: null,
      decoder: null,
      identity: "",
      payloadId: 0,
      totalLen: 0,
      mode: "",
      sourceBlockSize: AUDIO_BLOCK_SIZE,
      targetPackets: 0,
      startedAt: 0,
      usefulFrameTimes: [],
      statsTimer: 0,
      finishing: false,
      queue: Promise.resolve()
    };
    const receiver = new AcousticReceiver(
      (frame) => {
        session.queue = session.queue.then(() => acceptPacket(session, frame)).catch((error) => {
          if (receiveSession === session) void failReceiveSession(session, error?.message || "Audio receive failed.");
        });
      },
      () => {
        if (receiveSession === session) {
          setVisualizerSignal(true);
          setTimeout(() => {
            if (receiveSession === session && !session.identity) setVisualizerSignal(false);
          }, 240);
        }
      }
    );
    session.receiver = receiver;
    receiveSession = session;
    await receiver.start();
    if (receiveSession !== session) {
      await receiver.stop();
      return;
    }
    const analyser = receiver.context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.78;
    receiver.source.connect(analyser);
    session.analyser = analyser;
    setVisualizerAnalyser(analyser);
    session.statsTimer = setInterval(() => updateReceiveProgress(session), STATS_TICK_MS);
    void requestScreenWakeLock();
  } catch (error) {
    if (receiveSession) await stopReceiver(false);
    showReceiveError(error?.name === "NotAllowedError" ? "Microphone permission is required." : error?.message || "Could not start the microphone.");
  }
}

// Send ----------------------------------------------------------------------
const sendPreview = makePreviewCanvas("Audio output visualizer");
sendActive.className = "";
sendActive.replaceChildren();
sendActive.style.width = "100%";
sendActive.append(sendPreview.zone);
const sendToolbar = document.createElement("div");
sendToolbar.className = "send-toolbar";
sendToolbar.style.gridTemplateColumns = "repeat(3, minmax(0, 1fr))";
const settingsButton = document.createElement("button");
settingsButton.type = "button";
settingsButton.className = "secondary-button send-toolbar-button";
settingsButton.textContent = "Settings";
settingsButton.setAttribute("aria-expanded", "false");
const receiverQrButton = document.createElement("button");
receiverQrButton.type = "button";
receiverQrButton.className = "secondary-button send-toolbar-button";
receiverQrButton.textContent = "Receive QR";
stopSendButton.className = "secondary-button send-toolbar-button";
stopSendButton.textContent = "Stop";
const settingsPanel = document.createElement("div");
settingsPanel.className = "send-settings-panel";
settingsPanel.hidden = true;
const settingsGrid = document.createElement("div");
settingsGrid.className = "send-settings-grid";
const volumeLabel = document.createElement("label");
const volumeTitle = document.createElement("span");
volumeTitle.textContent = "Volume";
const volumeInput = document.createElement("input");
volumeInput.type = "range";
volumeInput.min = "20";
volumeInput.max = "100";
volumeInput.step = "5";
volumeInput.value = "100";
volumeInput.setAttribute("aria-label", "Audio output volume");
const volumeValue = document.createElement("span");
volumeValue.style.fontSize = "11px";
volumeValue.style.textTransform = "none";
volumeValue.style.letterSpacing = "0";
volumeLabel.append(volumeTitle, volumeInput, volumeValue);
settingsGrid.append(volumeLabel);
settingsPanel.append(settingsGrid);
sendToolbar.append(settingsButton, receiverQrButton, stopSendButton, settingsPanel);
sendActive.append(sendToolbar);

const VOLUME_KEY = "airgapper:audio-volume:v1";
try {
  const saved = Number(localStorage.getItem(VOLUME_KEY));
  if (Number.isFinite(saved) && saved >= 20 && saved <= 100) volumeInput.value = String(saved);
} catch {}
function syncVolume() {
  const percent = Math.max(20, Math.min(100, Number(volumeInput.value) || 100));
  volumeValue.textContent = `${percent}%`;
  if (sendSession?.gain) sendSession.gain.gain.setTargetAtTime(percent / 100, sendSession.context.currentTime, 0.015);
  try { localStorage.setItem(VOLUME_KEY, String(percent)); } catch {}
}
syncVolume();
volumeInput.addEventListener("input", syncVolume);
settingsButton.addEventListener("click", () => {
  settingsPanel.hidden = !settingsPanel.hidden;
  settingsButton.setAttribute("aria-expanded", String(!settingsPanel.hidden));
});
receiverQrButton.addEventListener("click", openAudioReceiverQr);
function resetSendUi() {
  sendInputs.hidden = false;
  sendActive.hidden = true;
  fileInput.disabled = false;
  sendTextButton.disabled = false;
  settingsPanel.hidden = true;
  settingsButton.setAttribute("aria-expanded", "false");
  stopVisualizer();
}
function cleanupSendSession(session) {
  if (!session) return;
  session.stopped = true;
  try { session.source?.stop(); } catch {}
  try { session.source?.disconnect(); } catch {}
  try { session.analyser?.disconnect(); } catch {}
  try { session.gain?.disconnect(); } catch {}
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
  source.connect(session.analyser);
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
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    const gain = context.createGain();
    gain.gain.value = Math.max(0.2, Math.min(1, Number(volumeInput.value) / 100));
    analyser.connect(gain);
    gain.connect(context.destination);
    const session = {
      context,
      encoder,
      analyser,
      gain,
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
    setStatus(`Sending ${label} · ~${AUDIO_ESTIMATED_KBPS.toFixed(1)} KB/s`);
    startVisualizer(sendPreview.canvas, analyser, true);
    void requestScreenWakeLock();
    while (sendSession === session && !session.stopped) {
      const frames = [];
      for (let i = 0; i < 4; i++) {
        const encodingId = scheduledEncodingId(session.encoder.k, session.ordinal++);
        const block = session.encoder.encode(encodingId);
        frames.push(modulateAudioPacket(session.payloadId, session.totalLen, session.mode, encodingId, block));
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

// Navigation ----------------------------------------------------------------
async function setMode(mode) {
  if (mode !== "send" && mode !== "receive") return;
  await stopAll(false);
  currentMode = mode;
  audioView.classList.toggle("receiver-shell", mode === "receive");
  document.body.classList.toggle("receive-mode", mode === "receive");
  directionChooser.hidden = true;
  sendPane.hidden = mode !== "send";
  receivePane.hidden = mode !== "receive";
  status.hidden = mode === "receive";
  clearResult();
  setStatus("");
  resetSendUi();
  resetReceiveUi();
  if (mode === "receive") void startListening();
  else if (!matchMedia("(pointer: coarse)").matches) textInput.focus({ preventScroll: true });
}

sendTextButton.addEventListener("click", () => void sendText());
fileInput.addEventListener("change", () => void sendFile(fileInput.files?.[0]));
stopSendButton.addEventListener("click", () => stopSender(true));
listenButton.addEventListener("click", () => {
  if (!receiveSession) void startListening();
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

window.addEventListener("airgapper:audio-direction", (event) => {
  const direction = event.detail?.direction;
  if (direction === "send" || direction === "receive") void setMode(direction);
});
window.addEventListener("resize", () => {
  if (visualizerCanvas) drawVisualizer(visualizerCanvas, visualizerAnalyser, visualizerSignal, !visualizerAnalyser);
});
window.addEventListener("airgapper:leave-mode", () => {
  if (!audioView.classList.contains("active") && !sendSession && !receiveSession) return;
  void stopAll(false).then(() => {
    currentMode = null;
    document.body.classList.remove("receive-mode");
    audioView.classList.remove("receiver-shell");
    sendPane.hidden = true;
    receivePane.hidden = true;
    status.hidden = true;
    stopVisualizer();
  });
});
window.addEventListener("airgapper:pause-mode", () => {
  if (!audioView.classList.contains("active") || !currentMode) return;
  void stopAll(false).then(() => {
    if (currentMode === "send") resetSendUi();
    if (currentMode === "receive") resetReceiveUi();
  });
});
window.addEventListener("airgapper:resume-mode", () => {
  if (!audioView.classList.contains("active")) return;
  if (currentMode === "receive" && !receiveSession) void startListening();
});