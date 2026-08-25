// The detailed detect overlay exists only in Developer Mode. Keep its legacy
// canvas-coordinate correction out of normal receiving so normal users never
// patch CanvasRenderingContext2D.prototype.
const nativeClearRect = globalThis.CanvasRenderingContext2D?.prototype?.clearRect;
if (typeof nativeClearRect === "function" && !nativeClearRect.__airgapperOverlayCoordinates) {
  function overlayCoordinateClearRect(x, y, width, height) {
    if (this?.canvas?.id !== "detect-overlay") return nativeClearRect.call(this, x, y, width, height);

    nativeClearRect.call(this, x, y, width, height);

    const decode = globalThis.__airgapperDecoderDisplaySize?.() ?? {};
    const decodeWidth = Number(decode.width) || 0;
    const decodeHeight = Number(decode.height) || 0;
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
