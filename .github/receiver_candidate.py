from pathlib import Path


def rep(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'missing anchor {path}: {old[:140]}')
    p.write_text(s.replace(old, new, 1))

# Version/cache.
rep('receive/main.js', 'const RECEIVER_RUNTIME_BUILD = "v0.5.280";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.281";')
rep('main.js', 'const APP_BUILD = "v0.5.280";', 'const APP_BUILD = "v0.5.281";')
p = Path('index.html')
s = p.read_text()
if s.count('v0.5.280') < 2:
    raise SystemExit('index version anchors missing')
p.write_text(s.replace('v0.5.280', 'v0.5.281'))
rep('sw.js', 'airgapper-static-js-v227', 'airgapper-static-js-v228')

# Completion must visually reach 100% before synchronous payload assembly can
# monopolize the main thread. The normal bar intentionally eases width changes
# over 220 ms; cancel that transition for the final state so it cannot freeze
# at 97-99% while assemble()/unpack/verification runs.
p = Path('receive/main.js')
s = p.read_text()
old = '''function paintTransferComplete() {\n  bar.style.width = "100%";\n  progressEl.setAttribute("aria-valuenow", "100");\n  progressLabel.textContent = "100%";\n  transferSizeLabel.textContent = "";\n  etaLabel.textContent = "Finalizing…";\n}'''
new = '''function paintTransferComplete() {\n  // Snap, do not animate, the final 100%. Expensive assembly immediately after\n  // completion can block animation frames for large transfers; leaving the\n  // normal width transition active makes the bar appear stuck around 97-99%.\n  bar.classList.add("finalizing");\n  bar.getAnimations?.().forEach((animation) => animation.cancel());\n  bar.style.width = "100%";\n  progressEl.setAttribute("aria-valuenow", "100");\n  progressLabel.textContent = "100%";\n  transferSizeLabel.textContent = "";\n  etaLabel.textContent = "Finalizing…";\n}'''
if old not in s:
    raise SystemExit('paintTransferComplete anchor missing')
s = s.replace(old, new, 1)
old = '''function waitForProgressPaint() {\n  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));\n}'''
new = '''async function waitForProgressPaint() {\n  // rAF callbacks run before paint and promise continuations are microtasks, so\n  // a timer task after the rAF gives the compositor an unconditional paint\n  // opportunity before we enter synchronous payload assembly.\n  await new Promise((resolve) => requestAnimationFrame(resolve));\n  await new Promise((resolve) => setTimeout(resolve, 0));\n}'''
if old not in s:
    raise SystemExit('waitForProgressPaint anchor missing')
s = s.replace(old, new, 1)
# Reset the snap state for the next receive session.
old = '''  bar.style.width = "0";\n  bar.classList.remove("error");'''
new = '''  bar.style.width = "0";\n  bar.classList.remove("error", "finalizing");'''
if old not in s:
    raise SystemExit('bar reset anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)

# Preserve the pleasant transition/pulse during receiving; disable both only
# after all transport symbols are present and the UI is entering finalization.
p = Path('shared/style.css')
s = p.read_text()
old = '.progress > div { height: 100%; width: 0; background: var(--ink); border-radius: inherit; transition: width .22s ease-out; animation: progress-pulse 1.4s ease-in-out infinite; }\n.progress > div.error { background: var(--bad); animation: none; }'
new = '.progress > div { height: 100%; width: 0; background: var(--ink); border-radius: inherit; transition: width .22s ease-out; animation: progress-pulse 1.4s ease-in-out infinite; }\n.progress > div.finalizing { transition: none; animation: none; opacity: 1; }\n.progress > div.error { background: var(--bad); animation: none; }'
if old not in s:
    raise SystemExit('progress CSS anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)
