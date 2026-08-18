from pathlib import Path
import re


def once(path, old, new):
    p=Path(path); s=p.read_text()
    if old not in s:
        raise SystemExit(f'missing anchor in {path}: {old[:140]!r}')
    p.write_text(s.replace(old,new,1))

# Guided metrics ABI.
once('vendor/decimen-codec/source/wrapper/decimen_codec.h',
     '\tuint32_t perspectiveWarpTracks;\n',
     '\tuint32_t perspectiveWarpTracks;\n\tuint32_t perspectiveMeshWarpTracks;\n\tuint32_t erasureRsAttempts;\n\tuint32_t erasureRsSuccesses;\n\tuint32_t erasureRepairCodewords;\n')

p=Path('vendor/decimen-codec/source/wrapper/decimen_codec.cpp'); s=p.read_text()
s,n=re.subn(r'static_assert\(sizeof\(DecimenGuidedMetrics\) == 176',
            'static_assert(sizeof(DecimenGuidedMetrics) == 192',s,count=1)
if n != 1: raise SystemExit('guided metrics static_assert missing')
old='''        auto noteWarpMode = [&](const TurboFrameTransform& frameTransform) {
            if (frameTransform.translationOnly) ++metrics->translationWarpTracks;
            else if (frameTransform.affineOnly) ++metrics->affineWarpTracks;
            else ++metrics->perspectiveWarpTracks;
        };'''
new='''        auto noteWarpMode = [&](const TurboFrameTransform& frameTransform) {
            if (frameTransform.translationOnly) ++metrics->translationWarpTracks;
            else if (frameTransform.affineOnly) ++metrics->affineWarpTracks;
            else if (frameTransform.perspectiveMesh) ++metrics->perspectiveMeshWarpTracks;
            else ++metrics->perspectiveWarpTracks;
        };'''
if old not in s: raise SystemExit('warp note anchor missing')
s=s.replace(old,new,1)
old='''    if (erasureSampling && ambiguousCount > 0) {
        const double erasureDecodeStarted = guidedNowMs();'''
new='''    if (erasureSampling && ambiguousCount > 0) {
        ++metrics.erasureRsAttempts;
        const double erasureDecodeStarted = guidedNowMs();'''
if old not in s: raise SystemExit('erasure attempt anchor missing')
s=s.replace(old,new,1)
old='''        if (erasureDecoded.isValid() && !erasureDecoded.content().bytes.empty() &&
            hasValidCRC32(erasureDecoded.content().bytes))
            return erasureDecoded;'''
new='''        if (erasureDecoded.isValid() && !erasureDecoded.content().bytes.empty() &&
            hasValidCRC32(erasureDecoded.content().bytes)) {
            ++metrics.erasureRsSuccesses;
            return erasureDecoded;
        }'''
if old not in s: raise SystemExit('erasure success anchor missing')
s=s.replace(old,new,1)
old='''        const double repairSampleStarted = guidedNowMs();
        for (int codeword = 0; codeword < totalCodewords; ++codeword) {'''
new='''        metrics.erasureRepairCodewords += uint32_t(ambiguousCount);
        const double repairSampleStarted = guidedNowMs();
        for (int codeword = 0; codeword < totalCodewords; ++codeword) {'''
if old not in s: raise SystemExit('erasure repair anchor missing')
s=s.replace(old,new,1)
p.write_text(s)

# Worker ABI.
once('receive/worker.js','const GUIDED_METRICS_BYTES = 176;','const GUIDED_METRICS_BYTES = 192;')
once('receive/worker.js',
     '    perspectiveWarpTracks: metricsView.getUint32(172, true)\n',
     '    perspectiveWarpTracks: metricsView.getUint32(172, true),\n    perspectiveMeshWarpTracks: metricsView.getUint32(176, true),\n    erasureRsAttempts: metricsView.getUint32(180, true),\n    erasureRsSuccesses: metricsView.getUint32(184, true),\n    erasureRepairCodewords: metricsView.getUint32(188, true)\n')

# Receiver diagnostics / startup timestamps.
p=Path('receive/main.js'); s=p.read_text()
s=s.replace('const RECEIVER_RUNTIME_BUILD = "v0.5.263";','const RECEIVER_RUNTIME_BUILD = "v0.5.268";',1)
old='''  startedAt: 0,
  captures: 0,'''
new='''  startedAt: 0,
  firstCaptureAt: 0,
  firstJobAt: 0,
  firstQrAt: 0,
  captures: 0,'''
if old not in s: raise SystemExit('live pipeline start missing')
s=s.replace(old,new,1)
old='''  guidedPerspectiveWarpTracks: 0,
  guidedJobs: 0,'''
new='''  guidedPerspectiveWarpTracks: 0,
  guidedPerspectiveMeshWarpTracks: 0,
  guidedErasureRsAttempts: 0,
  guidedErasureRsSuccesses: 0,
  guidedErasureRepairCodewords: 0,
  guidedJobs: 0,'''
if old not in s: raise SystemExit('live metric fields missing')
s=s.replace(old,new,1)
old='''    startedAt: now, captures: 0, submittedJobs: 0,'''
new='''    startedAt: now, firstCaptureAt: 0, firstJobAt: 0, firstQrAt: 0, captures: 0, submittedJobs: 0,'''
if old not in s: raise SystemExit('pipeline reset start missing')
s=s.replace(old,new,1)
old='''    guidedStableRsAttempts: 0, guidedStableRsSuccesses: 0, guidedStableEligibleTracks: 0,
    guidedJobs: 0,'''
new='''    guidedStableRsAttempts: 0, guidedStableRsSuccesses: 0, guidedStableEligibleTracks: 0,
    guidedTranslationWarpTracks: 0, guidedAffineWarpTracks: 0, guidedPerspectiveWarpTracks: 0, guidedPerspectiveMeshWarpTracks: 0,
    guidedErasureRsAttempts: 0, guidedErasureRsSuccesses: 0, guidedErasureRepairCodewords: 0,
    guidedJobs: 0,'''
if old not in s: raise SystemExit('pipeline reset metrics missing')
s=s.replace(old,new,1)
old='''      livePipeline.guidedPerspectiveWarpTracks += Math.max(0, Number(guided.perspectiveWarpTracks) || 0);
      livePipeline.guidedFinderAttempts'''
new='''      livePipeline.guidedPerspectiveWarpTracks += Math.max(0, Number(guided.perspectiveWarpTracks) || 0);
      livePipeline.guidedPerspectiveMeshWarpTracks += Math.max(0, Number(guided.perspectiveMeshWarpTracks) || 0);
      livePipeline.guidedErasureRsAttempts += Math.max(0, Number(guided.erasureRsAttempts) || 0);
      livePipeline.guidedErasureRsSuccesses += Math.max(0, Number(guided.erasureRsSuccesses) || 0);
      livePipeline.guidedErasureRepairCodewords += Math.max(0, Number(guided.erasureRepairCodewords) || 0);
      livePipeline.guidedFinderAttempts'''
if old not in s: raise SystemExit('pipeline aggregate missing')
s=s.replace(old,new,1)

# Set once at real events, never derive startup from rolling/pruned arrays.
old='''    const submittedAt = receiverNow();
    if (!replayRunning && livePipeline.startedAt) {'''
new='''    const submittedAt = receiverNow();
    if (!replayRunning && livePipeline.startedAt && !livePipeline.firstJobAt) livePipeline.firstJobAt = submittedAt;
    if (!replayRunning && livePipeline.startedAt) {'''
if old not in s: raise SystemExit('job timestamp anchor missing')
s=s.replace(old,new,1)
old='''  const decodedAt = receiverNow();
  if (done) return;
  qrReadTimes.push(decodedAt);'''
new='''  const decodedAt = receiverNow();
  if (done) return;
  if (!replayRunning && livePipeline.startedAt && !livePipeline.firstQrAt) livePipeline.firstQrAt = decodedAt;
  qrReadTimes.push(decodedAt);'''
if old not in s: raise SystemExit('QR timestamp anchor missing')
s=s.replace(old,new,1)
old='''      livePipeline.captures++;'''
new='''      if (!livePipeline.firstCaptureAt) livePipeline.firstCaptureAt = now;
      livePipeline.captures++;'''
if old not in s: raise SystemExit('capture timestamp anchor missing')
s=s.replace(old,new,1)
old='''  const firstCaptureAt = captureTimes[0] ?? 0;
  const firstJobAt = hotJobSubmitSamples[0]?.at ?? 0;
  const firstQrAt = qrReadTimes[0] ?? 0;'''
new='''  const firstCaptureAt = livePipeline.firstCaptureAt;
  const firstJobAt = livePipeline.firstJobAt;
  const firstQrAt = livePipeline.firstQrAt;'''
if old not in s: raise SystemExit('startup output anchor missing')
s=s.replace(old,new,1)
old='''warp T/A/P ${lastGuidedMetrics.translationWarpTracks ?? 0}/${lastGuidedMetrics.affineWarpTracks ?? 0}/${lastGuidedMetrics.perspectiveWarpTracks ?? 0} · profile'''
new='''warp T/A/M/P ${lastGuidedMetrics.translationWarpTracks ?? 0}/${lastGuidedMetrics.affineWarpTracks ?? 0}/${lastGuidedMetrics.perspectiveMeshWarpTracks ?? 0}/${lastGuidedMetrics.perspectiveWarpTracks ?? 0} · erasure ${lastGuidedMetrics.erasureRsSuccesses ?? 0}/${lastGuidedMetrics.erasureRsAttempts ?? 0} repair ${lastGuidedMetrics.erasureRepairCodewords ?? 0} · profile'''
if old not in s: raise SystemExit('live guided output anchor missing')
s=s.replace(old,new,1)
old='''warp T/A/P ${livePipeline.guidedTranslationWarpTracks}/${livePipeline.guidedAffineWarpTracks}/${livePipeline.guidedPerspectiveWarpTracks} · finders'''
new='''warp T/A/M/P ${livePipeline.guidedTranslationWarpTracks}/${livePipeline.guidedAffineWarpTracks}/${livePipeline.guidedPerspectiveMeshWarpTracks}/${livePipeline.guidedPerspectiveWarpTracks} · erasure ${livePipeline.guidedErasureRsSuccesses}/${livePipeline.guidedErasureRsAttempts} repair ${livePipeline.guidedErasureRepairCodewords} · finders'''
if old not in s: raise SystemExit('aggregate guided output anchor missing')
s=s.replace(old,new,1)
p.write_text(s)

# App/cache versions.
once('main.js','const APP_BUILD = "v0.5.267";','const APP_BUILD = "v0.5.268";')
idx=Path('index.html'); t=idx.read_text()
if 'v0.5.267' not in t: raise SystemExit('index v267 missing')
idx.write_text(t.replace('v0.5.267','v0.5.268'))
once('sw.js','airgapper-static-js-v215','airgapper-static-js-v216')
