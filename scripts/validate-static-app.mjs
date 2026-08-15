import fs from "node:fs";
import path from "node:path";
const roots = ["app", "receive", "send", "shared"];
const files = [];
for (const root of roots) for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) if (entry.isFile() && entry.name.endsWith(".js")) files.push(path.join(entry.parentPath ?? entry.path, entry.name));
let bad = false;
for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  if (/import\.meta\.env/.test(source)) { console.error(file + ": import.meta.env remains"); bad = true; }
  const specs = [...source.matchAll(/(?:from\s*|import\s*\(|import\s*)["']([^"']+)["']/g)].map((match) => match[1]);
  for (const spec of specs) {
    if (!spec.startsWith(".")) { console.error(file + ": bare import " + spec); bad = true; continue; }
    if (/\?(?:url|worker)(?:$|&)/.test(spec) || /\.ts(?:$|[?#])/.test(spec)) { console.error(file + ": build-only import " + spec); bad = true; continue; }
    const resolved = path.resolve(path.dirname(file), spec.split(/[?#]/)[0]);
    if (!fs.existsSync(resolved)) { console.error(file + ": missing " + spec); bad = true; }
  }
}
if (bad) process.exit(1);
console.log("Static module graph OK: " + files.length + " modules");
