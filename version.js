import "./audio/output-level.js";

export const APP_VERSION = "0.5.566";
export const APP_BUILD = `v${APP_VERSION}`;

let updateCheckPending = false;
let lastUpdateCheck = 0;

async function checkForAppUpdate() {
  if (updateCheckPending || document.visibilityState !== "visible") return;
  const home = document.getElementById("homeView");
  if (home && !home.classList.contains("active")) return;
  const now = Date.now();
  if (now - lastUpdateCheck < 5000) return;
  lastUpdateCheck = now;
  updateCheckPending = true;
  try {
    const url = new URL("./version.js", location.href);
    url.searchParams.set("update", String(now));
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return;
    const source = await response.text();
    const match = source.match(/APP_VERSION\s*=\s*["']([^"']+)["']/);
    if (match?.[1] && match[1] !== APP_VERSION) location.reload();
  } catch {
  } finally {
    updateCheckPending = false;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("load", () => void checkForAppUpdate(), { once: true });
  window.addEventListener("pageshow", () => void checkForAppUpdate());
  window.addEventListener("focus", () => void checkForAppUpdate());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkForAppUpdate();
  });
  document.getElementById("home-button")?.addEventListener("click", () => {
    setTimeout(() => void checkForAppUpdate(), 0);
  });
  setInterval(() => void checkForAppUpdate(), 5000);
}
