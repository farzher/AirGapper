import type { Plugin } from "vite";

/** Remove links that cannot resolve beside a self-contained single HTML file. */
export function rewriteStandaloneLinks(page: "send" | "receive"): Plugin {
  const rules: [string, string][] = [
    [
      '<nav class="mode-nav" aria-label="Mode"><a href="../send/">Send</a><a href="../receive/">Receive</a></nav>',
      `<span class="mode-badge">${page === "send" ? "Send" : "Receive"}</span>`,
    ],
    ['<a class="brand" href="../">AirGapper</a>', '<span class="brand">AirGapper</span>'],
    ['<link rel="icon" href="../icon.svg" type="image/svg+xml" />', ""],
  ];
  return {
    name: "rewrite-standalone-links",
    transformIndexHtml(html) {
      for (const [from, to] of rules) {
        if (!html.includes(from)) throw new Error(`standalone rewrite missed: ${from}`);
        html = html.replaceAll(from, to);
      }
      return html;
    },
  };
}
