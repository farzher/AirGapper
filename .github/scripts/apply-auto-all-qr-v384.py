from pathlib import Path

# Export the complete QR-L byte-capacity table so Auto Size can search every
# standard QR version while manual Size keeps its small, readable preset list.
capacity = Path("shared/frame-capacity.js")
s = capacity.read_text()
old = """export {\n  MAX_SOURCE_BLOCKS,\n  blockLength,\n"""
new = """export {\n  MAX_SOURCE_BLOCKS,\n  QR_BYTE_CAPACITY_L,\n  blockLength,\n"""
if old not in s:
    raise SystemExit("frame-capacity export block did not match")
s = s.replace(old, new, 1)
capacity.write_text(s)

main = Path("send/main.js")
s = main.read_text()

old = """import {\n  fitsInOneStream,\n  selectTransportPlan,\n"""
new = """import {\n  fitsInOneStream,\n  QR_BYTE_CAPACITY_L,\n  selectTransportPlan,\n"""
if old not in s:
    raise SystemExit("frame-capacity import block did not match")
s = s.replace(old, new, 1)

old = """  const frameByteChoices = optimizeSize ? FRAME_BYTES_OPTIONS : [requestedFrameBytes];\n"""
new = """  // Manual Size stays intentionally simple, but Auto Size searches every\n  // standard QR-L capacity (v1..v40). This removes the large packing cliffs\n  // caused by choosing from only six arbitrary byte presets.\n  const frameByteChoices = optimizeSize ? QR_BYTE_CAPACITY_L : [requestedFrameBytes];\n"""
if old not in s:
    raise SystemExit("Auto Size choice line did not match")
s = s.replace(old, new, 1)

old = """  for (const maximumFrameBytes of frameByteChoices) {\n    if (!fitsInOneStream(payloadBytes, maximumFrameBytes, true)) continue;\n    const plan = selectTransportPlan(payloadBytes, maximumFrameBytes, true, true);\n    if (plan.mode === \"direct\") continue;\n    for (const layout of AUTO_GRID_LAYOUTS) {\n      const codes = layout.cols * layout.rows;\n      const extent = gridRasterExtent(plan.qrModules, layout.cols, layout.rows, GRID_MARGIN);\n      const displayW = landscape ? extent.height : extent.width;\n      const displayH = landscape ? extent.width : extent.height;\n"""
new = """  for (const maximumFrameBytes of frameByteChoices) {\n    let plan;\n    try {\n      // Small QR versions can be below transport-header capacity. They are\n      // simply not candidates; Auto must never abort because v1/v2 are tiny.\n      if (!fitsInOneStream(payloadBytes, maximumFrameBytes, true)) continue;\n      plan = selectTransportPlan(payloadBytes, maximumFrameBytes, true, true);\n    } catch {\n      continue;\n    }\n    if (plan.mode === \"direct\") continue;\n    for (const layout of AUTO_GRID_LAYOUTS) {\n      const codes = layout.cols * layout.rows;\n      const extent = gridRasterExtent(plan.qrModules, layout.cols, layout.rows, GRID_MARGIN);\n      const displayW = landscape ? extent.height : extent.width;\n      const displayH = landscape ? extent.width : extent.height;\n      const displayCols = landscape ? layout.rows : layout.cols;\n      const displayRows = landscape ? layout.cols : layout.rows;\n"""
if old not in s:
    raise SystemExit("Auto candidate loop did not match")
s = s.replace(old, new, 1)

old = """      candidates.push({ maximumFrameBytes, plan, layout, codes, moduleScale,\n        displayModulePx: moduleScale, screenFill, changesPerRefresh,\n        payloadPerSecond, refreshHz, aspectError });\n"""
new = """      candidates.push({ maximumFrameBytes, plan, layout, codes, moduleScale,\n        displayCols, displayRows, displayModulePx: moduleScale, screenFill,\n        changesPerRefresh, payloadPerSecond, refreshHz, aspectError });\n"""
if old not in s:
    raise SystemExit("candidate push block did not match")
s = s.replace(old, new, 1)

old = """  if (optimizeSize) {\n    candidates.sort((a, b) => {\n      const rateDelta = b.payloadPerSecond - a.payloadPerSecond;\n      const tied = Math.abs(rateDelta) <= Math.max(a.payloadPerSecond, b.payloadPerSecond) * 0.02;\n      if (!tied) return rateDelta;\n      return b.codes - a.codes || b.moduleScale - a.moduleScale ||\n        b.screenFill - a.screenFill || a.aspectError - b.aspectError ||\n        b.maximumFrameBytes - a.maximumFrameBytes || a.layout.id - b.layout.id;\n    });\n  } else {\n"""
new = """  if (optimizeSize) {\n    // First preserve essentially all available theoretical bandwidth. Then,\n    // within 5% of the fastest candidate, bias toward more display rows so a\n    // horizontal rolling-shutter transition destroys a smaller wall fraction.\n    // More independent QRs is the next robustness tie-break.\n    const maxPayloadPerSecond = Math.max(...candidates.map((candidate) => candidate.payloadPerSecond));\n    const robust = candidates.filter((candidate) =>\n      candidate.payloadPerSecond + 1e-9 >= maxPayloadPerSecond * 0.95\n    );\n    robust.sort((a, b) =>\n      b.displayRows - a.displayRows ||\n      b.codes - a.codes ||\n      b.payloadPerSecond - a.payloadPerSecond ||\n      b.screenFill - a.screenFill ||\n      b.moduleScale - a.moduleScale ||\n      a.aspectError - b.aspectError ||\n      b.plan.frameBytes - a.plan.frameBytes ||\n      a.layout.id - b.layout.id\n    );\n    candidates.length = 0;\n    candidates.push(...robust);\n  } else {\n"""
if old not in s:
    raise SystemExit("Auto Size sort block did not match")
s = s.replace(old, new, 1)

old = """  const sizeLabel = autoGrid.autoSize ? `Auto Size→${formatBytes(autoGrid.maximumFrameBytes)}` : `Size ${formatBytes(autoGrid.maximumFrameBytes)}`;\n"""
new = """  const sizeLabel = autoGrid.autoSize ? `Auto Size→${formatBytes(transport.frameBytes)}` : `Size ${formatBytes(autoGrid.maximumFrameBytes)}`;\n"""
if old not in s:
    raise SystemExit("Auto Size status label did not match")
s = s.replace(old, new, 1)

main.write_text(s)

version = Path("version.js")
v = version.read_text()
if 'APP_VERSION = "0.5.383"' not in v:
    raise SystemExit("unexpected version.js")
version.write_text(v.replace('APP_VERSION = "0.5.383"', 'APP_VERSION = "0.5.384"', 1))
