import type { Plugin } from "vite";

/**
 * Lock a standalone page down to exactly what it uses.
 *
 * The point is not XSS — it is making "no network" enforceable instead of
 * merely intended. Nothing in the current bundle names a network origin (the
 * decimen-codec glue resolves its wasm relative to the importing script), but
 * history warns here: the previously bundled zxing-wasm compiled a jsdelivr
 * URL into the receiver. A dependency change or a reordered init is all it
 * would take to regress silently. `default-src 'none'` with
 * no http(s) source anywhere means the browser refuses rather than the page
 * quietly phoning home from an air-gapped machine.
 *
 * Standalone only, because the hosted site legitimately fetches its own
 * assets and a service worker, and that is a different (much longer) policy.
 *
 * Notes on the awkward parts:
 * - 'unsafe-inline' for scripts is unavoidable — the whole bundle IS an inline
 *   script. It costs nothing here: it cannot re-enable a network origin, which
 *   is the only thing this policy is defending.
 * - 'wasm-unsafe-eval' is REQUIRED or WebAssembly.instantiate is blocked
 *   outright once any CSP is present, and the decoder simply never starts.
 * - The wasm arrives as a data: URI that Emscripten fetches, so connect-src
 *   has to allow data:. The decode worker is a blob: URL.
 * - frame-ancestors, sandbox and report-uri are ignored in a <meta> policy and
 *   only earn a console warning, so they are left out.
 */
export function standaloneCsp(page: "send" | "receive"): Plugin {
  const common = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "font-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ];
  const policy =
    page === "send"
      ? [...common, "script-src 'unsafe-inline'", "img-src data: blob:"]
      : [
          ...common,
          "script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:",
          "worker-src blob:",
          "connect-src data: blob:",
          "img-src data: blob:",
          "media-src blob: mediastream:",
        ];
  return {
    name: "standalone-csp",
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: {
            "http-equiv": "Content-Security-Policy",
            content: policy.join("; "),
          },
          // Must precede everything it governs.
          injectTo: "head-prepend",
        },
      ];
    },
  };
}
