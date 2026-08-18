from pathlib import Path
import re

def rep(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing anchor {path}: {old[:80]!r}")
    p.write_text(s.replace(old, new, count))

for path, old, new in [
    ('receive/main.js','const RECEIVER_RUNTIME_BUILD = "v0.5.297";','const RECEIVER_RUNTIME_BUILD = "v0.5.298";'),
    ('send/main.js','const SEND_RUNTIME_BUILD = "v0.5.297";','const SEND_RUNTIME_BUILD = "v0.5.298";'),
    ('main.js','const APP_BUILD = "v0.5.297";','const APP_BUILD = "v0.5.298";'),
    ('index.html','main.js?build=v0.5.297','main.js?build=v0.5.298'),
    ('index.html','<span class="brand">AirGapper <span class="app-version">v0.5.297</span></span>','<span class="brand">AirGapper <span class="app-version">v0.5.298</span></span>'),
    ('sw.js','airgapper-static-js-v245','airgapper-static-js-v246'),
    ('index.html','id="record-corpus" type="button">Record</button>','id="record-corpus" type="button">Record raw</button>')
]: rep(path, old, new)

# --- AGCAP v5: exact TrackProcessor luminance ---------------------------------
ag = Path('receive/agcap.js').read_text()
helper_anchor = '''function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}'''
helpers = helper_anchor + '''
const RAW_Y_FORMATS = new Set(["I420", "I420A", "NV12"]);
function normalizedRect(rect, width, height) {
  return {
    x: Math.max(0, Math.round(rect?.x ?? 0)),
    y: Math.max(0, Math.round(rect?.y ?? 0)),
    width: Math.max(1, Math.round(rect?.width ?? width)),
    height: Math.max(1, Math.round(rect?.height ?? height))
  };
}
async function copyVideoFrameY(videoFrame) {
  if (!videoFrame || typeof VideoFrame !== "function") throw new Error("Raw camera capture requires VideoFrame");
  const frame = new VideoFrame(videoFrame);
  try {
    const sourcePixelFormat = String(frame.format ?? "");
    if (!RAW_Y_FORMATS.has(sourcePixelFormat)) throw new Error(`Raw Y capture does not support ${sourcePixelFormat || "unknown"}`);
    const visibleRect = normalizedRect(frame.visibleRect, frame.codedWidth, frame.codedHeight);
    const options = { rect: visibleRect };
    const storage = new Uint8Array(frame.allocationSize(options));
    const layout = await frame.copyTo(storage, options);
    const plane = layout?.[0];
    if (!plane || plane.stride < visibleRect.width) throw new Error("Camera frame has no usable Y plane");
    const y = new Uint8Array(visibleRect.width * visibleRect.height);
    for (let row = 0; row < visibleRect.height; row++) {
      const start = plane.offset + row * plane.stride;
      y.set(storage.subarray(start, start + visibleRect.width), row * visibleRect.width);
    }
    return { y, meta: {
      sourcePixelFormat, codedWidth: frame.codedWidth, codedHeight: frame.codedHeight,
      visibleRect, displayWidth: frame.displayWidth || visibleRect.width,
      displayHeight: frame.displayHeight || visibleRect.height,
      frameTimestamp: Number(frame.timestamp) || 0,
      frameDuration: frame.duration == null ? void 0 : Number(frame.duration),
      rotation: Number(frame.rotation ?? 0) || 0
    }};
  } finally { frame.close(); }
}
function yToImageData(y, width, height) {
  if (y.length !== width * height) throw new Error("Y frame size mismatch");
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, p = 0; i < y.length; i++, p += 4) {
    rgba[p] = rgba[p + 1] = rgba[p + 2] = y[i]; rgba[p + 3] = 255;
  }
  return new ImageData(rgba, width, height);
}
function yRecordToVideoFrame(meta, y) {
  const visibleRect = normalizedRect(meta.visibleRect, meta.width, meta.height);
  const codedWidth = Math.max(visibleRect.x + visibleRect.width, Math.round(meta.codedWidth || meta.width || visibleRect.width));
  const codedHeight = Math.max(visibleRect.y + visibleRect.height, Math.round(meta.codedHeight || meta.height || visibleRect.height));
  if ((codedWidth & 1) || (codedHeight & 1)) throw new Error(`Raw Y replay requires even coded dimensions, got ${codedWidth}×${codedHeight}`);
  if (y.length !== visibleRect.width * visibleRect.height) throw new Error(`Frame ${meta.sequence} raw Y length mismatch`);
  const yBytes = codedWidth * codedHeight;
  const chromaBytes = (codedWidth >> 1) * (codedHeight >> 1);
  const i420 = new Uint8Array(yBytes + chromaBytes * 2);
  i420.fill(255, 0, yBytes); i420.fill(128, yBytes);
  for (let row = 0; row < visibleRect.height; row++) {
    const src = row * visibleRect.width;
    const dst = (visibleRect.y + row) * codedWidth + visibleRect.x;
    i420.set(y.subarray(src, src + visibleRect.width), dst);
  }
  const init = {
    format: "I420", codedWidth, codedHeight, visibleRect,
    displayWidth: Math.max(1, Math.round(meta.displayWidth || meta.width || visibleRect.width)),
    displayHeight: Math.max(1, Math.round(meta.displayHeight || meta.height || visibleRect.height)),
    timestamp: Number.isFinite(meta.frameTimestamp) ? Math.round(meta.frameTimestamp) : Math.max(0, Math.round((Number(meta.mediaTimeMs) || Number(meta.callbackTimeMs) || 0) * 1000))
  };
  if (Number.isFinite(meta.frameDuration) && meta.frameDuration > 0) init.duration = Math.round(meta.frameDuration);
  return new VideoFrame(i420, init);
}'''
if helper_anchor not in ag: raise SystemExit('missing agcap helper anchor')
ag = ag.replace(helper_anchor, helpers, 1)

# Recorder state + bounded copy queue.
ag = ag.replace('''    __publicField(this, "canvas", document.createElement("canvas"));''', '''    __publicField(this, "canvas", document.createElement("canvas"));
    __publicField(this, "pixelFormat");
    __publicField(this, "compression");
    __publicField(this, "storageBytes", 0);''', 1)
ag = ag.replace('''    if (this.pending >= 64) {''', '''    if (this.stopped || this.pending >= 8) {''', 1)

# Allow records to declare their actual stored pixel representation.
ag = ag.replace('''  enqueue(meta, pixels) {
    const metadata = encoder.encode(JSON.stringify(meta));''', '''  enqueue(meta, pixels, pixelFormat = "RGBA8888", compression = "png") {
    if (this.pixelFormat && this.pixelFormat !== pixelFormat) {
      this.pending--; this.drops++; return;
    }
    this.pixelFormat = pixelFormat;
    this.compression = compression;
    const metadata = encoder.encode(JSON.stringify(meta));''', 1)
ag = ag.replace('''    this.stored++;
    this.pending--;
  }
  addVideo(meta, video) {''', '''    this.storageBytes += metadata.length + pixels.byteLength + 8;
    this.stored++;
    this.pending--;
  }
  addFrame(meta, videoFrame, videoFallback) {
    if (videoFrame && typeof VideoFrame === "function") {
      if (!this.begin(meta)) return;
      void copyVideoFrameY(videoFrame).then(({ y, meta: frameMeta }) => {
        const width = frameMeta.visibleRect.width, height = frameMeta.visibleRect.height;
        this.enqueue({ ...meta, ...frameMeta,
          width: meta.width || frameMeta.displayWidth,
          height: meta.height || frameMeta.displayHeight,
          stride: width, yWidth: width, yHeight: height
        }, y, "Y8", "none");
      }).catch(() => { this.pending--; this.drops++; });
      return;
    }
    this.addVideo(meta, videoFallback);
  }
  addVideo(meta, video) {''', 1)

# v5 raw Y header; old canvas/PNG remains v4.
ag = ag.replace('''      formatVersion: 4,
      pixelFormat: "RGBA8888",
      compression: "png",''', '''      formatVersion: this.pixelFormat === "Y8" ? 5 : 4,
      pixelFormat: this.pixelFormat || "RGBA8888",
      compression: this.compression || "png",
      capturePath: this.pixelFormat === "Y8" ? "TrackProcessor VideoFrame exact Y plane" : "video canvas RGBA fallback",''', 1)
ag = ag.replace('''      estimatedCameraDrops: Math.max(0, expectedCallbacks - this.callbacks)''', '''      estimatedCameraDrops: Math.max(0, expectedCallbacks - this.callbacks),
      storageBytes: this.storageBytes''', 1)

# Loader accepts old RGBA corpora and new v5 Y8 corpora.
ag = ag.replace('''    if (![1, 2, 3, 4].includes(header.formatVersion) || header.pixelFormat !== "RGBA8888") {
      throw new Error("Unsupported AirGapper capture");
    }''', '''    const supported = header.pixelFormat === "RGBA8888"
      ? [1, 2, 3, 4].includes(header.formatVersion)
      : header.pixelFormat === "Y8" && header.formatVersion === 5;
    if (!supported) throw new Error("Unsupported AirGapper capture");''', 1)

# Expose raw records and recreate a VideoFrame with original coded/visible geometry.
frame_anchor = '''  async frame(index) {
    const record = this.records[index];'''
frame_new = '''  raw(index) {
    const record = this.records[index];
    if (this.header.pixelFormat !== "Y8") return null;
    const width = record.meta.yWidth || record.meta.visibleRect?.width || record.meta.width;
    const height = record.meta.yHeight || record.meta.visibleRect?.height || record.meta.height;
    if (record.pixels.length !== width * height) throw new Error(`Frame ${record.meta.sequence} raw Y length mismatch`);
    return { meta: record.meta, y: record.pixels };
  }
  videoFrame(index) {
    const raw = this.raw(index);
    return raw ? yRecordToVideoFrame(raw.meta, raw.y) : null;
  }
  async frame(index) {
    const record = this.records[index];
    if (this.header.pixelFormat === "Y8") {
      const raw = this.raw(index);
      const width = raw.meta.yWidth || raw.meta.visibleRect?.width || raw.meta.width;
      const height = raw.meta.yHeight || raw.meta.visibleRect?.height || raw.meta.height;
      return { meta: raw.meta, y: raw.y, rgba: yToImageData(raw.y, width, height).data };
    }'''
if frame_anchor not in ag: raise SystemExit('missing agcap frame anchor')
ag = ag.replace(frame_anchor, frame_new, 1)
ag = ag.replace('''  AgcapCorpus,
  AgcapRecorder
};''', '''  AgcapCorpus,
  AgcapRecorder,
  copyVideoFrameY,
  yToImageData
};''', 1)
Path('receive/agcap.js').write_text(ag)

# --- Receiver integration ------------------------------------------------------
rep('receive/main.js', 'import { AgcapCorpus, AgcapRecorder } from "./agcap.js";', 'import { AgcapCorpus, AgcapRecorder, copyVideoFrameY, yToImageData } from "./agcap.js";')
main = Path('receive/main.js').read_text()
pat = re.compile(r'recorder\.addVideo\(\{\n\s*sequence: frame\.sequence,[\s\S]*?\n\s*orientation\n\s*\}, video\);')
main, n = pat.subn(lambda m: m.group(0).replace('recorder.addVideo(', 'recorder.addFrame(').replace('}, video);', '}, frame.videoFrame, video);'), main, count=1)
if n != 1: raise SystemExit(f'raw recorder call patch count {n}')
main = main.replace('new AgcapRecorder(7e3, {', 'new AgcapRecorder(3e3, {', 1)
main = main.replace('recordCorpusBtn.textContent = "Stop · 7s";', 'recordCorpusBtn.textContent = "Stop · 3s";', 1)
main = main.replace('setStatus("Recording lossless frames… decoding paused");', 'setStatus("Recording exact raw camera Y frames… decoder paused");', 1)
main = main.replace('`${benchmarkCorpus.length} frames · ${benchmarkCorpus.header.width}×${benchmarkCorpus.header.height} RGBA · ${benchmarkCorpus.header.recorderDrops} recorder drops`', '`${benchmarkCorpus.length} frames · ${benchmarkCorpus.header.width}×${benchmarkCorpus.header.height} ${benchmarkCorpus.header.pixelFormat} · ${benchmarkCorpus.header.recorderDrops} recorder drops`', 1)

# Capture button: snapshot the same TrackProcessor frame instead of disabling it.
anchor = '''function cancelScanCapture() {
  clearTimeout(scanCaptureTimer);'''
helper = '''async function captureDirectSourceScan(source) {
  if (!captureNextScan || pendingScanCapture || !source.videoFrame || source.image) return;
  try {
    const captured = await copyVideoFrameY(source.videoFrame);
    const width = captured.meta.visibleRect.width, height = captured.meta.visibleRect.height;
    pendingScanCapture = {
      image: yToImageData(captured.y, width, height), ox: 0, oy: 0,
      full: !gridLattice.locked,
      tracks: gridLattice.locked ? regions.filter((region) => validQuadObject(region.quad)).map((region) => region.quad) : [],
      scaleX: source.width / width, scaleY: source.height / height, rawY: true
    };
    scanDialogStatus.textContent = `Captured exact camera Y frame ${width}×${height} · waiting for decoder…`;
  } catch (error) {
    scanDialogStatus.textContent = `Capture failed: ${error instanceof Error ? error.message : String(error)}`;
    cancelScanCapture();
  }
}
function cancelScanCapture() {
  clearTimeout(scanCaptureTimer);'''
if anchor not in main: raise SystemExit('missing capture cancel anchor')
main = main.replace(anchor, helper, 1)
anchor = '''  receiverFrameWidth = vw;
  receiverFrameHeight = vh;
  const now = receiverNow();'''
new = '''  receiverFrameWidth = vw;
  receiverFrameHeight = vh;
  if (captureNextScan && !pendingScanCapture && source.videoFrame && !source.image) await captureDirectSourceScan(source);
  const now = receiverNow();'''
if anchor not in main: raise SystemExit('missing captureFrame anchor')
main = main.replace(anchor, new, 1)
if main.count('source.image || captureNextScan ||') < 2: raise SystemExit('missing direct capture blockers')
main = main.replace('source.image || captureNextScan ||', 'source.image ||')
main = main.replace('source.videoFrame && !source.image && !captureNextScan', 'source.videoFrame && !source.image')
main, ids = re.subn(r'pendingScanCapture\.id = ([A-Za-z_][A-Za-z0-9_]*);', r'pendingScanCapture.id = \1; captureNextScan = false;', main)
if ids < 4: raise SystemExit(f'capture id patch count {ids}')

# Timed replay skips RGBA conversion and reconstructs production camera frames.
old = '''    for (let index = 0; index < corpus.length; index++) {
      const frame = await corpus.frame(index);
      if (!maximum) {'''
new = '''    for (let index = 0; index < corpus.length; index++) {
      const rawYReplay = corpus.header.pixelFormat === "Y8";
      const frame = rawYReplay ? corpus.raw(index) : await corpus.frame(index);
      if (!maximum) {'''
if old not in main: raise SystemExit('missing replay loop')
main = main.replace(old, new, 1)
old = '''      const cameraPixels = fastRegressionCameraFrames?.[index];
      let cameraFrame;
      if (cameraPixels) {'''
new = '''      const cameraPixels = fastRegressionCameraFrames?.[index];
      let cameraFrame = rawYReplay ? corpus.videoFrame(index) : void 0;
      if (!cameraFrame && cameraPixels) {'''
if old not in main: raise SystemExit('missing replay camera anchor')
main = main.replace(old, new, 1)
Path('receive/main.js').write_text(main)

# CI proves exact Y bytes + visibleRect offset survive file round trip.
runner = Path('benchmark/offline-runner.mjs').read_text()
anchor = '''try {
  const { easy, motion, dense, opticalDense, cameraDense } = await generateSenderProfiles();
  await page.evaluate(() => document.getElementById("home-button").click());'''
insert = '''try {
  const { easy, motion, dense, opticalDense, cameraDense } = await generateSenderProfiles();
  const rawYRoundTrip = await page.evaluate(async () => {
    const { AgcapRecorder, AgcapCorpus, copyVideoFrameY } = await import(new URL("./receive/agcap.js", location.href).href);
    const codedWidth = 640, codedHeight = 480, visibleRect = { x: 40, y: 0, width: 560, height: 480 };
    const yBytes = codedWidth * codedHeight, chromaBytes = (codedWidth >> 1) * (codedHeight >> 1);
    const i420 = new Uint8Array(yBytes + chromaBytes * 2);
    for (let y = 0; y < codedHeight; y++) for (let x = 0; x < codedWidth; x++) i420[y * codedWidth + x] = (x * 17 + y * 29 + (x ^ y)) & 255;
    i420.fill(128, yBytes);
    const source = new VideoFrame(i420, { format: "I420", codedWidth, codedHeight, visibleRect, displayWidth: 560, displayHeight: 480, timestamp: 123456 });
    const expected = new Uint8Array(visibleRect.width * visibleRect.height);
    for (let y = 0; y < visibleRect.height; y++) expected.set(i420.subarray(y * codedWidth + visibleRect.x, y * codedWidth + visibleRect.x + visibleRect.width), y * visibleRect.width);
    const recorder = new AgcapRecorder(1000, { width: 560, height: 480, stride: 560, cameraSettings: { width: 560, height: 480, frameRate: 30 }, airgapperVersion: "roundtrip", userAgent: navigator.userAgent });
    recorder.addFrame({ sequence: 0, mediaTimeMs: 0, presentationTimeMs: 0, expectedDisplayTimeMs: 0, callbackTimeMs: 0, width: 560, height: 480, stride: 560 }, source);
    source.close();
    const { blob, header } = await recorder.finish();
    const corpus = await AgcapCorpus.load(blob), replay = corpus.videoFrame(0), copied = await copyVideoFrameY(replay);
    replay.close();
    let different = 0; for (let i = 0; i < expected.length; i++) if (copied.y[i] !== expected[i]) different++;
    return { ok: different === 0 && header.formatVersion === 5 && header.pixelFormat === "Y8" && copied.meta.visibleRect.x === 40, different, formatVersion: header.formatVersion, pixelFormat: header.pixelFormat, visibleRect: copied.meta.visibleRect };
  });
  if (!rawYRoundTrip.ok) throw new Error(`AGCAP raw-Y round trip failed: ${JSON.stringify(rawYRoundTrip)}`);
  console.log(`AIRGAPPER_AGCAP_RAW_Y_PASS ${JSON.stringify(rawYRoundTrip)}`);
  await page.evaluate(() => document.getElementById("home-button").click());'''
if anchor not in runner: raise SystemExit('missing runner anchor')
runner = runner.replace(anchor, insert, 1)
Path('benchmark/offline-runner.mjs').write_text(runner)

for path, needle in [
  ('receive/agcap.js','header.pixelFormat === "Y8" && header.formatVersion === 5'),
  ('receive/main.js','Captured exact camera Y frame'),
  ('receive/main.js','rawYReplay ? corpus.videoFrame(index)'),
  ('benchmark/offline-runner.mjs','AIRGAPPER_AGCAP_RAW_Y_PASS')
]:
    if needle not in Path(path).read_text(): raise SystemExit(f'missing v298 invariant {path}: {needle}')
