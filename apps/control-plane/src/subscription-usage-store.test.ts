import { describe, expect, it } from "vitest";
import type { SubscriptionUsageEntry } from "./subscription-usage-presentation";
import { createSubscriptionUsageStore } from "./subscription-usage-store";

function entry(id: string): SubscriptionUsageEntry {
  return { id, label: id, usage: null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("createSubscriptionUsageStore", () => {
  it("keeps the last loaded limits for the next card that mounts", async () => {
    const store = createSubscriptionUsageStore(() => Promise.resolve([entry("a")]));
    expect(store.current()).toEqual([]);
    await store.refresh();
    expect(store.current()).toEqual([entry("a")]);
  });

  it("ignores a response that finishes after a newer one", async () => {
    const older = deferred<SubscriptionUsageEntry[] | null>();
    const newer = deferred<SubscriptionUsageEntry[] | null>();
    const responses = [older.promise, newer.promise];
    const store = createSubscriptionUsageStore(() => responses.shift()!);
    const first = store.refresh();
    const second = store.refresh();
    newer.resolve([entry("new")]);
    await second;
    older.resolve([entry("old")]);
    await first;
    expect(store.current()).toEqual([entry("new")]);
  });

  it("marks known subscriptions unavailable when a refresh fails", async () => {
    const loaded = { id: "a", label: "a", usage: { planType: "pro", windows: [] } };
    const responses: Array<SubscriptionUsageEntry[] | null> = [null, [loaded], null];
    const store = createSubscriptionUsageStore(() => Promise.resolve(responses.shift()!));
    // Whether a subscription exists is unknown until a request succeeds.
    await store.refresh();
    expect(store.current()).toEqual([]);
    await store.refresh();
    expect(store.current()).toEqual([loaded]);
    await store.refresh();
    expect(store.current()).toEqual([{ ...loaded, usage: null }]);
  });
});
