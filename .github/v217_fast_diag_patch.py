from pathlib import Path

p = Path("receive/main.js")
s = p.read_text()

old = '''  const unique = new Set(decoded.map((packet) => packet.esi));\n  const guidedKinds = Object.entries(result?.performance?.byKind ?? {})'''
new = '''  const unique = new Set(decoded.map((packet) => packet.esi));\n  const slotCounts = {};\n  for (const packet of decoded) {\n    const slot = Number(packet.slot);\n    if (Number.isInteger(slot) && slot >= 0) slotCounts[slot] = (slotCounts[slot] ?? 0) + 1;\n  }\n  const guidedKinds = Object.entries(result?.performance?.byKind ?? {})'''
if old not in s:
    raise SystemExit("fast regression slot diagnostic anchor missing")
s = s.replace(old, new, 1)

old = '''  const decodeErrors = jobs.filter((job) => job.error).map((job) => String(job.error));\n  const resultObject = {'''
new = '''  const decodeErrors = jobs.filter((job) => job.error).map((job) => String(job.error));\n  const lockedStates = new Set(["GRID_LOCK", "TRACK", "PARTIAL_LOSS"]);\n  const firstLockedStateFrame = frames.findIndex((frame) => lockedStates.has(frame.stateBefore) || lockedStates.has(frame.stateAfter));\n  const stateCounts = {};\n  for (const frame of frames) {\n    const state = frame.stateBefore ?? "unknown";\n    stateCounts[state] = (stateCounts[state] ?? 0) + 1;\n  }\n  const tail = frames.slice(Math.floor(frames.length / 2));\n  const tailJobs = tail.flatMap((frame) => frame.jobs ?? []);\n  const tailFullJobs = tailJobs.filter((job) => job.full).length;\n  const tailTrackedJobs = tailJobs.length - tailFullJobs;\n  const resultObject = {'''
if old not in s:
    raise SystemExit("fast regression state diagnostic anchor missing")
s = s.replace(old, new, 1)

old = '''    uniqueSymbols: unique.size,\n    qrPerSecond: result?.throughput?.qrPerSecond ?? 0,'''
new = '''    uniqueSymbols: unique.size,\n    decodedSlots: Object.keys(slotCounts).map(Number).sort((a, b) => a - b),\n    slotCounts,\n    qrPerSecond: result?.throughput?.qrPerSecond ?? 0,'''
if old not in s:
    raise SystemExit("fast regression result slot anchor missing")
s = s.replace(old, new, 1)

old = '''    firstGridLockFrame: result?.acquisition?.firstGridLockFrame,\n    transitions: result?.transitions?.length ?? 0,\n    jobs: jobs.length,'''
new = '''    firstGridLockFrame: result?.acquisition?.firstGridLockFrame,\n    firstLockedStateFrame: firstLockedStateFrame >= 0 ? firstLockedStateFrame : null,\n    stateCounts,\n    finalState: frames.at(-1)?.stateAfter ?? frames.at(-1)?.stateBefore ?? null,\n    transitions: result?.transitions?.length ?? 0,\n    jobs: jobs.length,'''
if old not in s:
    raise SystemExit("fast regression result state anchor missing")
s = s.replace(old, new, 1)

old = '''    guidedOutputs,\n    decodeP50Ms: result?.performance?.decodeP50Ms ?? 0,'''
new = '''    guidedOutputs,\n    tailFullJobs,\n    tailTrackedJobs,\n    decodeP50Ms: result?.performance?.decodeP50Ms ?? 0,'''
if old not in s:
    raise SystemExit("fast regression tail result anchor missing")
s = s.replace(old, new, 1)

p.write_text(s)
