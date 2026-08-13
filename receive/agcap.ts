const MAGIC = new TextEncoder().encode("AGCAP01\n");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface AgcapHeader {
  format: "AirGapper lossless camera corpus";
  formatVersion: 1 | 2 | 3;
  pixelFormat: "RGBA8888";
  compression: "gzip" | "gzip-stream" | "png+gzip-stream" | "none";
  width: number;
  height: number;
  stride: number;
  orientation: string;
  cameraSettings: MediaTrackSettings;
  airgapperVersion: string;
  userAgent: string;
  startedAt: string;
  requestedDurationMs: number;
  callbacks: number;
  framesStored: number;
  recorderDrops: number;
  estimatedCameraDrops: number;
}

export interface AgcapFrameMeta {
  sequence: number;
  mediaTimeMs: number;
  presentationTimeMs: number;
  expectedDisplayTimeMs: number;
  callbackTimeMs: number;
  width: number;
  height: number;
  stride: number;
  orientation: string;
}

export interface AgcapFrame {
  meta: AgcapFrameMeta;
  rgba: Uint8ClampedArray;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const input = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(input).arrayBuffer());
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function recordBytes(meta: AgcapFrameMeta, pixels: Uint8ClampedArray): Uint8Array<ArrayBuffer> {
  const metadata = encoder.encode(JSON.stringify(meta));
  const record = new Uint8Array(8 + metadata.length + pixels.byteLength);
  const view = new DataView(record.buffer);
  view.setUint32(0, metadata.length, true);
  record.set(metadata, 4);
  view.setUint32(4 + metadata.length, pixels.byteLength, true);
  record.set(pixels, 8 + metadata.length);
  return record;
}

export class AgcapRecorder {
  readonly startedAt = performance.now();
  callbacks = 0;
  drops = 0;
  private pending = 0;
  private stored = 0;
  private stopped = false;
  private firstMediaTime: number | undefined;
  private lastMediaTime: number | undefined;
  private writeTail: Promise<void> = Promise.resolve();
  private readonly writer: WritableStreamDefaultWriter<BufferSource>;
  private readonly compressedBody: Promise<ArrayBuffer>;
  private readonly canvas = document.createElement("canvas");

  constructor(
    readonly durationMs: number,
    private readonly base: Omit<AgcapHeader, "format" | "formatVersion" | "pixelFormat" | "compression" |
      "startedAt" | "requestedDurationMs" | "callbacks" | "framesStored" | "recorderDrops" | "estimatedCameraDrops">,
  ) {
    // One continuous gzip stream avoids constructing and warming a compressor
    // for every camera frame. The readable is drained while capture continues.
    const compressor = new CompressionStream("gzip");
    this.writer = compressor.writable.getWriter();
    this.compressedBody = new Response(compressor.readable).arrayBuffer();
  }

  get elapsedMs(): number { return performance.now() - this.startedAt; }
  get complete(): boolean { return this.stopped || this.elapsedMs >= this.durationMs; }

  private begin(meta: AgcapFrameMeta): boolean {
    this.callbacks++;
    this.firstMediaTime ??= meta.mediaTimeMs;
    this.lastMediaTime = meta.mediaTimeMs;
    // Keep enough camera surfaces and raw records to absorb short stalls
    // without risking unbounded memory on an old phone.
    if (this.pending >= 64) {
      this.drops++;
      return false;
    }
    this.pending++;
    return true;
  }

  private enqueue(meta: AgcapFrameMeta, pixels: Uint8ClampedArray): void {
    const record = recordBytes(meta, pixels);
    this.stored++;
    this.writeTail = this.writeTail
      .then(() => this.writer.write(record))
      .catch(() => { this.drops++; this.stored--; })
      .finally(() => { this.pending--; });
  }

  add(meta: AgcapFrameMeta, image: ImageData): void {
    if (this.begin(meta)) this.enqueue(meta, image.data);
  }

  addVideo(meta: AgcapFrameMeta, video: HTMLVideoElement): void {
    if (!this.begin(meta)) return;
    // This is production's exact video → canvas conversion, but PNG encoding
    // is asynchronous. Avoiding synchronous getImageData/VideoFrame.copyTo
    // keeps the camera producer moving while preserving every canvas pixel.
    if (this.canvas.width !== meta.width || this.canvas.height !== meta.height) {
      this.canvas.width = meta.width;
      this.canvas.height = meta.height;
    }
    this.canvas.getContext("2d")!.drawImage(video, 0, 0, meta.width, meta.height);
    this.canvas.toBlob((blob) => {
      if (!blob) {
        this.pending--;
        this.drops++;
        return;
      }
      void blob.arrayBuffer()
        .then((bytes) => this.enqueue(meta, new Uint8ClampedArray(bytes)))
        .catch(() => { this.pending--; this.drops++; });
    }, "image/png");
  }

  async finish(): Promise<{ blob: Blob; header: AgcapHeader }> {
    this.stopped = true;
    while (this.pending > 0) await new Promise((resolve) => setTimeout(resolve, 10));
    await this.writeTail;
    await this.writer.close();
    const body = await this.compressedBody;
    const settingsFps = Number(this.base.cameraSettings.frameRate) || 0;
    const mediaDuration = this.firstMediaTime === undefined || this.lastMediaTime === undefined
      ? 0 : Math.max(0, this.lastMediaTime - this.firstMediaTime);
    const expectedCallbacks = settingsFps && mediaDuration ? Math.round(mediaDuration / 1000 * settingsFps) + 1 : this.callbacks;
    const header: AgcapHeader = {
      ...this.base,
      format: "AirGapper lossless camera corpus",
      formatVersion: 3,
      pixelFormat: "RGBA8888",
      compression: "png+gzip-stream",
      startedAt: new Date().toISOString(),
      requestedDurationMs: this.durationMs,
      callbacks: this.callbacks,
      framesStored: this.stored,
      recorderDrops: this.drops,
      estimatedCameraDrops: Math.max(0, expectedCallbacks - this.callbacks),
    };
    const headerBytes = encoder.encode(JSON.stringify(header));
    return {
      blob: new Blob([
        MAGIC as BlobPart, u32(headerBytes.length) as BlobPart, headerBytes as BlobPart, body,
      ], { type: "application/vnd.airgapper.capture" }),
      header,
    };
  }
}

export class AgcapCorpus {
  private constructor(readonly header: AgcapHeader, private readonly records: { meta: AgcapFrameMeta; pixels: Uint8Array }[]) {}

  static async load(blob: Blob): Promise<AgcapCorpus> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length < 12 || !MAGIC.every((value, index) => bytes[index] === value)) throw new Error("Not an AirGapper capture");
    const outerView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerLength = outerView.getUint32(MAGIC.length, true);
    const headerStart = MAGIC.length + 4;
    const bodyStart = headerStart + headerLength;
    if (bodyStart > bytes.length) throw new Error("Truncated AirGapper capture");
    const header = JSON.parse(decoder.decode(bytes.subarray(headerStart, bodyStart))) as AgcapHeader;
    if (![1, 2, 3].includes(header.formatVersion) || header.pixelFormat !== "RGBA8888") {
      throw new Error("Unsupported AirGapper capture");
    }
    const body = header.compression === "gzip-stream" || header.compression === "png+gzip-stream"
      ? await gunzip(bytes.subarray(bodyStart)) : bytes.subarray(bodyStart);
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let offset = 0;
    const readPart = (): Uint8Array => {
      if (offset + 4 > body.length) throw new Error("Truncated AirGapper capture");
      const length = view.getUint32(offset, true);
      offset += 4;
      if (offset + length > body.length) throw new Error("Truncated AirGapper capture");
      const part = body.slice(offset, offset + length);
      offset += length;
      return part;
    };
    const records: { meta: AgcapFrameMeta; pixels: Uint8Array }[] = [];
    while (offset < body.length) {
      const meta = JSON.parse(decoder.decode(readPart())) as AgcapFrameMeta;
      records.push({ meta, pixels: readPart() });
    }
    if (records.length !== header.framesStored) throw new Error("AirGapper capture frame count mismatch");
    records.sort((a, b) => a.meta.sequence - b.meta.sequence);
    return new AgcapCorpus(header, records);
  }

  get length(): number { return this.records.length; }
  meta(index: number): AgcapFrameMeta { return this.records[index]!.meta; }

  async frame(index: number): Promise<AgcapFrame> {
    const record = this.records[index]!;
    if (this.header.compression === "png+gzip-stream") {
      const bitmap = await createImageBitmap(new Blob([record.pixels as BlobPart], { type: "image/png" }));
      try {
        const canvas = document.createElement("canvas");
        canvas.width = record.meta.width;
        canvas.height = record.meta.height;
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        context.drawImage(bitmap, 0, 0);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        return { meta: record.meta, rgba: image.data };
      } finally { bitmap.close(); }
    }
    const pixels = this.header.compression === "gzip" ? await gunzip(record.pixels) : record.pixels;
    const expected = record.meta.stride * record.meta.height;
    if (pixels.length !== expected) throw new Error(`Frame ${record.meta.sequence} pixel length mismatch`);
    return { meta: record.meta, rgba: new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength) };
  }
}
