import { makeAirGridPayload } from '../shared/airgrid-phy.js';
import { decodeAirGridY8Detailed } from './airgrid-sampler.js';

const now = () => globalThis.performance?.now?.() ?? Date.now();

async function copyVideoFrameY8(frame) {
  const width = frame.codedWidth || frame.displayWidth;
  const height = frame.codedHeight || frame.displayHeight;
  const yBytes = width * height;
  const chromaWidth = Math.ceil(width / 2);
  const chromaHeight = Math.ceil(height / 2);
  const chromaBytes = chromaWidth * chromaHeight;
  const started = now();
  try {
    const buffer = new Uint8Array(yBytes + chromaBytes * 2);
    await frame.copyTo(buffer, {
      format: 'I420',
      layout: [
        { offset: 0, stride: width },
        { offset: yBytes, stride: chromaWidth },
        { offset: yBytes + chromaBytes, stride: chromaWidth }
      ]
    });
    return { y8: buffer.subarray(0, yBytes), width, height, copyMs: now() - started, copyPath: 'videoframe-i420' };
  } catch {
    const rgba = new Uint8Array(yBytes * 4);
    await frame.copyTo(rgba, { format: 'RGBA', layout: [{ offset: 0, stride: width * 4 }] });
    const y8 = new Uint8Array(yBytes);
    for (let i = 0, p = 0; i < yBytes; i++, p += 4) {
      y8[i] = Math.max(0, Math.min(255, Math.round(rgba[p] * 0.2126 + rgba[p + 1] * 0.7152 + rgba[p + 2] * 0.0722)));
    }
    return { y8, width, height, copyMs: now() - started, copyPath: 'videoframe-rgba-fallback' };
  }
}

function verifyLane(lane) {
  const expected = makeAirGridPayload(lane.payload.length, lane.payloadId, lane.sequence, lane.laneIndex);
  if (expected.length !== lane.payload.length) return false;
  for (let i = 0; i < expected.length; i++) if (expected[i] !== lane.payload[i]) return false;
  return true;
}
function summarizeLanes(lanes, verifiedSet) {
  return lanes.map(lane => ({
    laneIndex: lane.laneIndex,
    sequence: lane.sequence,
    payloadId: lane.payloadId,
    payloadBytes: lane.payload?.length ?? 0,
    verified: verifiedSet.has(lane),
    separation: lane.separation,
    snr: lane.snr,
    confidence: lane.confidence,
    preambleErrors: lane.preambleErrors
  }));
}

self.onmessage = async event => {
  const message = event.data;
  if (message?.action !== 'decode') return;
  const started = now();
  let frame;
  try {
    let source;
    if (message.frame) {
      frame = message.frame;
      source = await copyVideoFrameY8(frame);
    } else if (message.y8 instanceof ArrayBuffer) {
      source = {
        y8: new Uint8Array(message.y8),
        width: message.width,
        height: message.height,
        copyMs: Number(message.copyMs) || 0,
        copyPath: message.copyPath || 'canvas-rgba'
      };
    } else throw new Error('AirGrid worker received no frame');

    const decodeStarted = now();
    const result = decodeAirGridY8Detailed({
      y8: source.y8,
      width: source.width,
      height: source.height,
      quad: message.quad,
      profile: message.profile,
      minSeparation: message.minSeparation ?? 18,
      includeLaneDiagnostics: Boolean(message.includeLaneDiagnostics)
    });
    const verifiedSet = new Set();
    for (const lane of result.lanes) if (verifyLane(lane)) verifiedSet.add(lane);
    const crcValidLanes = result.lanes.length;
    const verifiedLanes = verifiedSet.size;
    const patternMismatches = crcValidLanes - verifiedLanes;
    const payloadBytes = result.diagnostics.decode.payloadBytesPerLane;
    result.diagnostics.decode.crcValidLanes = crcValidLanes;
    result.diagnostics.decode.crcValidBytes = crcValidLanes * payloadBytes;
    result.diagnostics.decode.patternMismatches = patternMismatches;
    result.diagnostics.decode.validLanes = verifiedLanes;
    result.diagnostics.decode.validLaneRate = verifiedLanes / Math.max(1, result.diagnostics.decode.totalLanes);
    result.diagnostics.decode.bytesDecoded = verifiedLanes * payloadBytes;
    result.diagnostics.decode.utilization = result.diagnostics.decode.bytesDecoded / Math.max(1, result.diagnostics.decode.capacityBytes);
    result.diagnostics.decode.failures.patternMismatch = patternMismatches;
    const decodeWallMs = now() - decodeStarted;
    self.postMessage({
      type: 'decoded',
      generation: message.generation,
      frameId: message.frameId,
      captureTimestampMs: message.captureTimestampMs,
      queueMs: Math.max(0, started - (Number(message.sentAtMs) || started)),
      copyMs: source.copyMs,
      copyPath: source.copyPath,
      decodeWallMs,
      wallMs: now() - started,
      diagnostics: result.diagnostics,
      lanes: summarizeLanes(result.lanes, verifiedSet)
    });
  } catch (error) {
    self.postMessage({ type: 'error', generation: message?.generation, frameId: message?.frameId, error: error?.message || String(error) });
  } finally {
    try { frame?.close(); } catch {}
  }
};
