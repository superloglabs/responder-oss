import { useCallback, useSyncExternalStore } from "react";

export type ColorTheme = "dark" | "light";

const colorThemeStorageKey = "responder-marketing-theme";
const subscribers = new Set<() => void>();
let colorTheme: ColorTheme = "dark";
let inMemoryColorTheme: ColorTheme | null = null;
let isInitialized = false;

export function resolveColorTheme(
  storedTheme: string | null,
  prefersLight: boolean,
): ColorTheme {
  if (storedTheme === "dark" || storedTheme === "light") return storedTheme;
  return prefersLight ? "light" : "dark";
}

function readStoredColorTheme() {
  try {
    return window.localStorage.getItem(colorThemeStorageKey) ?? inMemoryColorTheme;
  } catch {
    return inMemoryColorTheme;
  }
}

function publishColorTheme(nextTheme: ColorTheme) {
  colorTheme = nextTheme;
  document.documentElement.dataset.colorTheme = nextTheme;
  document.documentElement.style.colorScheme = nextTheme;
  for (const subscriber of subscribers) subscriber();
}

function initializeColorTheme() {
  if (isInitialized || typeof window === "undefined") return;
  isInitialized = true;

  const lightModePreference = window.matchMedia("(prefers-color-scheme: light)");
  const syncTheme = () => {
    publishColorTheme(
      resolveColorTheme(readStoredColorTheme(), lightModePreference.matches),
    );
  };
  const syncStoredTheme = (event: StorageEvent) => {
    if (event.key === null || event.key === colorThemeStorageKey) syncTheme();
  };

  syncTheme();
  lightModePreference.addEventListener("change", syncTheme);
  window.addEventListener("storage", syncStoredTheme);
}

function subscribe(subscriber: () => void) {
  initializeColorTheme();
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

function getColorTheme() {
  return colorTheme;
}

function getServerColorTheme(): ColorTheme {
  return "dark";
}

export function setColorTheme(nextTheme: ColorTheme) {
  try {
    window.localStorage.setItem(colorThemeStorageKey, nextTheme);
    inMemoryColorTheme = null;
  } catch {
    inMemoryColorTheme = nextTheme;
  }
  publishColorTheme(nextTheme);
}

export function useColorTheme() {
  const theme = useSyncExternalStore(subscribe, getColorTheme, getServerColorTheme);
  const toggleTheme = useCallback(() => {
    setColorTheme(theme === "dark" ? "light" : "dark");
  }, [theme]);

  return { theme, toggleTheme };
}

initializeColorTheme();
