// Keep the QR overlay in the exact coordinate space used by the decoder.
// Safari/WebKit can expose a <video> presentation size that differs from the
// VideoFrame display/visible dimensions consumed by Receive. runtime.js draws
// overlay geometry using the <video> size, so compensate only when those two
// spaces actually differ. Matching cameras pay no per-frame transform cost.
let decodeWidth = 0;
let decodeHeight = 0;

function noteDecodeFrame(frame) {
  if (!frame) return;
  const width = Number(frame.displayWidth || frame.visibleRect?.width || frame.codedWidth || 0);
  const height = Number(frame.displayHeight || frame.visibleRect?.height || frame.codedHeight || 0);
  if (width > 0 && height > 0) {
    decodeWidth = width;
    decodeHeight = height;
  }
}

// track-processor-proxy.js is loaded immediately before this module, so wrap
// whichever processor implementation it installed. The wrapper changes no
// ownership or scheduling behavior; it only observes frames returned by read().
const PriorProcessor = globalThis.MediaStreamTrackProcessor;
if (typeof PriorProcessor === "function" && !PriorProcessor.__airgapperOverlayCoordinates) {
  function OverlayCoordinateProcessor(options) {
    const processor = new PriorProcessor(options);
    const readable = processor?.readable;
    if (readable && typeof readable.getReader === "function") {
      const priorGetReader = readable.getReader.bind(readable);
      readable.getReader = (...args) => {
        const reader = priorGetReader(...args);
        if (!reader || typeof reader.read !== "function") return reader;
        const priorRead = reader.read.bind(reader);
        reader.read = (...readArgs) => priorRead(...readArgs).then((result) => {
          if (!result?.done) noteDecodeFrame(result?.value);
          return result;
        });
        return reader;
      };
    }
    return processor;
  }
  OverlayCoordinateProcessor.prototype = PriorProcessor.prototype;
  try { Object.setPrototypeOf(OverlayCoordinateProcessor, PriorProcessor); } catch {}
  Object.defineProperty(OverlayCoordinateProcessor, "__airgapperOverlayCoordinates", { value: true });
  try { globalThis.MediaStreamTrackProcessor = OverlayCoordinateProcessor; } catch {}
}

const nativeClearRect = globalThis.CanvasRenderingContext2D?.prototype?.clearRect;
if (typeof nativeClearRect === "function" && !nativeClearRect.__airgapperOverlayCoordinates) {
  function overlayCoordinateClearRect(x, y, width, height) {
    if (this?.canvas?.id !== "detect-overlay") return nativeClearRect.call(this, x, y, width, height);

    // runtime.js intentionally resets to identity immediately before clearing.
    // Clear the whole backing canvas in that identity space first.
    nativeClearRect.call(this, x, y, width, height);

    const video = document.getElementById("video");
    const canvas = this.canvas;
    const previewWidth = Number(video?.videoWidth) || 0;
    const previewHeight = Number(video?.videoHeight) || 0;
    const physicalWidth = Number(canvas.width) || 0;
    const physicalHeight = Number(canvas.height) || 0;
    if (!(decodeWidth > 0) || !(decodeHeight > 0) || !(previewWidth > 0) || !(previewHeight > 0) ||
        !(physicalWidth > 0) || !(physicalHeight > 0)) return;

    if (decodeWidth === previewWidth && decodeHeight === previewHeight) return;

    const previewScale = Math.min(physicalWidth / previewWidth, physicalHeight / previewHeight);
    const decodeScale = Math.min(physicalWidth / decodeWidth, physicalHeight / decodeHeight);
    if (!(previewScale > 0) || !(decodeScale > 0)) return;

    // runtime's existing mapping is:
    //   previewOffset + decodeCoordinate * previewScale
    // Convert that affine result into the correct contain mapping:
    //   decodeOffset + decodeCoordinate * decodeScale
    const previewOffsetX = (physicalWidth - previewWidth * previewScale) * 0.5;
    const previewOffsetY = (physicalHeight - previewHeight * previewScale) * 0.5;
    const decodeOffsetX = (physicalWidth - decodeWidth * decodeScale) * 0.5;
    const decodeOffsetY = (physicalHeight - decodeHeight * decodeScale) * 0.5;
    const scale = decodeScale / previewScale;
    const translateX = decodeOffsetX - previewOffsetX * scale;
    const translateY = decodeOffsetY - previewOffsetY * scale;
    this.setTransform(scale, 0, 0, scale, translateX, translateY);
  }
  Object.defineProperty(overlayCoordinateClearRect, "__airgapperOverlayCoordinates", { value: true });
  try { globalThis.CanvasRenderingContext2D.prototype.clearRect = overlayCoordinateClearRect; } catch {}
}
