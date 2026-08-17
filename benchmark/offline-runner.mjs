import fs from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.AIRGAPPER_URL || "http://127.0.0.1:8080/";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
});

const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(5 * 60 * 1000);
page.on("console", (message) => {
  if (["error", "warning"].includes(message.type())) console.error(`[browser ${message.type()}] ${message.text()}`);
});
page.on("pageerror", (error) => console.error(`[browser pageerror] ${error.stack || error.message}`));

async function generateSenderFrames() {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator('[data-mode="send"]').click();
  await page.selectOption("#cfg-layout", "three-six");
  await page.selectOption("#cfg-orientation", "landscape");
  await page.selectOption("#cfg-scaling", "integer");
  await page.selectOption("#cfg-fps", "30");
  const payload = Array.from({ length: 42000 }, (_, index) => String.fromCharCode(33 + index % 90)).join("");
  await page.fill("#snippet-text", payload);
  await page.locator("#send-snippet").click();
  await page.waitForFunction(() => {
    const canvas = document.getElementById("qr");
    return canvas && canvas.width > 100 && canvas.height > 100 && !document.getElementById("stage").hidden;
  });

  const frames = [];
  const seen = new Set();
  const deadline = Date.now() + 5000;
  while (frames.length < 12 && Date.now() < deadline) {
    const url = await page.locator("#qr").evaluate((canvas) => canvas.toDataURL("image/png"));
    if (!seen.has(url)) {
      seen.add(url);
      frames.push(url);
    }
    await page.waitForTimeout(45);
  }
  if (frames.length < 6) throw new Error(`Only generated ${frames.length} distinct sender frames`);
  console.log(`AIRGAPPER_GENERATED_FRAMES ${frames.length}`);
  return frames;
}

try {
  const urls = await generateSenderFrames();
  await page.locator("#home-button").click();
  await page.waitForTimeout(100);
  await page.waitForFunction(() => typeof window.__airgapperRunOfflineImages === "function");

  const scenarios = [
    { name: "static-repeat", urls: [urls[0]], repeats: 36, fps: 30, mode: "performance" },
    { name: "animated-cycle", urls, repeats: 3, fps: 30, mode: "performance" },
    { name: "animated-maximum", urls, repeats: 2, fps: 30, mode: "maximum" }
  ];

  const results = {};
  for (const scenario of scenarios) {
    console.log(`AIRGAPPER_BENCHMARK_START ${scenario.name}`);
    const result = await page.evaluate(async (input) => window.__airgapperRunOfflineImages(input), scenario);
    results[scenario.name] = result;
    console.log(`AIRGAPPER_BENCHMARK_RESULT ${scenario.name} ${JSON.stringify(result)}`);
  }

  const output = { generatedAt: new Date().toISOString(), baseUrl, sourceFrames: urls.length, scenarios: results };
  await fs.writeFile("benchmark/offline-summary.json", JSON.stringify(output, null, 2));
  console.log(`AIRGAPPER_OFFLINE_SUMMARY ${JSON.stringify(output)}`);
} finally {
  await browser.close();
}
