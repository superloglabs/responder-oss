import { describe, expect, it, vi } from "vitest";
import { listProviderModels, normalizeProviderModels } from "./model-catalog.js";
import { automationModelProviders } from "./model-providers.js";

describe("live provider model catalogs", () => {
  it.each(automationModelProviders)("loads $name with credential headers and a fixed endpoint", async provider => {
    const request = vi.fn().mockResolvedValue(Response.json({ data: [] }));
    expect(await listProviderModels(provider.id, "private-key", request)).toEqual([]);
    const [url, init] = request.mock.calls[0];
    expect(url.toString()).toContain(`${provider.baseUrl}/models`);
    expect(url.toString()).not.toContain("private-key");
    expect(init.redirect).toBe("error");
    expect(init.headers[provider.id === "anthropic" ? "x-api-key" : "authorization"]).toContain("private-key");
  });
  it("follows Anthropic pagination without dropping newer or fine-tuned models", async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json({ data: [{ id: "claude-new", display_name: "New Claude" }], has_more: true, last_id: "claude-new" }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "claude-custom" }], has_more: false }));
    expect(await listProviderModels("anthropic", "key", request)).toHaveLength(2);
    expect(request.mock.calls[1][0].searchParams.get("after_id")).toBe("claude-new");
  });
  it("keeps live text models while excluding incompatible modalities and duplicates", () => {
    expect(normalizeProviderModels("openai", [{ id: "gpt-future" }, { id: "gpt-future" }, { id: "text-embedding-3-large" }, { id: "gpt-image-1" }, { id: "gpt-realtime" }, { id: "ft:gpt-4o:org:custom" }]).map(item => item.id)).toEqual(["ft:gpt-4o:org:custom", "gpt-future"]);
    expect(normalizeProviderModels("mistral", [{ id: "model", capabilities: { function_calling: false } }])).toEqual([]);
  });
  it("does not expose provider error bodies or credentials", async () => {
    const request = vi.fn().mockResolvedValue(new Response('private-key secret', { status: 401 }));
    await expect(listProviderModels("groq", "private-key", request)).rejects.toThrow(/^The provider rejected this API key\. Reconnect with a valid key\.$/);
  });
});
