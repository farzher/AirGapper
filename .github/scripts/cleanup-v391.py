from pathlib import Path
import re


def replace_one(text, old, new, label):
    if old not in text:
        raise SystemExit(f"missing {label}")
    return text.replace(old, new, 1)

# Compact transport duplicate tracking. RaptorQ uses a 24-bit ESI, so a bitset
# is dramatically smaller than a JS Set of boxed/hash-table numbers and creates
# no per-symbol Set entries. Grow only if an unusually long stream needs it.
p = Path("shared/transport.js")
s = p.read_text()
s = replace_one(s,
'''    this.mode = undefined;
    this.seen = /* @__PURE__ */ new Set();
    this.mdsBasis = undefined;''',
'''    this.mode = undefined;
    this.seenBits = undefined;
    this.mdsBasis = undefined;''',
"seen field")
s = replace_one(s,
'''    this.mode = codingMode(k);
    this.mdsBasis = new Array(k).fill(null);''',
'''    this.mode = codingMode(k);
    const seenBytes = Math.max(32, Math.ceil(Math.min(1 << 24, Math.max(256, k * 2)) / 8));
    this.seenBits = new Uint8Array(seenBytes);
    this.mdsBasis = new Array(k).fill(null);''',
"seen bitset init")
s = replace_one(s,
'''  addFrame(esi, block) {
    if (this.seen.has(esi)) {
      this.framesDup++;
      return;
    }
    this.seen.add(esi);
    this.framesNew++;''',
'''  isDuplicate(esi) {
    const value = Number(esi) >>> 0;
    const byteIndex = value >>> 3;
    if (byteIndex >= this.seenBits.length) {
      let nextLength = this.seenBits.length;
      const maxLength = 1 << 21; // one bit for every 24-bit ESI
      while (nextLength <= byteIndex && nextLength < maxLength) nextLength = Math.min(maxLength, nextLength * 2);
      if (byteIndex >= nextLength) return false;
      const grown = new Uint8Array(nextLength);
      grown.set(this.seenBits);
      this.seenBits = grown;
    }
    const mask = 1 << (value & 7);
    if (this.seenBits[byteIndex] & mask) return true;
    this.seenBits[byteIndex] |= mask;
    return false;
  }
  addFrame(esi, block) {
    if (this.isDuplicate(esi)) {
      this.framesDup++;
      return;
    }
    this.framesNew++;''',
"duplicate bitset")
s = replace_one(s,
'''    const pivot = coefficients.findIndex((value) => value !== 0);
    if (pivot < 0) {''',
'''    let pivot = -1;
    for (let index = 0; index < coefficients.length; index++) {
      if (coefficients[index] !== 0) { pivot = index; break; }
    }
    if (pivot < 0) {''',
"mds pivot loop")
s = replace_one(s,
'''    this.raptor = null;
    this.raptorPayload = null;
    this.seen.clear();
    this.mdsBasis.length = 0;''',
'''    this.raptor = null;
    this.raptorPayload = null;
    this.seenBits = null;
    this.mdsBasis.length = 0;''',
"seen free")
if "this.seen" in s:
    raise SystemExit("old Set duplicate tracking remains")
p.write_text(s)

# Normal stats only need the age of the oldest active worker, not a freshly
# allocated array of cloned job objects every tick.
p = Path("shared/worker-pool.js")
s = p.read_text()
s = replace_one(s,
'''  get busyCount() {
    let count = 0;
    for (let index = 0; index < this.busy.length; index++) count += Number(this.busy[index]);
    return count;
  }
  configureWorker(slot, worker) {''',
'''  get busyCount() {
    let count = 0;
    for (let index = 0; index < this.busy.length; index++) count += Number(this.busy[index]);
    return count;
  }
  get oldestActiveAgeMs() {
    const now = performance.now();
    let oldest = 0;
    for (let index = 0; index < this.activeMeta.length; index++) {
      const startedAt = this.activeMeta[index]?.startedAt;
      if (Number.isFinite(startedAt)) oldest = Math.max(oldest, now - startedAt);
    }
    return oldest;
  }
  configureWorker(slot, worker) {''',
"oldest active getter")
p.write_text(s)

p = Path("receive/main.js")
s = p.read_text()
# Completely dead telemetry: values were written/reset but never read.
block = re.compile(r'''\nconst pipelineEvents = \[\];\nconst PIPELINE_EVENT_LIMIT = 80;\nfunction notePipelineEvent\(kind, value = 0\) \{\n  if \(pipelineEvents\.length >= PIPELINE_EVENT_LIMIT\) return;\n  pipelineEvents\.push\(\[\n    Number\(\(\(receiverNow\(\) - cameraStartedTs\) / 1e3\)\.toFixed\(2\)\),\n    kind,\n    value\n  \]\);\n\}\n''')
s, count = block.subn("\n", s, count=1)
if count != 1:
    raise SystemExit("missing pipelineEvents block")
s = s.replace('  pipelineEvents.length = 0;\n', '')
# All call sites are intentionally one-line telemetry statements.
s = re.sub(r'^\s*notePipelineEvent\([^\n;]*\);\s*\n', '', s, flags=re.MULTILINE)
if "notePipelineEvent(" in s or "pipelineEvents" in s or "PIPELINE_EVENT_LIMIT" in s:
    raise SystemExit("dead pipeline telemetry remains")

old = '''  metric("m-cap").textContent = `${completionRate.toFixed(1)} fps`;
  metric("m-dec").textContent = `${qrRate.toFixed(1)} QR/s`;
  const activeJobs = pool.activeJobs;
  const oldestActiveMs = activeJobs.length ? Math.max(...activeJobs.map((job) => job.ageMs)) : 0;
  const observedP95Ms = Math.max(livePercentile(livePipeline.trackedLatencies, 0.95), livePercentile(livePipeline.fullLatencies, 0.95));
  const stallThresholdMs = Math.max(5e3, Math.min(9e3, observedP95Ms * 4 || 5e3));
  const completionSilenceMs = livePipeline.lastCompletedAt ? now - livePipeline.lastCompletedAt : now - cameraStartedTs;
  const stalled = activeJobs.length > 0 && oldestActiveMs >= stallThresholdMs && completionSilenceMs >= stallThresholdMs;'''
new = '''  metric("m-cap").textContent = `${completionRate.toFixed(1)} fps`;
  metric("m-dec").textContent = `${qrRate.toFixed(1)} QR/s`;
  const activeJobCount = pool.busyCount;
  const oldestActiveMs = pool.oldestActiveAgeMs;
  const observedP95Ms = Math.max(livePercentile(livePipeline.trackedLatencies, 0.95), livePercentile(livePipeline.fullLatencies, 0.95));
  const stallThresholdMs = Math.max(5e3, Math.min(9e3, observedP95Ms * 4 || 5e3));
  const completionSilenceMs = livePipeline.lastCompletedAt ? now - livePipeline.lastCompletedAt : now - cameraStartedTs;
  const stalled = activeJobCount > 0 && oldestActiveMs >= stallThresholdMs && completionSilenceMs >= stallThresholdMs;'''
s = replace_one(s, old, new, "normal active job allocation")
p.write_text(s)

p = Path("version.js")
s = p.read_text()
s = replace_one(s, 'export const APP_VERSION = "0.5.390";', 'export const APP_VERSION = "0.5.391";', "version")
p.write_text(s)
