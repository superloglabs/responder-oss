export async function copyToClipboard(
  text: string,
  clipboard: Pick<Clipboard, "writeText"> = navigator.clipboard,
) {
  await clipboard.writeText(text);
}
