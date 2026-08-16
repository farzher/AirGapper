from pathlib import Path

p = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
s = p.read_text()

start = s.index("template <class LumAt>\nstatic ByteArray decodeCachedTrack(")
end = s.index("\ntemplate <class LumAt>\nstatic int decodeBatchCachedY(", start)
new_cached = r'''template <class LumAt>
static ByteArray decodeCachedTrack(PersistentTrack& track, const LumAt& lumAt, DecimenBatchMetrics& measured)
{
	++measured.alignmentFitAttempts;
	const auto thresholds = buildFastThresholds(track, lumAt);
	if (!thresholds.ok) {
		++measured.bitstreamFailures;
		return {};
	}

	const int dim = track.dimension;
	const double sampleStarted = emscripten_get_now();
	bool inFrame = true;
	for (int y = 0; y < dim && inFrame; ++y)
		for (int x = 0; x < dim; ++x) {
			const auto& p = track.samples[y * dim + x];
			const int lum = lumAt(p.x + track.dx, p.y + track.dy);
			if (lum < 0) {
				inFrame = false;
				break;
			}
			const int threshold = thresholds.t[
				std::clamp(y * FAST_THRESH_TILES / dim, 0, FAST_THRESH_TILES - 1)
			][
				std::clamp(x * FAST_THRESH_TILES / dim, 0, FAST_THRESH_TILES - 1)
			];
			track.sampled.set(x, y, lum <= threshold);
		}
	measured.samples += dim * dim;
	measured.samplingMs += emscripten_get_now() - sampleStarted;
	if (!inFrame) {
		++measured.outOfFrameMisses;
		return {};
	}

	auto packetFromBytes = [&](const ByteArray& bytes) {
		ByteArray packet;
		if (bytes.size() <= 4)
			return packet;
		const double crcStarted = emscripten_get_now();
		const bool crcOK = hasValidCRC32(bytes);
		measured.crcMs += emscripten_get_now() - crcStarted;
		if (!crcOK) {
			++measured.crcFailures;
			return packet;
		}
		packet.resize(bytes.size() - 4);
		std::copy_n(bytes.begin(), bytes.size() - 4, packet.begin());
		return packet;
	};

	// Cheapest possible interpretation first: no QR Reed-Solomon. A pristine
	// sampled matrix still exits here.
	const double bitsStarted = emscripten_get_now();
	auto fast = decodeWithoutErrorCorrection(track.sampled);
	measured.bitExtractionMs += emscripten_get_now() - bitsStarted;
	if (fast.isValid()) {
		auto packet = packetFromBytes(fast.content().bytes);
		if (!packet.empty()) {
			++measured.alignmentFitSuccesses;
			return packet;
		}
	} else {
		++measured.bitstreamFailures;
	}

	// At high optical density a v40 matrix can contain a few bad modules even
	// when its geometry is perfectly usable. Do not run a detector, re-sample,
	// or recalibrate for that. Apply QR's own error correction directly to the
	// already-cached matrix, then require the AirGapper CRC as the final oracle.
	if (!track.calibrated)
		return {};

	const double rsStarted = emscripten_get_now();
	auto corrected = QRCode::Decode(track.sampled);
	measured.rsFallbackMs += emscripten_get_now() - rsStarted;
	++measured.rsFallbacks;
	if (!corrected.isValid())
		return {};

	auto packet = packetFromBytes(corrected.content().bytes);
	if (!packet.empty())
		++measured.alignmentFitSuccesses;
	return packet;
}
'''
s = s[:start] + new_cached + s[end:]

old_motion = "    if (!pending.empty()) {\n        PendingTrack* reference = nullptr;"
new_motion = "    if (!pending.empty() && pending.size() == measured.tracks) {\n        PendingTrack* reference = nullptr;"
if old_motion not in s:
    raise SystemExit("shared-motion condition not found")
s = s.replace(old_motion, new_motion, 1)

old_due = "\t\t\tif ((!track.calibrated || track.consecutiveMisses >= 2) && track.calibrationCooldown == 0)\n\t\t\t\tcalibrationDue = true;"
new_due = "\t\t\tif (!track.calibrated && track.calibrationCooldown == 0)\n\t\t\t\tcalibrationDue = true;"
if old_due not in s:
    raise SystemExit("calibrationDue condition not found")
s = s.replace(old_due, new_due, 1)

old_loop = "\t\t\tif (!track.active || track.calibrationCooldown > 0 || (track.calibrated && track.consecutiveMisses < 2))\n\t\t\t\tcontinue;"
new_loop = "\t\t\tif (!track.active || track.calibrationCooldown > 0 || track.calibrated)\n\t\t\t\tcontinue;"
if old_loop not in s:
    raise SystemExit("calibration loop condition not found")
s = s.replace(old_loop, new_loop, 1)

old_comment = "\t\t// Calibration is off the steady-state path. It is paid only for a new\n\t\t// track or after repeated CRC misses, then its distortion-corrected\n\t\t// module map is reused by decodeBatchCachedY on following frames."
new_comment = "\t\t// Calibration is initialization/reconfiguration work only. Ordinary CRC\n\t\t// misses are packet erasures; they must never trigger repeated expensive\n\t\t// geometry rebuilding on the steady-state camera path."
if old_comment not in s:
    raise SystemExit("calibration comment not found")
s = s.replace(old_comment, new_comment, 1)
p.write_text(s)

p = Path("receive/worker.js")
s = p.read_text()

old_recovery = '    const robustTrackedRecovery = !strictHotPath && !full && Array.isArray(tracks) && tracks.some((track) => (track.misses ?? 0) >= 2);'
new_recovery = '''    const coldTrackCount = !strictHotPath && !full && Array.isArray(tracks)
      ? tracks.filter((track) => (track.misses ?? 0) >= 4).length
      : 0;
    const robustTrackThreshold = Array.isArray(tracks) && tracks.length === 1
      ? 1
      : Math.max(2, Math.ceil((tracks?.length ?? 0) * 0.6));
    const robustTrackedRecovery = !strictHotPath && !full && Array.isArray(tracks)
      && coldTrackCount >= robustTrackThreshold;'''
if old_recovery not in s:
    raise SystemExit("robustTrackedRecovery line not found")
s = s.replace(old_recovery, new_recovery, 1)

old_auto_refresh = "    if (misses >= 3 && slot >= 0) nativeRefresh.add(slot);\n"
if old_auto_refresh not in s:
    raise SystemExit("automatic native refresh line not found")
s = s.replace(old_auto_refresh, "", 1)

marker = "function configureNativeBatch(zx, tracks, ox, oy) {"
if marker not in s:
    raise SystemExit("configureNativeBatch marker not found")
helper = r'''function quadShapeResidual(a, b) {
  if (!validQuad(a) || !validQuad(b)) return Infinity;
  const names = ["topLeft", "topRight", "bottomRight", "bottomLeft"];
  const deltas = names.map((name) => ({
    x: b[name].x - a[name].x,
    y: b[name].y - a[name].y
  }));
  const meanX = deltas.reduce((sum, p) => sum + p.x, 0) / deltas.length;
  const meanY = deltas.reduce((sum, p) => sum + p.y, 0) / deltas.length;
  return Math.max(...deltas.map((p) => Math.hypot(p.x - meanX, p.y - meanY)));
}
function quadModuleSize(q, dim) {
  if (!validQuad(q) || !dim) return 0;
  const edge = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  return Math.min(
    edge(q.topLeft, q.topRight),
    edge(q.topRight, q.bottomRight),
    edge(q.bottomRight, q.bottomLeft),
    edge(q.bottomLeft, q.topLeft)
  ) / dim;
}
'''
s = s.replace(marker, helper + marker, 1)

old_refresh_block = '''          const trackIndex = tracks.findIndex((track) => track.slot === slot);
          if (trackIndex >= 0) {
            // The robust decoder just gave us a fresh quad. Never keep using a
            // native sample map built from the geometry that needed recovery.
            nativeRefresh.add(trackIndex);
          }
          const recoveredPosition = validQuad(result.position)
            ? result.position
            : trackIndex >= 0 ? localQuad(tracks[trackIndex].quad, ox, oy) : null;
          if (!recoveredPosition) continue;'''
new_refresh_block = '''          const trackIndex = tracks.findIndex((track) => track.slot === slot);
          const recoveredPosition = validQuad(result.position)
            ? result.position
            : trackIndex >= 0 ? localQuad(tracks[trackIndex].quad, ox, oy) : null;
          if (!recoveredPosition) continue;
          if (trackIndex >= 0 && validQuad(result.position)) {
            const currentLocal = localQuad(tracks[trackIndex].quad, ox, oy);
            const moduleSize = quadModuleSize(currentLocal, tracks[trackIndex].dim);
            const refreshThreshold = Math.max(0.75, moduleSize * 0.45);
            // Pure camera translation belongs in native dx/dy tracking. Only
            // throw away an expensive distortion map when the robust quad says
            // the QR's actual shape changed beyond sub-module jitter.
            if (quadShapeResidual(currentLocal, result.position) > refreshThreshold)
              nativeRefresh.add(trackIndex);
          }'''
if old_refresh_block not in s:
    raise SystemExit("robust refresh block not found")
s = s.replace(old_refresh_block, new_refresh_block, 1)
p.write_text(s)

replacements = {
    "index.html": [("v0.5.80", "v0.5.81")],
    "main.js": [("v0.5.80", "v0.5.81")],
    "receive/main.js": [("v0.5.80", "v0.5.81")],
    "sw.js": [("airgapper-static-js-v43", "airgapper-static-js-v44")],
    "vendor/decimen-codec/source/VERSION": [("0.1.7", "0.1.8")],
}
for name, pairs in replacements.items():
    q = Path(name)
    t = q.read_text()
    for a, b in pairs:
        if a not in t:
            raise SystemExit(f"{a!r} not found in {name}")
        t = t.replace(a, b)
    q.write_text(t)
