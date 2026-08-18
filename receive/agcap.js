var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const MAGIC = new TextEncoder().encode("AGCAP01\n");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
async function gunzip(bytes) {
  const input = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(input).arrayBuffer());
}
function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}
const RAW_Y_FORMATS = new Set(["I420", "I420A", "NV12"]);
function normalizedRect(rect, width, height) {
  return { x: Math.max(0, Math.round(rect?.x ?? 0)), y: Math.max(0, Math.round(rect?.y ?? 0)),
    width: Math.max(1, Math.round(rect?.width ?? width)), height: Math.max(1, Math.round(rect?.height ?? height)) };
}
async function copyVideoFrameY(videoFrame) {
  if (!videoFrame || typeof VideoFrame !== "function") throw new Error("Raw camera capture requires VideoFrame");
  const frame = typeof videoFrame.clone === "function" ? videoFrame.clone() : new VideoFrame(videoFrame);
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
    return { y, meta: { sourcePixelFormat, codedWidth: frame.codedWidth, codedHeight: frame.codedHeight,
      visibleRect, displayWidth: frame.displayWidth || visibleRect.width, displayHeight: frame.displayHeight || visibleRect.height,
      frameTimestamp: Number(frame.timestamp) || 0, frameDuration: frame.duration == null ? void 0 : Number(frame.duration),
      rotation: Number(frame.rotation ?? 0) || 0, flip: Boolean(frame.flip) } };
  } finally { frame.close(); }
}
function yToImageData(y, width, height) {
  if (y.length !== width * height) throw new Error("Y frame size mismatch");
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, p = 0; i < y.length; i++, p += 4) rgba[p] = rgba[p + 1] = rgba[p + 2] = y[i], rgba[p + 3] = 255;
  return new ImageData(rgba, width, height);
}
function yRecordToVideoFrame(meta, y) {
  const sourceRect = normalizedRect(meta.visibleRect, meta.width, meta.height);
  const codedWidth = Math.max(sourceRect.x + sourceRect.width, Math.round(meta.codedWidth || meta.width || sourceRect.width));
  const codedHeight = Math.max(sourceRect.y + sourceRect.height, Math.round(meta.codedHeight || meta.height || sourceRect.height));
  if ((codedWidth & 1) || (codedHeight & 1)) throw new Error(`Raw Y replay requires even coded dimensions, got ${codedWidth}×${codedHeight}`);
  if (y.length !== sourceRect.width * sourceRect.height) throw new Error(`Frame ${meta.sequence} raw Y length mismatch`);
  const yBytes = codedWidth * codedHeight, chromaBytes = (codedWidth >> 1) * (codedHeight >> 1);
  const i420 = new Uint8Array(yBytes + chromaBytes * 2);
  i420.fill(255, 0, yBytes); i420.fill(128, yBytes);
  for (let row = 0; row < sourceRect.height; row++) {
    const src = row * sourceRect.width, dst = (sourceRect.y + row) * codedWidth + sourceRect.x;
    i420.set(y.subarray(src, src + sourceRect.width), dst);
  }
  const init = { format: "I420", codedWidth, codedHeight, visibleRect: sourceRect,
    displayWidth: Math.max(1, Math.round(meta.displayWidth || meta.width || sourceRect.width)),
    displayHeight: Math.max(1, Math.round(meta.displayHeight || meta.height || sourceRect.height)),
    timestamp: Number.isFinite(meta.frameTimestamp) ? Math.round(meta.frameTimestamp) : Math.max(0, Math.round((Number(meta.mediaTimeMs) || Number(meta.callbackTimeMs) || 0) * 1000)),
    rotation: Number(meta.rotation) || 0, flip: Boolean(meta.flip) };
  if (Number.isFinite(meta.frameDuration) && meta.frameDuration > 0) init.duration = Math.round(meta.frameDuration);
  return new VideoFrame(i420, init);
}
class AgcapRecorder {
  constructor(durationMs, base) {
    this.durationMs = durationMs;
    this.base = base;
    __publicField(this, "startedAt", performance.now());
    __publicField(this, "callbacks", 0);
    __publicField(this, "drops", 0);
    __publicField(this, "pending", 0);
    __publicField(this, "stored", 0);
    __publicField(this, "stopped", false);
    __publicField(this, "firstMediaTime");
    __publicField(this, "lastMediaTime");
    __publicField(this, "records", []);
    __publicField(this, "bodyParts", []);
    __publicField(this, "canvas", document.createElement("canvas"));
    __publicField(this, "pixelFormat");
    __publicField(this, "compression");
    __publicField(this, "storageBytes", 0);
  }
  get elapsedMs() {
    return performance.now() - this.startedAt;
  }
  get complete() {
    return this.stopped || this.elapsedMs >= this.durationMs;
  }
  begin(meta) {
    var _a;
    this.callbacks++;
    (_a = this.firstMediaTime) != null ? _a : this.firstMediaTime = meta.mediaTimeMs;
    this.lastMediaTime = meta.mediaTimeMs;
    if (this.stopped || this.pending >= 8) {
      this.drops++;
      return false;
    }
    this.pending++;
    return true;
  }
  enqueue(meta, pixels, pixelFormat = "RGBA8888", compression = "png") {
    if (this.pixelFormat && this.pixelFormat !== pixelFormat) { this.pending--; this.drops++; return; }
    this.pixelFormat = pixelFormat; this.compression = compression;
    const metadata = encoder.encode(JSON.stringify(meta));
    this.records.push({ meta, pixels });
    this.bodyParts.push(
      u32(metadata.length),
      metadata,
      u32(pixels.byteLength),
      pixels
    );
    this.storageBytes += metadata.length + pixels.byteLength + 8;
    this.stored++;
    this.pending--;
  }
  addFrame(meta, videoFrame, videoFallback) {
    if (videoFrame && typeof VideoFrame === "function") {
      if (!this.begin(meta)) return;
      void copyVideoFrameY(videoFrame).then(({ y, meta: frameMeta }) => {
        const width = frameMeta.visibleRect.width, height = frameMeta.visibleRect.height;
        this.enqueue({ ...meta, ...frameMeta, width: meta.width || frameMeta.displayWidth, height: meta.height || frameMeta.displayHeight,
          stride: width, yWidth: width, yHeight: height }, y, "Y8", "none");
      }).catch(() => { this.pending--; this.drops++; });
      return;
    }
    this.addVideo(meta, videoFallback);
  }
  addVideo(meta, video) {
    if (!this.begin(meta)) return;
    if (this.canvas.width !== meta.width || this.canvas.height !== meta.height) {
      this.canvas.width = meta.width;
      this.canvas.height = meta.height;
    }
    this.canvas.getContext("2d").drawImage(video, 0, 0, meta.width, meta.height);
    this.canvas.toBlob((blob) => {
      if (!blob) {
        this.pending--;
        this.drops++;
        return;
      }
      void blob.arrayBuffer().then((bytes) => this.enqueue(meta, new Uint8Array(bytes))).catch(() => {
        this.pending--;
        this.drops++;
      });
    }, "image/png");
  }
  async finish() {
    this.stopped = true;
    while (this.pending > 0) await new Promise((resolve) => setTimeout(resolve, 10));
    const settingsFps = Number(this.base.cameraSettings.frameRate) || 0;
    const mediaDuration = this.firstMediaTime === void 0 || this.lastMediaTime === void 0 ? 0 : Math.max(0, this.lastMediaTime - this.firstMediaTime);
    const expectedCallbacks = settingsFps && mediaDuration ? Math.round(mediaDuration / 1e3 * settingsFps) + 1 : this.callbacks;
    const header = {
      ...this.base,
      format: "AirGapper lossless camera corpus",
      formatVersion: this.pixelFormat === "Y8" ? 5 : 4,
      pixelFormat: this.pixelFormat || "RGBA8888",
      compression: this.compression || "png",
      capturePath: this.pixelFormat === "Y8" ? "TrackProcessor VideoFrame exact Y plane" : "video canvas RGBA fallback",
      startedAt: (/* @__PURE__ */ new Date()).toISOString(),
      requestedDurationMs: this.durationMs,
      callbacks: this.callbacks,
      framesStored: this.stored,
      recorderDrops: this.drops,
      estimatedCameraDrops: Math.max(0, expectedCallbacks - this.callbacks),
      storageBytes: this.storageBytes
    };
    const headerBytes = encoder.encode(JSON.stringify(header));
    return {
      blob: new Blob([
        MAGIC,
        u32(headerBytes.length),
        headerBytes,
        ...this.bodyParts
      ], { type: "application/vnd.airgapper.capture" }),
      header,
      corpus: AgcapCorpus.fromRecords(header, this.records)
    };
  }
}
class AgcapCorpus {
  constructor(header, records) {
    this.header = header;
    this.records = records;
    records.sort((a, b) => a.meta.sequence - b.meta.sequence);
  }
  static fromRecords(header, records) {
    return new AgcapCorpus(header, records);
  }
  static async load(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length < 12 || !MAGIC.every((value, index) => bytes[index] === value)) throw new Error("Not an AirGapper capture");
    const outerView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerLength = outerView.getUint32(MAGIC.length, true);
    const headerStart = MAGIC.length + 4;
    const bodyStart = headerStart + headerLength;
    if (bodyStart > bytes.length) throw new Error("Truncated AirGapper capture");
    const header = JSON.parse(decoder.decode(bytes.subarray(headerStart, bodyStart)));
    const supported = header.pixelFormat === "RGBA8888" ? [1, 2, 3, 4].includes(header.formatVersion)
      : header.pixelFormat === "Y8" && header.formatVersion === 5;
    if (!supported) throw new Error("Unsupported AirGapper capture");
    const body = header.compression === "gzip-stream" || header.compression === "png+gzip-stream" ? await gunzip(bytes.subarray(bodyStart)) : bytes.subarray(bodyStart);
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let offset = 0;
    const readPart = () => {
      if (offset + 4 > body.length) throw new Error("Truncated AirGapper capture");
      const length = view.getUint32(offset, true);
      offset += 4;
      if (offset + length > body.length) throw new Error("Truncated AirGapper capture");
      const part = body.slice(offset, offset + length);
      offset += length;
      return part;
    };
    const records = [];
    while (offset < body.length) {
      const meta = JSON.parse(decoder.decode(readPart()));
      records.push({ meta, pixels: readPart() });
    }
    if (records.length !== header.framesStored) throw new Error("AirGapper capture frame count mismatch");
    return new AgcapCorpus(header, records);
  }
  get length() {
    return this.records.length;
  }
  meta(index) {
    return this.records[index].meta;
  }
  raw(index) {
    const record = this.records[index];
    if (this.header.pixelFormat !== "Y8") return null;
    const width = record.meta.yWidth || record.meta.visibleRect?.width || record.meta.width;
    const height = record.meta.yHeight || record.meta.visibleRect?.height || record.meta.height;
    if (record.pixels.length !== width * height) throw new Error(`Frame ${record.meta.sequence} raw Y length mismatch`);
    return { meta: record.meta, y: record.pixels };
  }
  videoFrame(index) { const raw = this.raw(index); return raw ? yRecordToVideoFrame(raw.meta, raw.y) : null; }
  async frame(index) {
    const record = this.records[index];
    if (this.header.pixelFormat === "Y8") {
      const raw = this.raw(index), width = raw.meta.yWidth || raw.meta.visibleRect?.width || raw.meta.width;
      const height = raw.meta.yHeight || raw.meta.visibleRect?.height || raw.meta.height;
      return { meta: raw.meta, y: raw.y, rgba: yToImageData(raw.y, width, height).data };
    }
    if (this.header.compression === "png+gzip-stream" || this.header.compression === "png") {
      const bitmap = await createImageBitmap(new Blob([record.pixels], { type: "image/png" }));
      try {
        const canvas = document.createElement("canvas");
        canvas.width = record.meta.width;
        canvas.height = record.meta.height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(bitmap, 0, 0);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        return { meta: record.meta, rgba: image.data };
      } finally {
        bitmap.close();
      }
    }
    const pixels = this.header.compression === "gzip" ? await gunzip(record.pixels) : record.pixels;
    const expected = record.meta.stride * record.meta.height;
    if (pixels.length !== expected) throw new Error(`Frame ${record.meta.sequence} pixel length mismatch`);
    return { meta: record.meta, rgba: new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength) };
  }
}
export {
  AgcapCorpus,
  AgcapRecorder,
  copyVideoFrameY,
  yToImageData
};
