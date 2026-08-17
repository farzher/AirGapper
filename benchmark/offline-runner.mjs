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

async function perturbFrames(urls, count = 20) {
  return page.evaluate(async ({ urls, count }) => {
    const load = (url) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = url;
    });
    const sources = await Promise.all(urls.map(load));
    const width = sources[0].naturalWidth;
    const height = sources[0].naturalHeight;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    const frames = [];
    for (let index = 0; index < count; index++) {
      const phase = index * 0.73;
      const dx = Math.sin(phase) * 4.5;
      const dy = Math.cos(phase * 0.81) * 3.5;
      const scale = 1 + Math.sin(phase * 0.57) * 0.0045;
      const angle = Math.sin(phase * 0.43) * 0.22 * Math.PI / 180;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, width, height);
      ctx.translate(width / 2 + dx, height / 2 + dy);
      ctx.rotate(angle);
      ctx.scale(scale, scale);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(sources[index % sources.length], -width / 2, -height / 2);
      ctx.restore();
      frames.push(canvas.toDataURL("image/png"));
    }
    return frames;
  }, { urls, count });
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
  const motion = await perturbFrames(easy.frames, 20);
  console.log(`AIRGAPPER_SENDER_PROFILE motion-1000B ${easy.geometry.width}x${easy.geometry.height} frames=${motion.length}`);

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

  return { easy: easy.frames, motion, dense: dense.frames };
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function addNormalizedDiagnostics(result) {
  const guided = result.guided ?? {};
  const tracks = Number(guided.tracks) || 0;
  const outputs = Number(guided.outputs) || 0;
  const jobs = Number(guided.jobs) || 0;
  const turboAttempts = Number(guided.turboAttempts) || 0;
  const stableRsAttempts = Number(guided.stableRsAttempts) || 0;
  const dataOnlyAttempts = Number(guided.dataOnlyAttempts) || 0;
  result.normalized = {
    guidedOutputYield: ratio(outputs, tracks),
    turboYield: ratio(Number(guided.turboSuccesses) || 0, turboAttempts),
    stableRsYield: ratio(Number(guided.stableRsSuccesses) || 0, stableRsAttempts),
    dataOnlyYield: ratio(Number(guided.dataOnlySuccesses) || 0, dataOnlyAttempts),
    sampleMsPerTrack: ratio(Number(guided.sampleMs) || 0, tracks),
    sampleMsPerOutput: ratio(Number(guided.sampleMs) || 0, outputs),
    decodeMsPerOutput: ratio(Number(guided.decodeMs) || 0, outputs),
    guidedMsPerTrack: ratio(Number(guided.totalMs) || 0, tracks),
    guidedMsPerOutput: ratio(Number(guided.totalMs) || 0, outputs),
    guidedMsPerJob: ratio(Number(guided.totalMs) || 0, jobs),
    stableRsAttemptsPerTrack: ratio(stableRsAttempts, tracks),
    dataOnlyAttemptsPerTrack: ratio(dataOnlyAttempts, tracks)
  };
  return result;
}

function commonAssertions(name, result, failures) {
  if (!result.ok) failures.push("receiver invariants failed");
  if (!result.productionOnly) failures.push("oracle path was not disabled");
  if (result.decodedPackets <= 0) failures.push("no QR packets decoded");
  if (result.jobs <= 0) failures.push("no decode work scheduled");
  if (result.fullJobs <= 0) failures.push("acquisition never ran");
  if (result.firstProductionFrame == null) failures.push("never acquired a production QR");
  if (result.decodeErrors.length) failures.push(`decode errors: ${result.decodeErrors.join(" | ")}`);
  if (result.firstLockedStateFrame == null) failures.push("lattice never entered a locked state");
  else if (result.firstLockedStateFrame > 8) failures.push(`lock regressed to frame ${result.firstLockedStateFrame} (>8)`);
  if (result.fullJobs > 5) failures.push(`too many acquisition scans (${result.fullJobs} > 5)`);
  if (result.tailFullJobs !== 0) failures.push(`stable tail used ${result.tailFullJobs} full scans`);
}

function assertScenario(name, result) {
  const failures = [];
  commonAssertions(name, result, failures);

  // Y8 scenarios are the live-camera-equivalent path. These floors are broad:
  // they verify that the real Guided lane is active and useful without encoding
  // any expectation about these exact generated images.
  if (name === "stable-y8") {
    if (result.trackedJobs < 20) failures.push(`too little tracked work (${result.trackedJobs} < 20)`);
    if (result.guidedJobs < 12) failures.push(`too little actual Guided work (${result.guidedJobs} < 12)`);
    if (result.guidedTracks < 120) failures.push(`too few Guided track attempts (${result.guidedTracks} < 120)`);
    if (result.guidedOutputs < 80) failures.push(`too few Guided outputs (${result.guidedOutputs} < 80)`);
    if (result.tailTrackedJobs < 12) failures.push(`stable tail only scheduled ${result.tailTrackedJobs} tracked jobs (<12)`);
    if (result.decodeP95Ms > 180) failures.push(`stable Y8 p95 decode ${result.decodeP95Ms.toFixed(1)}ms > 180ms`);
    if (result.normalized.guidedOutputYield < 0.98) failures.push(`stable Guided yield ${(result.normalized.guidedOutputYield * 100).toFixed(1)}% < 98%`);
    if (result.guided.dataOnlyAttempts >= 50 && result.normalized.dataOnlyYield < 0.98)
      failures.push(`stable CRC-Turbo yield ${(result.normalized.dataOnlyYield * 100).toFixed(1)}% < 98%`);
  }
  if (name === "motion-y8") {
    if (result.finalState !== "TRACK") failures.push(`motion path ended in ${result.finalState}, not TRACK`);
    if (result.trackedJobs < 16) failures.push(`motion tracked jobs ${result.trackedJobs} < 16`);
    if (result.guidedJobs < 10) failures.push(`motion Guided jobs ${result.guidedJobs} < 10`);
    if (result.guidedOutputs < 80) failures.push(`motion Guided outputs ${result.guidedOutputs} < 80`);
    if (result.tailTrackedJobs < 10) failures.push(`motion tail only scheduled ${result.tailTrackedJobs} tracked jobs (<10)`);
    if (result.decodeP95Ms > 220) failures.push(`motion Y8 p95 decode ${result.decodeP95Ms.toFixed(1)}ms > 220ms`);
    if (result.normalized.guidedOutputYield < 0.75) failures.push(`motion Guided yield ${(result.normalized.guidedOutputYield * 100).toFixed(1)}% < 75%`);
  }
  if (name === "dense-y8") {
    if (result.trackedJobs < 10) failures.push(`dense tracked jobs ${result.trackedJobs} < 10`);
    if (result.guidedJobs < 7) failures.push(`dense actual Guided jobs ${result.guidedJobs} < 7`);
    if (result.guidedOutputs < 45) failures.push(`dense Guided outputs ${result.guidedOutputs} < 45`);
    if (result.uniqueUsefulQrPerSecond < 60) failures.push(`dense useful rate ${result.uniqueUsefulQrPerSecond.toFixed(1)} QR/s < 60`);
    if (result.decodeP95Ms > 220) failures.push(`dense Y8 p95 decode ${result.decodeP95Ms.toFixed(1)}ms > 220ms`);
    if (result.normalized.guidedOutputYield < 0.95) failures.push(`dense Guided yield ${(result.normalized.guidedOutputYield * 100).toFixed(1)}% < 95%`);
    if (result.guided.stableRsAttempts >= 40 && result.normalized.stableRsYield < 0.95)
      failures.push(`dense Stable-RS yield ${(result.normalized.stableRsYield * 100).toFixed(1)}% < 95%`);
  }
  // Keep a short buffered-path guard because corpus replay and non-TrackProcessor
  // inputs are real product paths too. Geometry-aware native decode should win
  // decisively before generic recovery on this clean stable wall.
  if (name === "buffered-rgba") {
    if ((result.hotPath?.nativeTracks ?? 0) < 80) failures.push("buffered path did not exercise native tracked decode");
    if ((result.hotPath?.crcFastPercent ?? 0) < 80) failures.push(`buffered native CRC yield ${(result.hotPath?.crcFastPercent ?? 0).toFixed(1)}% < 80%`);
    if ((result.hotPath?.localRecoveryAttempts ?? 0) > 4) failures.push(`buffered path used ${result.hotPath.localRecoveryAttempts} local recoveries (>4)`);
  }
  if (failures.length) throw new Error(`${name}: ${failures.join("; ")} · ${JSON.stringify(result)}`);
}

try {
  const { easy, motion, dense } = await generateSenderProfiles();
  await page.evaluate(() => document.getElementById("home-button").click());
  await page.waitForTimeout(50);
  await page.waitForFunction(() => typeof window.__airgapperRunFastRegression === "function");

  const easyOrder = Array.from({ length: easy.length }, (_, index) => index);
  const denseOrder = Array.from({ length: dense.length }, (_, index) => index);
  const scenarios = [
    {
      name: "stable-y8",
      urls: easy,
      order: [...easyOrder, ...Array(24).fill(0)],
      fps: 30,
      mode: "performance",
      cameraPath: true
    },
    {
      name: "motion-y8",
      urls: [...easy, ...motion],
      order: Array.from({ length: easy.length + motion.length }, (_, index) => index),
      fps: 30,
      mode: "performance",
      cameraPath: true
    },
    {
      name: "dense-y8",
      urls: dense,
      order: [...denseOrder, ...denseOrder],
      fps: 30,
      mode: "performance",
      cameraPath: true
    },
    {
      name: "buffered-rgba",
      urls: easy,
      order: [...easyOrder, ...Array(12).fill(0)],
      fps: 30,
      mode: "performance",
      cameraPath: false
    }
  ];

  const results = {};
  for (const scenario of scenarios) {
    console.log(`AIRGAPPER_FAST_REGRESSION_START ${scenario.name}`);
    const started = performance.now();
    const result = addNormalizedDiagnostics(await page.evaluate(async (input) => window.__airgapperRunFastRegression(input), scenario));
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
    sourceFrames: { stable: easy.length, motion: motion.length, dense: dense.length },
    oracle: false,
    browserErrors: pageErrors,
    scenarios: results
  };
  await fs.writeFile("benchmark/offline-summary.json", JSON.stringify(output, null, 2));
  console.log(`AIRGAPPER_FAST_REGRESSION_PASS ${JSON.stringify(output)}`);
} finally {
  await browser.close();
}
