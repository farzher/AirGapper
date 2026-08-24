const unavailable = () => false;
const unsupported = async () => ({ supported: false, reason: "Native camera backend removed" });
const startUnsupported = async () => { throw new Error("Native camera backend removed"); };

export const nativeCameraAvailable = unavailable;
export const nativeCameraTrack = () => undefined;
export const listNativeCameras = unsupported;
export const startNativeCamera = startUnsupported;
export const stopNativeCamera = async () => {};
export const ackNativeCameraFrame = () => {};
export const setNativeCameraFrameHandler = () => {};
