import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const scratch = resolve("scratch/browser-smoke");
const downloads = resolve(scratch, "downloads");
rmSync(scratch, { recursive: true, force: true });
mkdirSync(downloads, { recursive: true });

function run(file, profile) {
  const profileDir = resolve(scratch, profile);
  mkdirSync(resolve(profileDir, "Default"), { recursive: true });
  writeFileSync(resolve(profileDir, "Default/Preferences"), JSON.stringify({
    download: { default_directory: downloads, prompt_for_download: false },
    safebrowsing: { enabled: false },
  }));
  const url = `${pathToFileURL(resolve(file)).href}?smoke=1`;
  const run = spawnSync(chrome, [
    "--headless=new",
    "--no-first-run",
    "--disable-gpu",
    "--disable-background-networking",
    "--enable-logging=stderr",
    `--user-data-dir=${profileDir}`,
    `--download-default-directory=${downloads}`,
    "--run-all-compositor-stages-before-draw",
    "--virtual-time-budget=2000",
    "--dump-dom",
    url,
  ], { encoding: "utf8", timeout: 10_000, maxBuffer: 2_000_000 });
  // Chrome sometimes keeps its headless process alive after completing a
  // download on Windows. A timeout is acceptable only after dump-dom proves
  // the page completed every assertion.
  const output = run.stdout ?? "";
  if (!/data-smoke="pass"/.test(output)) {
    throw new Error(`${file}: navigation smoke failed (${run.error?.message ?? run.stderr ?? run.status})`);
  }
  if (/data-smoke="fail:/.test(output)) throw new Error(`${file}: ${output.match(/data-smoke="([^"]+)/)?.[1]}`);
  const consoleFailure = (run.stderr ?? "").split(/\r?\n/).find((line) =>
    /INFO:CONSOLE.*(?:Uncaught|Refused to|Failed to load|ERR_)/i.test(line),
  );
  if (consoleFailure) throw new Error(`${file}: browser console error: ${consoleFailure}`);
}

run("index.html", "root-profile");
const downloaded = resolve(downloads, "airgapper.html");
if (!existsSync(downloaded)) throw new Error("Download offline did not create airgapper.html");
const html = readFileSync(downloaded, "utf8");
if (/<script\b[^>]*\bsrc\s*=|<link\b[^>]*rel=["']stylesheet/i.test(html)) {
  throw new Error("downloaded artifact contains an external script or stylesheet");
}
run(downloaded, "download-profile");
console.log("browser smoke passed: file:// navigation, text sending, Download offline, and downloaded copy");
