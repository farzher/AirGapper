import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

export async function runAgcap({
  file,
  baseUrl = process.env.AIRGAPPER_URL || "http://127.0.0.1:8080/",
  mode = "performance",
  productionOnly = true,
  output = null,
  browser = null
}) {
  if (!file) throw new Error("Missing .agcap file");
  const absolute = path.resolve(file);
  await fs.access(absolute);
  const ownBrowser = !browser;
  browser ??= await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 2560 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.stack || error.message));
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text()); });
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 30000 });
    // Receiver benchmark APIs are intentionally lazy-loaded with Receive. Follow
    // the product path rather than making normal Home/Send load receiver code.
    await page.locator('[data-mode="receive"]').click();
    await page.waitForFunction(() =>
      typeof window.__airgapperRunLoadedCorpus === "function" &&
      typeof window.__airgapperLoadedCorpusHeader === "function",
      { timeout: 30000 });
    await page.locator("#corpus-file").setInputFiles(absolute);
    await page.waitForFunction(() => {
      const button = document.getElementById("run-benchmark");
      return button && !button.disabled && window.__airgapperLoadedCorpusHeader?.();
    }, { timeout: 30000 });
    const header = await page.evaluate(() => window.__airgapperLoadedCorpusHeader());
    const result = await page.evaluate(async ({ mode, productionOnly }) =>
      await window.__airgapperRunLoadedCorpus({ mode, productionOnly }), { mode, productionOnly });
    if (errors.length) result.browserErrors = [...(result.browserErrors || []), ...errors];
    if (output) await fs.writeFile(output, JSON.stringify(result, null, 2));
    return { header, result };
  } finally {
    await page.close();
    if (ownBrowser) await browser.close();
  }
}

function argValue(name) {
  const prefix = `--${name}=`;
  const item = process.argv.find((arg) => arg.startsWith(prefix));
  return item ? item.slice(prefix.length) : null;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const file = process.argv[2];
  if (!file || file.startsWith("--")) {
    console.error("Usage: node benchmark/run-agcap.mjs <capture.agcap> [--mode=performance|maximum|correctness] [--output=result.json] [--base-url=http://127.0.0.1:8080/]");
    process.exit(2);
  }
  const mode = argValue("mode") || "performance";
  const output = argValue("output");
  const baseUrl = argValue("base-url") || process.env.AIRGAPPER_URL || "http://127.0.0.1:8080/";
  const { header, result } = await runAgcap({ file, baseUrl, mode, productionOnly: true, output });
  console.log(JSON.stringify({
    file: path.basename(file), formatVersion: header.formatVersion, pixelFormat: header.pixelFormat,
    frames: header.framesStored, version: result.version,
    firstProductionFrame: result.acquisition?.firstProductionFrame ?? null,
    firstGridLockFrame: result.acquisition?.firstGridLockFrame ?? null,
    qrPerSecond: result.throughput?.qrPerSecond ?? 0,
    verifiedKBPerSecond: result.throughput?.verifiedKBPerSecond ?? 0,
    decodeP50Ms: result.performance?.decodeP50Ms ?? 0,
    decodeP95Ms: result.performance?.decodeP95Ms ?? 0,
    transitions: result.transitions?.length ?? 0,
    failures: result.failures?.length ?? 0,
    browserErrors: result.browserErrors?.length ?? 0
  }, null, 2));
}
