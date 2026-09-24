import type { AutomationModelProvider } from "./config.js";
import type { AutomationModelUsage } from "./model-usage.js";

export const aiGatewayBaseUrl = "https://ai-gateway.vercel.sh/v1";

const pricingCacheLifetimeMs = 60 * 60_000;
const pricingRequestTimeoutMs = 10_000;

interface PriceTier {
  cost: string;
  max?: number;
  min: number;
}

export interface GatewayModelPricing {
  input?: string;
  input_cache_read?: string;
  input_cache_read_tiers?: PriceTier[];
  input_cache_write?: string;
  input_cache_write_tiers?: PriceTier[];
  input_tiers?: PriceTier[];
  output?: string;
  output_tiers?: PriceTier[];
}

type PricingFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface GatewayCatalog {
  models: AIGatewayModel[];
  pricing: Map<string, GatewayModelPricing>;
}

let catalogCache: { catalog: GatewayCatalog; expiresAt: number } | undefined;
let catalogRequest: Promise<GatewayCatalog> | undefined;

export function resetAIGatewayPricingCache(): void {
  catalogCache = undefined;
  catalogRequest = undefined;
}

async function fetchCatalog(fetchCatalogImpl: PricingFetch): Promise<GatewayCatalog> {
  const response = await fetchCatalogImpl(`${aiGatewayBaseUrl}/models`, {
    signal: AbortSignal.timeout(pricingRequestTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`AI Gateway model catalog returned ${response.status}`);
  }
  const body = (await response.json()) as {
    data?: Array<{ id?: unknown; name?: unknown; pricing?: unknown; type?: unknown }>;
  };
  const catalog: GatewayCatalog = { models: [], pricing: new Map() };
  for (const model of body.data ?? []) {
    if (typeof model.id !== "string") continue;
    if (model.pricing && typeof model.pricing === "object") {
      catalog.pricing.set(model.id, model.pricing as GatewayModelPricing);
    }
    if (model.type === undefined || model.type === "language") {
      catalog.models.push({
        id: model.id,
        name: typeof model.name === "string" ? model.name : model.id,
      });
    }
  }
  return catalog;
}

async function loadCatalog(
  dependencies: { fetch?: PricingFetch; now?: () => number },
): Promise<GatewayCatalog> {
  const now = dependencies.now?.() ?? Date.now();
  if (!catalogCache || catalogCache.expiresAt <= now) {
    catalogRequest ??= fetchCatalog(dependencies.fetch ?? fetch).finally(() => {
      catalogRequest = undefined;
    });
    catalogCache = {
      catalog: await catalogRequest,
      expiresAt: now + pricingCacheLifetimeMs,
    };
  }
  return catalogCache.catalog;
}

export async function getAIGatewayModelPricing(
  gatewayModelId: string,
  dependencies: { fetch?: PricingFetch; now?: () => number } = {},
): Promise<GatewayModelPricing | null> {
  return (await loadCatalog(dependencies)).pricing.get(gatewayModelId) ?? null;
}

// AI Gateway lists models under their creator. Groq only hosts other
// creators' models, so it has no included-usage models of its own.
const aiGatewayCreators: Record<AutomationModelProvider, string | null> = {
  anthropic: "anthropic",
  deepseek: "deepseek",
  google: "google",
  groq: null,
  mistral: "mistral",
  openai: "openai",
  xai: "spacexai",
};

// Maps an automation model to an AI Gateway slug. Native Anthropic IDs use
// dashes and may carry a snapshot date; gateway slugs use dotted versions.
export function aiGatewayModelId(
  provider: AutomationModelProvider,
  model: string,
): string {
  if (model.includes("/")) return model;
  if (provider !== "anthropic") {
    return `${aiGatewayCreators[provider] ?? provider}/${model}`;
  }
  // `claude-sonnet-4-5` and legacy `claude-3-5-sonnet` both use a dotted version.
  const undated = model.replace(/-\d{8}$/u, "");
  return `anthropic/${undated.replace(/-(\d+)-(\d+)(?=-|$)/u, "-$1.$2")}`;
}

export interface AIGatewayModel {
  id: string;
  name: string;
}

// Language models the gateway serves for one provider, without the creator
// prefix, for the automation model picker.
export async function listAIGatewayModels(
  provider: AutomationModelProvider,
  dependencies: { fetch?: PricingFetch; now?: () => number } = {},
): Promise<AIGatewayModel[]> {
  const creator = aiGatewayCreators[provider];
  if (!creator) return [];
  const catalog = await loadCatalog(dependencies);
  return catalog.models
    .filter((model) => model.id.startsWith(`${creator}/`))
    .map((model) => ({ id: model.id.slice(creator.length + 1), name: model.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function tierPrice(
  base: string | undefined,
  tiers: PriceTier[] | undefined,
  promptTokens: number,
): number | null {
  const tier = tiers?.find((candidate) =>
    promptTokens >= candidate.min &&
    (candidate.max === undefined || promptTokens < candidate.max)
  );
  const value = Number(tier?.cost ?? base);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

// Returns the request cost in millionths of a US dollar, rounded up.
export function automationModelCostMicros(
  pricing: GatewayModelPricing,
  usage: AutomationModelUsage,
): number | null {
  const promptTokens =
    usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens;
  const input = tierPrice(pricing.input, pricing.input_tiers, promptTokens);
  const output = tierPrice(pricing.output, pricing.output_tiers, promptTokens);
  if (input === null || output === null) return null;
  const cacheRead = tierPrice(
    pricing.input_cache_read,
    pricing.input_cache_read_tiers,
    promptTokens,
  ) ?? input;
  const cacheWrite = tierPrice(
    pricing.input_cache_write,
    pricing.input_cache_write_tiers,
    promptTokens,
  ) ?? input;
  const dollars =
    usage.inputTokens * input +
    usage.cachedInputTokens * cacheRead +
    usage.cacheWriteTokens * cacheWrite +
    usage.outputTokens * output;
  return Math.ceil(dollars * 1_000_000 - 1e-6);
}
