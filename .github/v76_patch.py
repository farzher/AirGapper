from pathlib import Path


def replace_exact(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    found = s.count(old)
    if found != count:
        raise SystemExit(f"{path}: expected {count} matches, got {found}: {old[:160]!r}")
    p.write_text(s.replace(old, new, count))

replace_exact("index.html", "v0.5.75", "v0.5.76")
replace_exact("index.html", '<script type="module" src="./main.js"></script>', '<script type="module" src="./main.js?build=v0.5.76"></script>')
replace_exact("sw.js", 'const CACHE = "airgapper-static-js-v38";', 'const CACHE = "airgapper-static-js-v39";')
replace_exact(
    "sw.js",
    'event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));',
    '''event.waitUntil(caches.open(CACHE).then(async (cache) => {
      await Promise.all(PRECACHE.map(async (url) => {
        const response = await fetch(url, { cache: "reload" });
        if (!response.ok) throw new Error(`Precache failed ${response.status}: ${url}`);
        await cache.put(url, response);
      }));
    }).then(() => self.skipWaiting()));'''
)
replace_exact("sw.js", "const response = await fetch(request);", 'const response = await fetch(request, { cache: "no-store" });')

p = Path("main.js")
s = p.read_text()
start = s.index("var _a;")
marker = 'const installShell = document.querySelector(".install-shell");'
end = s.index(marker)
new = '''var _a;
import { closeOnBackdropClick } from "./shared/dialog.js";
import { isAndroid, isIOS } from "./shared/platform.js";

const APP_BUILD = "v0.5.76";
const serviceWorkers = navigator.serviceWorker;
let registration;
let swBootComplete = false;
let reloading = false;

function waitForServiceWorkerState(worker, timeoutMs = 5000) {
  if (!worker || worker.state === "installed" || worker.state === "activated" || worker.state === "redundant") return Promise.resolve();
  return Promise.race([
    new Promise((resolve) => worker.addEventListener("statechange", () => {
      if (worker.state === "installed" || worker.state === "activated" || worker.state === "redundant") resolve();
    })),
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

async function prepareServiceWorker() {
  if (!serviceWorkers) return;
  const priorController = serviceWorkers.controller;
  try {
    registration = await serviceWorkers.register(`./sw.js?build=${APP_BUILD}`, { scope: "./", updateViaCache: "none" });
    await registration.update().catch(() => void 0);
    await waitForServiceWorkerState(registration.installing);
    registration.waiting?.postMessage({ type: "SKIP_WAITING" });
    if (priorController && serviceWorkers.controller === priorController && registration.waiting) {
      await Promise.race([
        new Promise((resolve) => serviceWorkers.addEventListener("controllerchange", resolve, { once: true })),
        new Promise((resolve) => setTimeout(resolve, 3000))
      ]);
    }
  } catch {
  }
}

await prepareServiceWorker();
await Promise.all([
  import(`./send/main.js?build=${APP_BUILD}`),
  import(`./receive/main.js?build=${APP_BUILD}`)
]);

document.querySelector(".app-version").textContent = APP_BUILD;
swBootComplete = true;
if (serviceWorkers) {
  serviceWorkers.addEventListener("controllerchange", () => {
    if (!swBootComplete || reloading) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener("load", () => void registration?.update().catch(() => void 0), { once: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void registration?.update().catch(() => void 0);
  });
}
'''
p.write_text(s[:start] + new + s[end:])

replace_exact(
    "receive/main.js",
    'const startBtn = document.getElementById("start");',
    'const RECEIVER_RUNTIME_BUILD = "v0.5.76";\nconst startBtn = document.getElementById("start");'
)
replace_exact(
    "receive/main.js",
    '''Hot path ${strictHotPathActive() ? `STRICT · lock ${strictHotPathLockSeen ? "established" : "acquiring"}` : "LIVE"}''',
    '''Runtime ${RECEIVER_RUNTIME_BUILD}\nHot path ${strictHotPathActive() ? `STRICT · lock ${strictHotPathLockSeen ? "established" : "acquiring"}` : "LIVE"}'''
)
