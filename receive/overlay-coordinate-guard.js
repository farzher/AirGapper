// Keep overlay geometry in the exact coordinate space presented by <video>.
// Safari/WebKit may expose raw VideoFrame coordinates in landscape while the
// camera preview is portrait. Decoder geometry stays in raw-frame space.
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

// Observe frames from the already-selected processor without changing camera
// ownership or scheduling. Presentation-only geometry stays outside the decoder.
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
