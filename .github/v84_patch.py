from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    s = p.read_text()
    count = s.count(old)
    assert count == 1, f"{path}: expected one match, got {count}"
    p.write_text(s.replace(old, new, 1))

cpp = "vendor/decimen-codec/source/wrapper/decimen_codec.cpp"

old = r'''// Spend the expensive image analysis once, then keep the actual module-center
// coordinates. This mirrors zxing-cpp's alignment-pattern tiled sampler, but
// stores the resulting coordinates instead of throwing them away after one
// decode. Subsequent frames never need HybridBinarizer or SampleGrid.
static bool calibrateTrackSampleMap(PersistentTrack& track, const BitMatrix& image)
{
	const int dim = track.dimension;
	const int versionNumber = (dim - 17) / 4;
	const auto* version = QRCode::Version::Model2(versionNumber);
	if (!version)
		return false;
	const auto& apM = version->alignmentPatternCenters();
	if (apM.size() < 2)
		return false;

	auto base = trackedTransform(track, track.dx, track.dy);
	if (!base.isValid())
		return false;
	const int N = int(apM.size()) - 1;
	Matrix<std::optional<PointF>> apP(int(apM.size()), int(apM.size()));
	auto projectM2P = [&](int x, int y) { return base(centered(PointI(apM[x], apM[y]))); };

	auto center = base(PointF{dim / 2.0, dim / 2.0});
	auto right = base(PointF{dim / 2.0 + 1.0, dim / 2.0});
	auto down = base(PointF{dim / 2.0, dim / 2.0 + 1.0});
	const int moduleSize = std::max(1, int(std::lround((distance(center, right) + distance(center, down)) / 2.0)));

	auto fpSize = [&](double mx, double my) {
		auto a = base(PointF{mx - 3.5, my});
		auto b = base(PointF{mx + 3.5, my});
		return distance(a, b);
	};
	auto makeFp = [&](double mx, double my) {
		ConcentricPattern fp;
		static_cast<PointF&>(fp) = base(PointF{mx, my});
		fp.size = fpSize(mx, my);
		return fp;
	};
	auto seedFinderControl = [&](int x, int y, const ConcentricPattern& fp) {
		auto target = projectM2P(x, y);
		apP.set(x, y, target);
		if (auto quad = FindConcentricPatternCorners(image, fp, int(std::ceil(fp.size)), 2)) {
			double best = fp.size;
			for (auto c : *quad) {
				double d = distance(c, target);
				if (d < best) {
					best = d;
					apP.set(x, y, c);
				}
			}
		}
	};
	seedFinderControl(0, 0, makeFp(3.5, 3.5));
	seedFinderControl(0, N, makeFp(3.5, dim - 3.5));
	seedFinderControl(N, 0, makeFp(dim - 3.5, 3.5));
'''

new = r'''static const QRCode::FinderPatternSet* finderSetForTrack(
	const PersistentTrack& track, const QRCode::FinderPatternSets& sets)
{
	auto expected = trackedTransform(track, track.dx, track.dy);
	if (!expected.isValid())
		return nullptr;
	const double dim = track.dimension;
	const PointF expectedTL = expected(PointF{3.5, 3.5});
	const PointF expectedTR = expected(PointF{dim - 3.5, 3.5});
	const PointF expectedBL = expected(PointF{3.5, dim - 3.5});
	const QRCode::FinderPatternSet* best = nullptr;
	double bestScore = 1e30;
	for (const auto& fp : sets) {
		const double dTL = distance(fp.tl, expectedTL);
		const double dTR = distance(fp.tr, expectedTR);
		const double dBL = distance(fp.bl, expectedBL);
		const double finderSize = (fp.tl.size + fp.tr.size + fp.bl.size) / 3.0;
		const double gate = std::max(10.0, finderSize * 2.5);
		if (std::max({dTL, dTR, dBL}) > gate)
			continue;
		const double score = dTL * dTL + dTR * dTR + dBL * dBL;
		if (score < bestScore) {
			bestScore = score;
			best = &fp;
		}
	}
	return best;
}

// Spend the expensive image analysis once, then keep the actual module-center
// coordinates. Calibration is seeded by zxing-cpp's REAL finder detections,
// not finder patterns synthesized back from an already-warped outer quad.
// This preserves the information SampleQR uses to survive lens distortion.
static bool calibrateTrackSampleMap(PersistentTrack& track, const BitMatrix& image,
										 const QRCode::FinderPatternSet& fp)
{
	const int dim = track.dimension;
	const int versionNumber = (dim - 17) / 4;
	const auto* version = QRCode::Version::Model2(versionNumber);
	if (!version)
		return false;
	const auto& apM = version->alignmentPatternCenters();
	if (apM.size() < 2)
		return false;

	// Use the old tracked quad only to predict the bottom-right alignment
	// pattern. The transform itself is then rebuilt from the three measured
	// finder patterns plus that measured alignment point, matching SampleQR's
	// geometry convention (bottom-right is three modules inward).
	auto seed = trackedTransform(track, track.dx, track.dy);
	if (!seed.isValid())
		return false;
	const int N = int(apM.size()) - 1;
	const double finderModule = (fp.tl.size + fp.tr.size + fp.bl.size) / (3.0 * 7.0);
	const int moduleSize = std::max(1, int(std::lround(finderModule)));
	PointF br = fp.tr - fp.tl + fp.bl;
	PointF brOffset{0, 0};
	const auto brEstimate = seed(centered(PointI(apM[N], apM[N])));
	if (auto found = locateAlignmentPatternForCache(image, moduleSize, brEstimate)) {
		br = *found;
		brOffset = PointF{3, 3};
	}
	const auto moduleQuad = [&] {
		auto q = Rectangle(dim, dim, 3.5);
		q[2] = q[2] - brOffset;
		return q;
	}();
	PerspectiveTransform base(moduleQuad, QuadrilateralF{fp.tl, fp.tr, br, fp.bl});
	if (!base.isValid())
		return false;

	Matrix<std::optional<PointF>> apP(int(apM.size()), int(apM.size()));
	auto projectM2P = [&](int x, int y) { return base(centered(PointI(apM[x], apM[y]))); };

	// Same finder-control seeding used by SampleQR: the alignment-grid corner
	// nearest each projected control point is measured from the actual finder.
	auto seedFinderControl = [&](int x, int y, const ConcentricPattern& observed) {
		auto target = *apP.set(x, y, projectM2P(x, y));
		if (auto quad = FindConcentricPatternCorners(image, observed, observed.size, 2))
			for (auto c : *quad)
				if (distance(c, target) < observed.size / 2.0)
					apP.set(x, y, c);
	};
	seedFinderControl(0, 0, fp.tl);
	seedFinderControl(0, N, fp.bl);
	seedFinderControl(N, 0, fp.tr);
'''
replace_once(cpp, old, new)

old = r'''		bool calibratedAny = false;
		for (auto& track : decoder->tracks) {
			if (!track.active || track.calibrationCooldown > 0 || track.calibrated)
				continue;
			++measured.calibrationAttempts;
			const double calibrationStarted = emscripten_get_now();
			const bool ok = calibrateTrackSampleMap(track, *bits);
			measured.anchorMs += emscripten_get_now() - calibrationStarted;
'''
new = r'''		// Do the expensive finder scan once per lane calibration pass. Each track
		// then binds to the nearby real finder triplet instead of reconstructing
		// finder geometry from its outer quad.
		const double finderStarted = emscripten_get_now();
		auto finderPatterns = QRCode::FindFinderPatterns(*bits, true);
		auto finderSets = QRCode::GenerateFinderPatternSets(finderPatterns);
		measured.anchorMs += emscripten_get_now() - finderStarted;

		bool calibratedAny = false;
		for (auto& track : decoder->tracks) {
			if (!track.active || track.calibrationCooldown > 0 || track.calibrated)
				continue;
			++measured.calibrationAttempts;
			const double calibrationStarted = emscripten_get_now();
			const auto* finderSet = finderSetForTrack(track, finderSets);
			const bool ok = finderSet && calibrateTrackSampleMap(track, *bits, *finderSet);
			measured.anchorMs += emscripten_get_now() - calibrationStarted;
'''
replace_once(cpp, old, new)

replace_once("vendor/decimen-codec/source/VERSION", "0.1.9\n", "0.1.10\n")

p = Path("index.html")
s = p.read_text()
assert s.count("v0.5.83") == 2, f"index.html expected 2 version matches, got {s.count('v0.5.83')}"
p.write_text(s.replace("v0.5.83", "v0.5.84"))
replace_once("main.js", 'const APP_BUILD = "v0.5.83";', 'const APP_BUILD = "v0.5.84";')
replace_once("receive/main.js", 'const RECEIVER_RUNTIME_BUILD = "v0.5.83";', 'const RECEIVER_RUNTIME_BUILD = "v0.5.84";')
replace_once("sw.js", 'const CACHE = "airgapper-static-js-v46";', 'const CACHE = "airgapper-static-js-v47";')
