from pathlib import Path

def rep(path, old, new, count=1):
    p = Path(path); s = p.read_text()
    if old not in s: raise SystemExit(f"missing anchor {path}: {old[:100]!r}")
    p.write_text(s.replace(old, new, count))

for path, old, new in [
('receive/main.js','const RECEIVER_RUNTIME_BUILD = "v0.5.298";','const RECEIVER_RUNTIME_BUILD = "v0.5.299";'),
('send/main.js','const SEND_RUNTIME_BUILD = "v0.5.298";','const SEND_RUNTIME_BUILD = "v0.5.299";'),
('main.js','const APP_BUILD = "v0.5.298";','const APP_BUILD = "v0.5.299";'),
('index.html','main.js?build=v0.5.298','main.js?build=v0.5.299'),
('index.html','<span class="brand">AirGapper <span class="app-version">v0.5.298</span></span>','<span class="brand">AirGapper <span class="app-version">v0.5.299</span></span>'),
('sw.js','airgapper-static-js-v246','airgapper-static-js-v247')]: rep(path, old, new)

# Expose the already-loaded corpus to headless Playwright without adding a
# second replay implementation. This calls the exact same runReceiverBenchmark.
main = Path('receive/main.js').read_text()
anchor = '''closeBenchmarkBtn.addEventListener("click", () => benchmarkDialog.close());
runBenchmarkBtn.addEventListener("click", () => void runReceiverBenchmark());'''
insert = '''window.__airgapperRunLoadedCorpus = async ({ mode = "performance", productionOnly = true } = {}) => {
  if (!benchmarkCorpus) throw new Error("No .agcap corpus is loaded");
  if (!["performance", "maximum", "correctness"].includes(mode)) throw new Error(`Unknown replay mode ${mode}`);
  replayMode.value = mode;
  await runReceiverBenchmark({ productionOnly });
  if (!benchmarkResult) throw new Error(benchmarkStatus.textContent || "Corpus benchmark produced no result");
  return structuredClone(benchmarkResult);
};
window.__airgapperLoadedCorpusHeader = () => benchmarkCorpus ? structuredClone(benchmarkCorpus.header) : null;
closeBenchmarkBtn.addEventListener("click", () => benchmarkDialog.close());
runBenchmarkBtn.addEventListener("click", () => void runReceiverBenchmark());'''
if anchor not in main: raise SystemExit('missing benchmark event anchor')
main = main.replace(anchor, insert, 1)
Path('receive/main.js').write_text(main)

run_agcap = r'''import fs from "node:fs/promises";
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
    await page.waitForFunction(() => typeof window.__airgapperRunLoadedCorpus === "function");
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
'''
Path('benchmark/run-agcap.mjs').write_text(run_agcap)

suite = r'''import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { runAgcap } from "./run-agcap.mjs";

const manifestPath = path.resolve(process.env.AIRGAPPER_CORPUS_MANIFEST || "benchmark/corpora/manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const corpora = Array.isArray(manifest.corpora) ? manifest.corpora : [];
const summary = { format: "AirGapper real-camera corpus suite", generatedAt: new Date().toISOString(), manifest: path.relative(process.cwd(), manifestPath), corpora: [] };

function valueAt(object, dotted) {
  return dotted.split(".").reduce((value, key) => value == null ? void 0 : value[key], object);
}
function compare(actual, op, expected) {
  if (op === ">=") return actual >= expected;
  if (op === ">") return actual > expected;
  if (op === "<=") return actual <= expected;
  if (op === "<") return actual < expected;
  if (op === "===" || op === "==") return actual === expected;
  if (op === "!==" || op === "!=") return actual !== expected;
  throw new Error(`Unsupported corpus assertion operator ${op}`);
}

if (!corpora.length) {
  console.log("AIRGAPPER_CORPUS_SUITE_SKIP no real-camera corpora registered");
  await fs.writeFile("benchmark/hardware-corpus-summary.json", JSON.stringify(summary, null, 2));
} else {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  try {
    for (const entry of corpora) {
      const file = path.resolve(path.dirname(manifestPath), entry.file);
      const { header, result } = await runAgcap({ file, browser, mode: entry.mode || "maximum", productionOnly: true });
      const derived = {
        reacquireTransitions: (result.transitions || []).filter((item) => item.to === "REACQUIRE").length,
        partialLossTransitions: (result.transitions || []).filter((item) => item.to === "PARTIAL_LOSS").length,
        trackTransitions: (result.transitions || []).filter((item) => item.to === "TRACK").length,
        browserErrors: result.browserErrors?.length || 0
      };
      const assertionResults = (entry.assert || []).map((check) => {
        const source = check.path.startsWith("derived.") ? { derived } : result;
        const actual = valueAt(source, check.path);
        return { ...check, actual, ok: compare(actual, check.op || ">=", check.value) };
      });
      const failures = assertionResults.filter((item) => !item.ok);
      summary.corpora.push({ name: entry.name, file: entry.file, header, derived, assertions: assertionResults, result });
      console.log(`AIRGAPPER_CORPUS_RESULT ${entry.name} ${failures.length ? "FAIL" : "PASS"} ` + JSON.stringify({
        frames: header.framesStored, firstProductionFrame: result.acquisition?.firstProductionFrame ?? null,
        firstGridLockFrame: result.acquisition?.firstGridLockFrame ?? null,
        qrPerSecond: result.throughput?.qrPerSecond ?? 0, derived, failures
      }));
      if (failures.length) throw new Error(`${entry.name}: ${failures.map((f) => `${f.path} ${f.op || ">="} ${f.value}, got ${f.actual}`).join("; ")}`);
    }
  } finally { await browser.close(); }
  await fs.writeFile("benchmark/hardware-corpus-summary.json", JSON.stringify(summary, null, 2));
  console.log(`AIRGAPPER_CORPUS_SUITE_PASS corpora=${corpora.length}`);
}
'''
Path('benchmark/corpus-suite.mjs').write_text(suite)
Path('benchmark/corpora').mkdir(parents=True, exist_ok=True)
Path('benchmark/corpora/manifest.json').write_text('''{
  "format": "AirGapper real-camera corpus manifest v1",
  "corpora": []
}\n''')

# Validate the browser hook exists and syntax-load both node runners as part of
# the existing regression gate. Actual real-camera corpora are added later.
runner = Path('benchmark/offline-runner.mjs').read_text()
anchor = '''  console.log(`AIRGAPPER_AGCAP_RAW_Y_PASS ${JSON.stringify(rawYRoundTrip)}`);
  await page.evaluate(() => document.getElementById("home-button").click());'''
insert = '''  console.log(`AIRGAPPER_AGCAP_RAW_Y_PASS ${JSON.stringify(rawYRoundTrip)}`);
  const corpusRunnerReady = await page.evaluate(() => typeof window.__airgapperRunLoadedCorpus === "function" && typeof window.__airgapperLoadedCorpusHeader === "function");
  if (!corpusRunnerReady) throw new Error("Headless .agcap replay API unavailable");
  await import("./run-agcap.mjs");
  await import("./corpus-suite.mjs");
  await page.evaluate(() => document.getElementById("home-button").click());'''
if anchor not in runner: raise SystemExit('missing raw Y runner anchor')
Path('benchmark/offline-runner.mjs').write_text(runner.replace(anchor, insert, 1))

workflow = Path('.github/workflows/apply-v217-offline-benchmark.yml').read_text()
workflow = workflow.replace('''      - benchmark/grid-lattice-regression.mjs
      - .github/receiver_candidate.py''','''      - benchmark/grid-lattice-regression.mjs
      - benchmark/run-agcap.mjs
      - benchmark/corpus-suite.mjs
      - benchmark/corpora/**
      - .github/receiver_candidate.py''',1)
workflow = workflow.replace('''          AIRGAPPER_TRIALS=3 node benchmark/offline-runner.mjs 2>&1 | tee /tmp/receiver-regression.log
''','''          AIRGAPPER_TRIALS=3 node benchmark/offline-runner.mjs 2>&1 | tee /tmp/receiver-regression.log
          node benchmark/corpus-suite.mjs 2>&1 | tee /tmp/hardware-corpus.log
''',1)
workflow = workflow.replace('''          path: benchmark/offline-summary.json
''','''          path: |
            benchmark/offline-summary.json
            benchmark/hardware-corpus-summary.json
''',1)
Path('.github/workflows/apply-v217-offline-benchmark.yml').write_text(workflow)

for path, needle in [
('receive/main.js','window.__airgapperRunLoadedCorpus'),
('benchmark/run-agcap.mjs','export async function runAgcap'),
('benchmark/corpus-suite.mjs','AIRGAPPER_CORPUS_SUITE_PASS'),
('benchmark/offline-runner.mjs','Headless .agcap replay API unavailable'),
('.github/workflows/apply-v217-offline-benchmark.yml','benchmark/corpora/**')]:
    if needle not in Path(path).read_text(): raise SystemExit(f'missing v299 invariant {path}: {needle}')
