from pathlib import Path
p=Path('receive/main.js')
s=p.read_text()
old='''  const lockedStates = new Set(["GRID_LOCK", "TRACK", "PARTIAL_LOSS"]);\n  const firstLockedStateFrame = frames.findIndex((frame) => lockedStates.has(frame.stateBefore) || lockedStates.has(frame.stateAfter));'''
new='''  const lockedStates = new Set(["GRID_LOCK", "TRACK", "PARTIAL_LOSS"]);\n  // stateAfter can be updated asynchronously by a decode job whose source was\n  // captured several frames earlier. Use stateBefore for wall-clock lock\n  // observation; keep acquisition.firstGridLockFrame separately as the source\n  // frame whose decode triggered the transition.\n  const firstLockedStateFrame = frames.findIndex((frame) => lockedStates.has(frame.stateBefore));'''
if old not in s: raise SystemExit('fast regression lock-state anchor missing')
s=s.replace(old,new,1)
old='''    firstGridLockFrame: result?.acquisition?.firstGridLockFrame,\n    firstLockedStateFrame: firstLockedStateFrame >= 0 ? firstLockedStateFrame : null,'''
new='''    lockTriggerSourceFrame: result?.acquisition?.firstGridLockFrame,\n    firstGridLockFrame: firstLockedStateFrame >= 0 ? (frames[firstLockedStateFrame]?.sequence ?? firstLockedStateFrame) : null,\n    firstLockedStateFrame: firstLockedStateFrame >= 0 ? (frames[firstLockedStateFrame]?.sequence ?? firstLockedStateFrame) : null,'''
if old not in s: raise SystemExit('fast regression lock output anchor missing')
s=s.replace(old,new,1)
p.write_text(s)
