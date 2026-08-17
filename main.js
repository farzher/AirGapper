var _a;
import { closeOnBackdropClick } from "./shared/dialog.js";
import { isAndroid, isIOS } from "./shared/platform.js";

const APP_BUILD = "v0.5.210";
const serviceWorkers = navigator.serviceWorker;
let registration;

async function prepareServiceWorker() {
  if (!serviceWorkers) return;
  try {
    registration = await serviceWorkers.register(`./sw.js?build=${APP_BUILD}`, { scope: "./", updateViaCache: "none" });
  } catch {
  }
}

await prepareServiceWorker();
await Promise.all([
  import(`./send/main.js?build=${APP_BUILD}`),
  import(`./receive/main.js?build=${APP_BUILD}`)
]);

document.querySelector(".app-version").textContent = APP_BUILD;
if (serviceWorkers) {
  window.addEventListener("load", () => void registration?.update().catch(() => void 0), { once: true });
}
const installShell = document.querySelector(".install-shell");
const installMenuButton = document.getElementById("install-menu-button");
const installMenu = document.getElementById("install-menu");
const pwaInstall = document.getElementById("pwa-install");
const installHelp = document.getElementById("install-help");
let deferredInstall;
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
function openInstallMenu() {
  installMenu.hidden = false;
  installMenuButton.setAttribute("aria-expanded", "true");
  pwaInstall.focus();
}
installMenuButton.addEventListener("click", () => installMenu.hidden ? openInstallMenu() : closeInstallMenu());
pwaInstall.addEventListener("click", async () => {
  if (!deferredInstall) {
    installHelp.hidden = false;
    installHelp.textContent = installFallback();
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
  syncInstallUi();
});
window.addEventListener("appinstalled", () => {
  installed = true;
  deferredInstall = void 0;
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
let active = "home";
function historyView() {
  var _a2;
  const view = (_a2 = history.state) == null ? void 0 : _a2.airgapperView;
  return view === "home" || view === "send" || view === "receive" ? view : null;
}
const headerQr = document.getElementById("receiver-link-qr");
const headerQrButton = document.getElementById("receiver-link-open");
const receiverLinkDialog = document.getElementById("receiver-link-dialog");
const receiverLinkUrl = document.getElementById("receiver-link-url");
const receiverUrl = (_a = headerQr.dataset.receiverUrl) != null ? _a : "";
receiverLinkUrl.href = receiverUrl;
try {
  const parsedReceiverUrl = new URL(receiverUrl);
  receiverLinkUrl.textContent = `${parsedReceiverUrl.host}${parsedReceiverUrl.pathname.replace(/\/$/, "")}`;
} catch {
  receiverLinkUrl.textContent = receiverUrl.replace(/^https?:\/\//, "").replace(/[?#].*$/, "").replace(/\/$/, "");
}
receiverLinkUrl.target = "_blank";
receiverLinkUrl.rel = "noopener";
headerQrButton.addEventListener("click", () => receiverLinkDialog.showModal());
closeOnBackdropClick(receiverLinkDialog);
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
  headerQrButton.hidden = name === "receive";
  if (name === "receive") window.dispatchEvent(new CustomEvent("airgapper:enter-receive"));
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
}
window.addEventListener("popstate", () => {
  var _a2;
  return showView((_a2 = historyView()) != null ? _a2 : "home", "none");
});
let suspended = false;
window.airgapperSuspend = () => {
  if (suspended || active === "home" || document.body.classList.contains("receive-complete")) return;
  suspended = true;
  window.dispatchEvent(new CustomEvent("airgapper:pause-mode"));
};
function resumeActiveView() {
  if (document.visibilityState !== "visible") return;
  if (suspended) {
    suspended = false;
    window.dispatchEvent(new CustomEvent("airgapper:resume-mode"));
  } else if (active === "receive" && !document.body.classList.contains("receive-complete")) {
    window.dispatchEvent(new CustomEvent("airgapper:enter-receive"));
  }
}
document.addEventListener("visibilitychange", () => {
  var _a2;
  if (document.hidden) (_a2 = window.airgapperSuspend) == null ? void 0 : _a2.call(window);
  else resumeActiveView();
});
window.addEventListener("pageshow", resumeActiveView);
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
