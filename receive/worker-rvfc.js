// Worker wrapper for canvas/rVFC camera frames.
//
// runtime.js sometimes has to capture an RGBA canvas frame when
// MediaStreamTrackProcessor is unavailable. Historically worker-pool.js packed
// that entire 1440p RGBA buffer to Y8 on the browser main thread before posting
// it here. That starves requestVideoFrameCallback itself on slower phones.
// Keep the same Guided Y8 decoder, but do the achromatic green-channel pack in
// the decode worker where multiple frames can run in parallel.

const query = self.location.search || "";
await import(`./worker.js${query}`);

const baseOnMessage = self.onmessage;

self.onmessage = (event) => {
  const message = event?.data;
  if (!message?.__airgapperWorkerLumaFromRgba) {
    return baseOnMessage?.call(self, event);
  }

  const rgbaBuffer = message.videoFrame;
  const width = Math.trunc(Number(message.w) || 0);
  const height = Math.trunc(Number(message.h) || 0);
  const pixelCount = width * height;

  if (!(rgbaBuffer instanceof ArrayBuffer) || width <= 0 || height <= 0 ||
      pixelCount <= 0 || rgbaBuffer.byteLength < pixelCount * 4) {
    // Preserve the old generic RGBA fallback if the handoff is malformed.
    const fallback = { ...message, buf: rgbaBuffer, videoFrame: undefined };
    delete fallback.__airgapperWorkerLumaFromRgba;
    return baseOnMessage?.call(self, { data: fallback });
  }

  const rgba = new Uint8Array(rgbaBuffer, 0, pixelCount * 4);
  const y8 = new Uint8Array(pixelCount);
  for (let dst = 0, src = 1; dst < pixelCount; dst++, src += 4) y8[dst] = rgba[src];

  const next = {
    ...message,
    buf: undefined,
    videoFrame: y8.buffer,
    pixelFormat: "y8",
    yOffset: 0,
    yStride: width,
    payloadBytes: pixelCount,
    guidedDecode: true
  };
  delete next.__airgapperWorkerLumaFromRgba;
  return baseOnMessage?.call(self, { data: next });
};
