package com.airgapper.app;

import java.nio.ByteBuffer;

/** Thin JNI entry point for the existing AirGapper C++ QR codec. */
final class NativeDecoder {
    static {
        System.loadLibrary("airgapper_native");
    }

    private NativeDecoder() {}

    static native byte[] decodeGuided(
            ByteBuffer yPlane,
            int yOffset,
            int width,
            int height,
            int stride,
            int[] ids,
            int[] dimensions,
            float[] quads,
            int fallbackMask,
            int repairMask,
            int jobId,
            int sourceSequence,
            long frameNumber,
            long timestampNs,
            long exposureNs,
            long frameDurationNs,
            long rollingShutterSkewNs,
            float focusDistance,
            int iso,
            int settingsEpoch,
            int orientation,
            int pipeline);

    static native byte[] decodeFull(
            ByteBuffer yPlane,
            int yOffset,
            int width,
            int height,
            int stride,
            int cropX,
            int cropY,
            int cropWidth,
            int cropHeight,
            boolean tryHarder,
            boolean tryDownscale,
            int maxSymbols,
            boolean returnErrors,
            int jobId,
            int sourceSequence,
            long frameNumber,
            long timestampNs,
            long exposureNs,
            long frameDurationNs,
            long rollingShutterSkewNs,
            float focusDistance,
            int iso,
            int settingsEpoch,
            int orientation,
            int pipeline);
}
