interface AndroidBridge {
  beginDownload(name: string, type: string): void;
  appendDownloadChunk(base64: string): void;
  finishDownload(): void;
  copyText(text: string): void;
  setKeepScreenOn(enabled: boolean): void;
  setTrackingBoxes(json: string): void;
}

function bridge(): AndroidBridge | undefined {
  return (window as Window & { AirGapperAndroid?: AndroidBridge }).AirGapperAndroid;
}

export function isAndroidApp(): boolean {
  return bridge() !== undefined;
}

export function saveFileOnAndroid(name: string, type: string, bytes: Uint8Array): boolean {
  const android = bridge();
  if (!android) return false;
  android.beginDownload(name, type);
  const chunkSize = 48 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
    let binary = "";
    for (const byte of chunk) binary += String.fromCharCode(byte);
    android.appendDownloadChunk(btoa(binary));
  }
  android.finishDownload();
  return true;
}

export function copyTextOnAndroid(text: string): boolean {
  const android = bridge();
  if (!android) return false;
  android.copyText(text);
  return true;
}

export function setAndroidKeepScreenOn(enabled: boolean): void {
  bridge()?.setKeepScreenOn(enabled);
}

export interface AndroidTrackingBox {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  alpha: number;
  successful: boolean;
}

export function setAndroidTrackingBoxes(boxes: AndroidTrackingBox[]): void {
  bridge()?.setTrackingBoxes(JSON.stringify(boxes));
}
