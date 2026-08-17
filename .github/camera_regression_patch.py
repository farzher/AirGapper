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
    const width = 1440;
    const height = 2560;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    const frames = [];
    const sourceAspect = sources[0].naturalWidth / sources[0].naturalHeight;
    const wallWidth = 1410;
    const wallHeight = wallWidth / sourceAspect;
    for (let index = 0; index < count; index++) {
      const phase = index * 0.61;
      const dx = Math.sin(phase) * 1.35;
      const dy = Math.cos(phase * 0.83) * 1.05;
      const scale = 1 + Math.sin(phase * 0.47) * 0.0018;
      const angle = Math.sin(phase * 0.39) * 0.08 * Math.PI / 180;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.filter = "none";
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, width, height);
      ctx.translate(width / 2 + dx, height / 2 + dy);
      ctx.rotate(angle);
      ctx.scale(scale, scale);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      // Mild MTF loss + non-integer resampling approximate a real display ->
      // phone-camera link without encoding any device-specific noise pattern.
      ctx.filter = "blur(0.32px)";
      ctx.drawImage(sources[index % sources.length], -wallWidth / 2, -wallHeight / 2, wallWidth, wallHeight);
      ctx.restore();
      frames.push(canvas.toDataURL("image/png"));
    }
    return frames;
  }, { urls, count });
}

'''
if 'async function cameraLikeFrames' not in s:
    if anchor not in s: raise SystemExit('generateSenderProfiles anchor missing')
    s=s.replace(anchor,insert+anchor,1)

old='''  const dense = await captureDistinctFrames("dense-2953B", 10);\n\n  return { easy: easy.frames, motion, dense: dense.frames };'''
new='''  const dense = await captureDistinctFrames("dense-2953B", 10);\n  const cameraDense = await cameraLikeFrames(dense.frames, 20);\n  console.log(`AIRGAPPER_SENDER_PROFILE camera-dense-2953B 1440x2560 frames=${cameraDense.length}`);\n\n  return { easy: easy.frames, motion, dense: dense.frames, cameraDense };'''
if old not in s: raise SystemExit('dense return block missing')
s=s.replace(old,new,1)

old='''  if (name === "dense-y8") {\n    if (result.trackedJobs < 10) failures.push(`dense tracked jobs ${result.trackedJobs} < 10`);'''
new='''  if (name === "dense-y8") {\n    if (result.trackedJobs < 10) failures.push(`dense tracked jobs ${result.trackedJobs} < 10`);'''
# no-op anchor validation
if old not in s: raise SystemExit('dense assertion anchor missing')

camera_assert=r'''  if (name === "camera-dense-y8") {
    if (result.finalState !== "TRACK") failures.push(`camera-dense ended in ${result.finalState}, not TRACK`);
    if (result.trackedJobs < 10) failures.push(`camera-dense tracked jobs ${result.trackedJobs} < 10`);
    if (result.guidedJobs < 7) failures.push(`camera-dense Guided jobs ${result.guidedJobs} < 7`);
    if (result.guidedOutputs < 35) failures.push(`camera-dense Guided outputs ${result.guidedOutputs} < 35`);
    if (result.tailFullJobs !== 0) failures.push(`camera-dense tail used ${result.tailFullJobs} full scans`);
    if (result.normalized.guidedOutputYield < 0.45)
      failures.push(`camera-dense Guided yield ${(result.normalized.guidedOutputYield * 100).toFixed(1)}% < 45%`);
    if (result.decodeP95Ms > 420) failures.push(`camera-dense p95 ${result.decodeP95Ms.toFixed(1)}ms > 420ms`);
  }
'''
anchor='''  // Keep a short buffered-path guard because corpus replay and non-TrackProcessor'''
if 'name === "camera-dense-y8"' not in s:
    if anchor not in s: raise SystemExit('buffered assertion anchor missing')
    s=s.replace(anchor,camera_assert+'  '+anchor,1)

old='''  const { easy, motion, dense } = await generateSenderProfiles();'''
new='''  const { easy, motion, dense, cameraDense } = await generateSenderProfiles();'''
if old not in s: raise SystemExit('profile destructure missing')
s=s.replace(old,new,1)

scenario_anchor='''    {\n      name: "buffered-rgba",'''
camera_scenario=r'''    {
      name: "camera-dense-y8",
      urls: cameraDense,
      order: Array.from({ length: cameraDense.length }, (_, index) => index),
      fps: 30,
      mode: "performance",
      cameraPath: true
    },
'''
if 'name: "camera-dense-y8"' not in s:
    if scenario_anchor not in s: raise SystemExit('buffered scenario anchor missing')
    s=s.replace(scenario_anchor,camera_scenario+scenario_anchor,1)

old='''    sourceFrames: { stable: easy.length, motion: motion.length, dense: dense.length },'''
new='''    sourceFrames: { stable: easy.length, motion: motion.length, dense: dense.length, cameraDense: cameraDense.length },'''
if old not in s: raise SystemExit('sourceFrames missing')
s=s.replace(old,new,1)

p.write_text(s)
