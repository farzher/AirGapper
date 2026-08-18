from pathlib import Path

sw=Path('sw.js')
s=sw.read_text()
old='''        const cached = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
        if (cached) return cached;
'''
new='''        // Static build/scalar query parameters select runtime behavior, not
        // different file bytes. Precache stores the canonical paths, so offline
        // fallback must ignore the query (e.g. main.js?build=v... and
        // worker.js?scalar=1) or a freshly installed PWA can miss files it
        // already precached.
        const cached = await cache.match(request, { ignoreSearch: true });
        if (cached) return cached;
'''
if old not in s: raise SystemExit('offline cache fallback anchor missing')
s=s.replace(old,new,1)
if 'airgapper-static-js-v205' not in s: raise SystemExit('sw cache v205 missing')
s=s.replace('airgapper-static-js-v205','airgapper-static-js-v206',1)
sw.write_text(s)

for path in ['main.js','receive/main.js','index.html']:
    p=Path(path); text=p.read_text()
    if 'v0.5.249' not in text: raise SystemExit(f'{path}: v0.5.249 missing')
    p.write_text(text.replace('v0.5.249','v0.5.250'))
