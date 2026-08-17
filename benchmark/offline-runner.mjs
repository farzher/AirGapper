import fs from "node:fs/promises";
import process from "node:process";
import { chromium } from "playwright-core";

const baseUrl = process.env.AIRGAPPER_URL || "http://127.0.0.1:8080/";
const chrome = process.env.CHROME_BIN;
if (!chrome) throw new Error("CHROME_BIN is required");
const urls = process.argv.slice(2);
if (!urls.length) throw new Error("Pass one or more benchmark image URLs");

const browser = await chromium.launch({
  headless: true,
  executablePath: chrome,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
});

const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(10 * 60 * 1000);
page.on("console", (message) => {
  if (["error", "warning"].includes(message.type())) console.error(`[browser ${message.type()}] ${message.text()}`);
});
page.on("pageerror", (error) => console.error(`[browser pageerror] ${error.stack || error.message}`));

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => typeof window.__airgapperRunOfflineImages === "function");

  const scenarios = [
    ...urls.map((url, index) => ({ name: `static-${index + 1}`, urls: [url], repeats: 75, fps: 30, mode: "performance" })),
    { name: "trio-cycle", urls, repeats: 45, fps: 30, mode: "performance" },
    { name: "trio-maximum", urls, repeats: 30, fps: 30, mode: "maximum" }
  ];

  const results = {};
  for (const scenario of scenarios) {
    console.log(`AIRGAPPER_BENCHMARK_START ${scenario.name}`);
    const result = await page.evaluate(async (input) => window.__airgapperRunOfflineImages(input), scenario);
    results[scenario.name] = result;
    console.log(`AIRGAPPER_BENCHMARK_RESULT ${scenario.name} ${JSON.stringify(result)}`);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    scenarios: results
  };
  await fs.writeFile("benchmark/offline-summary.json", JSON.stringify(output, null, 2));
  console.log(`AIRGAPPER_OFFLINE_SUMMARY ${JSON.stringify(output)}`);
} finally {
  await browser.close();
}
