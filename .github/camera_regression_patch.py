from pathlib import Path

p=Path('benchmark/offline-runner.mjs')
s=p.read_text()

anchor='''async function generateSenderProfiles() {'''
insert=r'''async function cameraLikeFrames(urls, count = 20) {
  return page.evaluate(async ({ urls, count }) => {
    const load = (url) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = url;
    });
    const sources = await Promise.all(urls.map(load));
    const render = ({ width, height, wallWidth, wallHeight, blur, phaseScale, rotation = 0 }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { alpha: false });
      const frames = [];
      for (let index = 0; index < count; index++) {
        const phase = index * 0.61;
        const dx = Math.sin(phase) * 1.35 * phaseScale;
        const dy = Math.cos(phase * 0.83) * 1.05 * phaseScale;
        const scale = 1 + Math.sin(phase * 0.47) * 0.0018 * phaseScale;
        const angle = Math.sin(phase * 0.39) * 0.08 * phaseScale * Math.PI / 180;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.filter = "none";
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, width, height);
        ctx.translate(width / 2 + dx, height / 2 + dy);
        ctx.rotate(rotation + angle);
        ctx.scale(scale, scale);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.filter = `blur(${blur}px)`;
        ctx.drawImage(sources[index % sources.length], -wallWidth / 2, -wallHeight / 2, wallWidth, wallHeight);
        ctx.restore();
        frames.push(canvas.toDataURL("image/png"));
      }
      return frames;
    };

    // Same dense module scale as the sender, but with the sub-pixel resampling
    // and mild MTF loss a real display->camera path introduces. This is the
    // important fast-path realism case: Stable-RS remains eligible, but its
    // sampling is no longer fed perfect canvas pixels.
    const sourceWidth = sources[0].naturalWidth;
    const sourceHeight = sources[0].naturalHeight;
    const optical = render({
      width: sourceWidth,
      height: sourceHeight,
      wallWidth: sourceWidth - 3.4,
      wallHeight: sourceHeight - 1.7,
      blur: 0.36,
      phaseScale: 0.75
    });

    // The real OnePlus trace is a portrait-coded 1440x2560 VideoFrame but its
    // tracked crop is ~3.33 MP, almost the entire 3.69 MP source. Model the
    // physical landscape monitor as a quarter-turned ~1240x2480 wall. This
    // preserves the live dense module scale and crop cost instead of shrinking
    // the wall into a 1410x705 strip that incorrectly fell below Stable-RS.
    const camera = render({
      width: 1440,
      height: 2560,
      wallWidth: 2480,
      wallHeight: 1240,
      blur: 0.34,
      phaseScale: 1,
      rotation: Math.PI / 2
    });
    return { optical, camera };
  }, { urls, count });
}

'''
if 'async function cameraLikeFrames' not in s:
    if anchor not in s: raise SystemExit('generateSenderProfiles anchor missing')
    s=s.replace(anchor,insert+anchor,1)

old='''  const dense = await captureDistinctFrames("dense-2953B", 10);\n\n  return { easy: easy.frames, motion, dense: dense.frames };'''
new='''  const dense = await captureDistinctFrames("dense-2953B", 10);\n  const degraded = await cameraLikeFrames(dense.frames, 20);\n  const opticalDense = degraded.optical;\n  const cameraDense = degraded.camera;\n  console.log(`AIRGAPPER_SENDER_PROFILE optical-dense-2953B ${dense.geometry.width}x${dense.geometry.height} frames=${opticalDense.length}`);\n  console.log(`AIRGAPPER_SENDER_PROFILE camera-dense-2953B 1440x2560 frames=${cameraDense.length}`);\n\n  return { easy: easy.frames, motion, dense: dense.frames, opticalDense, cameraDense };'''
if old not in s: raise SystemExit('dense return block missing')
s=s.replace(old,new,1)

old='''  if (result.firstLockedStateFrame == null) failures.push("lattice never entered a locked state");\n  else if (result.firstLockedStateFrame > 8) failures.push(`lock regressed to frame ${result.firstLockedStateFrame} (>8)`);\n  if (result.fullJobs > 5) failures.push(`too many acquisition scans (${result.fullJobs} > 5)`);'''
new='''  if (result.firstLockedStateFrame == null) failures.push("lattice never entered a locked state");\n  else {\n    const lockLimit = name === "camera-dense-y8" ? 10 : 8;\n    if (result.firstLockedStateFrame > lockLimit) failures.push(`lock regressed to frame ${result.firstLockedStateFrame} (>${lockLimit})`);\n  }\n  const fullLimit = name === "camera-dense-y8" ? 8 : 5;\n  if (result.fullJobs > fullLimit) failures.push(`too many acquisition scans (${result.fullJobs} > ${fullLimit})`);'''
if old not in s: raise SystemExit('common lock/full limits missing')
s=s.replace(old,new,1)

optical_assert=r'''  if (name === "optical-dense-y8") {
    if (result.finalState !== "TRACK") failures.push(`optical-dense ended in ${result.finalState}, not TRACK`);
    if (result.trackedJobs < 10) failures.push(`optical-dense tracked jobs ${result.trackedJobs} < 10`);
    if (result.guidedJobs < 7) failures.push(`optical-dense Guided jobs ${result.guidedJobs} < 7`);
    if (result.guidedOutputs < 60) failures.push(`optical-dense Guided outputs ${result.guidedOutputs} < 60`);
    if ((result.guided?.stableEligibleTracks ?? 0) < 40)
      failures.push(`optical-dense only ${result.guided?.stableEligibleTracks ?? 0} Stable-RS eligible tracks`);
    if ((result.guided?.turboAttempts ?? 0) < 30)
      failures.push(`optical-dense only ${result.guided?.turboAttempts ?? 0} Turbo attempts`);
    if (result.normalized.guidedOutputYield < 0.65)
      failures.push(`optical-dense Guided yield ${(result.normalized.guidedOutputYield * 100).toFixed(1)}% < 65%`);
    if (result.decodeP95Ms > 260) failures.push(`optical-dense p95 ${result.decodeP95Ms.toFixed(1)}ms > 260ms`);
  }
'''
camera_assert=r'''  if (name === "camera-dense-y8") {
    if (result.finalState !== "TRACK") failures.push(`camera-dense ended in ${result.finalState}, not TRACK`);
    if (result.trackedJobs < 6) failures.push(`camera-dense tracked jobs ${result.trackedJobs} < 6`);
    if (result.guidedJobs < 6) failures.push(`camera-dense Guided jobs ${result.guidedJobs} < 6`);
    if (result.guidedOutputs < 35) failures.push(`camera-dense Guided outputs ${result.guidedOutputs} < 35`);
    if (result.tailFullJobs !== 0) failures.push(`camera-dense tail used ${result.tailFullJobs} full scans`);
    if (result.normalized.guidedOutputYield < 0.45)
      failures.push(`camera-dense Guided yield ${(result.normalized.guidedOutputYield * 100).toFixed(1)}% < 45%`);
    if (result.decodeP95Ms > 420) failures.push(`camera-dense p95 ${result.decodeP95Ms.toFixed(1)}ms > 420ms`);
  }
'''
anchor='''  // Keep a short buffered-path guard because corpus replay and non-TrackProcessor'''
if 'name === "optical-dense-y8"' not in s:
    if anchor not in s: raise SystemExit('buffered assertion anchor missing')
    s=s.replace(anchor,optical_assert+camera_assert+'  '+anchor,1)

old='''  const { easy, motion, dense } = await generateSenderProfiles();'''
new='''  const { easy, motion, dense, opticalDense, cameraDense } = await generateSenderProfiles();'''
if old not in s: raise SystemExit('profile destructure missing')
s=s.replace(old,new,1)

scenario_anchor='''    {\n      name: "buffered-rgba",'''
extra_scenarios=r'''    {
      name: "optical-dense-y8",
      urls: opticalDense,
      order: Array.from({ length: opticalDense.length }, (_, index) => index),
      fps: 30,
      mode: "performance",
      cameraPath: true
    },
    {
      name: "camera-dense-y8",
      urls: cameraDense,
      order: Array.from({ length: cameraDense.length }, (_, index) => index),
      fps: 30,
      mode: "performance",
      cameraPath: true
    },
'''
if 'name: "optical-dense-y8"' not in s:
    if scenario_anchor not in s: raise SystemExit('buffered scenario anchor missing')
    s=s.replace(scenario_anchor,extra_scenarios+scenario_anchor,1)

old='''    sourceFrames: { stable: easy.length, motion: motion.length, dense: dense.length },'''
new='''    sourceFrames: { stable: easy.length, motion: motion.length, dense: dense.length, opticalDense: opticalDense.length, cameraDense: cameraDense.length },'''
if old not in s: raise SystemExit('sourceFrames missing')
s=s.replace(old,new,1)

p.write_text(s)
