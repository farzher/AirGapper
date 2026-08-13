interface AndroidBridge {
  beginDownload(name: string, type: string): void;
  appendDownloadChunk(base64: string): void;
  finishDownload(): void;
  copyText(text: string): void;
  setKeepScreenOn(enabled: boolean): void;
  is64BitProcess?(): boolean;
}

function bridge(): AndroidBridge | undefined {
  return (window as Window & { AirGapperAndroid?: AndroidBridge }).AirGapperAndroid;
}

export function isAndroidApp(): boolean {
  return bridge() !== undefined;
}

export function isLegacyAndroidApp(): boolean {
  const android = bridge();
  return android !== undefined && android.is64BitProcess?.() === false;
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
