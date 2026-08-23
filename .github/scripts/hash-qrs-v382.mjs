import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(process.argv[2]).href + `?v=${Date.now()}`);
const QRCode = mod.default;
const cases = [
  [500, 15],
  [1000, 22],
  [1465, 27],
  [1850, 32],
  [2331, 36],
  [2953, 40]
];
const out = [];
for (const [length, version] of cases) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 73 + length * 11 + (i >>> 3)) & 255;
  const qr = QRCode.create([{ data: bytes, mode: 'byte' }], {
    errorCorrectionLevel: 'L', version, maskPattern: 4
  });
  const hash = crypto.createHash('sha256').update(qr.modules.data).digest('hex');
  out.push(`${length}:${qr.version}:${qr.modules.size}:${hash}`);
}
console.log(out.join('\n'));
