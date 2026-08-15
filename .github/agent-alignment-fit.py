from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    p.write_text(text.replace(old, new, 1))


cpp = Path("vendor/decimen-codec/source/wrapper/decimen_codec.cpp")
text = cpp.read_text()
text = text.replace("thresholdFallbacks", "alignmentFitAttempts")
text = text.replace("multiSampleRetries", "alignmentFitSuccesses")
cpp.write_text(text)

hdr = Path("vendor/decimen-codec/source/wrapper/decimen_codec.h")
text = hdr.read_text()
text = text.replace("thresholdFallbacks", "alignmentFitAttempts")
text = text.replace("multiSampleRetries", "alignmentFitSuccesses")
hdr.write_text(text)

replace_once(
    cpp,
'''\t\tauto fastDecode = [&]() {
\t\t\tByteArray fastPacket;
\t\t\tdouble fastStarted = emscripten_get_now();
\t\t\tauto fast = decodeWithoutErrorCorrection(track.sampled);
\t\t\tmeasured.bitExtractionMs += emscripten_get_now() - fastStarted;
\t\t\tif (!fast.isValid()) {
\t\t\t\t++measured.bitstreamFailures;
\t\t\t\treturn fastPacket;
\t\t\t}
\t\t\tconst auto& bytes = fast.content().bytes;
\t\t\tfastStarted = emscripten_get_now();
\t\t\tconst bool crcOK = hasValidCRC32(bytes);
\t\t\tmeasured.crcMs += emscripten_get_now() - fastStarted;
\t\t\tif (!crcOK) {
\t\t\t\t++measured.crcFailures;
\t\t\t\treturn fastPacket;
\t\t\t}
\t\t\tfastPacket.assign(bytes.begin(), bytes.end() - 4);
\t\t\t++measured.crcFastSuccesses;
\t\t\treturn fastPacket;
\t\t};
''',
'''\t\tauto fastDecode = [&]() {
\t\t\tByteArray fastPacket;
\t\t\tdouble fastStarted = emscripten_get_now();
\t\t\tauto fast = decodeWithoutErrorCorrection(track.sampled);
\t\t\tmeasured.bitExtractionMs += emscripten_get_now() - fastStarted;
\t\t\tif (!fast.isValid()) {
\t\t\t\t++measured.bitstreamFailures;
\t\t\t\treturn fastPacket;
\t\t\t}
\t\t\tconst auto& bytes = fast.content().bytes;
\t\t\tfastStarted = emscripten_get_now();
\t\t\tconst bool crcOK = hasValidCRC32(bytes);
\t\t\tmeasured.crcMs += emscripten_get_now() - fastStarted;
\t\t\tif (!crcOK) {
\t\t\t\t++measured.crcFailures;
\t\t\t\treturn fastPacket;
\t\t\t}
\t\t\tfastPacket.assign(bytes.begin(), bytes.end() - 4);
\t\t\t++measured.crcFastSuccesses;
\t\t\treturn fastPacket;
\t\t};

\t\t// A four-corner homography is not enough for a large QR viewed through a
\t\t// real camera lens: the corners can be exact while the interior is bowed
\t\t// across alignment-pattern cells. ZXing already has the right primitive
\t\t// for this: SampleQR traces/fits the alignment grid from known finder
\t\t// positions. We synthesize those finders from the tracked transform, so
\t\t// this is still a detector-free tracked operation. Strict mode remains
\t\t// no-RS: the fitted matrix must parse and pass our packet CRC exactly.
\t\tauto alignmentFit = [&](float dx, float dy) {
\t\t\t++measured.alignmentFitAttempts;
\t\t\tauto mod2Pix = trackedTransform(track, dx, dy);
\t\t\tauto fpCenter = [&](double mx, double my) { return mod2Pix(PointF{mx, my}); };
\t\t\tauto fpSize = [&](double mx, double my) {
\t\t\t\tauto a = mod2Pix(PointF{mx - 3.5, my});
\t\t\t\tauto b = mod2Pix(PointF{mx + 3.5, my});
\t\t\t\treturn std::hypot(b.x - a.x, b.y - a.y);
\t\t\t};
\t\t\tauto makeFp = [&](double mx, double my) {
\t\t\t\tConcentricPattern cp;
\t\t\t\tstatic_cast<PointF&>(cp) = fpCenter(mx, my);
\t\t\t\tcp.size = fpSize(mx, my);
\t\t\t\treturn cp;
\t\t\t};
\t\t\tQRCode::FinderPatternSet fp{
\t\t\t\tmakeFp(3.5, dim - 3.5),
\t\t\t\tmakeFp(3.5, 3.5),
\t\t\t\tmakeFp(dim - 3.5, 3.5)
\t\t\t};
\t\t\tfor (auto&& detected : QRCode::SampleQR(imageBits, fp)) {
\t\t\t\tif (!detected.isValid() || detected.bits().width() != dim)
\t\t\t\t\tcontinue;
\t\t\t\ttrack.sampled = std::move(detected).bits();
\t\t\t\tauto fittedPacket = fastDecode();
\t\t\t\tif (!fittedPacket.empty()) {
\t\t\t\t\t++measured.alignmentFitSuccesses;
\t\t\t\t\treturn fittedPacket;
\t\t\t\t}
\t\t\t}
\t\t\treturn ByteArray{};
\t\t};
''',
    "insert alignment fit")

replace_once(
    cpp,
'''\t\tByteArray packet;
\t\tif (track.crc32Payload)
\t\t\tpacket = fastDecode();
\t\tif (!packet.empty())
\t\t\t++measured.anchorBypassSuccesses;
''',
'''\t\tByteArray packet;
\t\tif (track.crc32Payload) {
\t\t\tpacket = fastDecode();
\t\t\tif (!packet.empty())
\t\t\t\t++measured.anchorBypassSuccesses;
\t\t\telse
\t\t\t\tpacket = alignmentFit(track.dx, track.dy);
\t\t}
''',
    "cached alignment fallback")

replace_once(
    cpp,
'''\t\t\t\tconst bool moved = std::abs(track.dx - trustedDx) > 0.01f || std::abs(track.dy - trustedDy) > 0.01f;
\t\t\t\tif (moved && sampleGrid(track.dx, track.dy))
\t\t\t\t\tpacket = fastDecode();
''',
'''\t\t\t\tconst bool moved = std::abs(track.dx - trustedDx) > 0.01f || std::abs(track.dy - trustedDy) > 0.01f;
\t\t\t\tif (moved) {
\t\t\t\t\tif (sampleGrid(track.dx, track.dy))
\t\t\t\t\t\tpacket = fastDecode();
\t\t\t\t\tif (packet.empty())
\t\t\t\t\t\tpacket = alignmentFit(track.dx, track.dy);
\t\t\t\t}
''',
    "refined alignment fallback")

worker = Path("receive/worker.js")
text = worker.read_text()
text = text.replace("thresholdFallbacks: view.getUint32(nativeMetricsPtr + 80, true)", "alignmentFitAttempts: view.getUint32(nativeMetricsPtr + 80, true)")
text = text.replace("multiSampleRetries: view.getUint32(nativeMetricsPtr + 96, true)", "alignmentFitSuccesses: view.getUint32(nativeMetricsPtr + 96, true)")
worker.write_text(text)

main = Path("receive/main.js")
text = main.read_text()
text = text.replace("thresholdFallbacks: 0,", "alignmentFitAttempts: 0,")
text = text.replace("multiSampleRetries: 0,", "alignmentFitSuccesses: 0,")
text = text.replace("hotPathAudit.thresholdFallbacks += completion.nativeMetrics.thresholdFallbacks ?? 0;", "hotPathAudit.alignmentFitAttempts += completion.nativeMetrics.alignmentFitAttempts ?? 0;")
text = text.replace("hotPathAudit.multiSampleRetries += completion.nativeMetrics.multiSampleRetries ?? 0;", "hotPathAudit.alignmentFitSuccesses += completion.nativeMetrics.alignmentFitSuccesses ?? 0;")
old = '''Sampler HybridBinarizer + SampleGrid · cached-grid CRC ${hotPathAudit.anchorBypassSuccesses}/${hotPathAudit.anchorBypassAttempts}\nCached-grid CRC ${hotPathAudit.anchorBypassSuccesses}/${hotPathAudit.anchorBypassAttempts}'''
new = '''Sampler HybridBinarizer · plain-grid CRC ${hotPathAudit.anchorBypassSuccesses}/${hotPathAudit.anchorBypassAttempts} · alignment-fit CRC ${hotPathAudit.alignmentFitSuccesses}/${hotPathAudit.alignmentFitAttempts}'''
if old not in text:
    raise SystemExit("diagnostic sampler lines not found")
text = text.replace(old, new, 1)
main.write_text(text)

index = Path("index.html")
text = index.read_text()
if "v0.5.56" not in text:
    raise SystemExit("version v0.5.56 not found")
index.write_text(text.replace("v0.5.56", "v0.5.57", 1))

sw = Path("sw.js")
text = sw.read_text()
if 'airgapper-static-js-v19' not in text:
    raise SystemExit("cache v19 not found")
sw.write_text(text.replace('airgapper-static-js-v19', 'airgapper-static-js-v20', 1))
