/**
 * Plain QR text has no AirGapper magic marker by design, so it must never win
 * a race against a framed file transfer. Accept a value after it appears in
 * two different camera scans; candidates are tracked independently so several
 * normal QRs in view cannot keep resetting each other. As soon as any framed
 * traffic appears, plain QRs are suppressed for the rest of the session.
 */
export class PlainQrPolicy {
  private readonly candidates = new Map<string, { lastScan: number; scans: number }>();
  private framedSeen = false;

  constructor(private readonly requiredScans = 2) {}

  noteFramed(): void {
    this.framedSeen = true;
    this.candidates.clear();
  }

  addPlain(text: string, scanId: number): string | null {
    if (this.framedSeen || !text) return null;
    const candidate = this.candidates.get(text);
    if (!candidate) {
      this.candidates.set(text, { lastScan: scanId, scans: 1 });
      return null;
    }
    // A decoder can report a symbol more than once from one worker reply. That
    // is one observation, not the requested two camera scans.
    if (candidate.lastScan === scanId) return null;
    candidate.lastScan = scanId;
    candidate.scans++;
    return candidate.scans >= this.requiredScans ? text : null;
  }

  reset(): void {
    this.candidates.clear();
    this.framedSeen = false;
  }
}
