var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class NoSignalHintTimer {
  constructor(firstDelayMs, dismissedDelayMs) {
    this.firstDelayMs = firstDelayMs;
    this.dismissedDelayMs = dismissedDelayMs;
    // `armed` is a separate flag rather than `armedAt === 0` meaning "not
    // started": zero is a perfectly legal timestamp, and overloading it makes the
    // timer silently dead for any clock that happens to start there.
    __publicField(this, "armed", false);
    __publicField(this, "armedAt", 0);
    __publicField(this, "delayMs");
    __publicField(this, "visible", false);
    __publicField(this, "sawFrame", false);
    this.delayMs = firstDelayMs;
  }
  get isVisible() {
    return this.visible;
  }
  /** The camera is live. Starts the first countdown. */
  cameraStarted(now) {
    if (this.sawFrame) return;
    this.armed = true;
    this.armedAt = now;
    this.delayMs = this.firstDelayMs;
    this.visible = false;
  }
  /**
   * Advance the clock. True exactly once per countdown, at the moment the hint
   * should go on screen — the caller renders it and is not told again until the
   * user dismisses it and another delay passes.
   */
  tick(now) {
    if (!this.armed || this.visible || this.sawFrame) return false;
    if (now - this.armedAt <= this.delayMs) return false;
    this.visible = true;
    return true;
  }
  /** The user dismissed it. Off screen, but the countdown restarts — on the
   *  longer leash from here on. */
  dismiss(now) {
    this.visible = false;
    this.armedAt = now;
    this.delayMs = this.dismissedDelayMs;
  }
  /** A frame parsed. Returns whether the hint was on screen and needs removing. */
  frameDecoded() {
    const wasVisible = this.visible;
    this.sawFrame = true;
    this.armed = false;
    this.visible = false;
    return wasVisible;
  }
}
export {
  NoSignalHintTimer
};
