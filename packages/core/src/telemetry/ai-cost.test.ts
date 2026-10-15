import { describe, expect, it } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import { calcPrice } from "@pydantic/genai-prices";
import { aiFieldExpr, isAiMeasureField, priceCard, resolveAiPrices } from "./ai-cost.js";
import { aiModelsInWindow, eventAggregate, eventSeries } from "./query.js";

const window = { since: "2026-10-01T00:00:00.000Z", until: "2026-10-08T00:00:00.000Z" };

describe("resolveAiPrices", () => {
  it("prices models by the names spans give them, with OpenTelemetry provider names", () => {
    const { params, prices, unpriced } = resolveAiPrices(
      [
        { model: "claude-sonnet-4-5-20250929", provider: "anthropic", tier: "" },
        { model: "gemini-2.5-pro", provider: "gcp.gen_ai", tier: "" },
        { model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", provider: "aws.bedrock", tier: "" },
        { model: "gpt-4o-mini", provider: "", tier: "" },
      ],
      window,
    );

    expect(unpriced).toEqual([]);
    expect(prices.map((price) => [price.model, price.catalogModel, price.source])).toEqual([
      ["claude-sonnet-4-5-20250929", "claude-sonnet-4-5", "catalogue"],
      ["gemini-2.5-pro", "gemini-2.5-pro", "catalogue"],
      ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", "regional.anthropic.claude-sonnet-4-5-20250929-v1:0", "catalogue"],
      ["gpt-4o-mini", "gpt-4o-mini", "catalogue"],
    ]);
    expect(params.aiPriceKey).toEqual([
      "anthropic|claude-sonnet-4-5-20250929|",
      "gcp.gen_ai|gemini-2.5-pro|",
      "aws.bedrock|us.anthropic.claude-sonnet-4-5-20250929-v1:0|",
      "|gpt-4o-mini|",
    ]);
    // One row each, open at both ends so no call falls outside them.
    expect(params.aiPriceFrom).toEqual([0, 0, 0, 0]);
    expect(params.aiPriceTo.every((to) => to === 2 ** 40)).toBe(true);
  });

  it("carries long-context prices and their threshold", () => {
    const { params, prices } = resolveAiPrices([{ model: "claude-sonnet-4-5", provider: "anthropic", tier: "" }], window);

    expect(prices[0]!.card).toEqual({
      cacheRead: 0.3,
      cacheWrite: 3.75,
      input: 3,
      long: { cacheRead: 0.6, cacheWrite: 7.5, input: 6, output: 22.5 },
      output: 15,
      threshold: 200_000,
    });
    expect(params.aiPriceThreshold).toEqual([200_000]);
    expect(params.aiPriceOutputLong).toEqual([22.5]);
  });

  it("splits the window where a service tier's price starts", () => {
    const { params } = resolveAiPrices(
      [{ model: "gpt-5", provider: "openai", tier: "flex" }],
      { since: "2026-10-10T00:00:00.000Z", until: "2026-10-14T00:00:00.000Z" },
    );

    const start = Date.parse("2026-10-12T00:00:00.000Z") / 1000;
    expect(params.aiPriceKey).toEqual(["openai|gpt-5|flex", "openai|gpt-5|flex"]);
    expect(params.aiPriceFrom).toEqual([0, start]);
    expect(params.aiPriceTo).toEqual([start, 2 ** 40]);
    expect(params.aiPriceInput).toEqual([1.25, 0.625]);
  });

  it("uses the workspace's own price before the catalogue, and lists models without a price", () => {
    const { params, prices, unpriced } = resolveAiPrices(
      [
        { model: "gpt-5", provider: "openai", tier: "" },
        { model: "ft:gpt-4o:acme", provider: "openai", tier: "" },
        { model: "", provider: "openai", tier: "" },
      ],
      window,
      [{ cacheReadMtok: null, cacheWriteMtok: null, inputMtok: 1, model: "GPT-5", outputMtok: 4, provider: "" }],
    );

    expect(prices).toEqual([
      expect.objectContaining({ card: expect.objectContaining({ cacheRead: 1, input: 1, output: 4 }), model: "gpt-5", source: "workspace" }),
    ]);
    expect(params.aiPriceInput).toEqual([1]);
    expect(unpriced).toEqual([
      { model: "ft:gpt-4o:acme", provider: "openai", tier: "" },
      { model: "", provider: "openai", tier: "" },
    ]);
  });
});

describe("priceCard", () => {
  it("charges cached tokens as input when the model has no cache price", () => {
    expect(priceCard({ input_mtok: 2, output_mtok: 8 })).toEqual({
      cacheRead: 2,
      cacheWrite: 2,
      input: 2,
      long: null,
      output: 8,
      threshold: null,
    });
    expect(priceCard({ output_mtok: 8 })).toBeNull();
  });

  it("matches the catalogue's own price for a call", () => {
    const usage = { cache_read_tokens: 6_000, cache_write_tokens: 1_000, input_tokens: 10_000, output_tokens: 500 };
    const reference = calcPrice(usage, "claude-sonnet-4-5", { providerId: "anthropic" })!;
    const card = priceCard(reference.model_price)!;
    const uncached = usage.input_tokens - usage.cache_read_tokens - usage.cache_write_tokens;
    const ours =
      (uncached * card.input + usage.cache_read_tokens * card.cacheRead + usage.cache_write_tokens * card.cacheWrite +
        usage.output_tokens * card.output) / 1e6;
    expect(ours).toBeCloseTo(reference.total_price, 12);
  });
});

type Call = { query: string; params: Record<string, unknown> };

function client(calls: Call[], rows: unknown[] = []) {
  return {
    query: async ({ query, query_params }: { query: string; query_params?: Record<string, unknown> }) => {
      calls.push({ params: query_params ?? {}, query });
      return { json: async () => rows };
    },
  } as unknown as ClickHouseClient;
}

const range = { since: "2026-10-14T13:00:00.000Z", until: "2026-10-14T14:00:00.000Z" };

describe("AI fields in queries", () => {
  it("names the fields a widget can read", () => {
    expect(isAiMeasureField("ai:cost")).toBe(true);
    expect(isAiMeasureField("ai:tokens.output")).toBe(true);
    expect(isAiMeasureField("span.gen_ai.usage.output_tokens")).toBe(false);
  });

  it("counts cached tokens into input when an instrumentation left them out", () => {
    expect(aiFieldExpr("ai:tokens.input")).toMatch(/^if\(/u);
    expect(aiFieldExpr("ai:tokens.input_uncached")).toMatch(/^greatest\(/u);
  });

  it("sums cost of model calls only, leaving out spans that repeat their calls' usage", async () => {
    const calls: Call[] = [];
    const prices = resolveAiPrices([{ model: "gpt-5", provider: "openai", tier: "" }], range).params;

    await eventAggregate(client(calls), "project-1", "traces", { range }, { aggregation: "sum", field: "ai:cost" }, "ai:model", 10, prices);

    const { params, query } = calls[0]!;
    expect(query).toMatch(/SpanId NOT IN \(\s*SELECT ParentSpanId FROM otel_traces/u);
    expect(query).toMatch(/arrayFirstIndex/u);
    expect(query).toMatch(/lower\(coalesce\(nullIf\(SpanAttributes\['gen_ai.response.model'\], ''\)/u);
    expect(params).toMatchObject({ aiPriceInput: [1.25], aiPriceKey: ["openai|gpt-5|"] });
  });

  it("reads token fields without prices and refuses distinct counts and logs", async () => {
    const calls: Call[] = [];
    const step = { n: 1, unit: "MINUTE" } as const;

    await eventSeries(client(calls), "project-1", "traces", { range }, { aggregation: "sum", field: "ai:tokens.output" }, undefined, step);
    expect(calls[0]!.params).not.toHaveProperty("aiPriceKey");
    expect(
      await eventSeries(client(calls), "project-1", "traces", { range }, { aggregation: "count_distinct", field: "ai:cost" }, undefined, step),
    ).toEqual([]);
    expect(await eventSeries(client(calls), "project-1", "logs", { range }, { aggregation: "sum", field: "ai:cost" }, undefined, step)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("lists the models called with their token totals", async () => {
    const calls: Call[] = [];
    const rows = [{ calls: "4", input_tokens: "1200", model: "gpt-5", output_tokens: 300, provider: "openai", tier: "" }];

    expect(await aiModelsInWindow(client(calls, rows), "project-1", { range })).toEqual([
      { calls: 4, inputTokens: 1200, model: "gpt-5", outputTokens: 300, provider: "openai", tier: "" },
    ]);
    expect(calls[0]!.query).toMatch(/GROUP BY provider, model, tier/u);
  });
});
