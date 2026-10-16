// AI usage read from GenAI spans: token counts from whichever conventions the
// instrumentation wrote, the model and provider, and the cost of each call at
// its model's price. Prices come from the genai-prices catalogue, or from a
// workspace's own price for a model.
import { calcPrice, updatePrices, type ModelInfo, type ModelPrice, type TieredPrices } from "@pydantic/genai-prices";

// Fields and groupings a widget can name. They read spans only.
export const AI_MEASURE_FIELDS = [
  "ai:cost",
  "ai:tokens.input",
  "ai:tokens.input_uncached",
  "ai:tokens.cache_read",
  "ai:tokens.cache_write",
  "ai:tokens.output",
  "ai:tokens.reasoning",
  "ai:tokens.total",
] as const;
export type AiMeasureField = (typeof AI_MEASURE_FIELDS)[number];
export const AI_GROUP_FIELDS = ["ai:model", "ai:provider"] as const;

export function isAiMeasureField(field: string | undefined): field is AiMeasureField {
  return (AI_MEASURE_FIELDS as readonly string[]).includes(field ?? "");
}

// Attribute keys per value, in order of preference: the GenAI semantic
// conventions, then older OpenLLMetry names, OpenInference and the Vercel AI
// SDK's own names.
const TOKEN_KEYS = {
  input: [
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.prompt_tokens",
    "llm.token_count.prompt",
    "ai.usage.inputTokens",
    "ai.usage.promptTokens",
  ],
  output: [
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.completion_tokens",
    "llm.token_count.completion",
    "ai.usage.outputTokens",
    "ai.usage.completionTokens",
  ],
  cacheRead: [
    "gen_ai.usage.cache_read.input_tokens",
    "gen_ai.usage.cache_read_input_tokens",
    "llm.token_count.prompt_details.cache_read",
    "ai.usage.cachedInputTokens",
  ],
  cacheWrite: [
    "gen_ai.usage.cache_write.input_tokens",
    "gen_ai.usage.cache_creation.input_tokens",
    "gen_ai.usage.cache_creation_input_tokens",
    "llm.token_count.prompt_details.cache_write",
  ],
  reasoning: [
    "gen_ai.usage.reasoning.output_tokens",
    "llm.token_count.completion_details.reasoning",
    "ai.usage.reasoningTokens",
  ],
} as const;

const MODEL_KEYS = ["gen_ai.response.model", "gen_ai.request.model", "llm.model_name", "ai.response.model", "ai.model.id"];
const PROVIDER_KEYS = ["gen_ai.provider.name", "gen_ai.system", "llm.provider", "llm.system", "ai.model.provider"];
const TIER_KEYS = [
  "openai.response.service_tier",
  "gen_ai.openai.response.service_tier",
  "openai.request.service_tier",
  "gen_ai.openai.request.service_tier",
];

// The keys are constants above, never input, so they are written into the SQL.
function numberOf(keys: readonly string[]): string {
  return `coalesce(${keys.map((key) => `toFloat64OrNull(SpanAttributes['${key}'])`).join(", ")})`;
}

function textOf(keys: readonly string[]): string {
  return `coalesce(${keys.map((key) => `nullIf(SpanAttributes['${key}'], '')`).join(", ")}, '')`;
}

const reportedInput = numberOf(TOKEN_KEYS.input);
const cacheRead = `ifNull(${numberOf(TOKEN_KEYS.cacheRead)}, 0)`;
const cacheWrite = `ifNull(${numberOf(TOKEN_KEYS.cacheWrite)}, 0)`;
const output = `ifNull(${numberOf(TOKEN_KEYS.output)}, 0)`;
// Input includes cached tokens, as the conventions define it. Some
// instrumentations report input without them; cached tokens beyond the input
// reported show that, and are added back.
const input = `if(${cacheRead} + ${cacheWrite} > ifNull(${reportedInput}, 0), ifNull(${reportedInput}, 0) + ${cacheRead} + ${cacheWrite}, ifNull(${reportedInput}, 0))`;
const uncachedInput = `greatest(${input} - ${cacheRead} - ${cacheWrite}, 0)`;

export const AI_MODEL_EXPR = `lower(${textOf(MODEL_KEYS)})`;
export const AI_PROVIDER_EXPR = `lower(${textOf(PROVIDER_KEYS)})`;
export const AI_TIER_EXPR = `lower(${textOf(TIER_KEYS)})`;

// A span that reports input or output token counts.
export const AI_INPUT_REPORTED_CONDITION = `isNotNull(${reportedInput})`;
export const AI_OUTPUT_REPORTED_CONDITION = `isNotNull(${numberOf(TOKEN_KEYS.output)})`;

// A span that reports token usage.
export const AI_USAGE_CONDITION = `(isNotNull(${reportedInput}) OR isNotNull(${numberOf(TOKEN_KEYS.output)}))`;

const priceKey = `concat(${AI_PROVIDER_EXPR}, '|', ${AI_MODEL_EXPR}, '|', ${AI_TIER_EXPR})`;
// The price row for the span's model, tier and time; 0 when there is none.
const priceIndex = `arrayFirstIndex((k, f, t) -> k = ${priceKey} AND toUnixTimestamp(Timestamp) >= f AND toUnixTimestamp(Timestamp) < t, {aiPriceKey:Array(String)}, {aiPriceFrom:Array(Int64)}, {aiPriceTo:Array(Int64)})`;

function priceOf(component: "Input" | "CacheRead" | "CacheWrite" | "Output"): string {
  const long = `{aiPriceThreshold:Array(Float64)}[${priceIndex}] > 0 AND ${input} > {aiPriceThreshold:Array(Float64)}[${priceIndex}]`;
  return `if(${long}, {aiPrice${component}Long:Array(Float64)}[${priceIndex}], {aiPrice${component}:Array(Float64)}[${priceIndex}])`;
}

const cost = `if(${priceIndex} = 0, NULL, (${uncachedInput} * ${priceOf("Input")} + ${cacheRead} * ${priceOf("CacheRead")} + ${cacheWrite} * ${priceOf("CacheWrite")} + ${output} * ${priceOf("Output")}) / 1e6)`;

// The number a field reads from a span.
export function aiFieldExpr(field: AiMeasureField): string {
  switch (field) {
    case "ai:cost":
      return cost;
    case "ai:tokens.input":
      return input;
    case "ai:tokens.input_uncached":
      return uncachedInput;
    case "ai:tokens.cache_read":
      return cacheRead;
    case "ai:tokens.cache_write":
      return cacheWrite;
    case "ai:tokens.output":
      return output;
    case "ai:tokens.reasoning":
      return `ifNull(${numberOf(TOKEN_KEYS.reasoning)}, 0)`;
    case "ai:tokens.total":
      return `${input} + ${output}`;
  }
}

export function aiGroupExpr(field: string): string | null {
  if (field === "ai:model") return AI_MODEL_EXPR;
  if (field === "ai:provider") return AI_PROVIDER_EXPR;
  return null;
}

// A model as spans name it.
export type AiModelKey = { model: string; provider: string; tier: string };

// USD per million tokens. Above `threshold` input tokens, a call is charged the
// long-context prices for all its tokens.
export type AiPriceCard = {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  long: { cacheRead: number; cacheWrite: number; input: number; output: number } | null;
  output: number;
  threshold: number | null;
};

// A workspace's own price for a model, for any time.
export type AiPriceOverride = {
  cacheReadMtok: number | null;
  cacheWriteMtok: number | null;
  inputMtok: number;
  model: string;
  outputMtok: number;
  provider: string;
};

export type AiModelPrice = AiModelKey & {
  // The catalogue's name for the model, or null for a workspace price.
  catalogModel: string | null;
  // The price for most of the window, for display.
  card: AiPriceCard;
  source: "catalogue" | "workspace";
};

export type AiPriceParams = {
  aiPriceCacheRead: number[];
  aiPriceCacheReadLong: number[];
  aiPriceCacheWrite: number[];
  aiPriceCacheWriteLong: number[];
  aiPriceFrom: number[];
  aiPriceInput: number[];
  aiPriceInputLong: number[];
  aiPriceKey: string[];
  aiPriceOutput: number[];
  aiPriceOutputLong: number[];
  aiPriceThreshold: number[];
  aiPriceTo: number[];
};

export const emptyAiPriceParams = (): AiPriceParams => ({
  aiPriceCacheRead: [],
  aiPriceCacheReadLong: [],
  aiPriceCacheWrite: [],
  aiPriceCacheWriteLong: [],
  aiPriceFrom: [],
  aiPriceInput: [],
  aiPriceInputLong: [],
  aiPriceKey: [],
  aiPriceOutput: [],
  aiPriceOutputLong: [],
  aiPriceThreshold: [],
  aiPriceTo: [],
});

// OpenTelemetry provider names that differ from the catalogue's provider IDs.
const CATALOGUE_PROVIDERS: Record<string, string> = {
  "aws.bedrock": "aws",
  "az.ai.inference": "azure",
  "az.ai.openai": "azure",
  "azure.ai.inference": "azure",
  "azure.ai.openai": "azure",
  "gcp.gemini": "google",
  "gcp.gen_ai": "google",
  "gcp.vertex_ai": "google",
  mistral_ai: "mistral",
  x_ai: "x-ai",
};

function priceAt(key: AiModelKey, timestamp: Date) {
  const options = {
    timestamp,
    ...(key.tier ? { priceContext: { service_tier: key.tier } } : {}),
  };
  const usage = { input_tokens: 0, output_tokens: 0 };
  const lookup = (model: string, provider: string) => {
    const providerId = provider ? (CATALOGUE_PROVIDERS[provider] ?? provider) : undefined;
    // An unknown provider name falls back to matching the model name.
    return (providerId ? calcPrice(usage, model, { ...options, providerId }) : null) ?? calcPrice(usage, model, options);
  };
  // Gateways and routers name a model "<provider>/<model>", such as
  // anthropic/claude-haiku-4.5. A name the catalogue does not know is looked
  // up as its two parts.
  const slash = key.model.indexOf("/");
  return lookup(key.model, key.provider) ?? (slash > 0 ? lookup(key.model.slice(slash + 1), key.model.slice(0, slash)) : null);
}

function base(price: number | TieredPrices | undefined): number | undefined {
  return typeof price === "object" ? price.base : price;
}

function longPrice(price: number | TieredPrices | undefined): number | undefined {
  return typeof price === "object" ? (price.tiers[0]?.price ?? price.base) : price;
}

// The four token prices of a rate card. Cached tokens without a price of
// their own are charged as input, as the catalogue charges them.
export function priceCard(price: ModelPrice): AiPriceCard | null {
  const input = base(price.input_mtok);
  if (input === undefined) return null;
  const threshold = Object.values(price).flatMap((value) =>
    typeof value === "object" && value.tiers[0] ? [value.tiers[0].start] : [],
  )[0] ?? null;
  const card = {
    cacheRead: base(price.cache_read_mtok) ?? input,
    cacheWrite: base(price.cache_write_mtok) ?? input,
    input,
    output: base(price.output_mtok) ?? 0,
  };
  return {
    ...card,
    long: threshold === null
      ? null
      : {
          cacheRead: longPrice(price.cache_read_mtok) ?? longPrice(price.input_mtok) ?? card.cacheRead,
          cacheWrite: longPrice(price.cache_write_mtok) ?? longPrice(price.input_mtok) ?? card.cacheWrite,
          input: longPrice(price.input_mtok) ?? input,
          output: longPrice(price.output_mtok) ?? card.output,
        },
    threshold,
  };
}

// Times within the window at which the model's catalogue price changes for
// calls in this service tier.
function priceChanges(model: ModelInfo, tier: string, sinceMs: number, untilMs: number): number[] {
  const starts = [
    ...(Array.isArray(model.prices) ? model.prices.map((price) => price.constraint) : []),
    ...(model.price_variants ?? [])
      .filter((variant) => tier !== "" && variant.when.service_tier === tier)
      .map((variant) => variant.constraint),
  ].flatMap((constraint) =>
    constraint && "start_date" in constraint ? [Date.parse(constraint.start_date)] : [],
  );
  return [...new Set(starts)].filter((time) => time > sinceMs && time < untilMs).sort((a, b) => a - b);
}

function overrideFor(key: AiModelKey, overrides: AiPriceOverride[]): AiPriceOverride | undefined {
  return overrides.find(
    (override) =>
      override.model.toLowerCase() === key.model && (override.provider === "" || override.provider.toLowerCase() === key.provider),
  );
}

// Prices for the models seen in a window, as query parameters for the cost
// field, with each model's price for display and the models with none.
export function resolveAiPrices(
  models: AiModelKey[],
  window: { since: string; until: string },
  overrides: AiPriceOverride[] = [],
): { params: AiPriceParams; prices: AiModelPrice[]; unpriced: AiModelKey[] } {
  const sinceMs = Date.parse(window.since);
  const untilMs = Date.parse(window.until);
  const params = emptyAiPriceParams();
  const prices: AiModelPrice[] = [];
  const unpriced: AiModelKey[] = [];
  const push = (key: AiModelKey, card: AiPriceCard, fromMs: number, toMs: number) => {
    params.aiPriceKey.push(`${key.provider}|${key.model}|${key.tier}`);
    // Seconds; the first and last rows reach past the window so no call
    // falls between them.
    params.aiPriceFrom.push(fromMs === sinceMs ? 0 : Math.floor(fromMs / 1000));
    params.aiPriceTo.push(toMs === untilMs ? 2 ** 40 : Math.floor(toMs / 1000));
    params.aiPriceThreshold.push(card.threshold ?? 0);
    params.aiPriceInput.push(card.input);
    params.aiPriceCacheRead.push(card.cacheRead);
    params.aiPriceCacheWrite.push(card.cacheWrite);
    params.aiPriceOutput.push(card.output);
    params.aiPriceInputLong.push(card.long?.input ?? card.input);
    params.aiPriceCacheReadLong.push(card.long?.cacheRead ?? card.cacheRead);
    params.aiPriceCacheWriteLong.push(card.long?.cacheWrite ?? card.cacheWrite);
    params.aiPriceOutputLong.push(card.long?.output ?? card.output);
  };
  for (const key of models) {
    if (!key.model) {
      unpriced.push(key);
      continue;
    }
    const override = overrideFor(key, overrides);
    if (override) {
      const card: AiPriceCard = {
        cacheRead: override.cacheReadMtok ?? override.inputMtok,
        cacheWrite: override.cacheWriteMtok ?? override.inputMtok,
        input: override.inputMtok,
        long: null,
        output: override.outputMtok,
        threshold: null,
      };
      push(key, card, sinceMs, untilMs);
      prices.push({ ...key, card, catalogModel: null, source: "workspace" });
      continue;
    }
    const first = priceAt(key, new Date(sinceMs));
    const firstCard = first ? priceCard(first.model_price) : null;
    if (!first || !firstCard) {
      unpriced.push(key);
      continue;
    }
    const bounds = [sinceMs, ...priceChanges(first.model, key.tier, sinceMs, untilMs), untilMs];
    let latest = firstCard;
    for (let index = 0; index < bounds.length - 1; index += 1) {
      const from = bounds[index]!;
      const card = index === 0 ? firstCard : priceCard(priceAt(key, new Date(from))?.model_price ?? {});
      if (!card) continue;
      push(key, card, from, bounds[index + 1]!);
      latest = card;
    }
    prices.push({ ...key, card: latest, catalogModel: first.model.id, source: "catalogue" });
  }
  return { params, prices, unpriced };
}

const priceRefreshMs = 86_400_000;
const priceRetryMs = 3_600_000;
let priceUpdatesStarted = false;

// Keeps the catalogue current: when a price is looked up and the loaded copy
// is a day old, the published feed is fetched in the background. Until it
// arrives, and when a fetch fails, the copy shipped with the package is used.
export function startAiPriceUpdates(fetchFeed: (url: string) => Promise<Response> = (url) => fetch(url)): void {
  if (priceUpdatesStarted) return;
  priceUpdatesStarted = true;
  updatePrices(({ onCalc, remoteDataUrl, setProviderData }) => {
    let nextFetch = 0;
    const refresh = () => {
      if (Date.now() < nextFetch) return;
      nextFetch = Date.now() + priceRefreshMs;
      setProviderData(
        fetchFeed(remoteDataUrl)
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null)
          .then((data) => {
            if (data === null) nextFetch = Date.now() + priceRetryMs;
            return data;
          }),
      );
    };
    onCalc(refresh);
    refresh();
  });
}
