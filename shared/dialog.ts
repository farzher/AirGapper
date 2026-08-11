/** Close a modal <dialog> when a click lands on its ::backdrop.
 *
 *  Comparing event.target to the dialog — the common recipe — is wrong: the
 *  gaps between a dialog's children (its padding, their margins) are also the
 *  dialog, so taps well inside the box kept closing it. A real backdrop click
 *  still targets the dialog, but its coordinates fall outside the dialog's
 *  border box; geometry is the only honest test. */
export function closeOnBackdropClick(dialog: HTMLDialogElement): void {
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    if (!inside) dialog.close();
  });
}
