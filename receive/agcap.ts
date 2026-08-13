const MAGIC = new TextEncoder().encode("AGCAP01\n");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface AgcapHeader {
  format: "AirGapper lossless camera corpus";
  formatVersion: 1;
  pixelFormat: "RGBA8888";
  compression: "gzip" | "none";
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

type StoredFrame = { meta: AgcapFrameMeta; pixels: Uint8Array };

async function transform(bytes: Uint8Array, kind: "gzip" | "gunzip"): Promise<Uint8Array> {
  const stream = kind === "gzip"
    ? new CompressionStream("gzip")
    : new DecompressionStream("gzip");
  const input = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(input).arrayBuffer());
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

export class AgcapRecorder {
  readonly startedAt = performance.now();
  callbacks = 0;
  drops = 0;
  private pending = 0;
  private stopped = false;
  private readonly frames: Promise<StoredFrame>[] = [];
  private firstMediaTime: number | undefined;
  private lastMediaTime: number | undefined;

  constructor(
    readonly durationMs: number,
    private readonly base: Omit<AgcapHeader, "format" | "formatVersion" | "pixelFormat" | "compression" |
      "startedAt" | "requestedDurationMs" | "callbacks" | "framesStored" | "recorderDrops" | "estimatedCameraDrops">,
  ) {}

  get elapsedMs(): number { return performance.now() - this.startedAt; }
  get complete(): boolean { return this.stopped || this.elapsedMs >= this.durationMs; }

  add(meta: AgcapFrameMeta, image: ImageData): void {
    this.callbacks++;
    this.firstMediaTime ??= meta.mediaTimeMs;
    this.lastMediaTime = meta.mediaTimeMs;
    // Compression may trail capture on an old phone. Bound copied-frame memory;
    // skipped corpus frames remain explicit through sequence numbers and drops.
    if (this.pending >= 4) {
      this.drops++;
      return;
    }
    this.pending++;
    const exact = new Uint8Array(image.data.slice().buffer);
    const promise = transform(exact, "gzip")
      .then((pixels) => ({ meta, pixels }))
      .finally(() => { this.pending--; });
    this.frames.push(promise);
  }

  async finish(): Promise<{ blob: Blob; header: AgcapHeader }> {
    this.stopped = true;
    const frames = await Promise.all(this.frames);
    const settingsFps = Number(this.base.cameraSettings.frameRate) || 0;
    const mediaDuration = this.firstMediaTime === undefined || this.lastMediaTime === undefined
      ? 0 : Math.max(0, this.lastMediaTime - this.firstMediaTime);
    const expectedCallbacks = settingsFps && mediaDuration ? Math.round(mediaDuration / 1000 * settingsFps) + 1 : this.callbacks;
    const header: AgcapHeader = {
      ...this.base,
      format: "AirGapper lossless camera corpus",
      formatVersion: 1,
      pixelFormat: "RGBA8888",
      compression: "gzip",
      startedAt: new Date().toISOString(),
      requestedDurationMs: this.durationMs,
      callbacks: this.callbacks,
      framesStored: frames.length,
      recorderDrops: this.drops,
      estimatedCameraDrops: Math.max(0, expectedCallbacks - this.callbacks),
    };
    const headerBytes = encoder.encode(JSON.stringify(header));
    const parts: BlobPart[] = [MAGIC as BlobPart, u32(headerBytes.length) as BlobPart, headerBytes as BlobPart];
    for (const frame of frames.sort((a, b) => a.meta.sequence - b.meta.sequence)) {
      const meta = encoder.encode(JSON.stringify(frame.meta));
      parts.push(u32(meta.length) as BlobPart, meta as BlobPart, u32(frame.pixels.length) as BlobPart, frame.pixels as BlobPart);
    }
    return { blob: new Blob(parts, { type: "application/vnd.airgapper.capture" }), header };
  }
}

export class AgcapCorpus {
  private constructor(readonly header: AgcapHeader, private readonly records: { meta: AgcapFrameMeta; pixels: Uint8Array }[]) {}

  static async load(blob: Blob): Promise<AgcapCorpus> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length < 12 || !MAGIC.every((value, index) => bytes[index] === value)) throw new Error("Not an AirGapper capture");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = MAGIC.length;
    const readPart = (): Uint8Array => {
      if (offset + 4 > bytes.length) throw new Error("Truncated AirGapper capture");
      const length = view.getUint32(offset, true);
      offset += 4;
      if (offset + length > bytes.length) throw new Error("Truncated AirGapper capture");
      const part = bytes.slice(offset, offset + length);
      offset += length;
      return part;
    };
    const header = JSON.parse(decoder.decode(readPart())) as AgcapHeader;
    if (header.formatVersion !== 1 || header.pixelFormat !== "RGBA8888") throw new Error("Unsupported AirGapper capture");
    const records: { meta: AgcapFrameMeta; pixels: Uint8Array }[] = [];
    while (offset < bytes.length) {
      const meta = JSON.parse(decoder.decode(readPart())) as AgcapFrameMeta;
      records.push({ meta, pixels: readPart() });
    }
    if (records.length !== header.framesStored) throw new Error("AirGapper capture frame count mismatch");
    return new AgcapCorpus(header, records);
  }

  get length(): number { return this.records.length; }
  meta(index: number): AgcapFrameMeta { return this.records[index]!.meta; }

  async frame(index: number): Promise<AgcapFrame> {
    const record = this.records[index]!;
    const bytes = this.header.compression === "gzip" ? await transform(record.pixels, "gunzip") : record.pixels;
    const expected = record.meta.stride * record.meta.height;
    if (bytes.length !== expected) throw new Error(`Frame ${record.meta.sequence} pixel length mismatch`);
    return { meta: record.meta, rgba: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
  }
}
