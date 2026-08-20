from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


replace_once(
    "android/app/src/main/java/com/airgapper/app/NativeCameraBridge.java",
    '            String[] orderedKeys = sizeKeys.stream().filter(STANDARD_SIZES::contains).toArray(String[]::new);\n            Arrays.sort(orderedKeys, Comparator.comparingLong(NativeCameraBridge::sizeArea));\n            for (String sizeKey : orderedKeys) {',
    '''            String[] orderedKeys = sizeKeys.toArray(new String[0]);
            Arrays.sort(orderedKeys, Comparator.comparingLong(NativeCameraBridge::sizeArea));
            for (String sizeKey : orderedKeys) {
                long area = sizeArea(sizeKey);
                if (area < 640L * 480L || area > 4096L * 2160L) continue;'''
)
replace_once(
    "android/app/src/main/java/com/airgapper/app/NativeCameraBridge.java",
    '                for (int fps : TEST_FPS) {\n                    Range<Integer> range = chooseFpsRange(ranges, fps);',
    '''                for (int fps : TEST_FPS) {
                    // Keep the 30 fps menu compact, but never hide a usable native
                    // 60 fps mode merely because it is not in our old browser-size list.
                    if (fps != 60 && !STANDARD_SIZES.contains(sizeKey)) continue;
                    Range<Integer> range = chooseFpsRange(ranges, fps);'''
)
replace_once(
    "receive/main.js",
    '    offerRetry("Native Camera2: no supported YUV camera mode found");',
    '    offerRetry("Native Camera2: no supported native camera mode found");'
)
replace_once(
    "receive/main.js",
    '''  } catch (error) {
    setNativeCameraFrameHandler();
    void stopNativeCamera();
    if (startAttempt !== cameraStartGen || receiverPaused) return;
    pool.resize(0);
    offerRetry(`Native Camera2: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }''',
    '''  } catch (error) {
    setNativeCameraFrameHandler();
    void stopNativeCamera();
    const message = error instanceof Error ? error.message : String(error);
    // Android may pause the Activity while its runtime camera-permission sheet
    // is on top. The native lifecycle deliberately cancels that pending open;
    // resume immediately starts a fresh request, so cancellation is not a
    // user-visible camera failure.
    if (message === "Camera start cancelled" || startAttempt !== cameraStartGen || receiverPaused) return;
    pool.resize(0);
    offerRetry(`Native Camera2: ${message}`);
    return;
  }'''
)

print("native camera runtime follow-up applied")
