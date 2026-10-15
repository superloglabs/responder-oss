import { listAiPriceOverrides } from "../db/ai-model-prices.js";
import { resolveAiPrices, startAiPriceUpdates, type AiPriceParams } from "./ai-cost.js";
import type { TelemetryClient } from "./client.js";
import { aiModelsInWindow, type SeriesFilter } from "./query.js";

// Model, provider and tier combinations priced for one query. Its filters
// usually narrow them to a few.
export const maxPricedModels = 10_000;

// Prices of every model the filter selects in its window, with the
// workspace's own prices, as parameters for the cost field. A call whose
// model has no price has no cost.
export async function aiPriceParamsFor(
  client: TelemetryClient,
  organizationId: string,
  filter: SeriesFilter & { range: { since: string; until: string } },
): Promise<AiPriceParams> {
  startAiPriceUpdates();
  const [models, overrides] = await Promise.all([
    aiModelsInWindow(client, organizationId, filter, maxPricedModels),
    listAiPriceOverrides(organizationId),
  ]);
  return resolveAiPrices(models, filter.range, overrides).params;
}
