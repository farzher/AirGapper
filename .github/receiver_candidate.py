from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing expected text in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


# Sender clock lifecycle.
replace_once(
    "send/main.js",
    'const SEND_RUNTIME_BUILD = "v0.5.267";',
    'const SEND_RUNTIME_BUILD = "v0.5.274";'
)
replace_once(
    "send/main.js",
    'let activeSendFpsSetter = null;\nfunction stopSendRenderer() {',
    'let activeSendFpsSetter = null;\nlet activeSendClockRebase = null;\nfunction stopSendRenderer() {'
)
replace_once(
    "send/main.js",
    '  activeSendRendererCleanup = null;\n  activeSendFpsSetter = null;\n  cleanup?.();',
    '  activeSendRendererCleanup = null;\n  activeSendFpsSetter = null;\n  activeSendClockRebase = null;\n  cleanup?.();'
)

# Parallel page/cell renderer: a hidden tab must never repay missed phase time.
replace_once(
    "send/main.js",
    '''    activeSendFpsSetter = (fps) => {\n      pageInterval = 1e3 / Math.max(1, fps);\n      cellInterval = pageInterval / gridCodes;\n      // Speed changes are live: keep the current sweep and warm workers. If the\n      // new rate is faster, pull the next phase forward; never blank/restart.\n      if (nextCellAt)\n        nextCellAt = Math.min(nextCellAt, performance.now() + cellInterval);\n    };''',
    '''    activeSendFpsSetter = (fps) => {\n      pageInterval = 1e3 / Math.max(1, fps);\n      cellInterval = pageInterval / gridCodes;\n      // Speed changes are live: keep the current sweep and warm workers. If the\n      // new rate is faster, pull the next phase forward; never blank/restart.\n      if (nextCellAt)\n        nextCellAt = Math.min(nextCellAt, performance.now() + cellInterval);\n    };\n    activeSendClockRebase = () => {\n      // Background tabs suspend rAF. Resume from the next real presentation\n      // opportunity; time spent hidden is not sender debt to be repaid.\n      nextCellAt = 0;\n    };'''
)
replace_once(
    "send/main.js",
    '''        if (!nextCellAt) nextCellAt = now;\n      }\n\n      let painted = 0;''',
    '''        if (!nextCellAt) nextCellAt = now;\n      }\n\n      // visibilitychange explicitly rebases this clock on tab restore. Also\n      // fence genuinely large scheduler stalls, but do not confuse an FPS above\n      // the display refresh rate with suspension: ordinary rAF lateness may\n      // still catch up exactly as before.\n      if (!nextCellAt || now - nextCellAt > 250)\n        nextCellAt = now + cellInterval;\n\n      let painted = 0;'''
)

# Single-thread fallback renderer gets the same clock semantics while preserving
# its old high-FPS behavior when normal rAF cadence is slower than requested FPS.
replace_once(
    "send/main.js",
    '''  activeSendFpsSetter = (fps) => {\n    interval = 1e3 / Math.max(1, fps);\n    nextAt = Math.min(nextAt, performance.now() + interval);\n  };\n  const tick = (now) => {\n    if (gen !== generation || generatorFailed) return;\n    requestAnimationFrame(tick);\n    if (now < nextAt) return;\n    if (now - nextAt > interval) nextAt = now;''',
    '''  activeSendFpsSetter = (fps) => {\n    interval = 1e3 / Math.max(1, fps);\n    nextAt = Math.min(nextAt, performance.now() + interval);\n  };\n  activeSendClockRebase = () => { nextAt = 0; };\n  const tick = (now) => {\n    if (gen !== generation || generatorFailed) return;\n    requestAnimationFrame(tick);\n    if (!nextAt || now - nextAt > 250) nextAt = now + interval;\n    if (now < nextAt) return;\n    if (now - nextAt > interval) nextAt = now;'''
)

# The app already emits pause/resume on visibility changes; use resume to fence
# the sender presentation clock before the first visible rAF callback.
replace_once(
    "send/main.js",
    '''window.addEventListener("airgapper:resume-mode", () => {\n  var _a;\n  if (!((_a = document.getElementById("sendView")) == null ? void 0 : _a.classList.contains("active")) || !selectedFile) return;\n  void requestScreenWakeLock();\n});''',
    '''window.addEventListener("airgapper:resume-mode", () => {\n  var _a;\n  if (!((_a = document.getElementById("sendView")) == null ? void 0 : _a.classList.contains("active")) || !selectedFile) return;\n  activeSendClockRebase?.();\n  void requestScreenWakeLock();\n});'''
)

# Cache/version bust so installed PWAs cannot retain the old sender scheduler.
replace_once("main.js", 'const APP_BUILD = "v0.5.273";', 'const APP_BUILD = "v0.5.274";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.273";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.274";')
replace_once("index.html", 'v0.5.273</span>', 'v0.5.274</span>')
replace_once("index.html", './main.js?build=v0.5.273', './main.js?build=v0.5.274')
replace_once("sw.js", 'airgapper-static-js-v221', 'airgapper-static-js-v222')
