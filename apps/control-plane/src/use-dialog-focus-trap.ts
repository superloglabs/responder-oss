import { useEffect, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Returns the index Tab should move to so focus wraps within a dialog, or null
 * when the browser's default move stays inside it.
 */
export function wrappedFocusIndex(
  count: number,
  activeIndex: number,
  backwards: boolean,
): number | null {
  if (count === 0) return null;
  if (activeIndex < 0) return backwards ? count - 1 : 0;
  if (backwards && activeIndex === 0) return count - 1;
  if (!backwards && activeIndex === count - 1) return 0;
  return null;
}

/**
 * Moves focus into an open modal dialog, keeps Tab focus inside it, and returns
 * focus to the element that opened it when the dialog closes. Dialogs using
 * this hook should not set `autoFocus`, which would move focus before the
 * opener is recorded.
 */
export function useDialogFocusTrap(
  dialogRef: RefObject<HTMLElement | null>,
  open: boolean,
): void {
  useEffect(() => {
    if (!open) return;
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableControls = () => [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []),
    ];
    focusableControls()[0]?.focus();
    const trapTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = focusableControls();
      const nextIndex = wrappedFocusIndex(
        focusable.length,
        focusable.indexOf(document.activeElement as HTMLElement),
        event.shiftKey,
      );
      if (nextIndex === null) return;
      event.preventDefault();
      focusable[nextIndex]?.focus();
    };
    document.addEventListener("keydown", trapTab);
    return () => {
      document.removeEventListener("keydown", trapTab);
      if (opener?.isConnected) opener.focus();
    };
  }, [dialogRef, open]);
}
