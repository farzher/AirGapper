/** A tracked decode is opportunistic. Every unavailable or failed tracked
 * attempt must run normal QR acquisition on the same pixels. */
export function shouldRunFullDecode(
  fullFrame: boolean,
  trackedAttempted: boolean,
  trackedHit: boolean,
): boolean {
  return fullFrame || !trackedAttempted || !trackedHit;
}
