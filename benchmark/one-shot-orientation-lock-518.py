from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, got {count}")
    return text.replace(old, new, 1)


# App-wide portrait lock: native/browser lock when available, CSS fallback otherwise.
p = Path("main.js")
s = p.read_text()
anchor = '''installCameraStartGuard();
window.AIRGAPPER_BUILD = APP_BUILD;
document.querySelector(".app-version").textContent = APP_BUILD;
'''
insert = '''installCameraStartGuard();
window.AIRGAPPER_BUILD = APP_BUILD;
document.querySelector(".app-version").textContent = APP_BUILD;

function portraitFallbackRotation() {
  const angle = Number(screen.orientation?.angle ?? window.orientation);
  return angle === 270 || angle === -90 ? "90deg" : "-90deg";
}
function syncPortraitFallback() {
  const landscape = window.innerWidth > window.innerHeight;
  document.body.classList.toggle("portrait-fallback", landscape);
  if (landscape) document.documentElement.style.setProperty("--portrait-fallback-rotation", portraitFallbackRotation());
  else document.documentElement.style.removeProperty("--portrait-fallback-rotation");
}
async function requestPortraitLock() {
  try {
    await screen.orientation?.lock?.("portrait-primary");
  } catch {
    // Browser tabs (notably iOS) commonly reject orientation locking. The CSS
    // fallback below keeps the app portrait without depending on this API.
  }
  syncPortraitFallback();
}
syncPortraitFallback();
void requestPortraitLock();
window.addEventListener("resize", syncPortraitFallback);
window.addEventListener("orientationchange", syncPortraitFallback);
screen.orientation?.addEventListener?.("change", syncPortraitFallback);
document.addEventListener("pointerdown", () => {
  // Some browsers only allow lock() from a user gesture/fullscreen context.
  if (document.body.classList.contains("portrait-fallback")) void requestPortraitLock();
}, { capture: true });
'''
s = replace_once(s, anchor, insert, "main orientation insertion")
p.write_text(s)

# Replace receiver-only landscape compaction with an app-wide portrait shell.
p = Path("shared/style.css")
s = p.read_text()
old = '''/* Browser tabs cannot reliably lock orientation, especially on iOS. In a short
   landscape receiver viewport, spend the height on the camera instead. */
@media (orientation: landscape) and (max-height: 600px) {
  body.receive-mode .app-header { display: none; }
  body.receive-mode .app-main { width: 100%; max-width: none; padding: 0; }
  body.receive-mode .receiver-primary { gap: 0; }
  body.receive-mode .receiver-heading { display: none; }
  body.receive-mode .preview-zone { flex: 1 1 0; min-height: 0; }
  body.receive-mode .transfer-panel { padding: 6px 10px; border-inline: 0; border-bottom: 0; border-radius: 0; }
  body.receive-mode .transfer-panel details.settings > .row { max-height: min(140px, 42vh); padding-bottom: 6px; }
  body.receive-mode .progress { height: 5px; margin-top: 6px; }
  body.receive-mode .transfer-meta { margin-top: 5px; }
}'''
new = '''/* Keep AirGapper logically portrait even when a browser refuses orientation.lock().
   The transformed shell uses the swapped viewport dimensions; hit testing follows
   the transform, so controls remain ordinary DOM controls. */
@media (orientation: landscape) {
  body.portrait-fallback { width: 100vw; height: 100vh; height: 100dvh; min-height: 0; overflow: hidden; }
  body.portrait-fallback .app {
    position: fixed;
    top: 50%;
    left: 50%;
    width: 100vh;
    width: 100dvh;
    height: 100vw;
    height: 100dvw;
    min-height: 0;
    overflow: auto;
    transform: translate(-50%, -50%) rotate(var(--portrait-fallback-rotation, -90deg));
    transform-origin: center;
  }
  body.portrait-fallback.qr-full .app { overflow: hidden; }
  body.portrait-fallback.qr-full #stage { width: 100%; height: 100%; min-height: 100%; }

  /* The viewport media queries still see the physical landscape width. Mirror
     the normal mobile layout against the shell's logical portrait width. */
  body.portrait-fallback .app-header { padding-top: 14px; }
  body.portrait-fallback .app-main { padding-top: 0; }
  body.portrait-fallback .home,
  body.portrait-fallback .send-inputs { grid-template-columns: 1fr; }
  body.portrait-fallback .mode { min-height: 130px; }
  body.portrait-fallback .file-picker,
  body.portrait-fallback .note-composer { min-height: 130px; }
  body.portrait-fallback .send-settings-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  body.portrait-fallback .stage { min-height: 0; }
  body.portrait-fallback .receiver-primary { gap: 8px; }
  body.portrait-fallback .preview { min-height: 0; }
  body.portrait-fallback .transfer-panel { padding: 10px 12px; }
  body.portrait-fallback .transfer-meta { margin-top: 7px; }
  body.portrait-fallback .pipeline-metrics { gap: 10px; }
}

@media (orientation: landscape) and (max-height: 390px) {
  body.portrait-fallback .receiver-settings .row { grid-template-columns: minmax(0, 1.5fr) minmax(62px, .7fr) auto auto; gap: 6px; }
  body.portrait-fallback .receiver-settings .optics-manual { grid-column: 1 / -1; grid-row: 2; }
  body.portrait-fallback .receiver-settings { padding-inline: 9px; }
}'''
s = replace_once(s, old, new, "orientation css")
p.write_text(s)

# Sender geometry must use the logical portrait viewport when the CSS fallback is active.
p = Path("send/main.js")
s = p.read_text()
old = '''function selectedOrientation() {
  const orientation = cfgOrientation.value;
  return orientation === "portrait" || orientation === "landscape" ? orientation : "auto";
}
function landscapeGrid() {
  const orientation = selectedOrientation();
  return orientation === "landscape" || orientation === "auto" && window.innerWidth > window.innerHeight;
}'''
new = '''function selectedOrientation() {
  const orientation = cfgOrientation.value;
  return orientation === "portrait" || orientation === "landscape" ? orientation : "auto";
}
function senderViewportCss() {
  const viewport = window.visualViewport;
  let width = Math.max(1, Number(viewport?.width) || window.innerWidth);
  let height = Math.max(1, Number(viewport?.height) || window.innerHeight);
  if (document.body.classList.contains("portrait-fallback")) [width, height] = [height, width];
  return { width, height };
}
function landscapeGrid() {
  const orientation = selectedOrientation();
  const viewport = senderViewportCss();
  return orientation === "landscape" || orientation === "auto" && viewport.width > viewport.height;
}'''
s = replace_once(s, old, new, "sender logical orientation")
old = '''function senderDisplayBudgetCss() {
  if (document.body.classList.contains("qr-full")) {
    // On mobile the layout viewport is integer-rounded while visualViewport can
    // retain the fractional CSS size implied by a fractional devicePixelRatio.
    // Solving against innerWidth/innerHeight can therefore create a bitmap that
    // Chrome has to resample when true fullscreen settles.
    const viewport = window.visualViewport;
    return {
      width: Math.max(1, Number(viewport?.width) || window.innerWidth),
      height: Math.max(1, Number(viewport?.height) || window.innerHeight)
    };
  }
  if (!stage.hidden) {
    const rect = stage.getBoundingClientRect();
    const style = getComputedStyle(stage);
    return {
      width: Math.max(1, rect.width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)),
      height: Math.max(1, rect.height - stageBottom.offsetHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom))
    };
  }
  // Match the CSS stage before it is measurable. startStream normally makes
  // Auto's stage/controls measurable before selection, but this conservative
  // fallback must never pretend the non-fullscreen wall owns the whole viewport.
  return {
    width: Math.max(1, Math.min(1400, window.innerWidth - 24)),
    height: Math.max(1, window.innerHeight - 180)
  };
}'''
new = '''function senderDisplayBudgetCss() {
  const logicalViewport = senderViewportCss();
  if (document.body.classList.contains("qr-full")) {
    // visualViewport is physical-browser geometry. senderViewportCss swaps it
    // when the app is using the portrait fallback so QR sizing matches the
    // transformed fullscreen stage exactly.
    return logicalViewport;
  }
  if (!stage.hidden) {
    const rect = stage.getBoundingClientRect();
    const style = getComputedStyle(stage);
    const portraitFallback = document.body.classList.contains("portrait-fallback");
    const width = portraitFallback ? stage.clientWidth : rect.width;
    const height = portraitFallback ? stage.clientHeight : rect.height;
    return {
      width: Math.max(1, width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)),
      height: Math.max(1, height - stageBottom.offsetHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom))
    };
  }
  // Match the CSS stage before it is measurable. startStream normally makes
  // Auto's stage/controls measurable before selection, but this conservative
  // fallback must never pretend the non-fullscreen wall owns the whole viewport.
  return {
    width: Math.max(1, Math.min(1400, logicalViewport.width - 24)),
    height: Math.max(1, logicalViewport.height - 180)
  };
}'''
s = replace_once(s, old, new, "sender display budget")
p.write_text(s)

# Installed PWA and native Android app can enforce portrait without the CSS fallback.
p = Path("manifest.webmanifest")
s = p.read_text()
old = '"display":"standalone","background_color"'
new = '"display":"standalone","orientation":"portrait-primary","background_color"'
s = replace_once(s, old, new, "manifest orientation")
p.write_text(s)

p = Path("android/app/src/main/AndroidManifest.xml")
s = p.read_text()
s = replace_once(s, 'android:screenOrientation="unspecified"', 'android:screenOrientation="portrait"', "android orientation")
p.write_text(s)

p = Path("version.js")
s = p.read_text()
s = replace_once(s, 'APP_VERSION = "0.5.517"', 'APP_VERSION = "0.5.518"', "version")
p.write_text(s)
