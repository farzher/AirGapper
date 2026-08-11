// Standalone builds only: the wasm rides along as a data: URI, which
// Emscripten's locateFile hands straight back. Importing the `?url` form here
// instead would emit a stray .wasm beside the "single" file.
import dataUrl from "virtual:codec-wasm-data-url";

export default dataUrl;
