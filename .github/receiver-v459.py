from pathlib import Path

path = Path("receive/runtime.js")
source = path.read_text()


def replace_once(old, new, label):
    global source
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    source = source.replace(old, new, 1)


def replace_all(old, new, expected, label):
    global source
    count = source.count(old)
    if count != expected:
        raise SystemExit(f"{label}: expected {expected} matches, found {count}")
    source = source.replace(old, new)


replace_once(
    '''const AUTO_OPTICS_POSE_STABLE_MS = 300;\nconst AUTO_OPTICS_POSE_WAIT_MS = 700;''',
    '''const AUTO_OPTICS_POSE_STABLE_MS = 300;\nconst AUTO_OPTICS_POSE_WAIT_MS = 700;\nconst AUTO_OPTICS_SEED_MIN_FULL_SCANS = 4;''',
    "seed evidence constant"
)

replace_once(
    '''let autoOpticsMemoryBootAt = 0;\nlet autoOpticsMemoryBoot;\nlet autoOpticsMeasurementSlots;''',
    '''let autoOpticsMemoryBootAt = 0;\nlet autoOpticsMemoryBoot;\nlet autoOpticsMeasurementSlots;\nlet autoOpticsSeedFullScansAt = 0;\nlet autoOpticsHoldPoseAnchor;\nlet autoOpticsHoldPoseStableSince = 0;''',
    "optics evidence state"
)

replace_once(
    '''function autoOpticsPoseDrift(a, b) {\n  if (!autoOpticsPoseUsable(a) || !autoOpticsPoseUsable(b)) return { center: Infinity, scale: Infinity };\n  return {\n    center: Math.hypot(b.x - a.x, b.y - a.y),\n    scale: Math.abs(Math.log2(b.scale / a.scale))\n  };\n}\nasync function waitForStableAutoOpticsPose''',
    '''function autoOpticsPoseDrift(a, b) {\n  if (!autoOpticsPoseUsable(a) || !autoOpticsPoseUsable(b)) return { center: Infinity, scale: Infinity };\n  return {\n    center: Math.hypot(b.x - a.x, b.y - a.y),\n    scale: Math.abs(Math.log2(b.scale / a.scale))\n  };\n}\nfunction resetAutomaticOpticsHoldPose() {\n  autoOpticsHoldPoseAnchor = void 0;\n  autoOpticsHoldPoseStableSince = 0;\n}\nfunction automaticOpticsHoldPoseStable(pose, now = receiverNow()) {\n  if (!autoOpticsPoseUsable(pose)) {\n    resetAutomaticOpticsHoldPose();\n    return false;\n  }\n  if (!autoOpticsHoldPoseAnchor) {\n    autoOpticsHoldPoseAnchor = pose;\n    autoOpticsHoldPoseStableSince = now;\n    return false;\n  }\n  const drift = autoOpticsPoseDrift(autoOpticsHoldPoseAnchor, pose);\n  if (drift.center > AUTO_OPTICS_POSE_MAX_CENTER_DRIFT || drift.scale > AUTO_OPTICS_POSE_MAX_SCALE_LOG2) {\n    autoOpticsHoldPoseAnchor = pose;\n    autoOpticsHoldPoseStableSince = now;\n    return false;\n  }\n  return now - autoOpticsHoldPoseStableSince >= AUTO_OPTICS_POSE_STABLE_MS;\n}\nasync function waitForStableAutoOpticsPose''',
    "continuous HOLD pose gate"
)

replace_once(
    '''  autoOpticsRuntimeState = "seed";\n  autoOpticsMemoryBootAt = 0;''',
    '''  autoOpticsRuntimeState = "seed";\n  autoOpticsSeedFullScansAt = fullScans;\n  autoOpticsMemoryBootAt = 0;''',
    "seed full-scan baseline"
)

replace_once(
    '''  if (seededStartup && gridLattice.locked) {\n    const recentSeedDecode = Boolean(lastStreamDecodeAt && lastStreamDecodeAt >= autoOpticsAcquisitionSince && now - lastStreamDecodeAt < AUTO_OPTICS_RECENT_DECODE_MS);\n    if (!recentSeedDecode && now - autoOpticsAcquisitionSince >= AUTO_OPTICS_ACQUISITION_RESCUE_MS) {''',
    '''  const seedFullScans = seededStartup ? Math.max(0, fullScans - autoOpticsSeedFullScansAt) : 0;\n  if (seededStartup && gridLattice.locked) {\n    const recentSeedDecode = Boolean(lastStreamDecodeAt && lastStreamDecodeAt >= autoOpticsAcquisitionSince && now - lastStreamDecodeAt < AUTO_OPTICS_RECENT_DECODE_MS);\n    if (!recentSeedDecode && now - autoOpticsAcquisitionSince >= AUTO_OPTICS_ACQUISITION_RESCUE_MS &&\n        seedFullScans >= AUTO_OPTICS_SEED_MIN_FULL_SCANS) {''',
    "locked seed evidence gate"
)

replace_once(
    '''    if (seededStartup) {\n      if (!recentDecode && now - autoOpticsAcquisitionSince >= AUTO_OPTICS_ACQUISITION_RESCUE_MS)\n        void abandonAutomaticShortSeed(track);''',
    '''    if (seededStartup) {\n      if (!recentDecode && now - autoOpticsAcquisitionSince >= AUTO_OPTICS_ACQUISITION_RESCUE_MS &&\n          seedFullScans >= AUTO_OPTICS_SEED_MIN_FULL_SCANS)\n        void abandonAutomaticShortSeed(track);''',
    "cold seed evidence gate"
)

replace_once(
    '''  if (autoOpticsRuntimeState === "manual") {\n    const poseUsable = gridLattice.locked && autoOpticsPoseUsable(autoOpticsPoseSnapshot());\n    const temporal = predictedTemporalBand(latestSourceFrameSequence + 1, now);''',
    '''  if (autoOpticsRuntimeState === "manual") {\n    const pose = autoOpticsPoseSnapshot();\n    const poseUsable = gridLattice.locked && autoOpticsPoseUsable(pose);\n    const poseStable = poseUsable && automaticOpticsHoldPoseStable(pose, now);\n    const temporal = predictedTemporalBand(latestSourceFrameSequence + 1, now);''',
    "HOLD pose state"
)

replace_once(
    '''    if (!poseUsable) {\n      // Losing a page, moving the camera, or seeing too little of the wall is\n      // not optical evidence. HOLD keeps its verified rollback point and makes\n      // no camera mutation until stable decoder-backed measurements return.\n      autoOpticsHoldSample = void 0;\n      autoOpticsHoldCollapseSince = 0;\n      return;\n    }''',
    '''    if (!poseStable) {\n      // Losing a page, moving the camera, or seeing too little of the wall is\n      // not optical evidence. HOLD keeps its verified rollback point and makes\n      // no camera mutation until the wall has actually been stationary again.\n      autoOpticsHoldSample = void 0;\n      autoOpticsHoldCollapseSince = 0;\n      return;\n    }''',
    "motion cannot collapse HOLD"
)

replace_all(
    '''    autoOpticsHoldSample = autoOpticsPipelineSnapshot();\n    autoOpticsHoldCollapseSince = 0;\n    autoOpticsRetryAt = Infinity;''',
    '''    autoOpticsHoldSample = autoOpticsPipelineSnapshot();\n    autoOpticsHoldCollapseSince = 0;\n    resetAutomaticOpticsHoldPose();\n    autoOpticsRetryAt = Infinity;''',
    2,
    "reset HOLD motion evidence on winner"
)

path.write_text(source)

version_path = Path("version.js")
version = version_path.read_text()
if 'APP_VERSION = "0.5.458"' not in version:
    raise SystemExit("expected v0.5.458 before bump")
version_path.write_text(version.replace('APP_VERSION = "0.5.458"', 'APP_VERSION = "0.5.459"', 1))
