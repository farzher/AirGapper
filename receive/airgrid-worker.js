import { makeAirGridPayload } from '../shared/airgrid-phy.js';
import { makeAirGridBlockPayload } from '../shared/airgrid-block.js';
import { decodeAirGridY8Detailed } from './airgrid-sampler.js';
import { decodeAirGridPam4Y8Detailed } from './airgrid-pam4-sampler.js';
import { decodeAirGridBlockY8Detailed } from './airgrid-block-sampler.js';

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

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function verifyUnit(unit, message) {
  if (message.profile?.blockMode) {
    return bytesEqual(unit.payload, makeAirGridBlockPayload(unit.payload.length, message.payloadId >>> 0, unit.sequence, unit.laneIndex, unit.blockIndex));
  }
  return bytesEqual(unit.payload, makeAirGridPayload(unit.payload.length, unit.payloadId, unit.sequence, unit.laneIndex));
}
function summarizeUnits(units, verifiedSet) {
  return units.map(unit => ({
    laneIndex:unit.laneIndex,
    blockIndex:unit.blockIndex,
    sequence:unit.sequence,
    payloadId:unit.payloadId,
    payloadBytes:unit.payload?.length ?? unit.payloadBytes ?? 0,
    verified:verifiedSet.has(unit),
    modulation:unit.modulation ?? 'binary',
    separation:unit.separation,
    snr:unit.snr,
    confidence:unit.confidence,
    evm:unit.evm,
    centers:unit.centers,
    preambleErrors:unit.preambleErrors,
    corrected:unit.corrected,
    syncErrors:unit.syncErrors,
    phaseX:unit.phaseX,
    phaseY:unit.phaseY
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
        y8:new Uint8Array(message.y8),
        width:message.width,
        height:message.height,
        copyMs:Number(message.copyMs) || 0,
        copyPath:message.copyPath || 'canvas-rgba'
      };
    } else throw new Error('AirGrid worker received no frame');

    const decodeStarted = now();
    const decodeOptions = {
      y8:source.y8,
      width:source.width,
      height:source.height,
      quad:message.quad,
      profile:message.profile,
      minSeparation:message.minSeparation ?? (message.modulation === 'pam4' ? 8 : 18),
      includeLaneDiagnostics:Boolean(message.includeLaneDiagnostics)
    };
    let result;
    if (message.profile?.blockMode) result = decodeAirGridBlockY8Detailed(decodeOptions);
    else if (message.modulation === 'pam4') result = decodeAirGridPam4Y8Detailed(decodeOptions);
    else result = decodeAirGridY8Detailed(decodeOptions);

    const verifiedSet = new Set();
    let crcValidBytes = 0;
    let verifiedBytes = 0;
    for (const unit of result.lanes) {
      const bytes = unit.payload?.length ?? 0;
      crcValidBytes += bytes;
      if (verifyUnit(unit, message)) {
        verifiedSet.add(unit);
        verifiedBytes += bytes;
      }
    }
    const crcValidLanes = result.lanes.length;
    const verifiedLanes = verifiedSet.size;
    const patternMismatches = crcValidLanes - verifiedLanes;
    const decode = result.diagnostics.decode;
    decode.crcValidLanes = crcValidLanes;
    decode.crcValidBytes = crcValidBytes;
    decode.patternMismatches = patternMismatches;
    decode.validLanes = verifiedLanes;
    decode.validLaneRate = verifiedLanes / Math.max(1, decode.totalLanes);
    decode.bytesDecoded = verifiedBytes;
    decode.utilization = verifiedBytes / Math.max(1, decode.capacityBytes);
    decode.failures.patternMismatch = patternMismatches;
    const decodeWallMs = now() - decodeStarted;

    self.postMessage({
      type:'decoded',
      generation:message.generation,
      frameId:message.frameId,
      modulation:message.modulation ?? 'binary',
      blockMode:Boolean(message.profile?.blockMode),
      captureTimestampMs:message.captureTimestampMs,
      queueMs:Math.max(0, started - (Number(message.sentAtMs) || started)),
      copyMs:source.copyMs,
      copyPath:source.copyPath,
      decodeWallMs,
      wallMs:now() - started,
      diagnostics:result.diagnostics,
      lanes:summarizeUnits(result.lanes, verifiedSet)
    });
  } catch (error) {
    self.postMessage({ type:'error', generation:message?.generation, frameId:message?.frameId, error:error?.message || String(error) });
  } finally {
    try { frame?.close(); } catch {}
  }
};
