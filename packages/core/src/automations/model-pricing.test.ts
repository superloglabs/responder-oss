import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aiGatewayModelId,
  listAIGatewayModels,
  automationModelCostMicros,
  getAIGatewayModelPricing,
  resetAIGatewayPricingCache,
} from "./model-pricing.js";

describe("AI Gateway model pricing", () => {
  afterEach(() => resetAIGatewayPricingCache());

  it("maps automation models to gateway slugs", () => {
    expect(aiGatewayModelId("openai", "gpt-5.4")).toBe("openai/gpt-5.4");
    expect(aiGatewayModelId("anthropic", "claude-sonnet-4-5")).toBe(
      "anthropic/claude-sonnet-4.5",
    );
    expect(aiGatewayModelId("anthropic", "claude-haiku-4-5-20251001")).toBe(
      "anthropic/claude-haiku-4.5",
    );
    expect(aiGatewayModelId("anthropic", "claude-3-5-sonnet-20241022")).toBe(
      "anthropic/claude-3.5-sonnet",
    );
    expect(aiGatewayModelId("anthropic", "claude-3-haiku-20240307")).toBe(
      "anthropic/claude-3-haiku",
    );
    expect(aiGatewayModelId("anthropic", "claude-opus-5")).toBe(
      "anthropic/claude-opus-5",
    );
    expect(aiGatewayModelId("anthropic", "anthropic/claude-sonnet-5")).toBe(
      "anthropic/claude-sonnet-5",
    );
    expect(aiGatewayModelId("xai", "grok-4.1-fast-reasoning")).toBe(
      "spacexai/grok-4.1-fast-reasoning",
    );
    expect(aiGatewayModelId("google", "gemini-3-pro")).toBe("google/gemini-3-pro");
  });

  it("prices each token class and applies long-context tiers", () => {
    const pricing = {
      input: "0.000003",
      input_cache_read: "0.0000003",
      input_cache_write: "0.00000375",
      input_tiers: [
        { cost: "0.000003", max: 200_001, min: 0 },
        { cost: "0.000006", min: 200_001 },
      ],
      output: "0.000015",
    };

    expect(automationModelCostMicros(pricing, {
      cacheWriteTokens: 1_000,
      cachedInputTokens: 10_000,
      inputTokens: 1_000,
      outputTokens: 1_000,
    })).toBe(3_000 + 3_000 + 3_750 + 15_000);
    expect(automationModelCostMicros(pricing, {
      cacheWriteTokens: 0,
      cachedInputTokens: 0,
      inputTokens: 250_000,
      outputTokens: 0,
    })).toBe(1_500_000);
  });

  it("falls back to the input price when a cache price is missing", () => {
    expect(automationModelCostMicros(
      { input: "0.000001", output: "0.000002" },
      { cacheWriteTokens: 10, cachedInputTokens: 10, inputTokens: 10, outputTokens: 10 },
    )).toBe(50);
    expect(automationModelCostMicros(
      { output: "0.000002" },
      { cacheWriteTokens: 0, cachedInputTokens: 0, inputTokens: 1, outputTokens: 1 },
    )).toBeNull();
  });

  it("caches the public model catalog", async () => {
    const fetchPricing = vi.fn().mockResolvedValue(Response.json({
      data: [{ id: "openai/gpt-5.4", pricing: { input: "1", output: "2" } }],
    }));

    await expect(getAIGatewayModelPricing("openai/gpt-5.4", {
      fetch: fetchPricing,
      now: () => 0,
    })).resolves.toEqual({ input: "1", output: "2" });
    await expect(getAIGatewayModelPricing("openai/unknown", {
      fetch: fetchPricing,
      now: () => 1_000,
    })).resolves.toBeNull();
    expect(fetchPricing).toHaveBeenCalledOnce();
  });

  it("lists a provider's priced gateway language models without the creator prefix", async () => {
    const fetchCatalog = vi.fn().mockResolvedValue(Response.json({
      data: [
        { id: "spacexai/grok-5", name: "Grok 5", pricing: { input: "0.000001", output: "0.000002" }, type: "language" },
        { id: "spacexai/grok-unpriced", name: "Grok Unpriced", type: "language" },
        { id: "spacexai/grok-imagine", name: "Grok Imagine", pricing: { image: "0.04" }, type: "image" },
        { id: "openai/gpt-5.4", name: "GPT-5.4", pricing: { input: "0.000001", output: "0.000002" }, type: "language" },
      ],
    }));

    await expect(listAIGatewayModels("xai", { fetch: fetchCatalog })).resolves.toEqual([
      { id: "grok-5", name: "Grok 5" },
    ]);
    await expect(listAIGatewayModels("groq", { fetch: fetchCatalog })).resolves.toEqual([]);
  });
});
