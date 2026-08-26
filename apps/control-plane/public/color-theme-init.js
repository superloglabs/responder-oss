(() => {
  const storageKey = "responder-marketing-theme";
  let storedTheme = null;

  try {
    storedTheme = globalThis.localStorage.getItem(storageKey);
  } catch {
    // Fall back to the system preference when storage is unavailable.
  }

  const theme =
    storedTheme === "dark" || storedTheme === "light"
      ? storedTheme
      : globalThis.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";

  globalThis.document.documentElement.dataset.colorTheme = theme;
  globalThis.document.documentElement.style.colorScheme = theme;
})();
