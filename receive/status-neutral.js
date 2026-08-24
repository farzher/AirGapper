// Receive status messages can be transient camera/runtime notices rather than
// fatal errors. Keep them visible without flashing a red failure state under
// the receiver diagnostics.
const style = document.createElement("style");
style.textContent = "#stats.error{color:var(--muted);font-weight:400}";
document.head.append(style);
