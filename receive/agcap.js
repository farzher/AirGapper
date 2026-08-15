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
    if (this.pending >= 64) {
      this.drops++;
      return false;
    }
    this.pending++;
    return true;
  }
  enqueue(meta, pixels) {
    const metadata = encoder.encode(JSON.stringify(meta));
    this.records.push({ meta, pixels });
    this.bodyParts.push(
      u32(metadata.length),
      metadata,
      u32(pixels.byteLength),
      pixels
    );
    this.stored++;
    this.pending--;
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
      formatVersion: 4,
      pixelFormat: "RGBA8888",
      compression: "png",
      startedAt: (/* @__PURE__ */ new Date()).toISOString(),
      requestedDurationMs: this.durationMs,
      callbacks: this.callbacks,
      framesStored: this.stored,
      recorderDrops: this.drops,
      estimatedCameraDrops: Math.max(0, expectedCallbacks - this.callbacks)
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
    if (![1, 2, 3, 4].includes(header.formatVersion) || header.pixelFormat !== "RGBA8888") {
      throw new Error("Unsupported AirGapper capture");
    }
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
  async frame(index) {
    const record = this.records[index];
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
  AgcapRecorder
};
