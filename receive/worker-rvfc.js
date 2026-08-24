// Worker wrapper for live camera decode jobs.
//
// rVFC/canvas capture arrives as a transferred RGBA ArrayBuffer. Compact the
// achromatic green channel into the beginning of that same owned buffer instead
// of allocating another full Y8 frame. TrackProcessor jobs also arrive here so
// the hot path can unpack its compact track descriptor without structured-clone
// churn from dozens of nested quad objects per camera frame.

const query = self.location.search || "";
await import(`./worker.js${query}`);

const baseOnMessage = self.onmessage;
const nativePostMessage = self.postMessage.bind(self);
const PACKED_TRACK_BYTES = 56;
const GEOMETRY_REPORTS_PER_FRAME = 4;
const trackPool = [];
const activeTracks = [];
let activeSourceSequence = -1;
let activeLiveTracked = false;

function validQuad(quad) {
  return Boolean(quad?.topLeft && quad?.topRight && quad?.bottomRight && quad?.bottomLeft &&
    [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft].every((point) =>
      Number.isFinite(point.x) && Number.isFinite(point.y)));
}

function thinGeometryReports(symbols) {
  if (!activeLiveTracked || !Array.isArray(symbols)) return;
  const measured = symbols.filter((symbol) => symbol?.geometryMeasured !== false && validQuad(symbol?.quad));
  if (measured.length <= GEOMETRY_REPORTS_PER_FRAME) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const positioned = measured.map((symbol) => {
    const q = symbol.quad;
    const x = (q.topLeft.x + q.topRight.x + q.bottomRight.x + q.bottomLeft.x) * 0.25;
    const y = (q.topLeft.y + q.topRight.y + q.bottomRight.y + q.bottomLeft.y) * 0.25;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    return { symbol, x, y };
  });
  const midX = (minX + maxX) * 0.5;
  const midY = (minY + maxY) * 0.5;
  const groups = [[], [], [], []];
  for (const item of positioned) {
    const quadrant = (item.y >= midY ? 2 : 0) + Number(item.x >= midX);
    groups[quadrant].push(item.symbol);
  }

  // Rotate within each quadrant so persistent lens-residual learning eventually
  // samples every slot instead of only the four corners, while every individual
  // frame still reports geometry distributed across the wall.
  const selected = new Set();
  const sequence = Math.max(0, Math.trunc(Number(activeSourceSequence) || 0));
  for (let quadrant = 0; quadrant < groups.length; quadrant++) {
    const group = groups[quadrant];
    if (group.length) selected.add(group[(sequence + quadrant) % group.length]);
  }
  if (selected.size < GEOMETRY_REPORTS_PER_FRAME) {
    const offset = measured.length ? sequence % measured.length : 0;
    for (let step = 0; step < measured.length && selected.size < GEOMETRY_REPORTS_PER_FRAME; step++) {
      selected.add(measured[(offset + step) % measured.length]);
    }
  }
  for (const symbol of measured) {
    if (!selected.has(symbol)) symbol.geometryMeasured = false;
  }
}

// worker.js posts through ctx === self, so this interception applies to its
// final result without changing the codec. Preflight/signature messages have no
// symbols and pass straight through.
self.postMessage = (message, transfer) => {
  thinGeometryReports(message?.symbols);
  return nativePostMessage(message, transfer);
};

function pooledTrack(index) {
  let track = trackPool[index];
  if (!track) {
    track = {
      id: 0,
      slot: undefined,
      misses: 0,
      dim: 0,
      crc32: false,
      temporalProbe: false,
      temporalRisk: 0,
      quad: {
        topLeft: { x: 0, y: 0 },
        topRight: { x: 0, y: 0 },
        bottomRight: { x: 0, y: 0 },
        bottomLeft: { x: 0, y: 0 }
      }
    };
    trackPool[index] = track;
  }
  return track;
}

function unpackTracks(message) {
  const buffer = message?.__airgapperPackedTracks;
  const count = Math.trunc(Number(message?.__airgapperPackedTrackCount) || 0);
  if (!(buffer instanceof ArrayBuffer) || count <= 0 || buffer.byteLength < count * PACKED_TRACK_BYTES) return;
  const view = new DataView(buffer);
  activeTracks.length = count;
  for (let index = 0; index < count; index++) {
    const base = index * PACKED_TRACK_BYTES;
    const track = pooledTrack(index);
    const slot = view.getInt32(base + 4, true);
    const flags = view.getUint32(base + 16, true);
    track.id = view.getInt32(base, true);
    track.slot = slot >= 0 ? slot : undefined;
    track.misses = view.getInt32(base + 8, true);
    track.dim = view.getInt32(base + 12, true);
    track.crc32 = Boolean(flags & 1);
    track.temporalProbe = Boolean(flags & 2);
    track.temporalRisk = view.getFloat32(base + 20, true);
    const q = track.quad;
    q.topLeft.x = view.getFloat32(base + 24, true);
    q.topLeft.y = view.getFloat32(base + 28, true);
    q.topRight.x = view.getFloat32(base + 32, true);
    q.topRight.y = view.getFloat32(base + 36, true);
    q.bottomRight.x = view.getFloat32(base + 40, true);
    q.bottomRight.y = view.getFloat32(base + 44, true);
    q.bottomLeft.x = view.getFloat32(base + 48, true);
    q.bottomLeft.y = view.getFloat32(base + 52, true);
    activeTracks[index] = track;
  }
  message.tracks = activeTracks;
  delete message.__airgapperPackedTracks;
  delete message.__airgapperPackedTrackCount;
}

self.onmessage = (event) => {
  const message = event?.data;
  if (!message) return baseOnMessage?.call(self, event);

  activeSourceSequence = Number(message.sourceSequence);
  activeLiveTracked = Boolean(message.__airgapperLiveTracked);
  delete message.__airgapperLiveTracked;
  unpackTracks(message);

  if (!message.__airgapperWorkerLumaFromRgba) {
    return baseOnMessage?.call(self, event);
  }

  const rgbaBuffer = message.videoFrame;
  const width = Math.trunc(Number(message.w) || 0);
  const height = Math.trunc(Number(message.h) || 0);
  const pixelCount = width * height;

  if (!(rgbaBuffer instanceof ArrayBuffer) || width <= 0 || height <= 0 ||
      pixelCount <= 0 || rgbaBuffer.byteLength < pixelCount * 4) {
    const fallback = message;
    fallback.buf = rgbaBuffer;
    fallback.videoFrame = undefined;
    delete fallback.__airgapperWorkerLumaFromRgba;
    return baseOnMessage?.call(self, { data: fallback });
  }

  // Safe forward compaction: for every pixel after the first, the green source
  // byte (4*n+1) is ahead of destination n, so no future source byte is
  // overwritten. The original transferred RGBA allocation becomes the Y8 input
  // with zero additional multi-megabyte allocation and no second frame copy.
  const bytes = new Uint8Array(rgbaBuffer, 0, pixelCount * 4);
  for (let dst = 0, src = 1; dst < pixelCount; dst++, src += 4) bytes[dst] = bytes[src];

  message.buf = undefined;
  message.videoFrame = rgbaBuffer;
  message.pixelFormat = "y8";
  message.yOffset = 0;
  message.yStride = width;
  message.payloadBytes = pixelCount;
  message.guidedDecode = true;
  delete message.__airgapperWorkerLumaFromRgba;
  return baseOnMessage?.call(self, { data: message });
};
