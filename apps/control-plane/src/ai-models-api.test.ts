import { describe, expect, it } from "vitest";
import { dashboardWidgetCreateSchema } from "../../../packages/core/src/telemetry/dashboards";
import { aiPriceSource, aiSpendWidgets, formatTokenPrice, type AiModel } from "./ai-models-api";

const card = { cacheRead: 0.3, cacheWrite: 3.75, input: 3, long: null, output: 15, threshold: null };
const model: AiModel = {
  calls: 4,
  inputTokens: 100,
  model: "claude-sonnet-4-5-20250929",
  outputTokens: 10,
  price: { card, catalogModel: "claude-sonnet-4-5", source: "catalogue" },
  provider: "anthropic",
  tier: "",
};

describe("AI models", () => {
  it("says where a model's price comes from", () => {
    expect(aiPriceSource(model)).toBe("Catalogue: claude-sonnet-4-5");
    expect(aiPriceSource({ ...model, model: "claude-sonnet-4-5" })).toBe("Catalogue");
    expect(aiPriceSource({ ...model, price: { card, catalogModel: null, source: "workspace" } })).toBe("Workspace price");
    expect(aiPriceSource({ ...model, price: null })).toBe("No price");
  });

  it("formats prices per million tokens", () => {
    expect(formatTokenPrice(3)).toBe("$3.00");
    expect(formatTokenPrice(0.075)).toBe("$0.075");
  });

  it("builds a starter dashboard from widgets the server accepts", () => {
    for (const widget of aiSpendWidgets) {
      expect(dashboardWidgetCreateSchema.safeParse(widget).success, widget.title).toBe(true);
    }
  });
});
