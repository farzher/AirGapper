// Receive runtime/camera notices remain available through diagnostics, but
// transient scanner/status text must never consume space or shift the UI.
const style = document.createElement("style");
style.textContent = "#stats,.receiver-heading,#m-limit{display:none!important}";
document.head.append(style);
