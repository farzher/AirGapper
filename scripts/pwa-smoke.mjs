import { mkdirSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { get } from "node:https";
import { resolve } from "node:path";

const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const scratch = resolve("scratch/pwa-smoke");
const profile = resolve(scratch, "profile");
const port = 43000 + (process.pid % 1000);
const url = `https://127.0.0.1:${port}/`;
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

const server = spawn(process.execPath, [
  resolve("node_modules/vite/bin/vite.js"),
  "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort",
], { stdio: "ignore" });

function reachable() {
  return new Promise((resolveReady) => {
    const request = get(url, { rejectUnauthorized: false }, (response) => {
      response.resume();
      resolveReady(response.statusCode === 200);
    });
    request.on("error", () => resolveReady(false));
    request.setTimeout(500, () => { request.destroy(); resolveReady(false); });
  });
}
for (let tries = 0; tries < 30 && !(await reachable()); tries++) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
}
if (!(await reachable())) throw new Error("PWA preview server did not start");

function open() {
  const run = spawnSync(chrome, [
    "--headless=new",
    "--no-first-run",
    "--ignore-certificate-errors",
    "--disable-gpu",
    "--disable-background-networking",
    `--user-data-dir=${profile}`,
    "--virtual-time-budget=8000",
    "--dump-dom",
    url,
  ], { encoding: "utf8", timeout: 20_000, maxBuffer: 2_000_000 });
  const output = run.stdout ?? "";
  if (!output.includes("Download offline")) {
    throw new Error(`PWA page unavailable (${run.error?.message ?? run.stderr ?? run.status})`);
  }
  return output;
}

try {
  open(); // installs and fills the precache
} finally {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    server.kill("SIGTERM");
  }
}
await new Promise((resolveWait) => setTimeout(resolveWait, 500));
open(); // no server: must be served by the installed worker
console.log("PWA smoke passed: the self-contained app loads after its HTTPS origin goes offline");
