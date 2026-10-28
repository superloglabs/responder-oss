export async function copyToClipboard(
  text: string,
  clipboard: Pick<Clipboard, "writeText"> = navigator.clipboard,
) {
  await clipboard.writeText(text);
}

// Copies text that may still be loading. Pending text is handed to the
// clipboard as a pending item, so the copy still counts as part of the click
// once it arrives.
export async function copyText(text: string | Promise<string>) {
  if (typeof text !== "string" && typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
    await navigator.clipboard.write([
      new ClipboardItem({ "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })) }),
    ]);
    return;
  }
  await navigator.clipboard.writeText(await text);
}
