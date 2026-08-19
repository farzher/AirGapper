import { packFile } from "./protocol.js";
const SNIPPET_MEDIA_TYPE = "application/vnd.airgapper.snippet";
const SNIPPET_FILE_NAME = "snippet.txt";
const MAX_SNIPPET_BYTES = 4 * 1024 * 1024;
const MAX_SNIPPET_LABEL = `${MAX_SNIPPET_BYTES / 1024 / 1024} MB`;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
function isSnippet(file) {
  return file.type === SNIPPET_MEDIA_TYPE;
}
async function packSnippet(text) {
  if (text.trim().length === 0) throw new Error("Paste or type some text before sending.");
  const bytes = encoder.encode(text);
  if (bytes.length > MAX_SNIPPET_BYTES) {
    throw new Error(`Text snippets are limited to ${MAX_SNIPPET_LABEL}.`);
  }
  return packFile(SNIPPET_FILE_NAME, SNIPPET_MEDIA_TYPE, bytes);
}
function snippetText(file) {
  if (!isSnippet(file)) throw new Error("This stream is not a text snippet.");
  try {
    return decoder.decode(file.bytes);
  } catch {
    throw new Error("The recovered snippet is not valid UTF-8.");
  }
}
export {
  MAX_SNIPPET_BYTES,
  MAX_SNIPPET_LABEL,
  SNIPPET_FILE_NAME,
  SNIPPET_MEDIA_TYPE,
  isSnippet,
  packSnippet,
  snippetText
};
