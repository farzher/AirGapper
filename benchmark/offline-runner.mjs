import fs from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.AIRGAPPER_URL || "http://127.0.0.1:8080/";
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
});

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

async function captureDistinctFrames(label, count) {
  const frames = [];
  const seen = new Set();
  const deadline = Date.now() + 4_000;
  while (frames.length < count && Date.now() < deadline) {
    const url = await page.locator("#qr").evaluate((canvas) => canvas.toDataURL("image/png"));
    if (!seen.has(url)) {
      seen.add(url);
      frames.push(url);
    }
    await page.waitForTimeout(40);
  }
  if (frames.length < Math.min(6, count)) throw new Error(`${label}: only generated ${frames.length} distinct sender frames`);
  const geometry = await page.locator("#qr").evaluate((canvas) => ({ width: canvas.width, height: canvas.height }));
  console.log(`AIRGAPPER_SENDER_PROFILE ${label} ${geometry.width}x${geometry.height} frames=${frames.length}`);
  return { frames, geometry };
}

async function generateSenderProfiles() {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator('[data-mode="send"]').click();
  await page.evaluate(() => {
    for (const [id, value] of [
      ["cfg-layout", "three-six"],
      ["cfg-orientation", "landscape"],
      ["cfg-scaling", "integer"],
      ["cfg-fps", "30"],
      ["cfg-size", "1"]
    ]) {
      const element = document.getElementById(id);
      element.value = value;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  // Deterministic but deliberately incompressible enough that Send must use
  // the animated transport instead of collapsing the fixture to one direct QR.
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

  const easy = await captureDistinctFrames("stable-1000B", 8);

  const easyGeometry = easy.geometry;
  await page.evaluate(() => {
    const size = document.getElementById("cfg-size");
    size.value = "5";
    size.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForFunction(({ width, height }) => {
    const canvas = document.getElementById("qr");
    return canvas && (canvas.width !== width || canvas.height !== height);
  }, easyGeometry).catch(() => void 0);
  await page.waitForTimeout(180);
  const dense = await captureDistinctFrames("dense-2953B", 10);

  return { easy: easy.frames, dense: dense.frames };
}

function assertScenario(name, result) {
  const failures = [];
  if (!result.ok) failures.push("receiver invariants failed");
  if (!result.productionOnly) failures.push("oracle path was not disabled");
  if (result.decodedPackets <= 0) failures.push("no QR packets decoded");
  if (result.jobs <= 0) failures.push("no decode work scheduled");
  if (result.fullJobs <= 0) failures.push("acquisition never ran");
  if (result.firstProductionFrame == null) failures.push("never acquired a production QR");
  if (result.decodeErrors.length) failures.push(`decode errors: ${result.decodeErrors.join(" | ")}`);

  if (name === "stable-path") {
    if (result.firstLockedStateFrame == null) failures.push("lattice never entered a locked state");
    if (result.trackedJobs <= 0) failures.push("never switched to tracked decoding");
    if (result.guidedJobs <= 0) failures.push("Guided/stable decoder never ran");
    if (result.tailTrackedJobs <= result.tailFullJobs)
      failures.push(`stable tail did not favor tracked work (${result.tailTrackedJobs} tracked vs ${result.tailFullJobs} full)`);
  }
  if (name === "dense-performance") {
    if (result.firstLockedStateFrame == null) failures.push("dense wall never locked");
    if (result.trackedJobs <= result.fullJobs) failures.push("dense wall did not move decisively to tracked decoding");
    if (result.tailFullJobs !== 0) failures.push(`dense tail still used ${result.tailFullJobs} full scans`);
    if (result.uniqueUsefulQrPerSecond <= 0) failures.push("dense wall produced no useful symbol rate");
  }
  if (failures.length) throw new Error(`${name}: ${failures.join("; ")} · ${JSON.stringify(result)}`);
}

try {
  const { easy, dense } = await generateSenderProfiles();
  await page.evaluate(() => document.getElementById("home-button").click());
  await page.waitForTimeout(50);
  await page.waitForFunction(() => typeof window.__airgapperRunFastRegression === "function");

  const easyOrder = Array.from({ length: easy.length }, (_, index) => index);
  const denseOrder = Array.from({ length: dense.length }, (_, index) => index);
  const scenarios = [
    {
      name: "stable-path",
      urls: easy,
      order: [...easyOrder, ...Array(24).fill(0)],
      fps: 30,
      mode: "performance"
    },
    {
      name: "dense-performance",
      urls: dense,
      order: [...denseOrder, ...denseOrder],
      fps: 30,
      mode: "performance"
    }
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
    sourceFrames: { stable: easy.length, dense: dense.length },
    oracle: false,
    browserErrors: pageErrors,
    scenarios: results
  };
  await fs.writeFile("benchmark/offline-summary.json", JSON.stringify(output, null, 2));
  console.log(`AIRGAPPER_FAST_REGRESSION_PASS ${JSON.stringify(output)}`);
} finally {
  await browser.close();
}
