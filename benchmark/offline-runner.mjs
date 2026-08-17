import fs from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.AIRGAPPER_URL || "http://127.0.0.1:8080/";
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
});

// Match the 1440p desktop sender class used for the dense 18-QR wall.
const page = await browser.newPage({ viewport: { width: 2560, height: 1440 } });
page.setDefaultTimeout(30_000);
const pageErrors = [];
page.on("console", (message) => {
  if (message.type() !== "error" || message.text().startsWith("Failed to load resource:")) return;
  pageErrors.push(message.text());
  console.error(`[browser error] ${message.text()}`);
});
page.on("response", (response) => {
  if (response.status() < 400) return;
  const url = response.url();
  if (url.endsWith("/favicon.ico")) return;
  pageErrors.push(`HTTP ${response.status()} ${url}`);
  console.error(`[browser http] ${response.status()} ${url}`);
});
page.on("pageerror", (error) => {
  pageErrors.push(error.stack || error.message);
  console.error(`[browser pageerror] ${error.stack || error.message}`);
});

async function generateSenderFrames() {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator('[data-mode="send"]').click();
  await page.evaluate(() => {
    for (const [id, value] of [
      ["cfg-layout", "three-six"],
      ["cfg-orientation", "landscape"],
      ["cfg-scaling", "integer"],
      ["cfg-fps", "30"]
    ]) {
      const element = document.getElementById(id);
      element.value = value;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  let seed = 0x6d2b79f5;
  let payload = "";
  for (let index = 0; index < 48_000; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    payload += String.fromCharCode(33 + seed % 90);
  }
  await page.fill("#snippet-text", payload);
  await page.locator("#send-snippet").click();
  await page.waitForFunction(() => {
    const canvas = document.getElementById("qr");
    return canvas && canvas.width > 100 && canvas.height > 100 && !document.getElementById("stage").hidden;
  });
  await page.locator("#qr").click({ position: { x: 4, y: 4 } });
  await page.waitForFunction(() => document.body.classList.contains("qr-full"));
  await page.waitForTimeout(120);

  const geometry = await page.locator("#qr").evaluate((canvas) => ({ width: canvas.width, height: canvas.height }));
  if (geometry.width < 1000 || geometry.height < 600)
    throw new Error(`Unexpectedly small fullscreen sender canvas ${geometry.width}x${geometry.height}`);
  console.log(`AIRGAPPER_SENDER_CANVAS ${geometry.width}x${geometry.height}`);
  const frames = [];
  const seen = new Set();
  const deadline = Date.now() + 4_000;
  while (frames.length < 10 && Date.now() < deadline) {
    const url = await page.locator("#qr").evaluate((canvas) => canvas.toDataURL("image/png"));
    if (!seen.has(url)) {
      seen.add(url);
      frames.push(url);
    }
    await page.waitForTimeout(40);
  }
  if (frames.length < 6) throw new Error(`Only generated ${frames.length} distinct sender frames`);
  console.log(`AIRGAPPER_GENERATED_FRAMES ${frames.length}`);
  return frames;
}

function assertScenario(name, result) {
  const failures = [];
  if (!result.ok) failures.push("receiver invariants failed");
  if (!result.productionOnly) failures.push("oracle path was not disabled");
  if (result.decodedPackets <= 0) failures.push("no QR packets decoded");
  if (result.jobs <= 0) failures.push("no decode work scheduled");
  if (result.fullJobs <= 0) failures.push("acquisition never ran");
  if (result.firstProductionFrame == null) failures.push("never acquired a production QR");
  if (name === "acquire-then-stable") {
    if (result.firstGridLockFrame == null) failures.push("never established grid lock");
    if (result.trackedJobs <= 0) failures.push("never switched from acquisition to tracked decoding");
    if (result.guidedJobs <= 0) failures.push("tracked wall never exercised Guided/stable decoder");
  }
  if (result.decodeErrors.length) failures.push(`decode errors: ${result.decodeErrors.join(" | ")}`);
  if (failures.length) throw new Error(`${name}: ${failures.join("; ")} · ${JSON.stringify(result)}`);
}

try {
  const urls = await generateSenderFrames();
  // The header is intentionally hidden in qr-full mode. Trigger the real button
  // handler directly instead of making Playwright wait for visual visibility.
  await page.evaluate(() => document.getElementById("home-button").click());
  await page.waitForTimeout(50);
  await page.waitForFunction(() => typeof window.__airgapperRunFastRegression === "function");

  const animatedOrder = Array.from({ length: urls.length }, (_, index) => index);
  const scenarios = [
    {
      name: "acquire-then-stable",
      urls,
      order: [...animatedOrder, ...Array(30).fill(0)],
      fps: 30,
      mode: "performance"
    },
    { name: "animated-cycle", urls, order: [...animatedOrder, ...animatedOrder], fps: 30, mode: "performance" },
    { name: "animated-maximum", urls, order: [...animatedOrder, ...animatedOrder], fps: 30, mode: "maximum" }
  ];

  const results = {};
  for (const scenario of scenarios) {
    console.log(`AIRGAPPER_FAST_REGRESSION_START ${scenario.name}`);
    const started = performance.now();
    const result = await page.evaluate(async (input) => window.__airgapperRunFastRegression(input), scenario);
    result.wallTimeMs = Math.round(performance.now() - started);
    assertScenario(scenario.name, result);
    results[scenario.name] = result;
    console.log(`AIRGAPPER_FAST_REGRESSION_RESULT ${scenario.name} ${JSON.stringify(result)}`);
  }

  if (pageErrors.length) throw new Error(`Browser emitted ${pageErrors.length} error(s): ${pageErrors.join(" | ")}`);
  const output = {
    format: "AirGapper fast production regression",
    generatedAt: new Date().toISOString(),
    baseUrl,
    sourceFrames: urls.length,
    oracle: false,
    browserErrors: pageErrors,
    scenarios: results
  };
  await fs.writeFile("benchmark/offline-summary.json", JSON.stringify(output, null, 2));
  console.log(`AIRGAPPER_FAST_REGRESSION_PASS ${JSON.stringify(output)}`);
} finally {
  await browser.close();
}
