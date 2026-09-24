import { modelProvider, type ModelProviderId, type AvailableAutomationModel } from "./model-providers.js";

export class ModelCatalogError extends Error {
  constructor(readonly authenticationFailed: boolean) {
    super(authenticationFailed ? "The provider rejected this API key. Reconnect with a valid key." : "Unable to load models from this provider. Please retry.");
  }
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function normalizeProviderModels(provider: ModelProviderId, items: unknown[]): AvailableAutomationModel[] {
  const models = new Map<string, AvailableAutomationModel>();
  for (const value of items) {
    const item = record(value);
    const id = item.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/u.test(id)) continue;
    if (item.active === false) continue;
    // These APIs also list non-conversational models that cannot run an automation.
    if (/embed|whisper|tts|transcri|moderation|rerank|dall-e|sora|image|audio|realtime|guard/iu.test(id)) continue;
    if (provider === "openai" && !/^(gpt-|chatgpt-|o\d|codex-|ft:(gpt-|o\d))/u.test(id)) continue;
    if (provider === "google" && !id.startsWith("gemini-")) continue;
    if (provider === "mistral" && (record(item.capabilities).completion_chat === false || record(item.capabilities).function_calling === false)) continue;
    const name = item.display_name ?? item.name ?? id;
    models.set(id, { id, name: typeof name === "string" ? name : id });
  }
  return [...models.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export async function listProviderModels(provider: ModelProviderId, apiKey: string, providerFetch: typeof fetch = fetch) {
  const base = modelProvider(provider).baseUrl;
  const headers: Record<string, string> = provider === "anthropic"
    ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    : { authorization: `Bearer ${apiKey}` };
  let cursor: string | undefined;
  const items: unknown[] = [];
  const signal = AbortSignal.timeout(30_000);
  for (let page = 0; page < 100; page++) {
    const url = new URL(`${base}/models`);
    if (provider === "anthropic") { url.searchParams.set("limit", "1000"); if (cursor) url.searchParams.set("after_id", cursor); }
    let response: Response;
    try { response = await providerFetch(url, { headers, signal, redirect: "error" }); }
    catch { throw new ModelCatalogError(false); }
    if (!response.ok) throw new ModelCatalogError([401, 403].includes(response.status));
    const raw: unknown = await response.json();
    const body = record(raw);
    const data = Array.isArray(raw) ? raw : body.data;
    if (!Array.isArray(data)) throw new ModelCatalogError(false);
    items.push(...data);
    if (provider !== "anthropic" || !body.has_more) return normalizeProviderModels(provider, items);
    if (typeof body.last_id !== "string" || body.last_id === cursor) throw new ModelCatalogError(false);
    cursor = body.last_id;
  }
  throw new ModelCatalogError(false);
}
