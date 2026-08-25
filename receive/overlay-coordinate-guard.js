// Keep overlay geometry in the exact coordinate space presented by <video>.
// Safari/WebKit may expose raw VideoFrame coordinates in landscape while the
// camera preview is portrait. Decoder geometry stays in raw-frame space; this
// module owns the presentation-only transform used by both receiver overlays.
let decodeWidth = 0;
let decodeHeight = 0;

globalThis.__airgapperDecoderDisplaySize = () => ({ width: decodeWidth, height: decodeHeight });

function noteDecodeFrame(frame) {
  if (!frame) return;
  const width = Number(frame.displayWidth || frame.visibleRect?.width || frame.codedWidth || 0);
  const height = Number(frame.displayHeight || frame.visibleRect?.height || frame.codedHeight || 0);
  if (width > 0 && height > 0) {
    decodeWidth = width;
    decodeHeight = height;
  }
}

function overlayPresentation() {
  const video = document.getElementById("video");
  const previewWidth = Number(video?.videoWidth) || 0;
  const previewHeight = Number(video?.videoHeight) || 0;
  if (!(decodeWidth > 0) || !(decodeHeight > 0) || !(previewWidth > 0) || !(previewHeight > 0)) return null;

  if (decodeWidth === previewWidth && decodeHeight === previewHeight) {
    return {
      width: previewWidth,
      height: previewHeight,
      rotation: 0,
      mapPoint(point) { return { x: point.x, y: point.y }; }
    };
  }

  // iOS commonly delivers a landscape VideoFrame while <video> presents the
  // same back-camera image rotated clockwise into portrait. Keep decoding in
  // the raw landscape buffer and rotate only overlay presentation coordinates.
  if (decodeWidth === previewHeight && decodeHeight === previewWidth) {
    return {
      width: previewWidth,
      height: previewHeight,
      rotation: 90,
      mapPoint(point) {
        return { x: decodeHeight - point.y, y: point.x };
      }
    };
  }

  // Non-rotated dimension mismatches (visible crop / browser rescale) remain a
  // simple normalization into preview coordinates.
  const scaleX = previewWidth / decodeWidth;
  const scaleY = previewHeight / decodeHeight;
  return {
    width: previewWidth,
    height: previewHeight,
    rotation: 0,
    mapPoint(point) { return { x: point.x * scaleX, y: point.y * scaleY }; }
  };
}

globalThis.__airgapperOverlayPresentation = overlayPresentation;

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
    if (!(previewScale > 0)) return;
    const previewOffsetX = (physicalWidth - previewWidth * previewScale) * 0.5;
    const previewOffsetY = (physicalHeight - previewHeight * previewScale) * 0.5;

    if (decodeWidth === previewHeight && decodeHeight === previewWidth) {
      // runtime has already converted raw decoder coordinates as though they
      // were preview coordinates: p = previewOffset + raw * previewScale.
      // Rotate those already-scaled points clockwise into the actual portrait
      // preview. This affects drawing only; decoder/lattice coordinates stay raw.
      const translateX = previewOffsetX + previewOffsetY + previewWidth * previewScale;
      const translateY = previewOffsetY - previewOffsetX;
      this.setTransform(0, 1, -1, 0, translateX, translateY);
      return;
    }

    const decodeScale = Math.min(physicalWidth / decodeWidth, physicalHeight / decodeHeight);
    if (!(decodeScale > 0)) return;
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
