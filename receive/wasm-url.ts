// The audited decimen-codec WASM is embedded as a data URL by the build. This
// keeps the exact same decoder in direct-file and hosted PWA use.
import dataUrl from "virtual:codec-wasm-data-url";

export default dataUrl;
