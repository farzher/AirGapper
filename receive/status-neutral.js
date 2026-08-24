// Receive runtime/camera notices remain available through diagnostics, but the
// standalone status row must not consume space or shift the receive UI.
const style = document.createElement("style");
style.textContent = "#stats,.receiver-heading{display:none!important}";
document.head.append(style);
