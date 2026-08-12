/**
 * Plain QR text has no AirGapper magic marker by design, so it must never win
 * a race against a framed file transfer. Dense multi-code grids can briefly
 * produce an unrelated, valid-looking text decode before zxing acquires an
 * AirGapper frame. Hold plain text until the same static value has remained
 * stable, and permanently prefer framed traffic as soon as any frame appears.
 */
export class PlainQrPolicy {
  private candidate = "";
  private firstAt = 0;
  private matches = 0;
  private framedSeen = false;

  constructor(
    private readonly settleMs = 2000,
    private readonly requiredMatches = 5,
  ) {}

  noteFramed(): void {
    this.framedSeen = true;
    this.candidate = "";
    this.matches = 0;
  }

  addPlain(text: string, now: number): string | null {
    if (this.framedSeen || !text) return null;
    if (text !== this.candidate) {
      this.candidate = text;
      this.firstAt = now;
      this.matches = 1;
      return null;
    }
    this.matches++;
    return this.matches >= this.requiredMatches && now - this.firstAt >= this.settleMs
      ? text
      : null;
  }

  reset(): void {
    this.candidate = "";
    this.firstAt = 0;
    this.matches = 0;
    this.framedSeen = false;
  }
}
