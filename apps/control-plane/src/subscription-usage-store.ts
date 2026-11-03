import type { SubscriptionUsageEntry } from "./subscription-usage-presentation";

// Holds the last loaded limits across page changes, since each page renders
// its own sidebar. Only the newest request may replace them.
export function createSubscriptionUsageStore(
  load: () => Promise<SubscriptionUsageEntry[] | null>,
) {
  let subscriptions: SubscriptionUsageEntry[] = [];
  let latest = 0;
  return {
    current: () => subscriptions,
    async refresh(): Promise<SubscriptionUsageEntry[]> {
      const request = ++latest;
      const loaded = await load();
      if (loaded && request === latest) subscriptions = loaded;
      return subscriptions;
    },
  };
}

async function loadSubscriptionUsage(): Promise<SubscriptionUsageEntry[] | null> {
  const response = await fetch("/api/automations/subscriptions/usage").catch(() => null);
  if (!response?.ok) return null;
  const body = (await response.json().catch(() => null)) as
    | { subscriptions?: SubscriptionUsageEntry[] }
    | null;
  return body?.subscriptions ?? null;
}

export const subscriptionUsageStore = createSubscriptionUsageStore(loadSubscriptionUsage);
