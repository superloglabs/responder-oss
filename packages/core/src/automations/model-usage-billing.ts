import {
  billingIsEnabled,
  checkAutomationInferenceAllowance,
  trackAutomationInferenceUsage,
} from "../billing/autumn.js";
import {
  completeResponderModelUsage,
  listUnbilledAutomationModelUsage,
  markAutomationModelUsageBilled,
  markAutomationModelUsageBillingAttempted,
  purgeAbandonedResponderModelUsage,
  recordAutomationModelUsage,
  releaseResponderModelUsage,
  reserveResponderModelUsage,
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
// billing. Organization-funded rows only need a price. Failures leave the row
// unsettled for the worker to retry.
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
  if (row.inferenceSource !== "responder") {
    await dependencies.markBilled(row.id);
    return;
  }
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
  // An unpriced organization-funded row stays open so the worker can price it.
  await dependencies.record({
    ...input.usage,
    costMicros,
    inferenceSource: input.inferenceSource,
    model: input.model,
    organizationId: input.organizationId,
    provider: input.provider,
    runId: input.runId,
    settled: costMicros !== null,
  });
}

interface ReservationDependencies {
  checkAllowance: typeof checkAutomationInferenceAllowance;
  reserve: typeof reserveResponderModelUsage;
}

const defaultReservationDependencies: ReservationDependencies = {
  checkAllowance: checkAutomationInferenceAllowance,
  reserve: reserveResponderModelUsage,
};

// Holds the estimated maximum cost of a Responder-funded request against the
// organization's allowance. Returns null when the allowance cannot cover it.
export async function reserveResponderInference(
  input: {
    estimateMicros: number;
    model: string;
    organizationId: string;
    provider: AutomationModelProvider;
    runId: string;
  },
  dependencies: ReservationDependencies = defaultReservationDependencies,
): Promise<string | null> {
  return dependencies.reserve(input, async (requiredMicros) =>
    (await dependencies.checkAllowance(
      input.organizationId,
      requiredMicros / 1_000_000,
    )).allowed);
}

export function releaseResponderInference(reservationId: string): Promise<void> {
  return releaseResponderModelUsage(reservationId);
}

// Replaces a reservation with the request's actual usage and reports it.
export async function completeResponderInference(
  input: {
    model: string;
    provider: AutomationModelProvider;
    reservationId: string;
    usage: AutomationModelUsage;
  },
  dependencies: SettlementDependencies & {
    complete: typeof completeResponderModelUsage;
  } = { ...defaultDependencies, complete: completeResponderModelUsage },
): Promise<void> {
  const costMicros = await usageCostMicros(
    input.provider,
    input.model,
    input.usage,
    dependencies,
  ).catch(() => null);
  const row = await dependencies.complete(input.reservationId, input.usage, costMicros);
  if (!row) return;
  if (!billingIsEnabled()) {
    await dependencies.markBilled(row.id);
    return;
  }
  await settleAutomationModelUsage(row, dependencies);
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
    purgeAbandoned: typeof purgeAbandonedResponderModelUsage;
  } = {
    ...defaultDependencies,
    list: listUnbilledAutomationModelUsage,
    markAttempted: markAutomationModelUsageBillingAttempted,
    now: Date.now,
    purgeAbandoned: purgeAbandonedResponderModelUsage,
  },
): Promise<{ failed: number; settled: number }> {
  const now = dependencies.now();
  await dependencies.purgeAbandoned(new Date(now));
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
