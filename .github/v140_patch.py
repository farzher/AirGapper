from pathlib import Path


def replace_exact(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f"{path}: expected {count} matches, found {actual}")
    p.write_text(text.replace(old, new, count))


replace_exact(
    'shared/style.css',
    '.stage canvas { display: block; max-width: 100%; cursor: pointer; }\n#qr { cursor: none; }',
    '.stage canvas { display: block; max-width: 100%; cursor: pointer; }\n#qr { cursor: pointer; }\n#qr.cursor-idle { cursor: none; }'
)

replace_exact(
    'send/main.js',
    'const canvas = document.getElementById("qr");\nconst stage = document.getElementById("stage");',
    '''const canvas = document.getElementById("qr");
const CURSOR_IDLE_MS = 1000;
let cursorIdleTimer;
function wakeCanvasCursor() {
  clearTimeout(cursorIdleTimer);
  canvas.classList.remove("cursor-idle");
  cursorIdleTimer = setTimeout(() => {
    if (canvas.matches(":hover")) canvas.classList.add("cursor-idle");
  }, CURSOR_IDLE_MS);
}
canvas.addEventListener("mouseenter", wakeCanvasCursor);
canvas.addEventListener("mousemove", wakeCanvasCursor);
canvas.addEventListener("mouseleave", () => {
  clearTimeout(cursorIdleTimer);
  canvas.classList.remove("cursor-idle");
});
const stage = document.getElementById("stage");'''
)

replace_exact('index.html', 'v0.5.139', 'v0.5.140')
replace_exact('main.js', 'v0.5.139', 'v0.5.140')
replace_exact('receive/main.js', 'v0.5.139', 'v0.5.140')
replace_exact('sw.js', 'airgapper-static-js-v102', 'airgapper-static-js-v103')
