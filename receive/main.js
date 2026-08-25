import "./camera-constraints.js";
import "./exposure-ev.js";
import "./track-processor-proxy.js";
import "./dev-settings-unlock.js";
import "./user-overlay.js";
import "./runtime.js";

// These diagnostics are intentionally absent from the normal receiver UI.
// Keep that presentation state at the app entrypoint instead of injecting a
// runtime <style> element from a separate side-effect module.
document.getElementById("stats")?.setAttribute("hidden", "");
document.querySelector(".receiver-heading")?.setAttribute("hidden", "");
document.getElementById("m-limit")?.setAttribute("hidden", "");