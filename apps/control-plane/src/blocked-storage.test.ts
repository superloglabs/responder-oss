import { describe, expect, it } from "vitest";
import { MemoryStorage, replaceBlockedStorage } from "./blocked-storage.js";

function securityError(name: string) {
  return new DOMException(
    `Failed to read the '${name}' property from 'Window': Access is denied for this document.`,
    "SecurityError",
  );
}

// A window whose storage getters behave like a browser's: own, configurable
// accessors that either return storage or throw.
function browserWindow(blocked: { local: boolean; session: boolean }) {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const target = {};
  Object.defineProperty(target, "localStorage", {
    configurable: true,
    enumerable: true,
    get() {
      if (blocked.local) throw securityError("localStorage");
      return local;
    },
  });
  Object.defineProperty(target, "sessionStorage", {
    configurable: true,
    enumerable: true,
    get() {
      if (blocked.session) throw securityError("sessionStorage");
      return session;
    },
  });
  return { local, session, target: target as Window };
}

describe("replaceBlockedStorage", () => {
  it("keeps storage the browser allows", () => {
    const { local, session, target } = browserWindow({ local: false, session: false });

    expect(replaceBlockedStorage(target)).toEqual([]);
    expect(target.localStorage).toBe(local);
    expect(target.sessionStorage).toBe(session);
  });

  it("replaces blocked storage with storage kept in memory", () => {
    const { target } = browserWindow({ local: true, session: true });

    expect(replaceBlockedStorage(target)).toEqual(["localStorage", "sessionStorage"]);

    target.localStorage.setItem("c15t-storage-test-key", "test");
    expect(target.localStorage.getItem("c15t-storage-test-key")).toBe("test");
    expect(target.sessionStorage.getItem("c15t-storage-test-key")).toBeNull();
  });

  it("replaces only the storage that is blocked", () => {
    const { session, target } = browserWindow({ local: true, session: false });

    expect(replaceBlockedStorage(target)).toEqual(["localStorage"]);
    expect(target.localStorage).toBeInstanceOf(MemoryStorage);
    expect(target.sessionStorage).toBe(session);
  });

  it("replaces storage that refuses writes", () => {
    const { session, target } = browserWindow({ local: false, session: false });
    const local = target.localStorage;
    local.setItem("kept", "1");
    local.setItem = () => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    };

    expect(replaceBlockedStorage(target)).toEqual(["localStorage"]);
    expect(target.localStorage).not.toBe(local);
    target.localStorage.setItem("a", "1");
    expect(target.localStorage.getItem("a")).toBe("1");
    expect(target.sessionStorage).toBe(session);
  });

  it("leaves no probe value in storage it keeps", () => {
    const { local, session, target } = browserWindow({ local: false, session: false });

    replaceBlockedStorage(target);
    expect(local.length).toBe(0);
    expect(session.length).toBe(0);
  });

  it("keeps a value stored under the probe key", () => {
    const { local, target } = browserWindow({ local: false, session: false });
    local.setItem("responder-storage-probe", "saved");

    expect(replaceBlockedStorage(target)).toEqual([]);
    expect(local.getItem("responder-storage-probe")).toBe("saved");
  });

  it("leaves a property it cannot redefine", () => {
    const target = {};
    Object.defineProperty(target, "localStorage", {
      configurable: false,
      get() {
        throw securityError("localStorage");
      },
    });
    Object.defineProperty(target, "sessionStorage", { value: new MemoryStorage() });

    expect(replaceBlockedStorage(target as Window)).toEqual([]);
  });
});

describe("MemoryStorage", () => {
  it("behaves like Storage", () => {
    const storage = new MemoryStorage();

    storage.setItem("a", "1");
    storage.setItem("b", "2");
    storage.setItem("a", "3");
    expect(storage.length).toBe(2);
    expect(storage.key(0)).toBe("a");
    expect(storage.key(5)).toBeNull();
    expect(storage.getItem("a")).toBe("3");
    expect(storage.getItem("missing")).toBeNull();

    storage.removeItem("a");
    expect(storage.getItem("a")).toBeNull();
    expect(storage.length).toBe(1);

    storage.clear();
    expect(storage.length).toBe(0);
  });
});
