from pathlib import Path


def read(path):
    return Path(path).read_text(encoding="utf-8")


def write(path, text):
    Path(path).write_text(text, encoding="utf-8")


def replace_once(path, old, new):
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}: {old[:100]!r}")
    write(path, text.replace(old, new, 1))


def replace_version(path):
    text = read(path)
    count = text.count("v0.5.349")
    if count < 1:
        raise SystemExit(f"{path}: missing v0.5.349")
    write(path, text.replace("v0.5.349", "v0.5.350"))


# Native APK is already the installed application. Never show the web/PWA install UI there.
replace_once(
    "main.js",
    'import { isAndroid, isIOS } from "./shared/platform.js";\n',
    'import { isAndroid, isIOS } from "./shared/platform.js";\nimport { isAndroidApp } from "./shared/android.js";\n'
)

old_install = '''let deferredInstall;
let installed = matchMedia("(display-mode: standalone)").matches || Boolean(navigator.standalone);
function closeInstallMenu(restoreFocus = false) {
  installMenu.hidden = true;
  installMenuButton.setAttribute("aria-expanded", "false");
  if (restoreFocus) installMenuButton.focus();
}
function installFallback() {
  if (isIOS) return "Use Share → Add to Home Screen.";
  if (isAndroid) return "Use your browser menu → Install app.";
  return "Use your browser menu to install AirGapper.";
}
function syncInstallUi() {
  installShell.hidden = installed;
  pwaInstall.disabled = installed;
  installHelp.hidden = installed || Boolean(deferredInstall);
  installHelp.textContent = installed ? "" : installFallback();
}
'''
new_install = '''let deferredInstall;
let installHelpRequested = false;
let installed = isAndroidApp() || matchMedia("(display-mode: standalone)").matches || Boolean(navigator.standalone);
function closeInstallMenu(restoreFocus = false) {
  installMenu.hidden = true;
  installMenuButton.setAttribute("aria-expanded", "false");
  if (restoreFocus) installMenuButton.focus();
}
function installFallback() {
  if (isIOS) return "If AirGapper isn't already installed, use Share → Add to Home Screen.";
  if (isAndroid) return "If AirGapper isn't already installed, use your browser menu → Install app.";
  return "If AirGapper isn't already installed, use your browser's install option.";
}
function syncInstallUi() {
  installShell.hidden = installed;
  pwaInstall.disabled = installed;
  const showHelp = !installed && !deferredInstall && installHelpRequested;
  installHelp.hidden = !showHelp;
  installHelp.textContent = showHelp ? installFallback() : "";
}
'''
replace_once("main.js", old_install, new_install)

replace_once(
    "main.js",
    '''pwaInstall.addEventListener("click", async () => {
  if (!deferredInstall) {
    installHelp.hidden = false;
    installHelp.textContent = installFallback();
    return;
  }
''',
    '''pwaInstall.addEventListener("click", async () => {
  if (!deferredInstall) {
    installHelpRequested = true;
    syncInstallUi();
    return;
  }
'''
)
replace_once(
    "main.js",
    '''window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstall = event;
  syncInstallUi();
});
window.addEventListener("appinstalled", () => {
  installed = true;
  deferredInstall = void 0;
  closeInstallMenu();
  syncInstallUi();
});
''',
    '''window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstall = event;
  installHelpRequested = false;
  syncInstallUi();
});
window.addEventListener("appinstalled", () => {
  installed = true;
  deferredInstall = void 0;
  installHelpRequested = false;
  closeInstallMenu();
  syncInstallUi();
});
'''
)

# Android WebView capability reporting can claim a 30 fps ceiling even when a requested
# 60 fps camera mode is usable. Keep all standard test modes selectable in the APK;
# the actual negotiated track settings remain visible to the user.
replace_once(
    "receive/main.js",
    'browserModes = standardBrowserModes().filter((mode) => mode.width >= widthMin && mode.width <= widthMax && mode.height >= heightMin && mode.height <= heightMax && mode.fps >= fpsMin && mode.fps <= fpsMax);',
    'browserModes = standardBrowserModes().filter((mode) => isAndroidApp() || mode.width >= widthMin && mode.width <= widthMax && mode.height >= heightMin && mode.height <= heightMax && mode.fps >= fpsMin && mode.fps <= fpsMax);'
)

# A completed transfer leaves transferFinalizing=true. stopReceiver resets every other
# session field, so explicitly clear this flag when leaving Receive or the next session's
# progress estimator returns forever even while useful symbols/KB/s are arriving.
replace_once(
    "receive/main.js",
    '''  receiverPaused = false;
  pauseStartedAt = 0;
  releaseScreenWakeLock();
''',
    '''  receiverPaused = false;
  pauseStartedAt = 0;
  transferFinalizing = false;
  releaseScreenWakeLock();
'''
)

# Version all runtime surfaces together so PWA cache busting and APK contents stay coherent.
for path in ("main.js", "send/main.js", "receive/main.js", "index.html"):
    replace_version(path)

replace_once("sw.js", 'const CACHE = "airgapper-static-js-v297";', 'const CACHE = "airgapper-static-js-v350";')
replace_once("android/app/build.gradle", "versionCode 349", "versionCode 350")
replace_once("android/app/build.gradle", 'versionName "0.5.349"', 'versionName "0.5.350"')

print("AIRGAPPER_V350_FIXES_APPLIED")
