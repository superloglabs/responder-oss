import { apiErrorMessage } from "./agents-api";
import { addWidget, createDashboard, type TelemetryDashboard, type WidgetDraft } from "./dashboards-api";
import type { TelemetryRange } from "./telemetry-api";
import type { AiModelPriceOverride } from "../../../packages/core/src/db/ai-model-prices";
import type { AiPriceCard, AiPriceOverride } from "../../../packages/core/src/telemetry/ai-cost";
import type { DashboardWidgetLayout } from "../../../packages/core/src/telemetry/dashboards";

export type { AiModelPriceOverride, AiPriceCard, AiPriceOverride };

// A model called in the window, with the price its calls are charged at.
export interface AiModel {
  calls: number;
  inputTokens: number;
  model: string;
  outputTokens: number;
  price: { card: AiPriceCard; catalogModel: string | null; source: "catalogue" | "workspace" } | null;
  provider: string;
  tier: string;
}

export interface AiModels {
  // Model calls whose spans report no token counts.
  callsWithoutUsage: number;
  models: AiModel[];
  overrides: AiModelPriceOverride[];
}

async function request<T>(url: string, init?: { body?: unknown; method?: string }): Promise<T> {
  const response = await fetch(url, {
    ...(init?.method ? { method: init.method } : {}),
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body), headers: { "content-type": "application/json" } }),
  });
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) throw new Error(apiErrorMessage(body, response.status));
  return body as T;
}

export function fetchAiModels(projectId: string, range: TelemetryRange): Promise<AiModels> {
  return request<AiModels>(`/api/telemetry/ai-models?${new URLSearchParams({ projectId, range })}`);
}

export async function saveAiPriceOverride(price: AiPriceOverride): Promise<AiModelPriceOverride> {
  return (await request<{ override: AiModelPriceOverride }>("/api/telemetry/ai-price-overrides", { body: price, method: "PUT" })).override;
}

export function deleteAiPriceOverride(id: string): Promise<void> {
  return request(`/api/telemetry/ai-price-overrides/${encodeURIComponent(id)}`, { method: "DELETE" });
}

const perMillion = new Intl.NumberFormat("en-US", { currency: "USD", maximumFractionDigits: 4, style: "currency" });

// A price per million tokens, such as "$3" or "$0.075".
export function formatTokenPrice(price: number): string {
  return perMillion.format(price);
}

// What the model's price applies to, for people reading the list.
export function aiPriceSource(model: AiModel): string {
  if (!model.price) return "No price";
  if (model.price.source === "workspace") return "Workspace price";
  return model.price.catalogModel && model.price.catalogModel !== model.model
    ? `Catalogue: ${model.price.catalogModel}`
    : "Catalogue";
}

const modelCalls = { filter: {}, source: "traces" as const };

// The widgets of a starter dashboard for AI spend. Cost and token fields
// read model calls only, so they need no filter.
export const aiSpendWidgets: Array<WidgetDraft & { layout: DashboardWidgetLayout }> = [
  {
    config: { ...modelCalls, aggregation: "sum", compare: "previous_period", display: "number", field: "ai:cost", unit: "usd" },
    layout: { h: 2, w: 3, x: 0, y: 0 },
    title: "Spend",
    type: "timeseries_count",
  },
  {
    config: { ...modelCalls, aggregation: "avg", compare: "previous_period", display: "number", field: "ai:cost", unit: "usd" },
    layout: { h: 2, w: 3, x: 3, y: 0 },
    title: "Cost per call",
    type: "timeseries_count",
  },
  {
    config: { ...modelCalls, aggregation: "sum", compare: "previous_period", display: "number", field: "ai:tokens.input" },
    layout: { h: 2, w: 3, x: 6, y: 0 },
    title: "Input tokens",
    type: "timeseries_count",
  },
  {
    config: { ...modelCalls, aggregation: "sum", compare: "previous_period", display: "number", field: "ai:tokens.output" },
    layout: { h: 2, w: 3, x: 9, y: 0 },
    title: "Output tokens",
    type: "timeseries_count",
  },
  {
    config: { ...modelCalls, aggregation: "sum", chartType: "bar", field: "ai:cost", groupBy: "ai:model", limit: 6, unit: "usd" },
    layout: { h: 5, w: 8, x: 0, y: 2 },
    title: "Spend by model",
    type: "timeseries_count",
  },
  {
    config: { ...modelCalls, aggregation: "sum", display: "bar_list", field: "ai:cost", groupBy: "service", limit: 8, unit: "usd" },
    layout: { h: 5, w: 4, x: 8, y: 2 },
    title: "Spend by service",
    type: "timeseries_count",
  },
  {
    config: {
      ...modelCalls,
      aggregation: "sum",
      compare: "previous_period",
      display: "table",
      field: "ai:cost",
      groupBy: "ai:provider",
      limit: 10,
      unit: "usd",
    },
    layout: { h: 4, w: 6, x: 0, y: 7 },
    title: "Spend by provider",
    type: "timeseries_count",
  },
  {
    config: { ...modelCalls, aggregation: "p95", display: "table", field: "ai:cost", groupBy: "ai:model", limit: 10, unit: "usd" },
    layout: { h: 4, w: 6, x: 6, y: 7 },
    title: "95th percentile cost per call",
    type: "timeseries_count",
  },
  {
    config: {
      filter: {},
      markdown:
        "### Spend per customer or feature\nAdd an attribute such as `app.customer.id` to the spans around your model calls, then add a widget that sums **Cost** grouped by it.",
    },
    layout: { h: 2, w: 12, x: 0, y: 11 },
    title: "Spend per customer or feature",
    type: "markdown",
  },
];

// Creates the starter dashboard for a project and returns it.
export async function createAiSpendDashboard(projectId: string): Promise<TelemetryDashboard> {
  const dashboard = await createDashboard({ name: "AI spend", projectId });
  for (const widget of aiSpendWidgets) await addWidget(dashboard.id, widget);
  return dashboard;
}
