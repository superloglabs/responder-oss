import {
  billingIsEnabled,
  trackAutomationInferenceUsage,
} from "../billing/autumn.js";
import {
  listUnbilledAutomationModelUsage,
  markAutomationModelUsageBilled,
  markAutomationModelUsageBillingAttempted,
  recordAutomationModelUsage,
  setAutomationModelUsageCost,
  type AutomationModelUsageRecord,
} from "../db/automation-model-usage.js";
import type {
  AutomationInferenceSource,
  AutomationModelProvider,
} from "./config.js";
import {
  aiGatewayModelId,
  automationModelCostMicros,
  getAIGatewayModelPricing,
} from "./model-pricing.js";
import type { AutomationModelUsage } from "./model-usage.js";

interface SettlementDependencies {
  getPricing: typeof getAIGatewayModelPricing;
  markBilled: typeof markAutomationModelUsageBilled;
  record: typeof recordAutomationModelUsage;
  setCost: typeof setAutomationModelUsageCost;
  track: typeof trackAutomationInferenceUsage;
}

const defaultDependencies: SettlementDependencies = {
  getPricing: getAIGatewayModelPricing,
  markBilled: markAutomationModelUsageBilled,
  record: recordAutomationModelUsage,
  setCost: setAutomationModelUsageCost,
  track: trackAutomationInferenceUsage,
};

async function usageCostMicros(
  provider: AutomationModelProvider,
  model: string,
  usage: AutomationModelUsage,
  dependencies: SettlementDependencies,
): Promise<number | null> {
  const pricing = await dependencies.getPricing(aiGatewayModelId(provider, model));
  return pricing ? automationModelCostMicros(pricing, usage) : null;
}

// Prices a stored request if needed and reports Responder-funded usage to
// billing. Failures leave the row unbilled for the worker to retry.
export async function settleAutomationModelUsage(
  row: AutomationModelUsageRecord,
  dependencies: SettlementDependencies = defaultDependencies,
): Promise<void> {
  let costMicros = row.costMicros;
  if (costMicros === null) {
    costMicros = await usageCostMicros(row.provider, row.model, row, dependencies);
    if (costMicros === null) {
      throw new Error(`No AI Gateway pricing is available for ${row.model}`);
    }
    await dependencies.setCost(row.id, costMicros);
  }
  if (row.inferenceSource !== "responder") return;
  await dependencies.track({
    costMicros,
    model: row.model,
    organizationId: row.organizationId,
    runId: row.runId,
    usageId: row.id,
  });
  await dependencies.markBilled(row.id);
}

// Records one brokered request. Organization-funded usage is priced for
// display only; Responder-funded usage is also reported to billing.
export async function recordBrokeredModelUsage(
  input: {
    inferenceSource: AutomationInferenceSource;
    model: string;
    organizationId: string;
    provider: AutomationModelProvider;
    runId: string;
    usage: AutomationModelUsage;
  },
  dependencies: SettlementDependencies = defaultDependencies,
): Promise<void> {
  const costMicros = await usageCostMicros(
    input.provider,
    input.model,
    input.usage,
    dependencies,
  ).catch(() => null);
  const billable = input.inferenceSource === "responder" && billingIsEnabled();
  const row = await dependencies.record({
    ...input.usage,
    costMicros,
    inferenceSource: input.inferenceSource,
    model: input.model,
    organizationId: input.organizationId,
    provider: input.provider,
    runId: input.runId,
    settled: !billable,
  });
  if (billable) await settleAutomationModelUsage(row, dependencies);
}

// Autumn keeps idempotency keys for 24 hours, so only retry rows younger than
// that. Older rows are left unbilled rather than risk a double charge.
const retryWindowMs = 23 * 60 * 60_000;
const retryDelayMs = 60_000;

export async function settleUnbilledAutomationModelUsage(
  dependencies: SettlementDependencies & {
    list: typeof listUnbilledAutomationModelUsage;
    markAttempted: typeof markAutomationModelUsageBillingAttempted;
    now: () => number;
  } = {
    ...defaultDependencies,
    list: listUnbilledAutomationModelUsage,
    markAttempted: markAutomationModelUsageBillingAttempted,
    now: Date.now,
  },
): Promise<{ failed: number; settled: number }> {
  if (!billingIsEnabled()) return { failed: 0, settled: 0 };
  const now = dependencies.now();
  const rows = await dependencies.list({
    createdAfter: new Date(now - retryWindowMs),
    createdBefore: new Date(now - retryDelayMs),
    limit: 200,
  });
  const failed: string[] = [];
  for (const row of rows) {
    try {
      await settleAutomationModelUsage(row, dependencies);
    } catch {
      failed.push(row.id);
    }
  }
  await dependencies.markAttempted(failed);
  return { failed: failed.length, settled: rows.length - failed.length };
}
