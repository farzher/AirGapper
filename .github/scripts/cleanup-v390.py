from pathlib import Path


def replace_one(text, old, new, label):
    if old not in text:
        raise SystemExit(f"missing {label}")
    return text.replace(old, new, 1)

# shared/protocol.js: stream gzip output directly into its declared final buffer
# instead of retaining every decompressed chunk and then copying the whole file.
p = Path("shared/protocol.js")
s = p.read_text()
old = '''async function gunzipAsync(bytes, maxBytes) {
  const inflated = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = inflated.getReader();
  const chunks = [];
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("The recovered file expands past its declared length.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}'''
new = '''async function gunzipAsync(bytes, maxBytes) {
  const inflated = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = inflated.getReader();
  const out = new Uint8Array(maxBytes);
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > maxBytes) {
      await reader.cancel();
      throw new Error("The recovered file expands past its declared length.");
    }
    out.set(value, total);
    total += value.length;
  }
  if (total !== maxBytes) throw new Error("The decompressed file length does not match its header.");
  return out;
}'''
s = replace_one(s, old, new, "streaming gunzip")
p.write_text(s)

# shared/transport.js: free large JS references deterministically as well as WASM.
p = Path("shared/transport.js")
s = p.read_text()
s = replace_one(s, '''  free() {
    this.raptor?.free();
    this.mdsCache = null;
  }
}''', '''  free() {
    this.raptor?.free();
    this.raptor = null;
    this.mdsCache = null;
    this.byteBlocks = null;
  }
}''', "encoder free")
s = replace_one(s, '''  free() {
    this.raptor?.free();
  }
}''', '''  free() {
    this.raptor?.free();
    this.raptor = null;
    this.raptorPayload = null;
    this.seen.clear();
    this.mdsBasis.length = 0;
    this.mdsBlocks = null;
  }
}''', "decoder free")
p.write_text(s)

# receive/main.js: lazy dev-only AGCAP, remove dead timeline collection, release
# completed decoder state before file verification, and keep exactly one Blob per
# received file in normal browser mode.
p = Path("receive/main.js")
s = p.read_text()
s = replace_one(s,
'''import { AgcapCorpus, AgcapRecorder, copyVideoFrameY, yToImageData } from "./agcap.js";
const RECEIVER_RUNTIME_BUILD = window.AIRGAPPER_BUILD || "dev";''',
'''let agcapModulePromise;
function loadAgcap() {
  if (!agcapModulePromise) agcapModulePromise = import("./agcap.js");
  return agcapModulePromise;
}
const RECEIVER_RUNTIME_BUILD = window.AIRGAPPER_BUILD || "dev";''',
"lazy agcap import")
s = replace_one(s,
'''    // auto-phase reads controls created by phase-nudge, so preserve order.
    receiverDevToolsPromise = import("./phase-nudge.js").then(() => import("./auto-phase.js"));''',
'''    // auto-phase reads controls created by phase-nudge, so preserve order.
    // AGCAP is developer/benchmark tooling too; normal receivers never fetch it.
    receiverDevToolsPromise = Promise.all([
      import("./phase-nudge.js").then(() => import("./auto-phase.js")),
      loadAgcap()
    ]);''',
"dev tools lazy bundle")
s = replace_one(s,
'''async function captureDirectSourceScan(source) {
  if (!captureNextScan || pendingScanCapture || !source.videoFrame || source.image) return;
  try {
    const captured = await copyVideoFrameY(source.videoFrame);''',
'''async function captureDirectSourceScan(source) {
  if (!captureNextScan || pendingScanCapture || !source.videoFrame || source.image) return;
  try {
    const { copyVideoFrameY, yToImageData } = await loadAgcap();
    const captured = await copyVideoFrameY(source.videoFrame);''',
"scan capture agcap")
s = replace_one(s,
'''function freezeCompletionDiagnostics() {
  if (completionDiagnosticsText) return;''',
'''function freezeCompletionDiagnostics() {
  if (completionDiagnosticsText || !developerModeEverUsed) return;''',
"completion diagnostics gate")
s = replace_one(s,
'''let cameraStartedTs = 0;
const timeline = [];
const TIMELINE_MAX_SAMPLES = 2400;
const regions = [];''',
'''let cameraStartedTs = 0;
const regions = [];''',
"dead timeline declaration")
s = s.replace('  timeline.length = 0;\n', '', 1)
old_timeline = '''  const elapsed = (now - startTs) / 1e3;
  const activeGrid = regions.filter((region) => region.gridSlot !== void 0 && region.slotState === "ACTIVE");
  const liveNow = gridLattice.active ? activeGrid.filter((region) => region.decoded).length : decodedCount();
  if (timeline.length < TIMELINE_MAX_SAMPLES) {
    timeline.push([
      Number(elapsed.toFixed(1)),
      decoder.framesNew,
      decoder.solvedCount,
      liveNow,
      regions.length,
      Number(cameraRate.toFixed(1)),
      Number(qrRate.toFixed(1)),
      fullScans
    ]);
  }
'''
s = replace_one(s, old_timeline, '', "dead timeline sampling")
s = replace_one(s,
'''  const payload = completingDecoder.assemble();
  const ok = fnv1a(payload) === payloadId;
  await finish(payload, ok, transferSeconds);''',
'''  let payload;
  try {
    payload = completingDecoder.assemble();
  } finally {
    // Assembly owns its returned Uint8Array. Decoder/WASM state is no longer
    // useful, so release it before hashing/decompression can raise peak memory.
    completingDecoder.free();
    if (decoder === completingDecoder) decoder = null;
  }
  const ok = fnv1a(payload) === payloadId;
  await finish(payload, ok, transferSeconds);''',
"early completed decoder release")
# Keep an uncompressed Android payload alive because the native Save handler
# intentionally owns the JS bytes until the user taps the file. Browsers instead
# snapshot one Blob and can wipe/release the transport buffer immediately.
s = replace_one(s,
'''  etaLabel.textContent = `${formatDuration(seconds)} total`;
  try {
    if (!hashOk) throw new Error("The optical stream checksum did not match.");
    const file = await unpackFile(container);''',
'''  etaLabel.textContent = `${formatDuration(seconds)} total`;
  let retainContainer = false;
  try {
    if (!hashOk) throw new Error("The optical stream checksum did not match.");
    const file = await unpackFile(container);''',
"finish retain flag")
s = replace_one(s,
'''    if (!await verifyFile(file)) throw new Error("The recovered file failed SHA-256 verification.");
    if (finishGen !== captureGen) {''',
'''    if (!await verifyFile(file)) throw new Error("The recovered file failed SHA-256 verification.");
    retainContainer = isAndroidApp() && file.compression === "none" && !isSnippet(file);
    if (finishGen !== captureGen) {''',
"android alias retention")
s = replace_one(s,
'''  } finally {
    releaseTransportDecoder();
    container.fill(0);
  }
}''',
'''  } finally {
    releaseTransportDecoder();
    if (!retainContainer) container.fill(0);
  }
}''',
"conditional container wipe")
old_download = '''function downloadLink(name, type, bytes, label = `Save ${name}`) {
  const link = document.createElement("a");
  link.className = "download";
  link.href = receivedObjectUrl(new Blob([bytes], { type }));
  link.download = name;
  link.textContent = label;
  link.addEventListener("click", (event) => {
    if (!saveFileOnAndroid(name, type, bytes)) return;
    event.preventDefault();
  });
  return link;
}'''
new_download = '''function downloadLink(name, type, bytes, label = `Save ${name}`, blobUrl) {
  const link = document.createElement("a");
  link.className = "download";
  link.href = blobUrl || receivedObjectUrl(new Blob([bytes], { type }));
  link.download = name;
  link.textContent = label;
  // Browser downloads only need the Blob URL. Do not close over a 64 MB
  // Uint8Array forever just to discover that the Android bridge is absent.
  if (isAndroidApp()) link.addEventListener("click", (event) => {
    if (!saveFileOnAndroid(name, type, bytes)) return;
    event.preventDefault();
  });
  return link;
}'''
s = replace_one(s, old_download, new_download, "download retention")
s = replace_one(s,
'''  const container = document.createElement("section");
  container.className = "received-file";
  const url = receivedObjectUrl(new Blob([entry.bytes], { type }));''',
'''  const container = document.createElement("section");
  container.className = "received-file";
  const blob = new Blob([entry.bytes], { type });
  const url = receivedObjectUrl(blob);''',
"single received blob")
s = replace_one(s,
'''    const src = await servableMediaUrl(entry.bytes, type, url);''',
'''    const src = await servableMediaUrl(blob, type, url);''',
"media blob reuse")
s = replace_one(s,
'''  const link = downloadLink(entry.name, type, entry.bytes, entry.name);''',
'''  const link = downloadLink(entry.name, type, entry.bytes, entry.name, url);''',
"download blob reuse")
s = replace_one(s,
'''async function servableMediaUrl(bytes, type, blobUrl) {''',
'''async function servableMediaUrl(blob, type, blobUrl) {''',
"servable media signature")
s = replace_one(s,
'''      new Response(new Blob([bytes]), {
        headers: {
          "Content-Type": type,
          "Content-Length": String(bytes.length)
        }
      })''',
'''      new Response(blob, {
        headers: {
          "Content-Type": type,
          "Content-Length": String(blob.size)
        }
      })''',
"servable media blob reuse")
# AGCAP entry points.
s = replace_one(s,
'''recordCorpusBtn.addEventListener("click", () => {''',
'''recordCorpusBtn.addEventListener("click", async () => {''',
"async record corpus")
s = replace_one(s,
'''  const version = (_c = (_b = (_a = document.querySelector(".app-version")) == null ? void 0 : _a.textContent) == null ? void 0 : _b.replace(/^v/, "")) != null ? _c : "unknown";
  benchmarkRecorder = new AgcapRecorder(3e3, {''',
'''  const version = (_c = (_b = (_a = document.querySelector(".app-version")) == null ? void 0 : _a.textContent) == null ? void 0 : _b.replace(/^v/, "")) != null ? _c : "unknown";
  const { AgcapRecorder } = await loadAgcap();
  benchmarkRecorder = new AgcapRecorder(3e3, {''',
"record corpus lazy class")
s = replace_one(s,
'''    if (!benchmarkDialog.open) benchmarkDialog.showModal();
    benchmarkCorpus = await AgcapCorpus.load(file);''',
'''    if (!benchmarkDialog.open) benchmarkDialog.showModal();
    const { AgcapCorpus } = await loadAgcap();
    benchmarkCorpus = await AgcapCorpus.load(file);''',
"load corpus lazy class")
s = replace_one(s,
'''    await new Promise(requestAnimationFrame);
    try {
      benchmarkCorpus = await AgcapCorpus.load(benchmarkPendingBlob);''',
'''    await new Promise(requestAnimationFrame);
    try {
      const { AgcapCorpus } = await loadAgcap();
      benchmarkCorpus = await AgcapCorpus.load(benchmarkPendingBlob);''',
"pending corpus lazy class")
s = replace_one(s,
'''window.__airgapperRunFastRegression = async ({ urls, order, repeats = 1, fps = 30, mode = "performance", cameraPath = false }) => {
  if (!Array.isArray(urls) || !urls.length) throw new Error("Fast regression needs images");''',
'''window.__airgapperRunFastRegression = async ({ urls, order, repeats = 1, fps = 30, mode = "performance", cameraPath = false }) => {
  if (!Array.isArray(urls) || !urls.length) throw new Error("Fast regression needs images");
  const { AgcapCorpus } = await loadAgcap();''',
"fast regression lazy class")
# Guard against accidental remaining static AGCAP identifiers outside the lazy sites.
if 'from "./agcap.js"' in s:
    raise SystemExit("static agcap import remains")
p.write_text(s)

# sw.js: dev/benchmark modules stay available online but are not part of every
# user's production offline install. Core receiver modules remain precached.
p = Path("sw.js")
s = p.read_text()
for entry in [
    '    "./receive/agcap.js",\n',
    '    "./receive/auto-phase.js",\n',
    '    "./receive/auto-phase-policy.js",\n',
    '    "./receive/phase-nudge.js",\n',
]:
    if entry not in s:
        raise SystemExit(f"missing precache entry {entry.strip()}")
    s = s.replace(entry, '', 1)
p.write_text(s)

# version bump
p = Path("version.js")
s = p.read_text()
s = replace_one(s, 'export const APP_VERSION = "0.5.389";', 'export const APP_VERSION = "0.5.390";', "version")
p.write_text(s)
