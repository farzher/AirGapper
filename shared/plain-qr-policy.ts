/**
 * Plain QR text has no AirGapper magic marker by design, so it must never win
 * a race against a framed file transfer. Dense multi-code grids can briefly
 * produce an unrelated, valid-looking text decode before zxing acquires an
 * AirGapper frame. Require the same plain value on two consecutive decodes,
 * and permanently prefer framed traffic as soon as any frame appears.
 */
export class PlainQrPolicy {
  private candidate = "";
  private matches = 0;
  private framedSeen = false;

  constructor(private readonly requiredMatches = 2) {}

  noteFramed(): void {
    this.framedSeen = true;
    this.candidate = "";
    this.matches = 0;
  }

  addPlain(text: string): string | null {
    if (this.framedSeen || !text) return null;
    if (text !== this.candidate) {
      this.candidate = text;
      this.matches = 1;
      return null;
    }
    this.matches++;
    return this.matches >= this.requiredMatches ? text : null;
  }

  reset(): void {
    this.candidate = "";
    this.matches = 0;
    this.framedSeen = false;
  }
}
