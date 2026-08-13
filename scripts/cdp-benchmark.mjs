import fs from "node:fs";

const [corpus, referenceFile, output] = process.argv.slice(2);
if (!corpus || !referenceFile) throw new Error("usage: node scripts/cdp-benchmark.mjs corpus.agcap reference.json [output.json]");
const referenceResult = JSON.parse(fs.readFileSync(referenceFile, "utf8"));
const reference = referenceResult.frames.map(({ sequence, reference }) => ({ sequence, reference }));
const downloadDir = `${process.env.TEMP}\\airgapper-bench-downloads`;
fs.mkdirSync(downloadDir, { recursive: true });
for (const file of fs.readdirSync(downloadDir)) fs.rmSync(`${downloadDir}\\${file}`);

const pages = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = pages.find((item) => item.type === "page" && item.url.includes("127.0.0.1:"));
if (!page) throw new Error("AirGapper page not found");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 1;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  const job = pending.get(message.id);
  if (!job) return;
  pending.delete(message.id);
  message.error ? job.reject(new Error(JSON.stringify(message.error))) : job.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression, awaitPromise = false) => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
const waitUntil = async (label, predicate, timeoutMs) => {
  const started = Date.now();
  let lastStatus = "";
  for (;;) {
    const state = await evaluate(`({status:document.getElementById("benchmark-status").textContent, runDisabled:document.getElementById("run-benchmark").disabled, files:document.getElementById("corpus-file").files.length})`);
    if (state.status && state.status !== lastStatus) {
      lastStatus = state.status;
      console.log(`${label}: ${state.status}`);
    }
    if (predicate(state)) return state;
    if (Date.now() - started > timeoutMs) throw new Error(`${label} timed out: ${JSON.stringify(state)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};
try {
  await send("Runtime.enable");
  await send("DOM.enable");
  await send("Network.enable");
  await send("Network.setBypassServiceWorker", { bypass: true });
  await send("Page.enable");
  await send("Page.reload", { ignoreCache: true });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if (await evaluate(`document.readyState === "complete" && Boolean(document.getElementById("corpus-file"))`)) break;
    } catch { /* The execution context is replaced during navigation. */ }
    if (attempt === 99) throw new Error("AirGapper page reload timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir, eventsEnabled: true });
  await evaluate(`window.__airgapperBenchmarkReference=${JSON.stringify(reference)}; document.getElementById("decode-workers").value="4"; document.getElementById("replay-mode").value="performance"`);
  const { root } = await send("DOM.getDocument", { depth: -1, pierce: true });
  const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: "#corpus-file" });
  await send("DOM.setFileInputFiles", { nodeId, files: [corpus] });
  await evaluate(`document.getElementById("corpus-file").dispatchEvent(new Event("change",{bubbles:true}))`);
  await waitUntil("load", (state) => !state.runDisabled && state.status.includes("frames"), 60_000);
  await evaluate(`document.getElementById("run-benchmark").click()`);
  await waitUntil("replay", (state) => !state.runDisabled && state.status.includes("Run complete"), 180_000);
  await evaluate(`document.getElementById("save-benchmark").click()`);
  let downloaded;
  for (let attempt = 0; attempt < 100; attempt++) {
    const files = fs.readdirSync(downloadDir).filter((file) => file.endsWith(".json"));
    if (files.length) { downloaded = `${downloadDir}\\${files[0]}`; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!downloaded) throw new Error("benchmark download did not finish");
  const result = JSON.parse(fs.readFileSync(downloaded, "utf8"));
  if (output) fs.copyFileSync(downloaded, output);
  console.log(JSON.stringify({ throughput: result.throughput, performance: result.performance }, null, 2));
} finally {
  ws.close();
}
