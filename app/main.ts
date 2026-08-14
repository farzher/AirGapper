import "../send/main";
import "../receive/main";
import { closeOnBackdropClick } from "../shared/dialog";
import { isAndroid, isIOS } from "../shared/platform";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

const installMenuButton = document.getElementById("install-menu-button") as HTMLButtonElement;
const installMenu = document.getElementById("install-menu")!;
const pwaInstall = document.getElementById("pwa-install") as HTMLButtonElement;
const installHelp = document.getElementById("install-help")!;
let deferredInstall: InstallPromptEvent | undefined;
let installed = matchMedia("(display-mode: standalone)").matches ||
  Boolean((navigator as Navigator & { standalone?: boolean }).standalone);

function closeInstallMenu(restoreFocus = false): void {
  installMenu.hidden = true;
  installMenuButton.setAttribute("aria-expanded", "false");
  if (restoreFocus) installMenuButton.focus();
}
function installFallback(): string {
  if (isIOS) return "Use Share → Add to Home Screen.";
  if (isAndroid) return "Use your browser menu → Install app.";
  return "Use your browser menu to install AirGapper.";
}
function syncInstallUi(): void {
  installMenuButton.textContent = installed ? "Installed" : "Install App";
  installMenuButton.disabled = false;
  pwaInstall.textContent = installed ? "Installed" : "Install App";
  pwaInstall.disabled = installed;
  installHelp.hidden = installed || Boolean(deferredInstall);
  installHelp.textContent = installed ? "" : installFallback();
}
function openInstallMenu(): void {
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
  deferredInstall = undefined;
  await prompt.prompt();
  const choice = await prompt.userChoice;
  if (choice.outcome === "accepted") closeInstallMenu();
  syncInstallUi();
});
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstall = event as InstallPromptEvent;
  syncInstallUi();
});
window.addEventListener("appinstalled", () => {
  installed = true;
  deferredInstall = undefined;
  closeInstallMenu();
  syncInstallUi();
});
document.addEventListener("pointerdown", (event) => {
  if (!installMenu.hidden && event.target instanceof Node && !installMenu.parentElement!.contains(event.target)) closeInstallMenu();
});
installMenu.addEventListener("keydown", (event) => {
  const items = [...installMenu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (event.key === "Escape") {
    event.preventDefault();
    closeInstallMenu(true);
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  }
});
syncInstallUi();

const views = {
  home: document.getElementById("homeView")!,
  send: document.getElementById("sendView")!,
  receive: document.getElementById("receiveView")!,
};
type ViewName = keyof typeof views;
type HistoryMode = "push" | "replace" | "none";
let active: ViewName = "home";

function historyView(): ViewName | null {
  const view = (history.state as { airgapperView?: unknown } | null)?.airgapperView;
  return view === "home" || view === "send" || view === "receive" ? view : null;
}
const headerQr = document.getElementById("receiver-link-qr") as HTMLCanvasElement;
const headerQrButton = document.getElementById("receiver-link-open") as HTMLButtonElement;
const receiverLinkDialog = document.getElementById("receiver-link-dialog") as HTMLDialogElement;
const receiverLinkUrl = document.getElementById("receiver-link-url") as HTMLAnchorElement;
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
headerQrButton.addEventListener("click", () => receiverLinkDialog.showModal());
closeOnBackdropClick(receiverLinkDialog);

function showView(name: ViewName, historyMode: HistoryMode = "push"): void {
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
  // Focusing from the Send tap opens the on-screen keyboard immediately on
  // phones and hides half the chooser. Desktop users still get the convenient
  // ready-to-type focus.
  const hasMobileInput = isIOS || isAndroid || matchMedia("(pointer: coarse)").matches;
  if (name === "send" && !hasMobileInput) {
    (document.getElementById("snippet-text") as HTMLTextAreaElement).focus({ preventScroll: true });
  }
  window.scrollTo(0, 0);
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
  button.addEventListener("click", () => showView(button.dataset.mode as "send" | "receive"));
}
document.getElementById("home-button")!.addEventListener("click", () => showView("home"));

// The phone handoff QR deep-links straight into Receive. Consume that launch
// flag immediately: a later reload should open the normal home screen, not
// keep trapping the phone in Receive. Other query parameters are preserved.
const initialParams = new URLSearchParams(location.search);
if (initialParams.has("r") || initialParams.has("receive")) {
  initialParams.delete("r");
  initialParams.delete("receive");
  const query = initialParams.toString();
  history.replaceState(
    { ...history.state, airgapperView: "receive" },
    "",
    `${location.pathname}${query ? `?${query}` : ""}${location.hash}`,
  );
  // Entering asks for the rear camera immediately; browsers that require
  // interaction or previously denied access expose the existing retry button.
  showView("receive", "none");
} else {
  // A reload is a fresh session: return to the chooser rather than reviving a
  // half-finished sender or camera. History traversal still restores views via
  // popstate below; only a document load resets the current entry to Home.
  history.replaceState({ ...history.state, airgapperView: "home" }, "");
}

window.addEventListener("popstate", () => showView(historyView() ?? "home", "none"));
let suspended = false;
(window as Window & { airgapperSuspend?: () => void }).airgapperSuspend = () => {
  if (suspended || active === "home" || document.body.classList.contains("receive-complete")) return;
  suspended = true;
  // Backgrounding pauses hot resources without treating it as navigation.
  // The selected sender payload and partial transport decoder stay in memory.
  window.dispatchEvent(new CustomEvent("airgapper:pause-mode"));
};

function resumeActiveView(): void {
  if (document.visibilityState !== "visible") return;
  if (suspended) {
    suspended = false;
    window.dispatchEvent(new CustomEvent("airgapper:resume-mode"));
  } else if (active === "receive" && !document.body.classList.contains("receive-complete")) {
    window.dispatchEvent(new CustomEvent("airgapper:enter-receive"));
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) (window as Window & { airgapperSuspend?: () => void }).airgapperSuspend?.();
  else resumeActiveView();
});
window.addEventListener("pageshow", resumeActiveView);
(window as Window & { airgapperResume?: () => void }).airgapperResume = resumeActiveView;

(window as Window & { airgapperHandleBack?: () => boolean }).airgapperHandleBack = () => {
  const inspectorClose = document.querySelector<HTMLButtonElement>(".media-inspector-close");
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

