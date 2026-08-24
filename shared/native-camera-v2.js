const unavailable = () => false;
const unsupported = async () => ({ supported: false, reason: "Native camera backend removed" });
const startUnsupported = async () => { throw new Error("Native camera backend removed"); };

export const nativeCameraV2Available = unavailable;
export const nativeCameraV2Track = () => undefined;
export const listNativeCamerasV2 = unsupported;
export const startNativeCameraV2 = startUnsupported;
export const stopNativeCameraV2 = async () => {};
export const submitNativeCameraV2Plan = async () => false;
export const setNativeCameraV2FrameHandler = () => {};
export const setNativeCameraV2PreviewHandler = () => {};
export const setNativeCameraV2ResultHandler = () => {};
