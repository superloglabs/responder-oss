// Password managers such as 1Password add their inline menus to the page
// outside the app and move focus into them. Only a click or focus elsewhere
// in the app dismisses a popover, so those menus leave it open.
export function movedElsewhereInApp(popover: Element | null, target: EventTarget | null): boolean {
  if (!popover || !(target instanceof Node)) return false;
  return Boolean(document.getElementById("root")?.contains(target)) && !popover.contains(target);
}
