import type { AvailableAutomationModel } from "../../../../packages/core/src/automations/model-providers.js";

/** Cache only public model metadata or usage, never provider credentials. */
export function createModelCatalogCache<T = AvailableAutomationModel[]>(now: () => number = Date.now) {
  const cached = new Map<string, { expiresAt: number; models: T }>();
  const pending = new Map<string, Promise<T>>();
  return async (key: string, load: () => Promise<T>, refresh = false) => {
    const running = pending.get(key);
    if (running) return running;
    const existing = cached.get(key);
    if (!refresh && existing && existing.expiresAt > now()) return existing.models;
    const request = Promise.resolve().then(load).then(models => {
      cached.delete(key);
      if (cached.size >= 100) cached.delete(cached.keys().next().value!);
      cached.set(key, { models, expiresAt: now() + 5 * 60_000 });
      return models;
    }).finally(() => { pending.delete(key); });
    pending.set(key, request);
    return request;
  };
}
