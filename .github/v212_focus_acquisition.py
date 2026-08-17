from pathlib import Path


def replace(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"replacement not found in {path}: {old[:220]!r}")
    p.write_text(s.replace(old, new, count))

replace("index.html", "v0.5.211", "v0.5.212")
replace("main.js", 'const APP_BUILD = "v0.5.211";', 'const APP_BUILD = "v0.5.212";')
replace("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.211";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.212";')
replace("sw.js", 'const CACHE = "airgapper-static-js-v173";', 'const CACHE = "airgapper-static-js-v174";')

p = Path("receive/focus-controller.js")
s = p.read_text()
old = '''  noteValidDecode(scanId, now = performance.now()) {
    if (scanId === void 0 || scanId < this.decodeBoundary) return;
    this.lastValidDecodeAt = now;
    if (scanId !== this.lastValidScanId) {
      this.lastValidScanId = scanId;
      this.validDecodesInGeneration++;
      this.validDecodeTimes.push(now);
      while (this.validDecodeTimes.length && this.validDecodeTimes[0] < now - 1e4) this.validDecodeTimes.shift();
    }
  }'''
new = '''  noteValidDecode(scanId, now = performance.now()) {
    if (scanId === void 0 || scanId < this.decodeBoundary) return;
    this.lastValidDecodeAt = now;
    if (scanId !== this.lastValidScanId) {
      this.lastValidScanId = scanId;
      this.validDecodesInGeneration++;
      this.validDecodeTimes.push(now);
      while (this.validDecodeTimes.length && this.validDecodeTimes[0] < now - 1e4) this.validDecodeTimes.shift();
    }
    // A CRC-verified AirGapper packet is stronger evidence than the optional
    // optical analyzer that focus is already usable. The direct Y8 hot path can
    // intentionally bypass that analyzer, so never leave AF recovery armed just
    // because no ImageData optical sample happened to run. This changes only the
    // controller state; continuous hardware AF itself remains active.
    if (this.strategy === "auto" && this.isAcquiring() && !this.isOptimizing()) {
      this.commitSettings(this.settings());
      this.lockedAt = now;
      if (this.initialLockMs === void 0) this.initialLockMs = Math.max(0, now - this.attachedAt);
      this.transition("LOCKED", "verified QR decode; autofocus recovery disarmed");
    }
  }'''
if old not in s:
    raise SystemExit("noteValidDecode block missing")
s = s.replace(old, new, 1)

old = '''    const modes = this.focusModes();
    const canSingle = modes.includes("single-shot") && !this.singleShotAfRejected;
    const canContinuous = modes.includes("continuous") || this.settings().focusMode === "continuous";
    if (!canSingle && !canContinuous) return;'''
new = '''    const modes = this.focusModes();
    const currentFocusMode = this.settings().focusMode;
    const canSingle = modes.includes("single-shot") && !this.singleShotAfRejected;
    const canContinuous = modes.includes("continuous") || currentFocusMode === "continuous";
    if (!canSingle && !canContinuous) return;
    // Continuous AF is the least disruptive acquisition tool. Some Android
    // cameras advertise single-shot but reject it or perform a visible lens
    // sweep. Give already-running continuous AF several QR-evidence windows
    // before escalating to single-shot.
    const trySingle = canSingle && (!canContinuous || currentFocusMode !== "continuous" || this.seekingAfRetries >= CAMERA_TUNING.seekingAfFastRetries);'''
if old not in s:
    raise SystemExit("AF capability block missing")
s = s.replace(old, new, 1)

old = '''      if (canSingle) {
        this.requestedMode = "single-shot";'''
new = '''      if (trySingle) {
        this.requestedMode = "single-shot";'''
if old not in s:
    raise SystemExit("single-shot branch missing")
s = s.replace(old, new, 1)

old = '''  async configureInitialHardwareFocusOnce() {
    if (this.automaticFocusConfigured || this.strategy !== "auto") return;
    this.automaticFocusConfigured = true;
    const track = this.track;
    if (!track || track.readyState !== "live") return;
    const modes = this.focusModes();
    if (!modes.includes("single-shot") && !modes.includes("continuous") && this.settings().focusMode !== "continuous") {
      this.lastReason = "hardware autofocus controls unavailable";
      this.changed();
      return;
    }
    this.lastSeekingAfAt = -Infinity;
    await this.maybeRetrySeekingAutofocus(performance.now(), void 0, true);
  }'''
new = '''  async configureInitialHardwareFocusOnce() {
    if (this.automaticFocusConfigured || this.strategy !== "auto") return;
    this.automaticFocusConfigured = true;
    const track = this.track;
    if (!track || track.readyState !== "live") return;
    const modes = this.focusModes();
    const initial = this.settings();
    const canContinuous = modes.includes("continuous") || initial.focusMode === "continuous";
    const canSingle = modes.includes("single-shot");
    if (!canSingle && !canContinuous) {
      this.lastReason = "hardware autofocus controls unavailable";
      this.changed();
      return;
    }

    // Camera HALs normally open in continuous AF already. Do not immediately
    // kick the lens through a single-shot sweep: first let the live QR stream
    // prove whether the current focus works. A later no-decode watchdog can
    // nudge continuous AF, then escalate to single-shot only after repeated
    // failure.
    if (canContinuous) {
      this.requestedMode = "continuous";
      if (initial.focusMode !== "continuous") {
        await this.apply(track, { focusMode: "continuous" });
        if (!this.track || track.readyState !== "live") return;
      }
      const actual = this.settings();
      this.committedFocusMode = actual.focusMode;
      this.committedFocusDistance = actual.focusDistance;
      this.lastSeekingAfAt = performance.now();
      this.lastReason = initial.focusMode === "continuous"
        ? "continuous hardware AF already running; waiting for QR evidence"
        : "continuous hardware AF selected; waiting for QR evidence";
      this.changed();
      return;
    }

    this.lastSeekingAfAt = -Infinity;
    await this.maybeRetrySeekingAutofocus(performance.now(), void 0, true);
  }'''
if old not in s:
    raise SystemExit("initial hardware focus block missing")
s = s.replace(old, new, 1)
p.write_text(s)
