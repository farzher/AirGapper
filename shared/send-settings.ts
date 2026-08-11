// The sender's transmit tuning, in one place. The dropdowns in app.html are
// rendered from these lists via the %TX_FPS_OPTIONS% / %FRAME_BYTES_OPTIONS%
// tokens (see htmlTokens() in vite.config.ts), and the receiver's no-signal
// hint names its fallback values from here too — so the advice can never point
// at a setting the sender doesn't offer.

/** What the no-signal hint tells the user to turn the sender down to. */
export const NO_SIGNAL_HINT_FRAME_BYTES = 1465;
export const NO_SIGNAL_HINT_TX_FPS = 24;

// Current sender defaults: one maximum-capacity standard QR at a cadence that
// stays stable on ordinary 60 Hz displays.
export const DEFAULT_TX_FPS = 20;
export const DEFAULT_FRAME_BYTES = 2953;

// The hint values appear in these lists by construction, not by coincidence.
// 55 sits just under the 60 Hz ceiling: on 120 Hz displays it gets a clean
// ≥2 refresh cycles per frame, and on 60 Hz screens the deliberate 5 fps slip
// against the refresh clock means frame boundaries drift through the scanout
// instead of riding it, so the same frames don't get torn twice in a row.
export const TX_FPS_OPTIONS: readonly number[] = [
  10,
  15,
  DEFAULT_TX_FPS,
  24,
  30,
  55,
  60,
];
export const FRAME_BYTES_OPTIONS: readonly number[] = [
  500,
  1000,
  1465,
  1850,
  2331,
  DEFAULT_FRAME_BYTES,
];
