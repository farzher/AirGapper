import "../send/main";
import "../receive/main";
import { closeOnBackdropClick } from "../shared/dialog";
import { isAndroid, isIOS } from "../shared/platform";

const views = {
  home: document.getElementById("homeView")!,
  send: document.getElementById("sendView")!,
  receive: document.getElementById("receiveView")!,
};
type ViewName = keyof typeof views;
let active: ViewName = "home";
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

function showView(name: ViewName): void {
  if (name === active) return;
  if (active !== "home") window.dispatchEvent(new CustomEvent("airgapper:leave-mode"));
  active = name;
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
  history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
  // Entering asks for the rear camera immediately; browsers that require
  // interaction or previously denied access expose the existing retry button.
  showView("receive");
}
(window as Window & { airgapperSuspend?: () => void }).airgapperSuspend = () => {
  // The Android document picker pauses the Activity while saving a completed
  // transfer. Preserve that result screen and its in-memory file until the
  // picker returns; only a live sender/receiver needs suspension teardown.
  if (active !== "home" && !document.body.classList.contains("receive-complete")) {
    window.dispatchEvent(new CustomEvent("airgapper:leave-mode"));
  }
};

document.addEventListener("visibilitychange", () => {
  if (document.hidden) (window as Window & { airgapperSuspend?: () => void }).airgapperSuspend?.();
});

(window as Window & { airgapperHandleBack?: () => boolean }).airgapperHandleBack = () => {
  if (receiverLinkDialog.open) {
    receiverLinkDialog.close();
    return true;
  }
  if (document.body.classList.contains("qr-full")) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    return true;
  }
  if (active !== "home") {
    showView("home");
    return true;
  }
  return false;
};

