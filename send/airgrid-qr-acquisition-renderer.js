import QRCode from '../vendor/qrcode.js';
import {
  AIRGRID_QR_CENTERS,
  AIRGRID_QR_ORDER,
  encodeAirGridQrAcquisition
} from '../shared/airgrid-qr-acquisition.js';

function qrMatrix(text) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  return { size: qr.modules.size, data: qr.modules.data };
}

function renderQrMatrix(ctx, matrix, x0, y0, sidePx) {
  const quiet = 4;
  const logical = matrix.size + quiet * 2;
  const modulePx = Math.max(2, Math.floor(sidePx / logical));
  const side = logical * modulePx;
  const ox = Math.round(x0 + (sidePx - side) * 0.5);
  const oy = Math.round(y0 + (sidePx - side) * 0.5);
  ctx.fillStyle = '#fff';
  ctx.fillRect(ox, oy, side, side);
  ctx.fillStyle = '#000';
  for (let y = 0; y < matrix.size; y++) {
    const row = y * matrix.size;
    for (let x = 0; x < matrix.size; x++) {
      if (!matrix.data[row + x]) continue;
      ctx.fillRect(
        ox + (x + quiet) * modulePx,
        oy + (y + quiet) * modulePx,
        modulePx,
        modulePx
      );
    }
  }
  return { x: ox, y: oy, side, modulePx, logical };
}

class AirGridQrAcquisitionRenderer {
  constructor() {
    this.key = '';
    this.matrices = new Map();
  }

  prepare(config) {
    const key = `${config.modulation}:${config.columns}:${config.lanes}:${config.senderHz}:${config.payloadId >>> 0}`;
    if (key === this.key) return;
    this.key = key;
    this.matrices.clear();
    for (const corner of AIRGRID_QR_ORDER) {
      this.matrices.set(corner, qrMatrix(encodeAirGridQrAcquisition(config, corner)));
    }
  }

  render(ctx, width, height, config, build = '') {
    this.prepare(config);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = 'copy';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);

    const targetSide = Math.max(160, Math.floor(Math.min(width, height) * 0.235));
    for (const corner of AIRGRID_QR_ORDER) {
      const center = AIRGRID_QR_CENTERS[corner];
      const x0 = center.x * width - targetSide * 0.5;
      const y0 = center.y * height - targetSide * 0.5;
      renderQrMatrix(ctx, this.matrices.get(corner), x0, y0, targetSide);
    }

    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.max(24, Math.floor(Math.min(width, height) * 0.035))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillText('AIRGRID ACQUIRE', width * 0.5, height * 0.46);
    ctx.font = `${Math.max(16, Math.floor(Math.min(width, height) * 0.022))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    if (build) ctx.fillText(build, width * 0.5, height * 0.53);
    ctx.fillText(`${config.modulation.toUpperCase()} · ${config.columns}×${config.lanes} · ${config.senderHz} Hz`, width * 0.5, height * 0.59);
    ctx.restore();
  }
}

export { AirGridQrAcquisitionRenderer };
