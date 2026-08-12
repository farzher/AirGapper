// The sender's transmit tuning, in one place.

/** What the no-signal hint tells the user to turn the sender down to. */
export const NO_SIGNAL_HINT_FRAME_BYTES = 1465;
export const NO_SIGNAL_HINT_TX_FPS = 10;

// Current sender defaults: one maximum-capacity standard QR at a conservative
// cadence that stays stable on ordinary displays.
export const DEFAULT_TX_FPS = 15;
export const DEFAULT_FRAME_BYTES = 2953;

export const TX_FPS_OPTIONS: readonly number[] = [
  10,
  DEFAULT_TX_FPS,
  20,
  30,
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
