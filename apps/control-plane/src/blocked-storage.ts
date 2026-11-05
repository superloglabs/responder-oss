// Browsers set to block site data throw a SecurityError when a page reads
// window.localStorage or window.sessionStorage. Libraries such as the consent
// manager read them while rendering, so the error takes down the whole page.
// Replacing a blocked storage with one kept in memory lets the page work; what
// it stores lasts until the page unloads.

type StorageName = "localStorage" | "sessionStorage";

const storageNames: StorageName[] = ["localStorage", "sessionStorage"];

export class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length() {
    return this.#values.size;
  }

  clear() {
    this.#values.clear();
  }

  getItem(key: string) {
    return this.#values.get(String(key)) ?? null;
  }

  key(index: number) {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.#values.delete(String(key));
  }

  setItem(key: string, value: string) {
    this.#values.set(String(key), String(value));
  }
}

function isBlocked(target: Window, name: StorageName) {
  try {
    void target[name];
    return false;
  } catch {
    return true;
  }
}

/** Returns the names of the storages it replaced. */
export function replaceBlockedStorage(target: Window): StorageName[] {
  const replaced: StorageName[] = [];
  for (const name of storageNames) {
    if (!isBlocked(target, name)) continue;
    try {
      Object.defineProperty(target, name, {
        configurable: true,
        enumerable: true,
        value: new MemoryStorage(),
      });
      replaced.push(name);
    } catch {
      // The browser keeps the original property; reads still throw.
    }
  }
  return replaced;
}
