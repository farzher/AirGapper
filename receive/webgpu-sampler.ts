import type { SymbolQuad } from "../shared/worker-pool";

export interface GpuSampleTrack {
  id: number;
  quad: SymbolQuad;
  dim: number;
  crc32: boolean;
  /** 0 = luminance, 1 = red, 2 = green. Separate logical tracks may share a
   * quad to support future dual-colour streams without another camera copy. */
  channel?: 0 | 1 | 2;
}

export interface GpuSampleResult {
  packed: ArrayBuffer;
  tracks: GpuSampleTrack[];
  wordsPerMatrix: number;
  gpuMs: number;
  readbackMs: number;
}

export interface WebGpuSamplerMetrics {
  enabled: boolean;
  submitted: number;
  dropped: number;
  trackedQrs: number;
  packedBytes: number;
  gpuTotalMs: number;
  readbackMs: number;
  lastGpuMs: number;
  lastReadbackMs: number;
}

const MAX_TRACKS = 15;
const MAX_DIMENSION = 177;
const WORDS_PER_MATRIX = Math.ceil(MAX_DIMENSION * MAX_DIMENSION / 32);
const TRACK_FLOATS = 12;
const TRACK_BYTES = TRACK_FLOATS * 4;
const SLOT_COUNT = 3;
const CALIBRATION_READBACK_BYTES = 256;

// WebGPU constants are repeated here because TypeScript's DOM library does not
// yet include WebGPU on every supported compiler.
const BUFFER_MAP_READ = 0x0001;
const BUFFER_COPY_SRC = 0x0004;
const BUFFER_COPY_DST = 0x0008;
const BUFFER_UNIFORM = 0x0040;
const BUFFER_STORAGE = 0x0080;
const MAP_READ = 0x0001;

const SHADER = /* wgsl */ `
struct Params { frameSize: vec2f, trackCount: u32, wordsPerMatrix: u32 }
struct Track { h0: vec4f, h1: vec4f, info: vec4f }
struct Calibration { threshold: f32, contrast: f32, dx: f32, dy: f32 }

@group(0) @binding(0) var camera: texture_external;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var<storage, read> tracks: array<Track>;
@group(0) @binding(3) var<storage, read_write> calibration: array<Calibration>;
@group(0) @binding(4) var<storage, read_write> packed: array<u32>;

fn cameraPoint(track: Track, module: vec2f) -> vec2f {
  let d = track.h0.w * module.x + track.h1.w * module.y + 1.0;
  return vec2f(
    (track.h0.x * module.x + track.h0.y * module.y + track.h0.z) / d,
    (track.h1.x * module.x + track.h1.y * module.y + track.h1.z) / d
  );
}

fn levelAt(track: Track, module: vec2f, offset: vec2f) -> f32 {
  let rgb = textureSampleBaseClampToEdge(camera, (cameraPoint(track, module) + offset) / params.frameSize).rgb;
  let channel = u32(track.info.y);
  if (channel == 1u) { return rgb.r; }
  if (channel == 2u) { return rgb.g; }
  return dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
}

fn level(track: Track, module: vec2f) -> f32 {
  let correction = vec2f(calibration[u32(track.info.w)].dx, calibration[u32(track.info.w)].dy);
  // Four quarter-module samples survive defocus, display scaling and rolling
  // shutter substantially better than one fragile center texel.
  return (levelAt(track, module + vec2f(-0.25, -0.25), correction) +
    levelAt(track, module + vec2f(0.25, -0.25), correction) +
    levelAt(track, module + vec2f(-0.25, 0.25), correction) +
    levelAt(track, module + vec2f(0.25, 0.25), correction)) * 0.25;
}

fn finderBlack(x: u32, y: u32) -> bool {
  return x == 0u || x == 6u || y == 0u || y == 6u || (x >= 2u && x <= 4u && y >= 2u && y <= 4u);
}

@compute @workgroup_size(1)
fn calibrate(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= params.trackCount) { return; }
  let track = tracks[index];
  let dim = u32(track.info.x);
  var bestScore = -100000.0;
  var best = Calibration(0.5, 0.0, 0.0, 0.0);
  // Search only around the cached transform. This replaces twelve independent
  // detections with a small parallel finder-pattern correlation.
  for (var sy = -8; sy <= 8; sy++) {
    for (var sx = -8; sx <= 8; sx++) {
      let correction = vec2f(f32(sx), f32(sy)) * 0.5;
      var black = 0.0;
      var white = 0.0;
      var blackCount = 0u;
      var whiteCount = 0u;
      for (var finder = 0u; finder < 3u; finder++) {
        let origin = select(select(vec2u(0u, dim - 7u), vec2u(dim - 7u, 0u), finder == 1u), vec2u(0u), finder == 0u);
        for (var y = 0u; y < 7u; y++) {
          for (var x = 0u; x < 7u; x++) {
            let value = levelAt(track, vec2f(origin + vec2u(x, y)) + vec2f(0.5), correction);
            if (finderBlack(x, y)) { black += value; blackCount++; }
            else { white += value; whiteCount++; }
          }
        }
      }
      let blackLevel = black / f32(blackCount);
      let whiteLevel = white / f32(whiteCount);
      // Contrast is the finder correlation for a known binary pattern. A tiny
      // distance penalty prevents noisy frames from walking a stable track.
      let score = whiteLevel - blackLevel - length(correction) * 0.002;
      if (score > bestScore) {
        bestScore = score;
        best = Calibration((blackLevel + whiteLevel) * 0.5, whiteLevel - blackLevel, correction.x, correction.y);
      }
    }
  }
  calibration[index] = best;
}

@compute @workgroup_size(64)
fn sampleAndPack(@builtin(global_invocation_id) gid: vec3u) {
  let word = gid.x;
  let trackIndex = gid.y;
  if (trackIndex >= params.trackCount || word >= params.wordsPerMatrix) { return; }
  let track = tracks[trackIndex];
  let dim = u32(track.info.x);
  var result = 0u;
  for (var bit = 0u; bit < 32u; bit++) {
    let linear = word * 32u + bit;
    if (linear < dim * dim) {
      let module = vec2u(linear % dim, linear / dim);
      if (level(track, vec2f(module) + vec2f(0.5)) <= calibration[trackIndex].threshold) {
        result |= 1u << bit;
      }
    }
  }
  packed[trackIndex * params.wordsPerMatrix + word] = result;
}
`;

interface Slot {
  busy: boolean;
  params: any;
  tracks: any;
  calibration: any;
  output: any;
  readback: any;
}

/** Direct video-external-texture prototype for already acquired QR quads. */
export class WebGpuQrSampler {
  private readonly slots: Slot[] = [];
  private nextSlot = 0;
  private alive = true;
  private readonly values = new Float32Array(MAX_TRACKS * TRACK_FLOATS);
  private readonly counters: WebGpuSamplerMetrics = {
    enabled: true, submitted: 0, dropped: 0, trackedQrs: 0, packedBytes: 0,
    gpuTotalMs: 0, readbackMs: 0, lastGpuMs: 0, lastReadbackMs: 0,
  };

  private constructor(private readonly device: any, private readonly pipeline: any) {
    const outputBytes = MAX_TRACKS * WORDS_PER_MATRIX * 4;
    const readbackBytes = CALIBRATION_READBACK_BYTES + outputBytes;
    for (let i = 0; i < SLOT_COUNT; i++) {
      this.slots.push({
        busy: false,
        params: device.createBuffer({ size: 16, usage: BUFFER_UNIFORM | BUFFER_COPY_DST }),
        tracks: device.createBuffer({ size: MAX_TRACKS * TRACK_BYTES, usage: BUFFER_STORAGE | BUFFER_COPY_DST }),
        calibration: device.createBuffer({ size: MAX_TRACKS * 16, usage: BUFFER_STORAGE | BUFFER_COPY_SRC }),
        output: device.createBuffer({ size: outputBytes, usage: BUFFER_STORAGE | BUFFER_COPY_SRC }),
        readback: device.createBuffer({ size: readbackBytes, usage: BUFFER_COPY_DST | BUFFER_MAP_READ }),
      });
    }
  }

  static async create(): Promise<WebGpuQrSampler | null> {
    const gpu = (navigator as Navigator & { gpu?: any }).gpu;
    if (!gpu) return null;
    try {
      const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      const module = device.createShaderModule({ code: SHADER });
      const pipeline = device.createComputePipeline({
        layout: "auto",
        compute: { module, entryPoint: "sampleAndPack" },
      });
      // Both entry points have the same explicitly declared bindings, so the
      // sampling pipeline's auto layout can also run calibration.
      const calibrationPipeline = device.createComputePipeline({
        layout: pipeline.getBindGroupLayout(0) ? device.createPipelineLayout({ bindGroupLayouts: [pipeline.getBindGroupLayout(0)] }) : "auto",
        compute: { module, entryPoint: "calibrate" },
      });
      const sampler = new WebGpuQrSampler(device, { sampling: pipeline, calibration: calibrationPipeline });
      void device.lost.then(() => sampler.destroy());
      return sampler;
    } catch {
      return null;
    }
  }

  get metrics(): WebGpuSamplerMetrics {
    return { ...this.counters, enabled: this.alive };
  }

  submit(video: HTMLVideoElement, inputTracks: GpuSampleTrack[], done: (result: GpuSampleResult) => void): boolean {
    if (!this.alive || !inputTracks.length) return false;
    const tracks = inputTracks.slice(0, MAX_TRACKS);
    let slot: Slot | undefined;
    for (let i = 0; i < this.slots.length; i++) {
      const candidate = this.slots[(this.nextSlot + i) % this.slots.length];
      if (candidate && !candidate.busy) {
        slot = candidate;
        this.nextSlot = (this.nextSlot + i + 1) % this.slots.length;
        break;
      }
    }
    if (!slot) {
      this.counters.dropped++;
      return true; // Saturation drops the frame rather than invoking CPU capture.
    }

    try {
      for (let i = 0; i < tracks.length; i++) this.writeTrack(i, tracks[i]!);
      const params = new ArrayBuffer(16);
      const paramsView = new DataView(params);
      paramsView.setFloat32(0, video.videoWidth, true);
      paramsView.setFloat32(4, video.videoHeight, true);
      paramsView.setUint32(8, tracks.length, true);
      paramsView.setUint32(12, WORDS_PER_MATRIX, true);
      this.device.queue.writeBuffer(slot.params, 0, params);
      this.device.queue.writeBuffer(slot.tracks, 0, this.values.buffer, 0, tracks.length * TRACK_BYTES);

      const external = this.device.importExternalTexture({ source: video });
      const bindGroup = this.device.createBindGroup({
        layout: this.pipeline.sampling.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: external },
          { binding: 1, resource: { buffer: slot.params } },
          { binding: 2, resource: { buffer: slot.tracks } },
          { binding: 3, resource: { buffer: slot.calibration } },
          { binding: 4, resource: { buffer: slot.output } },
        ],
      });
      const encoder = this.device.createCommandEncoder();
      let pass = encoder.beginComputePass();
      pass.setPipeline(this.pipeline.calibration);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(tracks.length);
      pass.end();
      pass = encoder.beginComputePass();
      pass.setPipeline(this.pipeline.sampling);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(WORDS_PER_MATRIX / 64), tracks.length);
      pass.end();
      const bytes = tracks.length * WORDS_PER_MATRIX * 4;
      const mappedBytes = CALIBRATION_READBACK_BYTES + bytes;
      encoder.copyBufferToBuffer(slot.calibration, 0, slot.readback, 0, tracks.length * 16);
      encoder.copyBufferToBuffer(slot.output, 0, slot.readback, CALIBRATION_READBACK_BYTES, bytes);
      slot.busy = true;
      const submittedAt = performance.now();
      this.device.queue.submit([encoder.finish()]);
      this.counters.submitted++;
      this.counters.trackedQrs += tracks.length;
      this.counters.packedBytes += bytes;
      void slot.readback.mapAsync(MAP_READ, 0, mappedBytes).then(() => {
        const mappedAt = performance.now();
        const mapped = slot!.readback.getMappedRange(0, mappedBytes);
        const calibration = new Float32Array(mapped, 0, tracks.length * 4);
        const correctedTracks = tracks.map((track, index) => {
          const contrast = calibration[index * 4 + 1] ?? 0;
          const dx = contrast >= 0.08 ? calibration[index * 4 + 2] ?? 0 : 0;
          const dy = contrast >= 0.08 ? calibration[index * 4 + 3] ?? 0 : 0;
          return dx || dy ? { ...track, quad: translateQuad(track.quad, dx, dy) } : track;
        });
        const packed = mapped.slice(CALIBRATION_READBACK_BYTES, CALIBRATION_READBACK_BYTES + bytes);
        slot!.readback.unmap();
        slot!.busy = false;
        if (!this.alive) return;
        const readbackMs = performance.now() - mappedAt;
        const gpuMs = mappedAt - submittedAt;
        this.counters.lastGpuMs = gpuMs;
        this.counters.lastReadbackMs = readbackMs;
        this.counters.gpuTotalMs += gpuMs;
        this.counters.readbackMs += readbackMs;
        done({ packed, tracks: correctedTracks, wordsPerMatrix: WORDS_PER_MATRIX, gpuMs, readbackMs });
      }).catch(() => {
        slot!.busy = false;
      });
      return true;
    } catch {
      slot.busy = false;
      return false;
    }
  }

  destroy(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const slot of this.slots) {
      slot.params.destroy();
      slot.tracks.destroy();
      slot.calibration.destroy();
      slot.output.destroy();
      if (!slot.busy) slot.readback.destroy();
    }
  }

  private writeTrack(index: number, track: GpuSampleTrack): void {
    const h = homography(track.dim, track.quad);
    const offset = index * TRACK_FLOATS;
    this.values.set([h[0]!, h[1]!, h[2]!, h[6]!, h[3]!, h[4]!, h[5]!, h[7]!, track.dim, track.channel ?? 0, 0, index], offset);
  }
}

function translateQuad(quad: SymbolQuad, dx: number, dy: number): SymbolQuad {
  const move = (point: { x: number; y: number }) => ({ x: point.x + dx, y: point.y + dy });
  return {
    topLeft: move(quad.topLeft), topRight: move(quad.topRight),
    bottomRight: move(quad.bottomRight), bottomLeft: move(quad.bottomLeft),
  };
}

/** Solve the 8 projective coefficients mapping module-space corners to the
 * camera quad. The shader applies the ninth coefficient as 1. */
function homography(dim: number, quad: SymbolQuad): number[] {
  const points = [
    [0, 0, quad.topLeft.x, quad.topLeft.y],
    [dim, 0, quad.topRight.x, quad.topRight.y],
    [dim, dim, quad.bottomRight.x, quad.bottomRight.y],
    [0, dim, quad.bottomLeft.x, quad.bottomLeft.y],
  ];
  const a: number[][] = [];
  for (const [x, y, u, v] of points) {
    a.push([x!, y!, 1, 0, 0, 0, -u! * x!, -u! * y!, u!]);
    a.push([0, 0, 0, x!, y!, 1, -v! * x!, -v! * y!, v!]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    const scale = a[col]![col]!;
    for (let k = col; k < 9; k++) a[col]![k] = a[col]![k]! / scale;
    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const factor = a[row]![col]!;
      for (let k = col; k < 9; k++) a[row]![k] = a[row]![k]! - factor * a[col]![k]!;
    }
  }
  return a.map((row) => row[8]!);
}
