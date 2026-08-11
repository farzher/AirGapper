import "../send/main";
import "../receive/main";
import { closeOnBackdropClick } from "../shared/dialog";

const views = {
  home: document.getElementById("homeView")!,
  send: document.getElementById("sendView")!,
  receive: document.getElementById("receiveView")!,
};
type ViewName = keyof typeof views;
let active: ViewName = "home";

function showView(name: ViewName): void {
  if (name === active) return;
  if (active !== "home") window.dispatchEvent(new CustomEvent("airgapper:leave-mode"));
  active = name;
  for (const [key, view] of Object.entries(views)) view.classList.toggle("active", key === name);
  window.scrollTo(0, 0);
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
  button.addEventListener("click", () => showView(button.dataset.mode as "send" | "receive"));
}
for (const button of document.querySelectorAll<HTMLButtonElement>(".back")) {
  button.addEventListener("click", () => showView("home"));
}
document.getElementById("home-button")!.addEventListener("click", () => showView("home"));

const legal = document.getElementById("legal-dialog") as HTMLDialogElement;
document.getElementById("legal-button")!.addEventListener("click", () => legal.showModal());
document.getElementById("legal-close")!.addEventListener("click", () => legal.close());
closeOnBackdropClick(legal);

// Capture the untouched, fully bundled document before UI state changes. This
// avoids a network fetch and makes Download offline work identically from
// HTTPS, file://, and a previously downloaded copy.
const standaloneDocument = document.documentElement.cloneNode(true) as HTMLElement;
standaloneDocument.querySelector('link[rel="manifest"]')?.remove();
const standaloneHtml = `<!doctype html>\n${standaloneDocument.outerHTML}`;
function downloadOffline(): void {
  const url = URL.createObjectURL(new Blob([standaloneHtml], { type: "text/html;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "airgapper.html";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
document.getElementById("download-offline")!.addEventListener("click", downloadOffline);

/** In-artifact browser smoke mode. scripts/browser-smoke.mjs opens the exact
 * checked-in file with ?smoke=1, then repeats against the downloaded copy. */
async function runSmoke(): Promise<void> {
  const root = document.documentElement;
  try {
    (document.querySelector('[data-mode="send"]') as HTMLButtonElement).click();
    if (!views.send.classList.contains("active")) throw new Error("Send did not open");
    const text = document.getElementById("snippet-text") as HTMLTextAreaElement;
    text.value = "AirGapper browser smoke";
    (document.getElementById("send-snippet") as HTMLButtonElement).click();
    for (let tries = 0; tries < 20 && (document.getElementById("stage") as HTMLElement).hidden; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if ((document.getElementById("stage") as HTMLElement).hidden) throw new Error("text sender did not start");
    (views.send.querySelector(".back") as HTMLButtonElement).click();
    if (!views.home.classList.contains("active")) throw new Error("Back did not return home");
    (document.querySelector('[data-mode="receive"]') as HTMLButtonElement).click();
    if (!views.receive.classList.contains("active")) throw new Error("Receive did not open");
    (views.receive.querySelector(".back") as HTMLButtonElement).click();
    if (!views.home.classList.contains("active")) throw new Error("second Back did not return home");
    (document.getElementById("download-offline") as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const unexpectedLoads = performance.getEntriesByType("resource").filter((entry) => {
      const url = new URL(entry.name, location.href);
      return !["data:", "blob:"].includes(url.protocol) && url.href !== location.href;
    });
    if (unexpectedLoads.length) throw new Error(`unexpected resource request: ${unexpectedLoads[0]!.name}`);
    root.dataset.smoke = "pass";
  } catch (error) {
    root.dataset.smoke = `fail:${error instanceof Error ? error.message : String(error)}`;
  }
}
if (new URLSearchParams(location.search).get("smoke") === "1") void runSmoke();
