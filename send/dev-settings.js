const SEND_DEV_TOGGLE_WINDOW_MS = 1000;
const SIDE_GUTTER_KEY = "airgapper:send-side-gutter:v1";
const sendSettingsToggle = document.getElementById("send-settings-toggle");
const sendSettingsPanel = document.getElementById("send-settings-panel");
const sendView = document.getElementById("sendView");
const stage = document.getElementById("stage");

const sendDevActions = document.createElement("div");
sendDevActions.id = "send-dev-actions";
sendDevActions.hidden = true;
sendDevActions.style.cssText = "margin-top:11px;padding-top:10px;border-top:1px solid var(--line)";

const gutterLabel = document.createElement("label");
gutterLabel.style.cssText = "display:grid;grid-template-columns:1fr auto;gap:4px 10px;align-items:center;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em";
const gutterName = document.createElement("span");
gutterName.textContent = "Side gutter";
const gutter = document.createElement("select");
gutter.id = "cfg-side-gutter";
gutter.setAttribute("aria-label", "Side gutter for curved displays");
for (let px = 0; px <= 6; px++) gutter.add(new Option(`${px} px`, String(px)));
gutterLabel.append(gutterName, gutter);
sendDevActions.append(gutterLabel);
sendSettingsPanel?.append(sendDevActions);

function clampGutter(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(6, Math.round(number))) : 0;
}

let sideGutter = 0;
try { sideGutter = clampGutter(localStorage.getItem(SIDE_GUTTER_KEY)); } catch {}
gutter.value = String(sideGutter);

function appliesToSender() {
  return sideGutter > 0 && sendView?.classList.contains("active");
}

// Fullscreen Auto Grid solves against visualViewport.width. Reserve the gutter
// in that same budget rather than shrinking the finished QR canvas afterward;
// this preserves integer/pixel-perfect module sizing.
const viewport = window.visualViewport;
if (viewport) {
  let owner = Object.getPrototypeOf(viewport);
  let descriptor;
  while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, "width"))) owner = Object.getPrototypeOf(owner);
  if (descriptor?.get && descriptor.configurable && !descriptor.get.__airgapperSideGutter) {
    const nativeGet = descriptor.get;
    const guardedGet = function() {
      const width = nativeGet.call(this);
      if (this === viewport && appliesToSender() && document.body.classList.contains("qr-full")) {
        return Math.max(1, width - sideGutter * 2);
      }
      return width;
    };
    Object.defineProperty(guardedGet, "__airgapperSideGutter", { value: true });
    try { Object.defineProperty(owner, "width", { ...descriptor, get: guardedGet }); } catch {}
  }
}

let resizeQueued = false;
function applyGutter() {
  if (stage) stage.style.paddingInline = sideGutter ? `${sideGutter}px` : "";
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    window.dispatchEvent(new Event("resize"));
  });
}
applyGutter();

gutter.addEventListener("change", () => {
  sideGutter = clampGutter(gutter.value);
  gutter.value = String(sideGutter);
  try { localStorage.setItem(SIDE_GUTTER_KEY, String(sideGutter)); } catch {}
  applyGutter();
});

const toggleTimes = [];
let previousToggleAt = 0;
function noteToggle() {
  const now = performance.now();
  const open = sendSettingsPanel?.hidden === false;
  const slowToggle = previousToggleAt > 0 && now - previousToggleAt > SEND_DEV_TOGGLE_WINDOW_MS;
  previousToggleAt = now;

  if (!sendDevActions.hidden) {
    if (!open || !slowToggle) return;
    sendDevActions.hidden = true;
    toggleTimes.length = 0;
    return;
  }

  toggleTimes.push(now);
  while (toggleTimes.length && toggleTimes[0] < now - SEND_DEV_TOGGLE_WINDOW_MS) toggleTimes.shift();
  if (open && toggleTimes.length >= 3) {
    sendDevActions.hidden = false;
    toggleTimes.length = 0;
  }
}

// send/main.js owns opening/closing the panel. Observe after its click handlers
// finish so this works regardless of module evaluation order.
sendSettingsToggle?.addEventListener("click", () => queueMicrotask(noteToggle));
