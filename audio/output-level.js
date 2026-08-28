import { getAndroidMediaOutputLevel } from "../shared/android.js";

const POLL_MS = 100;
let canvas = null;

function knownOutputLevel() {
  const androidLevel = getAndroidMediaOutputLevel();
  if (androidLevel !== null) return androidLevel;
  if (typeof navigator !== "undefined" && navigator.audioSession?.state === "interrupted") return 0;
  return 1;
}

function resetCanvas(target) {
  if (!target) return;
  target.style.removeProperty("transform");
  target.style.removeProperty("transform-origin");
  target.style.removeProperty("transition");
}

function update() {
  const active = document.getElementById("audio-send-active");
  const nextCanvas = active?.querySelector("canvas") ?? null;
  if (nextCanvas !== canvas) {
    resetCanvas(canvas);
    canvas = nextCanvas;
    if (canvas) {
      canvas.style.transformOrigin = "50% 50%";
      canvas.style.transition = "transform 80ms linear";
      active.querySelector(".send-toolbar")?.style.setProperty("grid-template-columns", "repeat(2, minmax(0, 1fr))");
    }
  }
  if (canvas) {
    const level = active && !active.hidden ? knownOutputLevel() : 1;
    const amplitude = level <= 0.001 ? 0 : Math.sqrt(level);
    canvas.style.transform = `scaleY(${amplitude})`;
  }
  setTimeout(update, POLL_MS);
}

if (typeof document !== "undefined") update();
