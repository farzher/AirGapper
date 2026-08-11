import { closeOnBackdropClick } from "../shared/dialog";

const views = {
  home: document.getElementById("homeView")!,
  send: document.getElementById("sendView")!,
  receive: document.getElementById("receiveView")!,
};
let active: keyof typeof views = "home";

function showView(name: keyof typeof views): void {
  active = name;
  for (const [key, view] of Object.entries(views)) view.classList.toggle("active", key === name);
  window.scrollTo(0, 0);
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
  button.addEventListener("click", () => showView(button.dataset.mode as "send" | "receive"));
}

function returnHome(): void {
  if (active === "home") return;
  // Reloading releases a live camera, sender animation, workers, and payload
  // buffers instead of leaving a hidden transfer running behind the home view.
  window.location.replace(window.location.pathname + window.location.search);
}
for (const button of document.querySelectorAll<HTMLButtonElement>(".back")) {
  button.addEventListener("click", returnHome);
}
document.getElementById("home-button")!.addEventListener("click", returnHome);

const legal = document.getElementById("legal-dialog") as HTMLDialogElement;
document.getElementById("legal-button")!.addEventListener("click", () => legal.showModal());
document.getElementById("legal-close")!.addEventListener("click", () => legal.close());
closeOnBackdropClick(legal);
