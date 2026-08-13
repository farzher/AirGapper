interface AndroidBridge {
  beginDownload(name: string, type: string): void;
  appendDownloadChunk(base64: string): void;
  finishDownload(): void;
  copyText(text: string): void;
  setKeepScreenOn(enabled: boolean): void;
  getNativeCameraCapabilities(): string;
  setNativePreviewBounds(left: number, top: number, width: number, height: number): void;
  startNativeCamera(mode: string): void;
  stopNativeCamera(): void;
  setNativeTorch(enabled: boolean): void;
  setNativeExposure(value: number): void;
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

export interface NativeCameraMode {
  key: string;
  cameraId: string;
  width: number;
  height: number;
  fpsMin: number;
  fpsMax: number;
  highSpeed: boolean;
  preview: boolean;
  analysis: boolean;
  autofocus: boolean;
  torch: boolean;
  stabilization: boolean;
  exposureMin: number;
  exposureMax: number;
}

export interface NativeCameraCapabilities {
  decoderAvailable: boolean;
  error?: string;
  modes: NativeCameraMode[];
}

export function nativeCameraCapabilities(): NativeCameraCapabilities | undefined {
  const android = bridge();
  if (!android?.getNativeCameraCapabilities) return undefined;
  try {
    return JSON.parse(android.getNativeCameraCapabilities()) as NativeCameraCapabilities;
  } catch {
    return undefined;
  }
}

export function setNativePreviewBounds(rect: DOMRect): void {
  bridge()?.setNativePreviewBounds(
    Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height),
  );
}

export function startNativeCamera(mode: string): void {
  bridge()?.startNativeCamera(mode);
}

export function stopNativeCamera(): void {
  bridge()?.stopNativeCamera();
}

export function setNativeTorch(enabled: boolean): void { bridge()?.setNativeTorch(enabled); }
export function setNativeExposure(value: number): void { bridge()?.setNativeExposure(value); }

