from pathlib import Path

# Small sender-control UI polish. Keep the Show QR button visually identical to
# the adjacent select controls, and use the same Receive terminology as Home.
index = Path('index.html')
s = index.read_text()
s = s.replace(
    '<div class="send-link-control"><span>Receiver</span><button class="secondary-button" id="send-receiver-link-open" type="button">Show QR</button></div>',
    '<div class="send-link-control"><span>Receive</span><button class="secondary-button" id="send-receiver-link-open" type="button">Show QR</button></div>',
    1,
)
s = s.replace('AirGapper <span class="app-version">v0.5.268</span>', 'AirGapper <span class="app-version">v0.5.269</span>', 1)
s = s.replace('./main.js?build=v0.5.268', './main.js?build=v0.5.269', 1)
index.write_text(s)

style = Path('shared/style.css')
s = style.read_text()
old = '.send-link-control .secondary-button { width: 100%; min-height: 34px; padding: 5px 9px; color: var(--ink); background: var(--card); }'
new = '.send-link-control .secondary-button { width: 100%; min-height: 34px; padding: 5px 8px; color: var(--ink); background: var(--bg); border-radius: 8px; }'
if old not in s:
    raise SystemExit('send link button style anchor missing')
style.write_text(s.replace(old, new, 1))

main = Path('main.js')
s = main.read_text()
if 'const APP_BUILD = "v0.5.268";' not in s:
    raise SystemExit('unexpected app build')
main.write_text(s.replace('const APP_BUILD = "v0.5.268";', 'const APP_BUILD = "v0.5.269";', 1))

sw = Path('sw.js')
s = sw.read_text()
if 'airgapper-static-js-v216' not in s:
    raise SystemExit('unexpected service worker cache version')
sw.write_text(s.replace('airgapper-static-js-v216', 'airgapper-static-js-v217', 1))
