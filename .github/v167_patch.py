from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing anchor in {path}: {old[:180]!r}")
    p.write_text(text.replace(old, new, 1))

replace_once("index.html", "v0.5.166", "v0.5.167")
replace_once("main.js", 'const APP_BUILD = "v0.5.166";', 'const APP_BUILD = "v0.5.167";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.166";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.167";')
replace_once("sw.js", 'airgapper-static-js-v128', 'airgapper-static-js-v129')

p = Path("receive/main.js")
text = p.read_text()

anchor = '''const livePipeline = {\n'''
insert = '''const SLOT_METRIC_COUNT = 64;\nconst slotAttemptCounts = new Uint32Array(SLOT_METRIC_COUNT);\nconst slotHitCounts = new Uint32Array(SLOT_METRIC_COUNT);\nfunction resetSlotMetrics() {\n  slotAttemptCounts.fill(0);\n  slotHitCounts.fill(0);\n}\nfunction noteSlotMetric(slot, hit) {\n  const index = Number(slot);\n  if (!Number.isInteger(index) || index < 0 || index >= SLOT_METRIC_COUNT) return;\n  slotAttemptCounts[index]++;\n  if (hit) slotHitCounts[index]++;\n}\nfunction formatSlotMetric(slot) {\n  const attempts = slotAttemptCounts[slot] || 0;\n  const hits = slotHitCounts[slot] || 0;\n  return `s${slot} ${hits}/${attempts}${attempts ? ` ${(hits / attempts * 100).toFixed(0)}%` : ""}`;\n}\nfunction cornerSlotMetrics() {\n  const candidates = regions.filter((region) =>\n    region.gridSlot !== void 0 && region.slotState !== "OFFSCREEN" &&\n    [region.x, region.y, region.w, region.h].every(Number.isFinite)\n  );\n  if (candidates.length < 2) return "";\n  const center = (region) => ({ x: region.x + region.w / 2, y: region.y + region.h / 2 });\n  const pick = (score, largest = false) => candidates.reduce((best, region) => {\n    const value = score(center(region));\n    if (!best || (largest ? value > best.value : value < best.value)) return { region, value };\n    return best;\n  }, null)?.region;\n  const tl = pick((p) => p.x + p.y);\n  const tr = pick((p) => p.x - p.y, true);\n  const bl = pick((p) => p.y - p.x, true);\n  const br = pick((p) => p.x + p.y, true);\n  const corner = (label, region) => region ? `${label} ${formatSlotMetric(region.gridSlot)}` : "";\n  const measured = candidates\n    .map((region) => {\n      const slot = region.gridSlot;\n      const attempts = slotAttemptCounts[slot] || 0;\n      const hits = slotHitCounts[slot] || 0;\n      return { slot, attempts, hits, rate: attempts ? hits / attempts : 1 };\n    })\n    .filter((item, index, array) => item.attempts >= 4 && array.findIndex((other) => other.slot === item.slot) === index)\n    .sort((a, b) => a.rate - b.rate || b.attempts - a.attempts)\n    .slice(0, 4);\n  const weak = measured.length ? ` · weak ${measured.map((item) => formatSlotMetric(item.slot)).join(" · ")}` : "";\n  return `Corners  ${[corner("TL", tl), corner("TR", tr), corner("BL", bl), corner("BR", br)].filter(Boolean).join(" · ")}${weak}`;\n}\n\nconst livePipeline = {\n'''
if anchor not in text:
    raise SystemExit("live pipeline anchor missing")
text = text.replace(anchor, insert, 1)

old = '''  });\n  resetGuidedRollout();\n}\nfunction pushLiveLatency'''
new = '''  });\n  resetSlotMetrics();\n  resetGuidedRollout();\n}\nfunction pushLiveLatency'''
if old not in text:
    raise SystemExit("reset pipeline anchor missing")
text = text.replace(old, new, 1)

old = '''    const hit = completion.symbols.some((symbol) => symbol.box && regionAt(symbol.box) === region);\n    region.decodeConfidence = region.decodeConfidence * 0.82 + Number(hit) * 0.18;'''
new = '''    const hit = completion.symbols.some((symbol) => symbol.box && regionAt(symbol.box) === region);\n    if (region.gridSlot !== void 0) noteSlotMetric(region.gridSlot, hit);\n    region.decodeConfidence = region.decodeConfidence * 0.82 + Number(hit) * 0.18;'''
if old not in text:
    raise SystemExit("slot hit anchor missing")
text = text.replace(old, new, 1)

old = '''    `Output   valid ${validQrRate.toFixed(1)} · unique ${uniqueQrRate.toFixed(1)} · duplicate ${duplicateQrRate.toFixed(1)} QR/s · useful ${liveGoodputKbs(perfNow).toFixed(1)} KB/s`,\n    `Pressure worker-busy'''
new = '''    `Output   valid ${validQrRate.toFixed(1)} · unique ${uniqueQrRate.toFixed(1)} · duplicate ${duplicateQrRate.toFixed(1)} QR/s · useful ${liveGoodputKbs(perfNow).toFixed(1)} KB/s`,\n    cornerSlotMetrics(),\n    `Pressure worker-busy'''
if old not in text:
    raise SystemExit("focus diagnostics anchor missing")
text = text.replace(old, new, 1)

p.write_text(text)
