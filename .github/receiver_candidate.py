from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:200]!r}")
    p.write_text(text.replace(old, new, 1))

send = "send/main.js"

replace_once(send,
'''  const temporalOrder = spatiallyDispersedOrder(gridCols, gridRows);\n  const phaseStep = temporalPhaseStep(gridCodes);\n''',
'''  // Synchronous walls never use per-cell phase ordering. Avoid building and\n  // retaining scheduling state that cannot participate in this mode.\n  const temporalOrder = synchronousUpdates ? null : spatiallyDispersedOrder(gridCols, gridRows);\n  const phaseStep = synchronousUpdates ? 1 : temporalPhaseStep(gridCodes);\n''')

replace_once(send,
'''          version\n        }, transfer);\n''',
'''          // The transport planner already solved the exact byte capacity and\n          // therefore the QR version. Tell every worker immediately instead of\n          // making each worker rediscover it independently on its first page.\n          version: version ?? transport.qrVersion\n        }, transfer);\n''')

replace_once(send,
'''    const drawPage = (page) => {\n      const { source, totalW, totalH } = validatePage(page);\n      const stagingCtx = staging.getContext("2d");\n      stagingCtx.setTransform(1, 0, 0, 1, 0, 0);\n      stagingCtx.globalCompositeOperation = "copy";\n      stagingCtx.imageSmoothingEnabled = false;\n      stagingCtx.drawImage(source, 0, 0, totalW, totalH);\n      stagingCtx.globalCompositeOperation = "source-over";\n      if (fitStaging) {\n        const fitCtx = fitStaging.getContext("2d");\n        fitCtx.setTransform(1, 0, 0, 1, 0, 0);\n        fitCtx.globalCompositeOperation = "copy";\n        fitCtx.imageSmoothingEnabled = false;\n        fitCtx.drawImage(staging, 0, 0, totalW, totalH, 0, 0, fitStaging.width, fitStaging.height);\n        fitCtx.globalCompositeOperation = "source-over";\n        renderFitCanvas();\n      } else {\n        const ctx = canvas.getContext("2d");\n        ctx.globalCompositeOperation = "copy";\n        ctx.imageSmoothingEnabled = false;\n        if (landscapeGrid())\n          ctx.setTransform(0, canvas.height / totalW, -canvas.width / totalH, 0, canvas.width, 0);\n        else\n          ctx.setTransform(canvas.width / totalW, 0, 0, canvas.height / totalH, 0, 0);\n        ctx.drawImage(staging, 0, 0);\n        ctx.setTransform(1, 0, 0, 1, 0, 0);\n        ctx.globalCompositeOperation = "source-over";\n      }\n      if (activeTransportCursor?.key === transportKey)\n        activeTransportCursor.nextOrdinal = Math.max(activeTransportCursor.nextOrdinal, page.endOrdinal);\n    };\n''',
'''    const drawPage = (page) => {\n      const { source, totalW, totalH } = validatePage(page);\n      // A synchronous page is already a complete immutable wall from the\n      // worker. It never needs the persistent module-resolution staging wall\n      // used by phased/cell updates, so present it directly and remove one\n      // full-wall canvas copy from every sender frame.\n      let drawSource = source;\n      if (!synchronousUpdates) {\n        const stagingCtx = staging.getContext("2d");\n        stagingCtx.setTransform(1, 0, 0, 1, 0, 0);\n        stagingCtx.globalCompositeOperation = "copy";\n        stagingCtx.imageSmoothingEnabled = false;\n        stagingCtx.drawImage(source, 0, 0, totalW, totalH);\n        stagingCtx.globalCompositeOperation = "source-over";\n        drawSource = staging;\n      }\n      if (fitStaging) {\n        const fitCtx = fitStaging.getContext("2d");\n        fitCtx.setTransform(1, 0, 0, 1, 0, 0);\n        fitCtx.globalCompositeOperation = "copy";\n        fitCtx.imageSmoothingEnabled = false;\n        fitCtx.drawImage(drawSource, 0, 0, totalW, totalH, 0, 0, fitStaging.width, fitStaging.height);\n        fitCtx.globalCompositeOperation = "source-over";\n        renderFitCanvas();\n      } else {\n        const ctx = canvas.getContext("2d");\n        ctx.globalCompositeOperation = "copy";\n        ctx.imageSmoothingEnabled = false;\n        if (landscapeGrid())\n          ctx.setTransform(0, canvas.height / totalW, -canvas.width / totalH, 0, canvas.width, 0);\n        else\n          ctx.setTransform(canvas.width / totalW, 0, 0, canvas.height / totalH, 0, 0);\n        ctx.drawImage(drawSource, 0, 0);\n        ctx.setTransform(1, 0, 0, 1, 0, 0);\n        ctx.globalCompositeOperation = "source-over";\n      }\n      if (activeTransportCursor?.key === transportKey)\n        activeTransportCursor.nextOrdinal = Math.max(activeTransportCursor.nextOrdinal, page.endOrdinal);\n    };\n''')

replace_once(send, 'const SEND_RUNTIME_BUILD = "v0.5.347";', 'const SEND_RUNTIME_BUILD = "v0.5.348";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.347";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.348";')
replace_once("main.js", 'const APP_BUILD = "v0.5.347";', 'const APP_BUILD = "v0.5.348";')
replace_once("index.html", 'v0.5.347</span>', 'v0.5.348</span>')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v295";', 'const CACHE = "airgapper-static-js-v296";')

print("v0.5.348 candidate applied")
