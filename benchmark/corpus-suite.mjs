import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { runAgcap } from "./run-agcap.mjs";

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

export async function runCorpusSuite({
  manifestFile = process.env.AIRGAPPER_CORPUS_MANIFEST || "benchmark/corpora/manifest.json",
  output = "benchmark/hardware-corpus-summary.json",
  baseUrl = process.env.AIRGAPPER_URL || "http://127.0.0.1:8080/"
} = {}) {
  const manifestPath = path.resolve(manifestFile);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const corpora = Array.isArray(manifest.corpora) ? manifest.corpora : [];
  const summary = {
    format: "AirGapper real-camera corpus suite",
    generatedAt: new Date().toISOString(),
    manifest: path.relative(process.cwd(), manifestPath),
    corpora: []
  };

  if (!corpora.length) {
    console.log("AIRGAPPER_CORPUS_SUITE_SKIP no real-camera corpora registered");
    await fs.writeFile(output, JSON.stringify(summary, null, 2));
    return summary;
  }

  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });
  try {
    for (const entry of corpora) {
      const file = path.resolve(path.dirname(manifestPath), entry.file);
      const { header, result } = await runAgcap({
        file,
        browser,
        baseUrl,
        mode: entry.mode || "maximum",
        productionOnly: true
      });
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
      summary.corpora.push({
        name: entry.name,
        file: entry.file,
        header,
        derived,
        assertions: assertionResults,
        result
      });
      console.log(`AIRGAPPER_CORPUS_RESULT ${entry.name} ${failures.length ? "FAIL" : "PASS"} ` + JSON.stringify({
        frames: header.framesStored,
        firstProductionFrame: result.acquisition?.firstProductionFrame ?? null,
        firstGridLockFrame: result.acquisition?.firstGridLockFrame ?? null,
        qrPerSecond: result.throughput?.qrPerSecond ?? 0,
        derived,
        failures
      }));
      if (failures.length) {
        throw new Error(`${entry.name}: ${failures.map((failure) => `${failure.path} ${failure.op || ">="} ${failure.value}, got ${failure.actual}`).join("; ")}`);
      }
    }
  } finally {
    await browser.close();
  }

  await fs.writeFile(output, JSON.stringify(summary, null, 2));
  console.log(`AIRGAPPER_CORPUS_SUITE_PASS corpora=${corpora.length}`);
  return summary;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) await runCorpusSuite();
