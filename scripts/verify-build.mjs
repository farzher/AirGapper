import { readFileSync } from "node:fs";

function requireText(text, needle, file) {
  if (!text.toLowerCase().includes(needle.toLowerCase())) throw new Error(`${file}: missing ${needle}`);
}
function verifyArtifact(file) {
  const html = readFileSync(file, "utf8");
  for (const needle of [
    "AirGapper",
    "Download offline",
    "Legal / Source",
    "AGPL-3.0-or-later",
    "NO WARRANTY",
    "modified 2026-08-11",
    "https://github.com/farzher/AirGapper",
    "data:application/wasm;base64",
    "default-src 'none'",
  ]) requireText(html, needle, file);
  if (/<script\b[^>]*\bsrc\s*=|<link\b[^>]*rel=["']stylesheet/i.test(html)) {
    throw new Error(`${file}: external script or stylesheet found`);
  }
  if (/\bsrc=["'][^"']+\.wasm|\bsrc=["'][^"']+\.js|href=["'][^"']+\.css/i.test(html)) {
    throw new Error(`${file}: sibling runtime asset found`);
  }
  if (/\.ts(?:[?"'<]|\b)/i.test(html)) throw new Error(`${file}: TypeScript reference found`);
  if (/href=["'][^"']*icon\.svg/i.test(html)) throw new Error(`${file}: external icon.svg reference found`);
  if (/Offline transport is not encryption/i.test(html)) throw new Error(`${file}: security prose leaked into minimal UI`);
  if (/linear-gradient|radial-gradient|color-scheme:\s*dark/i.test(html)) throw new Error(`${file}: stale gradient or dark theme found`);
  return html;
}

const root = verifyArtifact("index.html");
const built = verifyArtifact("dist/index.html");
if (root !== built) throw new Error("checked-in index.html is stale; npm run build must update it");

for (const file of [
  "dist/LICENSE.txt",
  "dist/NOTICE.txt",
  "dist/UPSTREAM.txt",
  "dist/LICENSE.zxing-cpp.txt",
  "dist/CODEC-NOTICE.txt",
  "dist/manifest.webmanifest",
  "dist/sw.js",
]) readFileSync(file);

const sw = readFileSync("dist/sw.js", "utf8");
requireText(sw, "index.html", "dist/sw.js");
if (/decimen\.app|418\.5 KB\/s|199\.2 KB\/s|601\.5 KB\/s/i.test(root + sw)) {
  throw new Error("upstream branding or unsupported performance claim found");
}
console.log("build verification passed: one self-contained app, PWA cache, and legal notices");
