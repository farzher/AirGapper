var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class PlainQrPolicy {
  constructor(requiredScans = 2) {
    this.requiredScans = requiredScans;
    __publicField(this, "candidates", /* @__PURE__ */ new Map());
    __publicField(this, "framedSeen", false);
  }
  noteFramed() {
    this.framedSeen = true;
    this.candidates.clear();
  }
  addPlain(text, scanId) {
    if (this.framedSeen || !text) return null;
    const candidate = this.candidates.get(text);
    if (!candidate) {
      this.candidates.set(text, { lastScan: scanId, scans: 1 });
      return null;
    }
    if (candidate.lastScan === scanId) return null;
    candidate.lastScan = scanId;
    candidate.scans++;
    return candidate.scans >= this.requiredScans ? text : null;
  }
  reset() {
    this.candidates.clear();
    this.framedSeen = false;
  }
}
export {
  PlainQrPolicy
};
