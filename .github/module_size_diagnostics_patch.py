from pathlib import Path

p=Path('receive/worker.js')
s=p.read_text()
old='''    stableRsAttempts: metricsView.getUint32(144, true),\n    stableRsSuccesses: metricsView.getUint32(148, true),\n    stableEligibleTracks: metricsView.getUint32(152, true)\n  };'''
new='''    stableRsAttempts: metricsView.getUint32(144, true),\n    stableRsSuccesses: metricsView.getUint32(148, true),\n    stableEligibleTracks: metricsView.getUint32(152, true)\n  };\n  const moduleSizes = tracks.map((track) => quadModuleSize(track.quad, track.dim)).filter((value) => value > 0 && Number.isFinite(value));\n  if (moduleSizes.length) {\n    metrics.moduleSizeMin = Math.min(...moduleSizes);\n    metrics.moduleSizeMax = Math.max(...moduleSizes);\n    metrics.moduleSizeAvg = moduleSizes.reduce((sum, value) => sum + value, 0) / moduleSizes.length;\n  } else {\n    metrics.moduleSizeMin = metrics.moduleSizeMax = metrics.moduleSizeAvg = 0;\n  }'''
if old not in s: raise SystemExit('guided metrics parse anchor missing')
s=s.replace(old,new,1)
p.write_text(s)

p=Path('receive/main.js')
s=p.read_text()
old='''stableRS ${lastGuidedMetrics.stableRsSuccesses ?? 0}/${lastGuidedMetrics.stableRsAttempts ?? 0} stable ${lastGuidedMetrics.stableEligibleTracks ?? 0} · RS'''
new='''stableRS ${lastGuidedMetrics.stableRsSuccesses ?? 0}/${lastGuidedMetrics.stableRsAttempts ?? 0} stable ${lastGuidedMetrics.stableEligibleTracks ?? 0} · module ${(lastGuidedMetrics.moduleSizeAvg ?? 0).toFixed(2)}px [${(lastGuidedMetrics.moduleSizeMin ?? 0).toFixed(2)}–${(lastGuidedMetrics.moduleSizeMax ?? 0).toFixed(2)}] · RS'''
if old not in s: raise SystemExit('guided diagnostic line anchor missing')
s=s.replace(old,new,1)

old='''  const guidedOutputs = sumGuided("successful");\n  const guided = {\n    jobs: guidedJobs,'''
new='''  const guidedOutputs = sumGuided("successful");\n  const moduleWeighted = guidedMetrics.reduce((sum, metrics) => sum + (Number(metrics.moduleSizeAvg) || 0) * (Number(metrics.tracks) || 0), 0);\n  const moduleMins = guidedMetrics.map((metrics) => Number(metrics.moduleSizeMin) || 0).filter((value) => value > 0);\n  const moduleMaxes = guidedMetrics.map((metrics) => Number(metrics.moduleSizeMax) || 0).filter((value) => value > 0);\n  const guided = {\n    jobs: guidedJobs,\n    moduleSizeAvg: guidedTracks ? moduleWeighted / guidedTracks : 0,\n    moduleSizeMin: moduleMins.length ? Math.min(...moduleMins) : 0,\n    moduleSizeMax: moduleMaxes.length ? Math.max(...moduleMaxes) : 0,'''
if old not in s: raise SystemExit('benchmark guided builder anchor missing')
s=s.replace(old,new,1)
if 'const RECEIVER_RUNTIME_BUILD = "v0.5.232";' not in s: raise SystemExit('receiver version anchor missing')
s=s.replace('const RECEIVER_RUNTIME_BUILD = "v0.5.232";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.233";', 1)
p.write_text(s)

for path in ['main.js','index.html']:
    q=Path(path); text=q.read_text()
    if 'v0.5.232' not in text: raise SystemExit(f'{path}: app version anchor missing')
    q.write_text(text.replace('v0.5.232','v0.5.233'))
q=Path('sw.js'); text=q.read_text()
if 'airgapper-static-js-v188' not in text: raise SystemExit('sw cache anchor missing')
q.write_text(text.replace('airgapper-static-js-v188','airgapper-static-js-v189',1))
