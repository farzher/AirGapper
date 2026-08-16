from pathlib import Path

def replace_exact(path, old, new, count=1):
    p = Path(path)
    s = p.read_text()
    found = s.count(old)
    if found != count:
        raise SystemExit(f"{path}: expected {count} matches, got {found}: {old[:140]!r}")
    p.write_text(s.replace(old, new, count))

replace_exact("index.html", "v0.5.74", "v0.5.75")
replace_exact("sw.js", "airgapper-static-js-v37", "airgapper-static-js-v38")

old_snapshot = '''  snapshot() {
    const candidate = this.candidate;
    const count = candidate.layout.cols * candidate.layout.rows;
    const modules = candidate.observations[0].modules;
    const decoded = new Set(candidate.observations.map((observation) => observation.slotIndex));
    const slots = [];
    for (let index = 0; index < count; index++) {
      const points = slotWorld(candidate.layout, modules, index).map((point) => project(candidate.transform, point));
      const quad = { topLeft: points[0], topRight: points[1], bottomRight: points[2], bottomLeft: points[3] };
      const box = bounds(quad);
      if (!box) return null;
      slots.push({ index, quad, box, decoded: decoded.has(index) });
    }
    const confidence = Math.max(0, Math.min(1, candidate.observations.length / Math.min(3, candidate.observations.length + 1) * (1 - candidate.error)));
    return { state: this.state, confidence, layout: candidate.layout, modules, slots };
  }'''

new_snapshot = '''  snapshot() {
    const candidate = this.candidate;
    const count = candidate.layout.cols * candidate.layout.rows;
    const modules = candidate.observations[0].modules;
    // The whole-grid homography is a prediction model, not a replacement for
    // measured per-QR geometry. Real phone lenses distort a large QR field in
    // ways a single projective transform cannot represent. Once a slot has
    // actually decoded, keep that exact CRC-backed quad and use the lattice
    // only for cells that have not yet been observed.
    const observed = new Map(candidate.observations.map((observation) => [observation.slotIndex, observation]));
    const decoded = new Set(observed.keys());
    const slots = [];
    for (let index = 0; index < count; index++) {
      const observation = observed.get(index);
      let quad;
      if (observation && validGeometry(observation)) {
        const points = corners(observation.quad);
        quad = {
          topLeft: { ...points[0] },
          topRight: { ...points[1] },
          bottomRight: { ...points[2] },
          bottomLeft: { ...points[3] }
        };
      } else {
        const points = slotWorld(candidate.layout, modules, index).map((point) => project(candidate.transform, point));
        quad = { topLeft: points[0], topRight: points[1], bottomRight: points[2], bottomLeft: points[3] };
      }
      const box = bounds(quad);
      if (!box) return null;
      slots.push({ index, quad, box, decoded: decoded.has(index), observed: Boolean(observation) });
    }
    const confidence = Math.max(0, Math.min(1, candidate.observations.length / Math.min(3, candidate.observations.length + 1) * (1 - candidate.error)));
    return { state: this.state, confidence, layout: candidate.layout, modules, slots, observedSlots: observed.size, fitError: candidate.error };
  }'''
replace_exact("receive/grid-lattice.js", old_snapshot, new_snapshot)

old_diag = '''Sampler sparse CRC ${hotPathAudit.fastSamplerSuccesses}/${hotPathAudit.fastSamplerAttempts} · Hybrid fallback CRC ${hotPathAudit.anchorBypassSuccesses}/${hotPathAudit.anchorBypassAttempts}
Pixel path ${lastDirectPixelPath.toUpperCase()}'''
new_diag = '''Sampler sparse CRC ${hotPathAudit.fastSamplerSuccesses}/${hotPathAudit.fastSamplerAttempts} · Hybrid fallback CRC ${hotPathAudit.anchorBypassSuccesses}/${hotPathAudit.anchorBypassAttempts}
Geometry ${lastGridSnapshot ? `${lastGridSnapshot.observedSlots ?? 0}/${lastGridSnapshot.slots.length} exact · global fit ${((lastGridSnapshot.fitError ?? 0) * 100).toFixed(1)}%` : "no lattice"}
Pixel path ${lastDirectPixelPath.toUpperCase()}'''
replace_exact("receive/main.js", old_diag, new_diag)
