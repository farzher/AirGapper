/// <reference types="vite/client" />

/**
 * Emitted by the `inline-codec-wasm` plugin in build/inline-codec-wasm.ts:
 * the decoder wasm as a data: URI. Only standalone builds import it — served
 * builds resolve receive/wasm-url.ts instead and never touch this module.
 */
declare module "virtual:codec-wasm-data-url" {
  const dataUrl: string;
  export default dataUrl;
}
