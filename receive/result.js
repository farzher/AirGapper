import { formatBytes } from "../shared/format.js";
import { copyTextOnAndroid, isAndroidApp, saveFileOnAndroid } from "../shared/android.js";
import { readStoredZip } from "../shared/zip.js";

const RECEIVED_MEDIA_CACHE = "received-media";
const MIME_BY_EXTENSION = {
  apng: "image/apng", gif: "image/gif", jpeg: "image/jpeg", jpg: "image/jpeg",
  png: "image/png", svg: "image/svg+xml", webp: "image/webp", mp3: "audio/mpeg",
  m4a: "audio/mp4", oga: "audio/ogg", ogg: "audio/ogg", wav: "audio/wav",
  m4v: "video/mp4", mov: "video/quicktime", mp4: "video/mp4", ogv: "video/ogg",
  webm: "video/webm", css: "text/css", csv: "text/csv", html: "text/html",
  json: "application/json", md: "text/markdown", pdf: "application/pdf",
  txt: "text/plain", zip: "application/zip"
};
const SNIPPET_LINK = /(?:https?:\/\/|www\.)[^\s<>]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gi;
const TRAILING_LINK_PUNCTUATION = /[.,;:!?\])}]+$/;
const result = document.getElementById("result");
const receivedObjectUrls = new Set();
let generation = 0;

function receivedObjectUrl(blob) {
  const url = URL.createObjectURL(blob);
  receivedObjectUrls.add(url);
  return url;
}

export function clearReceivedResult() {
  generation++;
  result.replaceChildren();
  for (const url of receivedObjectUrls) URL.revokeObjectURL(url);
  receivedObjectUrls.clear();
  if ("caches" in window) void caches.delete(RECEIVED_MEDIA_CACHE).catch(() => void 0);
}

function inferredType(name) {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function downloadLink(name, type, bytes, label = `Save ${name}`, blobUrl) {
  const link = document.createElement("a");
  link.className = "download";
  link.href = blobUrl || receivedObjectUrl(new Blob([bytes], { type }));
  link.download = name;
  link.textContent = label;
  if (isAndroidApp()) link.addEventListener("click", (event) => {
    if (!saveFileOnAndroid(name, type, bytes)) return;
    event.preventDefault();
  });
  return link;
}

async function servableMediaUrl(blob, type, blobUrl) {
  try {
    if (!navigator.serviceWorker?.controller) return blobUrl;
    const target = new URL(`../received-media/${Date.now()}-${Math.random().toString(36).slice(2)}`, window.location.href).href;
    const cache = await caches.open(RECEIVED_MEDIA_CACHE);
    await cache.put(target, new Response(blob, {
      headers: { "Content-Type": type, "Content-Length": String(blob.size) }
    }));
    return `${target}?v=${Date.now()}`;
  } catch {
    return blobUrl;
  }
}

function enableMediaInspection(media) {
  media.classList.add("inspectable");
  media.tabIndex = 0;
  media.title = media instanceof HTMLImageElement ? "Tap to view and zoom" : "Tap to view full screen";
  const open = async () => {
    if (media instanceof HTMLVideoElement) {
      if (!media.requestFullscreen && media.webkitEnterFullscreen) media.webkitEnterFullscreen();
      else if (media.requestFullscreen) await media.requestFullscreen().catch(() => void 0);
      else window.open(media.currentSrc || media.src, "_blank", "noopener");
      void media.play();
      return;
    }
    const placeholder = document.createComment("received image");
    media.replaceWith(placeholder);
    const inspector = document.createElement("div");
    inspector.className = "media-inspector";
    inspector.setAttribute("role", "dialog");
    inspector.setAttribute("aria-label", "Image viewer");
    const closeButton = document.createElement("button");
    closeButton.className = "media-inspector-close";
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Close image");
    closeButton.textContent = "×";
    inspector.append(media, closeButton);
    document.body.append(inspector);
    document.body.classList.add("media-inspecting");
    let scale = 1;
    let x = 0;
    let y = 0;
    const pointers = new Map();
    const render = () => { media.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale})`; };
    const zoomAt = (nextScale, clientX, clientY) => {
      const clamped = Math.max(1, Math.min(6, nextScale));
      const ratio = clamped / scale;
      x = clientX - innerWidth / 2 - (clientX - innerWidth / 2 - x) * ratio;
      y = clientY - innerHeight / 2 - (clientY - innerHeight / 2 - y) * ratio;
      scale = clamped;
      if (scale === 1) x = y = 0;
      render();
    };
    const close = () => {
      if (!inspector.isConnected) return;
      inspector.remove();
      media.removeAttribute("style");
      placeholder.replaceWith(media);
      document.body.classList.remove("media-inspecting");
      media.focus();
    };
    closeButton.addEventListener("click", close);
    inspector.addEventListener("pointerdown", (event) => {
      if (event.target === closeButton) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      inspector.setPointerCapture(event.pointerId);
      media.classList.add("dragging");
    });
    inspector.addEventListener("pointermove", (event) => {
      const previous = pointers.get(event.pointerId);
      if (!previous) return;
      if (pointers.size === 1) {
        if (scale > 1) {
          x += event.clientX - previous.x;
          y += event.clientY - previous.y;
          render();
        }
      } else {
        const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)?.[1];
        if (other) {
          const oldDistance = Math.hypot(previous.x - other.x, previous.y - other.y);
          const newDistance = Math.hypot(event.clientX - other.x, event.clientY - other.y);
          zoomAt(scale * newDistance / Math.max(1, oldDistance), (event.clientX + other.x) / 2, (event.clientY + other.y) / 2);
        }
      }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    });
    const releasePointer = (event) => {
      pointers.delete(event.pointerId);
      if (!pointers.size) media.classList.remove("dragging");
    };
    inspector.addEventListener("pointerup", releasePointer);
    inspector.addEventListener("pointercancel", releasePointer);
    inspector.addEventListener("wheel", (event) => {
      event.preventDefault();
      zoomAt(scale * Math.exp(-event.deltaY * 2e-3), event.clientX, event.clientY);
    }, { passive: false });
    inspector.addEventListener("dblclick", (event) => zoomAt(scale > 1 ? 1 : 2.5, event.clientX, event.clientY));
  };
  media.addEventListener("click", () => void open());
  media.addEventListener("keydown", (event) => {
    if (!(event instanceof KeyboardEvent) || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    void open();
  });
}

async function appendReceivedFile(entry, parent, declaredType, autoplayVideo, expectedGeneration) {
  const type = declaredType || inferredType(entry.name);
  const container = document.createElement("section");
  container.className = "received-file";
  const blob = new Blob([entry.bytes], { type });
  const url = receivedObjectUrl(blob);
  let receivedVideo;
  if (type.startsWith("image/")) {
    const image = document.createElement("img");
    image.className = "received";
    image.alt = `Received file preview: ${entry.name}`;
    image.src = url;
    enableMediaInspection(image);
    container.append(image);
  } else if (type.startsWith("video/") || type.startsWith("audio/")) {
    const player = document.createElement(type.startsWith("video/") ? "video" : "audio");
    player.className = "received";
    player.controls = true;
    player.preload = "metadata";
    player.setAttribute("aria-label", `Received file: ${entry.name}`);
    if (player instanceof HTMLVideoElement) {
      player.playsInline = true;
      if (autoplayVideo) {
        player.autoplay = true;
        receivedVideo = player;
      }
    }
    const src = await servableMediaUrl(blob, type, url);
    if (expectedGeneration !== generation) return false;
    if (src !== url) player.addEventListener("error", () => { player.src = url; }, { once: true });
    player.src = src;
    if (player instanceof HTMLVideoElement) enableMediaInspection(player);
    container.append(player);
  }
  const row = document.createElement("div");
  row.className = "received-file-download";
  const link = downloadLink(entry.name, type, entry.bytes, entry.name, url);
  link.title = entry.name;
  const size = document.createElement("span");
  size.textContent = formatBytes(entry.bytes.length);
  row.append(link, size);
  container.append(row);
  parent.append(container);
  if (receivedVideo) void receivedVideo.play().catch(async () => {
    receivedVideo.muted = true;
    await receivedVideo.play().catch(() => void 0);
  });
  return true;
}

export async function showReceivedFile(file, isCurrent = () => true) {
  clearReceivedResult();
  const expectedGeneration = generation;
  if (file.type === "application/vnd.airgapper.files+zip") {
    for (const entry of readStoredZip(file.bytes)) {
      if (!isCurrent() || !await appendReceivedFile(entry, result, undefined, false, expectedGeneration)) return false;
    }
    const archive = document.createElement("section");
    archive.className = "received-file received-archive";
    const type = document.createElement("span");
    type.className = "received-file-type";
    type.textContent = "ZIP";
    const row = document.createElement("div");
    row.className = "received-file-download";
    const link = downloadLink(file.name, "application/zip", file.bytes, file.name);
    link.title = file.name;
    const size = document.createElement("span");
    size.textContent = formatBytes(file.bytes.length);
    row.append(link, size);
    archive.append(type, row);
    result.append(archive);
    return true;
  }
  return isCurrent() && appendReceivedFile({ name: file.name, bytes: file.bytes }, result, file.type, true, expectedGeneration);
}

function appendLinkifiedText(parent, text) {
  SNIPPET_LINK.lastIndex = 0;
  let cursor = 0;
  for (let match = SNIPPET_LINK.exec(text); match; match = SNIPPET_LINK.exec(text)) {
    const candidate = match[0].replace(TRAILING_LINK_PUNCTUATION, "");
    if (!candidate) continue;
    parent.append(document.createTextNode(text.slice(cursor, match.index)));
    const isEmail = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(candidate);
    const href = isEmail ? `mailto:${candidate}` : candidate.toLowerCase().startsWith("www.") ? `https://${candidate}` : candidate;
    try {
      const url = new URL(href);
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) throw new Error("unsupported link");
      const link = document.createElement("a");
      link.href = url.href;
      link.textContent = candidate;
      link.className = "snippet-link";
      if (url.protocol !== "mailto:") {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      parent.append(link);
    } catch {
      parent.append(document.createTextNode(candidate));
    }
    cursor = match.index + candidate.length;
  }
  parent.append(document.createTextNode(text.slice(cursor)));
}

export function showReceivedSnippet(text) {
  clearReceivedResult();
  const body = document.createElement("p");
  body.className = "received-note";
  appendLinkifiedText(body, text);
  const actions = document.createElement("div");
  actions.className = "note-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "download";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    try {
      if (!copyTextOnAndroid(text)) await navigator.clipboard.writeText(text);
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy"; }, 1500);
    } catch {
      copy.textContent = "Copy failed";
    }
  });
  actions.append(copy);
  result.replaceChildren(body, actions);
}

export function showReceiveFailure(restartButton) {
  clearReceivedResult();
  const heading = document.createElement("div");
  heading.className = "failed";
  heading.textContent = "Transfer failed";
  const detail = document.createElement("p");
  detail.className = "received-note";
  detail.textContent = "Nothing usable came out of that stream. Restart the sender, then scan it again — a partial transfer costs nothing but the time.";
  result.append(heading, detail, restartButton);
}

clearReceivedResult();
