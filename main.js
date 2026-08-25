import { isAndroid, isIOS } from "./shared/platform.js";
import { isAndroidApp } from "./shared/android.js";
import { APP_BUILD } from "./version.js";
import { cameraRequestPending, installCameraStartGuard } from "./shared/camera-start-guard.js";

installCameraStartGuard();
window.AIRGAPPER_BUILD = APP_BUILD;
document.querySelector(".app-version").textContent = APP_BUILD;

const serviceWorkers = navigator.serviceWorker;
let registration;

async function prepareServiceWorker() {
  if (!serviceWorkers) return;
  try {
    registration = await serviceWorkers.register(`./sw.js?build=${APP_BUILD}`, { scope: "./", updateViaCache: "none" });
  } catch {
  }
}

void prepareServiceWorker();
let sendModulePromise;
function ensureSendModule() {
  if (!sendModulePromise) {
    sendModulePromise = Promise.all([
      import(`./send/dev-settings.js?build=${APP_BUILD}`),
      import(`./send/main.js?build=${APP_BUILD}`)
    ]).then(([, module]) => module);
  }
  return sendModulePromise;
}
let receiveModulePromise;
let receiveModuleLoaded = false;
function ensureReceiveModule() {
  if (!receiveModulePromise) {
    receiveModulePromise = import(`./receive/main.js?build=${APP_BUILD}`).then((module) => {
      receiveModuleLoaded = true;
      return module;
    });
  }
  return receiveModulePromise;
}

if (serviceWorkers) {
  window.addEventListener("load", () => void registration?.update().catch(() => void 0), { once: true });
}
const installShell = document.querySelector(".install-shell");
const installMenuButton = document.getElementById("install-menu-button");
const installMenu = document.getElementById("install-menu");
const pwaInstall = document.getElementById("pwa-install");
const installHelp = document.getElementById("install-help");
let deferredInstall;
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
function openInstallMenu() {
  installMenu.hidden = false;
  installMenuButton.setAttribute("aria-expanded", "true");
  pwaInstall.focus();
}
installMenuButton.addEventListener("click", () => installMenu.hidden ? openInstallMenu() : closeInstallMenu());
pwaInstall.addEventListener("click", async () => {
  if (!deferredInstall) {
    installHelpRequested = true;
    syncInstallUi();
    return;
  }
  const prompt = deferredInstall;
  deferredInstall = void 0;
  await prompt.prompt();
  const choice = await prompt.userChoice;
  if (choice.outcome === "accepted") closeInstallMenu();
  syncInstallUi();
});
window.addEventListener("beforeinstallprompt", (event) => {
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
document.addEventListener("pointerdown", (event) => {
  if (!installMenu.hidden && event.target instanceof Node && !installMenu.parentElement.contains(event.target)) closeInstallMenu();
});
installMenu.addEventListener("keydown", (event) => {
  var _a2;
  const items = [...installMenu.querySelectorAll('[role="menuitem"]:not([disabled])')];
  const index = items.indexOf(document.activeElement);
  if (event.key === "Escape") {
    event.preventDefault();
    closeInstallMenu(true);
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    (_a2 = items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]) == null ? void 0 : _a2.focus();
  }
});
syncInstallUi();
const views = {
  home: document.getElementById("homeView"),
  send: document.getElementById("sendView"),
  receive: document.getElementById("receiveView")
};
const receiveVideo = document.getElementById("video");
let active = "home";
let receiveLoadDispatchQueued = false;
function dispatchReceiveWhenReady(type = "airgapper:enter-receive") {
  if (receiveModuleLoaded) {
    if (active === "receive") window.dispatchEvent(new CustomEvent(type));
    return;
  }
  if (receiveLoadDispatchQueued) return;
  receiveLoadDispatchQueued = true;
  void ensureReceiveModule().then(() => {
    receiveLoadDispatchQueued = false;
    if (active === "receive" && !suspended && document.visibilityState === "visible") {
      window.dispatchEvent(new CustomEvent("airgapper:enter-receive"));
      if (isIOS) scheduleReceiveHealthCheck(1500);
    }
  }).catch(() => {
    receiveLoadDispatchQueued = false;
  });
}
function historyView() {
  var _a2;
  const view = (_a2 = history.state) == null ? void 0 : _a2.airgapperView;
  return view === "home" || view === "send" || view === "receive" ? view : null;
}
const headerQr = document.getElementById("receiver-link-qr");
const headerQrButton = document.getElementById("receiver-link-open");
const sendReceiverLinkButton = document.getElementById("send-receiver-link-open");
const receiverLinkDialog = document.getElementById("receiver-link-dialog");
const receiverLinkUrl = document.getElementById("receiver-link-url");
const receiverUrl = headerQr.dataset.receiverUrl ?? "";
receiverLinkUrl.href = receiverUrl;
try {
  const parsedReceiverUrl = new URL(receiverUrl);
  receiverLinkUrl.textContent = `${parsedReceiverUrl.host}${parsedReceiverUrl.pathname.replace(/\/$/, "")}`;
} catch {
  receiverLinkUrl.textContent = receiverUrl.replace(/^https?:\/\//, "").replace(/[?#].*$/, "").replace(/\/$/, "");
}
receiverLinkUrl.target = "_blank";
receiverLinkUrl.rel = "noopener";
const openReceiverLinkDialog = () => receiverLinkDialog.showModal();
headerQrButton.addEventListener("click", openReceiverLinkDialog);
sendReceiverLinkButton?.addEventListener("click", openReceiverLinkDialog);
receiverLinkDialog.addEventListener("click", (event) => {
  if (event.target !== receiverLinkDialog) return;
  const rect = receiverLinkDialog.getBoundingClientRect();
  const inside = event.clientX >= rect.left && event.clientX <= rect.right &&
    event.clientY >= rect.top && event.clientY <= rect.bottom;
  if (!inside) receiverLinkDialog.close();
});
function showView(name, historyMode = "push") {
  if (name === active) {
    if (historyMode === "replace") history.replaceState({ ...history.state, airgapperView: name }, "");
    return;
  }
  if (active !== "home") window.dispatchEvent(new CustomEvent("airgapper:leave-mode"));
  active = name;
  if (historyMode === "push") history.pushState({ ...history.state, airgapperView: name }, "");
  else if (historyMode === "replace") history.replaceState({ ...history.state, airgapperView: name }, "");
  for (const [key, view] of Object.entries(views)) view.classList.toggle("active", key === name);
  document.body.classList.toggle("receive-mode", name === "receive");
  headerQrButton.hidden = name !== "home";
  if (name === "receive") dispatchReceiveWhenReady();
  else if (name === "send" || name === "home") void ensureSendModule();
  const hasMobileInput = isIOS || isAndroid || matchMedia("(pointer: coarse)").matches;
  if (name === "send" && !hasMobileInput) {
    document.getElementById("snippet-text").focus({ preventScroll: true });
  }
  window.scrollTo(0, 0);
}
for (const button of document.querySelectorAll("[data-mode]")) {
  button.addEventListener("click", () => showView(button.dataset.mode));
}
document.getElementById("home-button").addEventListener("click", () => showView("home"));
const initialParams = new URLSearchParams(location.search);
if (initialParams.has("r") || initialParams.has("receive")) {
  initialParams.delete("r");
  initialParams.delete("receive");
  const query = initialParams.toString();
  history.replaceState(
    { ...history.state, airgapperView: "receive" },
    "",
    `${location.pathname}${query ? `?${query}` : ""}${location.hash}`
  );
  showView("receive", "none");
} else {
  history.replaceState({ ...history.state, airgapperView: "home" }, "");
  void ensureSendModule();
}
window.addEventListener("popstate", () => {
  var _a2;
  return showView((_a2 = historyView()) != null ? _a2 : "home", "none");
});
let suspended = false;
let receiveHealthToken = 0;
function receiveNeedsCamera() {
  return active === "receive" && !document.body.classList.contains("receive-complete");
}
function liveReceiveTrack() {
  const source = receiveVideo?.srcObject;
  if (!source || typeof source.getVideoTracks !== "function") return null;
  return source.getVideoTracks().find((track) => track.readyState === "live") || null;
}
function recycleReceiveCamera() {
  if (!receiveModuleLoaded || !isIOS || !receiveNeedsCamera() || document.visibilityState !== "visible" || cameraRequestPending()) return;
  // pauseReceiver() preserves transport progress/decoder state but clears a
  // dead MediaStream and in-flight frame work. Resuming then opens a fresh
  // camera stream, which is what iPadOS needs after killing a background track.
  window.dispatchEvent(new CustomEvent("airgapper:pause-mode"));
  queueMicrotask(() => {
    if (receiveNeedsCamera() && document.visibilityState === "visible" && !cameraRequestPending()) {
      window.dispatchEvent(new CustomEvent("airgapper:resume-mode"));
    }
  });
}
function scheduleReceiveHealthCheck(delay = 1200, attempt = 0) {
  if (!isIOS || !receiveModuleLoaded) return;
  const token = ++receiveHealthToken;
  setTimeout(() => {
    if (token !== receiveHealthToken || !receiveNeedsCamera() || document.visibilityState !== "visible") return;
    if (cameraRequestPending()) {
      if (attempt < 8) scheduleReceiveHealthCheck(400, attempt + 1);
      return;
    }
    const track = liveReceiveTrack();
    if (!track) {
      recycleReceiveCamera();
      return;
    }
    const initialTime = Number(receiveVideo.currentTime) || 0;
    setTimeout(() => {
      if (token !== receiveHealthToken || !receiveNeedsCamera() || document.visibilityState !== "visible" || cameraRequestPending()) return;
      const currentTrack = liveReceiveTrack();
      const ready = Boolean(currentTrack) && receiveVideo.readyState >= 2 && receiveVideo.videoWidth > 0 && receiveVideo.videoHeight > 0;
      const advanced = (Number(receiveVideo.currentTime) || 0) > initialTime + 0.03;
      if (!ready || !advanced) recycleReceiveCamera();
      else if (receiveVideo.paused) void receiveVideo.play().catch(() => recycleReceiveCamera());
    }, 650);
  }, delay);
}
window.airgapperSuspend = () => {
  // Safari/iPadOS can emit lifecycle transitions while its camera permission
  // sheet is on top. Cancelling Receive here invalidates the pending request
  // and can make the sheet disappear before the user can answer it.
  if (cameraRequestPending()) return;
  receiveHealthToken++;
  const completedReceive = active === "receive" && document.body.classList.contains("receive-complete");
  if (suspended || active === "home" || completedReceive) return;
  suspended = true;
  // Pause belongs to the active mode. Send owns its wake lock and scheduler;
  // Receive owns camera teardown. Do not require Receive to be loaded merely to
  // tell an already-running sender that the document became hidden.
  if (active === "send" || active === "receive" && receiveModuleLoaded)
    window.dispatchEvent(new CustomEvent("airgapper:pause-mode"));
};
function resumeActiveView() {
  if (document.visibilityState !== "visible" || cameraRequestPending()) return;
  const wasSuspended = suspended;
  if (suspended) {
    suspended = false;
    if (active === "send") {
      window.dispatchEvent(new CustomEvent("airgapper:resume-mode"));
    } else if (active === "receive") {
      dispatchReceiveWhenReady(receiveModuleLoaded ? "airgapper:resume-mode" : "airgapper:enter-receive");
    }
  } else if (receiveNeedsCamera()) {
    dispatchReceiveWhenReady();
  }
  if (receiveNeedsCamera() && receiveModuleLoaded) scheduleReceiveHealthCheck(wasSuspended ? 1500 : 1200);
}
document.addEventListener("visibilitychange", () => {
  var _a2;
  if (document.hidden) (_a2 = window.airgapperSuspend) == null ? void 0 : _a2.call(window);
  else resumeActiveView();
});
window.addEventListener("pageshow", resumeActiveView);
window.addEventListener("focus", resumeActiveView);
window.airgapperResume = resumeActiveView;
window.airgapperHandleBack = () => {
  const inspectorClose = document.querySelector(".media-inspector-close");
  if (inspectorClose) {
    inspectorClose.click();
    return true;
  }
  if (receiverLinkDialog.open) {
    receiverLinkDialog.close();
    return true;
  }
  if (document.body.classList.contains("qr-full")) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    return true;
  }
  if (active !== "home") {
    history.back();
    return true;
  }
  return false;
};