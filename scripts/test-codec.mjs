import { cpSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve("vendor/decimen-codec-source");
if (!existsSync(resolve(root, "package.json"))) {
  throw new Error("codec source is missing; run git submodule update --init --recursive");
}
mkdirSync(resolve(root, "dist"), { recursive: true });
for (const file of ["decimen_codec.js", "decimen_codec.wasm"]) {
  cpSync(resolve("vendor/decimen-codec", file), resolve(root, "dist", file));
}
for (const args of [["ci"], ["test"]]) {
  const windows = process.platform === "win32";
  const command = windows ? (process.env.ComSpec ?? "cmd.exe") : "npm";
  const commandArgs = windows ? ["/d", "/s", "/c", `npm ${args.join(" ")}`] : args;
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
