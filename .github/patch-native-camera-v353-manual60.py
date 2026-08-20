from pathlib import Path

p = Path("android/app/src/main/java/com/airgapper/app/NativeCameraBridge.java")
text = p.read_text()
old = '''                    } else {
                        builder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
                        if (activeFpsRange != null) builder.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, activeFpsRange);
                        currentExposureMode = "continuous";
                    }
                }
                if (patch.has("exposureTime")) {'''
new = '''                    } else if ("manual".equals(activeFpsControl)) {
                        // This stream can sustain the requested frame duration,
                        // but the HAL did not advertise a matching hardware-AE
                        // FPS range. Keep sensor timing manual rather than asking
                        // AE for an unsupported range. AutoOptics can still read
                        // the current exposure/ISO as its baseline and then tune
                        // the same manual sensor controls.
                        builder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_OFF);
                        builder.set(CaptureRequest.SENSOR_FRAME_DURATION, activeFrameDurationNs);
                        currentExposureMode = "manual";
                    } else {
                        builder.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
                        if (activeFpsRange != null) builder.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, activeFpsRange);
                        currentExposureMode = "continuous";
                    }
                }
                if (patch.has("exposureTime")) {'''
if text.count(old) != 1:
    raise SystemExit(f"manual-60 AE guard seam mismatch: {text.count(old)}")
text = text.replace(old, new, 1)
p.write_text(text)
print("manual 60fps AutoOptics guard applied")
