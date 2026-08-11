// Served builds fetch the decoder wasm (decimen-codec — QR-only plus the
// tracked fast path, see ../vendor/decimen-codec) as a
// separate asset, which the service worker precaches. Standalone builds swap
// this for wasm-url.inline.ts.
import wasmUrl from "../vendor/decimen-codec/decimen_codec.wasm?url";

export default wasmUrl;
