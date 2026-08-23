from pathlib import Path
import shutil


def replace_one(path, old, new, label):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing {label} in {path}")
    p.write_text(text.replace(old, new, 1))


def remove_one(path, old, label):
    replace_one(path, old, "", label)

# Receiver-only recovery code belongs under receive/, not shared/.
Path("shared/receiver-recovery-state.js").rename("receive/recovery-state.js")
Path("shared/receiver-recovery-policy.js").rename("receive/recovery-policy.js")

replace_one(
    "receive/recovery-policy.js",
    'import { FocusController } from "../receive/focus-controller.js";\nimport { GridLattice } from "../receive/grid-lattice.js";\nimport { DecodeWorkerPool } from "./worker-pool.js";\n',
    'import { FocusController } from "./focus-controller.js";\nimport { GridLattice } from "./grid-lattice.js";\nimport { DecodeWorkerPool } from "../shared/worker-pool.js";\n',
    "recovery policy local imports",
)
replace_one(
    "receive/recovery-policy.js",
    '} from "./receiver-recovery-state.js";',
    '} from "./recovery-state.js";',
    "recovery state import",
)
replace_one(
    "receive/camera-constraints.js",
    'import { installReceiverRecoveryPolicy } from "../shared/receiver-recovery-policy.js";',
    'import { installReceiverRecoveryPolicy } from "./recovery-policy.js";',
    "camera constraint recovery policy import",
)
replace_one(
    "receive/camera-constraints.js",
    '} from "../shared/receiver-recovery-state.js";',
    '} from "./recovery-state.js";',
    "camera constraint recovery state import",
)
replace_one(
    "benchmark/receiver-recovery-policy-smoke.mjs",
    '} from "../shared/receiver-recovery-state.js";',
    '} from "../receive/recovery-state.js";',
    "recovery smoke import",
)

# platform.js is genuinely shared again. Receive imports its camera-specific
# constraint policy directly instead of hiding a receiver dependency here.
p = Path("shared/platform.js")
s = p.read_text()
start = s.index("let cameraConstraintApply;")
end = s.index("export {", start)
s = s[:start] + s[end:]
s = s.replace("  applyAdvancedConstraint,\n", "")
p.write_text(s)
replace_one(
    "receive/runtime.js",
    'import { applyAdvancedConstraint, isAndroid, isIOS } from "../shared/platform.js";',
    'import { isAndroid, isIOS } from "../shared/platform.js";\nimport { applyAdvancedConstraint } from "./camera-constraints.js";',
    "runtime camera constraint import",
)

# The APK is a thin local-WebView wrapper. Browser getUserMedia is already the
# production/default receiver, so remove the experimental parallel Camera2/NDK
# implementation rather than maintaining two camera stacks.
p = Path("android/app/src/main/java/com/airgapper/app/MainActivity.java")
s = p.read_text()
for old, label in [
    ("    private NativeCameraBridge nativeCameraBridge;\n", "legacy camera field"),
    ("    private NativeCameraV2Bridge nativeCameraV2Bridge;\n", "v2 camera field"),
    ("        nativeCameraBridge = new NativeCameraBridge(this, webView);\n", "legacy camera init"),
    ("        nativeCameraV2Bridge = new NativeCameraV2Bridge(this, webView);\n", "v2 camera init"),
    ("        if (nativeCameraV2Bridge != null && nativeCameraV2Bridge.onRequestPermissionsResult(requestCode, results)) return;\n", "v2 permission hook"),
    ("        if (nativeCameraBridge != null && nativeCameraBridge.onRequestPermissionsResult(requestCode, results)) return;\n", "legacy permission hook"),
    ("        if (nativeCameraV2Bridge != null) nativeCameraV2Bridge.stop();\n", "v2 pause hook"),
    ("        if (nativeCameraBridge != null) nativeCameraBridge.stop();\n", "legacy pause hook"),
]:
    if old not in s:
        raise SystemExit(f"missing {label}")
    s = s.replace(old, "", 1)
for old, label in [
    ('''        if (nativeCameraV2Bridge != null) {\n            nativeCameraV2Bridge.close();\n            nativeCameraV2Bridge = null;\n        }\n''', "v2 destroy hook"),
    ('''        if (nativeCameraBridge != null) {\n            nativeCameraBridge.close();\n            nativeCameraBridge = null;\n        }\n''', "legacy destroy hook"),
]:
    if old not in s:
        raise SystemExit(f"missing {label}")
    s = s.replace(old, "", 1)
p.write_text(s)

p = Path("android/app/build.gradle")
s = p.read_text()
for old, label in [
    ('''        ndk {\n            abiFilters "armeabi-v7a", "arm64-v8a"\n        }\n        externalNativeBuild {\n            cmake {\n                cppFlags "-std=c++20"\n            }\n        }\n''', "default native build"),
    ('''\n    externalNativeBuild {\n        cmake {\n            path file("src/main/cpp/CMakeLists.txt")\n            version "3.22.1"\n        }\n    }\n''', "cmake build"),
    ('''\ndependencies {\n    implementation "androidx.webkit:webkit:1.15.0"\n}\n''', "androidx webkit dependency"),
]:
    if old not in s:
        raise SystemExit(f"missing {label}")
    s = s.replace(old, "\n", 1)
p.write_text(s)

# Remove the native backend from normal UI entirely. There is now exactly one
# receiver implementation on web, PWA, and APK.
replace_one(
    "index.html",
    '<video id="video" muted playsinline></video><canvas id="native-camera-preview" class="native-camera-preview" aria-hidden="true" hidden></canvas><canvas id="detect-overlay" class="detect-overlay" aria-hidden="true"></canvas>',
    '<video id="video" muted playsinline></video><canvas id="detect-overlay" class="detect-overlay" aria-hidden="true"></canvas>',
    "native preview canvas",
)
replace_one(
    "index.html",
    '<label id="camera-backend-control"><span>Backend</span><select id="camera-backend"><option value="browser">Browser / WebView</option><option value="native-v2">Camera2 · Native decode</option></select></label><label id="camera-device-control">',
    '<label id="camera-device-control">',
    "camera backend selector",
)
replace_one(
    "shared/style.css",
    '.preview video, .native-camera-preview { position: relative; z-index: 0; width: 100%; height: 100%; display: block; object-fit: contain; background: transparent; }\n.native-camera-preview { image-rendering: auto; }',
    '.preview video { position: relative; z-index: 0; width: 100%; height: 100%; display: block; object-fit: contain; background: transparent; }',
    "native preview style",
)

# Remove the Android-only native implementation and its NDK compatibility
# headers. MainActivity + platform WebView APIs are the complete app shell now.
for path in [
    "android/app/src/main/java/com/airgapper/app/NativeCameraBridge.java",
    "android/app/src/main/java/com/airgapper/app/NativeCameraV2Bridge.java",
    "android/app/src/main/java/com/airgapper/app/NativeDecoder.java",
    "android/app/src/main/java/com/airgapper/app/NativeGpuCameraReader.java",
]:
    Path(path).unlink()
shutil.rmtree("android/app/src/main/cpp")

# Update offline ownership/layout. Native JS adapters remain temporarily inert
# until the follow-up runtime branch deletion; they are no longer mandatory
# offline assets because no production UI can activate them.
p = Path("sw.js")
s = p.read_text()
s = s.replace('    "./shared/native-camera.js",\n', '')
s = s.replace('    "./shared/native-camera-v2.js",\n', '')
s = s.replace('    "./shared/receiver-recovery-policy.js",\n', '    "./receive/recovery-policy.js",\n')
s = s.replace('    "./shared/receiver-recovery-state.js",\n', '    "./receive/recovery-state.js",\n')
p.write_text(s)

# Keep permanent regression paths aligned with the receiver-only module move.
p = Path(".github/workflows/fast-regression.yml")
s = p.read_text()
s = s.replace('node --input-type=module --check < shared/receiver-recovery-state.js', 'node --input-type=module --check < receive/recovery-state.js')
s = s.replace('node --input-type=module --check < shared/receiver-recovery-policy.js', 'node --input-type=module --check < receive/recovery-policy.js')
p.write_text(s)

replace_one(
    "version.js",
    'export const APP_VERSION = "0.5.391";',
    'export const APP_VERSION = "0.5.392";',
    "version",
)
