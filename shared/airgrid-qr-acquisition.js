const AIRGRID_QR_ACQ_PREFIX = 'AG2';
const AIRGRID_QR_CENTERS = Object.freeze({
  TL: Object.freeze({ x: 0.13, y: 0.13 }),
  TR: Object.freeze({ x: 0.87, y: 0.13 }),
  BR: Object.freeze({ x: 0.87, y: 0.87 }),
  BL: Object.freeze({ x: 0.13, y: 0.87 })
});
const AIRGRID_QR_ORDER = Object.freeze(['TL', 'TR', 'BR', 'BL']);

function encodeAirGridQrAcquisition(config, corner) {
  if (!AIRGRID_QR_CENTERS[corner]) throw new Error(`unknown AirGrid acquisition corner ${corner}`);
  const mode = config.modulation === 'pam4' ? 'P' : 'B';
  const payloadId = (config.payloadId >>> 0).toString(16).padStart(8, '0');
  return [
    AIRGRID_QR_ACQ_PREFIX,
    corner,
    mode,
    Math.round(config.columns),
    Math.round(config.lanes),
    Math.round(config.senderHz),
    payloadId
  ].join('|');
}

function parseAirGridQrAcquisition(value) {
  const parts = String(value ?? '').trim().split('|');
  if (parts.length !== 7 || parts[0] !== AIRGRID_QR_ACQ_PREFIX) return null;
  const corner = parts[1];
  if (!AIRGRID_QR_CENTERS[corner]) return null;
  const modulation = parts[2] === 'P' ? 'pam4' : parts[2] === 'B' ? 'binary' : null;
  if (!modulation) return null;
  const columns = Number(parts[3]);
  const lanes = Number(parts[4]);
  const senderHz = Number(parts[5]);
  const payloadId = Number.parseInt(parts[6], 16);
  if (!Number.isInteger(columns) || columns < 64 || columns > 65535) return null;
  if (!Number.isInteger(lanes) || lanes < 8 || lanes > 65535) return null;
  if (!Number.isInteger(senderHz) || senderHz < 1 || senderHz > 1000) return null;
  if (!Number.isFinite(payloadId)) return null;
  return { corner, modulation, columns, lanes, senderHz, payloadId: payloadId >>> 0 };
}

function airGridQrConfigKey(config) {
  return config ? `${config.modulation}:${config.columns}:${config.lanes}:${config.senderHz}:${config.payloadId >>> 0}` : '';
}

export {
  AIRGRID_QR_ACQ_PREFIX,
  AIRGRID_QR_CENTERS,
  AIRGRID_QR_ORDER,
  airGridQrConfigKey,
  encodeAirGridQrAcquisition,
  parseAirGridQrAcquisition
};
