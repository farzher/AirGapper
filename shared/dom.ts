/** DOM conveniences missing from the Firefox 68 build used by older receivers. */
export function replaceChildren(element: Element, ...children: Node[]): void {
  while (element.firstChild) element.removeChild(element.firstChild);
  for (const child of children) element.appendChild(child);
}

export function readFileBytes(file: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("The selected file could not be read."));
    reader.readAsArrayBuffer(file);
  });
}
