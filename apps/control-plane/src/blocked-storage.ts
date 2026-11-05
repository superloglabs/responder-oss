// Browsers set to block site data throw a SecurityError when a page reads
// window.localStorage or window.sessionStorage, and storage without quota
// throws when written. Libraries such as the consent manager read storage
// while rendering, so the error takes down the whole page. Replacing unusable
// storage with one kept in memory lets the page work; what it stores lasts
// until the page unloads.

type StorageName = "localStorage" | "sessionStorage";

const storageNames: StorageName[] = ["localStorage", "sessionStorage"];
const probeKey = "responder-storage-probe";

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

function isUnusable(target: Window, name: StorageName) {
  try {
    const storage = target[name];
    storage.setItem(probeKey, probeKey);
    storage.removeItem(probeKey);
    return false;
  } catch {
    return true;
  }
}

/** Returns the names of the storages it replaced. */
export function replaceBlockedStorage(target: Window): StorageName[] {
  const replaced: StorageName[] = [];
  for (const name of storageNames) {
    if (!isUnusable(target, name)) continue;
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
