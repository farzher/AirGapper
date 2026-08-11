import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}
function requireText(text, needle, file) {
  if (!text.toLowerCase().includes(needle.toLowerCase())) throw new Error(`${file}: missing ${needle}`);
}

for (const file of filesUnder("dist-standalone")) {
  const html = readFileSync(file, "utf8");
  requireText(html, "default-src &#39;none&#39;", file);
  requireText(html, "AGPL-3.0-or-later", file);
  requireText(html, "NO WARRANTY", file);
  requireText(html, "modified 2026-08-11", file);
  requireText(html, "https://github.com/farzher/AirGapper", file);
  if (/<script\b[^>]*\bsrc\s*=/i.test(html) || /<link\b[^>]*rel=["']stylesheet/i.test(html)) {
    throw new Error(`${file}: standalone build has an external script or stylesheet`);
  }
}

for (const file of filesUnder("dist")) {
  if (!/\.(?:html|js|css)$/.test(file)) continue;
  const text = readFileSync(file, "utf8");
  if (/\b(?:fetch|importScripts)\s*\(\s*["']https?:/i.test(text)) {
    throw new Error(`${file}: automatic network URL found`);
  }
  if (/decimen\.app|418\.5 KB\/s|199\.2 KB\/s|601\.5 KB\/s/i.test(text)) {
    throw new Error(`${file}: upstream branding or performance claim found`);
  }
}
for (const file of ["dist/index.html", "dist/send/index.html", "dist/receive/index.html"]) {
  const html = readFileSync(file, "utf8");
  requireText(html, "Legal / Source", file);
  requireText(html, "modified 2026-08-11", file);
}
for (const file of ["dist/LICENSE.txt", "dist/NOTICE.txt", "dist/UPSTREAM.txt", "dist/LICENSE.zxing-cpp.txt"]) {
  readFileSync(file);
}
console.log("build verification passed: offline references, standalone CSP, and legal notices");
