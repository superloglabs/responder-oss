import {
  aiGatewayModelId,
  automationModelCostMicros,
  getAIGatewayModelPricing,
} from "../automations/model-pricing.js";
import {
  insertAgentModelUsage,
  listUnbilledAgentModelUsage,
  markAgentModelUsageBilled,
  markAgentModelUsageBillingAttempted,
  setAgentModelUsageCharge,
  type AgentModelUsageRecord,
} from "../db/agent-model-usage.js";
import { organizationHasCapability } from "../db/organization-capabilities.js";
import {
  closeStaleSandboxUsage,
  listUnbilledSandboxUsage,
  markSandboxUsageBilled,
  markSandboxUsageBillingAttempted,
  setSandboxUsageCharge,
  stopSandboxUsage,
  type SandboxUsageRecord,
} from "../db/sandbox-usage.js";
import { billingIsEnabled, trackUsageCharge } from "./autumn.js";
import { inferenceCharge, sandboxCharge } from "./usage-charges.js";

// Organizations with simplified navigation pay for investigations, pull
// request work, and automations from one usage allowance instead of
// investigation credits.
export function organizationUsesUsageBilling(organizationId: string): Promise<boolean> {
  return organizationHasCapability(organizationId, "simplified_navigation");
}

interface SandboxSettlementDependencies {
  markBilled: typeof markSandboxUsageBilled;
  setCharge: typeof setSandboxUsageCharge;
  track: typeof trackUsageCharge;
}

const defaultSandboxDependencies: SandboxSettlementDependencies = {
  markBilled: markSandboxUsageBilled,
  setCharge: setSandboxUsageCharge,
  track: trackUsageCharge,
};

export function sandboxUsageChargeMicros(row: SandboxUsageRecord): number {
  const seconds = Math.max(0, (row.stoppedAt.getTime() - row.startedAt.getTime()) / 1_000);
  return sandboxCharge(
    { cpu: row.cpu, diskGiB: row.diskGiB, memoryGiB: row.memoryGiB },
    seconds,
  );
}

// Prices a stopped sandbox period and reports billable periods. Failures
// leave the row unsettled for the worker to retry.
export async function settleSandboxUsage(
  row: SandboxUsageRecord,
  dependencies: SandboxSettlementDependencies = defaultSandboxDependencies,
): Promise<void> {
  const chargeMicros = row.chargeMicros ?? sandboxUsageChargeMicros(row);
  if (row.chargeMicros === null) await dependencies.setCharge(row.id, chargeMicros);
  if (row.billable && billingIsEnabled()) {
    await dependencies.track({
      chargeMicros,
      idempotencyKey: `sandbox-usage:${row.id}`,
      organizationId: row.organizationId,
      properties: { kind: "sandbox", workload: row.workload, workloadId: row.workloadId },
    });
  }
  await dependencies.markBilled(row.id);
}

// Closes a sandbox period and settles it. A period another process already
// closed is settled by the retry pass instead.
export async function finishSandboxUsage(
  id: string,
  dependencies: SandboxSettlementDependencies & { stop: typeof stopSandboxUsage } = {
    ...defaultSandboxDependencies,
    stop: stopSandboxUsage,
  },
): Promise<void> {
  const row = await dependencies.stop(id);
  if (row) await settleSandboxUsage(row, dependencies);
}

export interface AgentModelUsage {
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

interface AgentSettlementDependencies {
  getPricing: typeof getAIGatewayModelPricing;
  markBilled: typeof markAgentModelUsageBilled;
  setCharge: typeof setAgentModelUsageCharge;
  track: typeof trackUsageCharge;
}

const defaultAgentDependencies: AgentSettlementDependencies = {
  getPricing: getAIGatewayModelPricing,
  markBilled: markAgentModelUsageBilled,
  setCharge: setAgentModelUsageCharge,
  track: trackUsageCharge,
};

// Prices each request separately so long-context price tiers apply per
// request. Without per-request usage, as when a stored row is retried, the
// combined usage is priced as that many equal requests.
async function agentUsageChargeMicros(
  model: string,
  usage: AgentModelUsage,
  dependencies: AgentSettlementDependencies,
  requestUsage: AgentModelUsage[] = [],
): Promise<number | null> {
  const pricing = await dependencies.getPricing(aiGatewayModelId("openai", model));
  if (!pricing) return null;
  const requests = requestUsage.length > 0
    ? requestUsage
    : Array.from({ length: Math.max(1, usage.requests) }, () => ({
        cachedInputTokens: usage.cachedInputTokens / Math.max(1, usage.requests),
        inputTokens: usage.inputTokens / Math.max(1, usage.requests),
        outputTokens: usage.outputTokens / Math.max(1, usage.requests),
        requests: 1,
      }));
  let costMicros = 0;
  for (const request of requests) {
    const requestCost = automationModelCostMicros(pricing, { ...request, cacheWriteTokens: 0 });
    if (requestCost === null) return null;
    costMicros += requestCost;
  }
  return inferenceCharge(costMicros);
}

export async function settleAgentModelUsage(
  row: AgentModelUsageRecord,
  dependencies: AgentSettlementDependencies = defaultAgentDependencies,
): Promise<void> {
  let chargeMicros = row.chargeMicros;
  if (chargeMicros === null) {
    chargeMicros = await agentUsageChargeMicros(row.model, row, dependencies);
    if (chargeMicros === null) {
      // Usage that is not billed only loses its displayed price.
      if (!row.billable) return dependencies.markBilled(row.id);
      throw new Error(`No AI Gateway pricing is available for ${row.model}`);
    }
    await dependencies.setCharge(row.id, chargeMicros);
  }
  if (row.billable && billingIsEnabled()) {
    await dependencies.track({
      chargeMicros,
      idempotencyKey: `agent-model-usage:${row.id}`,
      organizationId: row.organizationId,
      properties: {
        kind: "inference",
        model: row.model,
        workload: row.workload,
        workloadId: row.workloadId,
      },
    });
  }
  await dependencies.markBilled(row.id);
}

// Records the model usage of one investigation or pull request review run
// and reports it when billable. A failed report is retried by the worker.
export async function recordAgentModelUsage(
  input: Omit<AgentModelUsageRecord, "chargeMicros" | "id">,
  requestUsage: AgentModelUsage[] = [],
  dependencies: AgentSettlementDependencies & { insert: typeof insertAgentModelUsage } = {
    ...defaultAgentDependencies,
    insert: insertAgentModelUsage,
  },
): Promise<void> {
  if (input.requests === 0) return;
  const chargeMicros = await agentUsageChargeMicros(
    input.model,
    input,
    dependencies,
    requestUsage,
  ).catch(() => null);
  const row = await dependencies.insert({ ...input, chargeMicros });
  await settleAgentModelUsage(row, dependencies).catch(() => undefined);
}

// Autumn keeps idempotency keys for 24 hours, so only retry rows younger than
// that. Older rows are left unbilled rather than risk a double charge.
const retryWindowMs = 23 * 60 * 60_000;
const retryDelayMs = 60_000;
// A pass stops reporting after this long, so no row it listed can age past
// the retry window before it is reported.
const passDeadlineMs = 10 * 60_000;
// A running sandbox renews its heartbeat every minute.
const sandboxHeartbeatStaleMs = 5 * 60_000;

export async function settleUnbilledUsage(
  dependencies: {
    closeStaleSandboxes: typeof closeStaleSandboxUsage;
    listAgentUsage: typeof listUnbilledAgentModelUsage;
    listSandboxUsage: typeof listUnbilledSandboxUsage;
    markAgentUsageAttempted: typeof markAgentModelUsageBillingAttempted;
    markSandboxUsageAttempted: typeof markSandboxUsageBillingAttempted;
    now: () => number;
    settleAgentUsage: (row: AgentModelUsageRecord) => Promise<void>;
    settleSandboxUsage: (row: SandboxUsageRecord) => Promise<void>;
  } = {
    closeStaleSandboxes: closeStaleSandboxUsage,
    listAgentUsage: listUnbilledAgentModelUsage,
    listSandboxUsage: listUnbilledSandboxUsage,
    markAgentUsageAttempted: markAgentModelUsageBillingAttempted,
    markSandboxUsageAttempted: markSandboxUsageBillingAttempted,
    now: Date.now,
    settleAgentUsage: (row) => settleAgentModelUsage(row),
    settleSandboxUsage: (row) => settleSandboxUsage(row),
  },
): Promise<{ failed: number; settled: number; staleSandboxes: number }> {
  const now = dependencies.now();
  const staleSandboxes = await dependencies.closeStaleSandboxes(sandboxHeartbeatStaleMs);
  const window = {
    after: new Date(now - retryWindowMs),
    before: new Date(now - retryDelayMs),
  };
  const [sandboxRows, agentRows] = await Promise.all([
    dependencies.listSandboxUsage({
      limit: 200,
      stoppedAfter: window.after,
      stoppedBefore: window.before,
    }),
    dependencies.listAgentUsage({
      createdAfter: window.after,
      createdBefore: window.before,
      limit: 200,
    }),
  ]);
  const beforeDeadline = () => dependencies.now() < now + passDeadlineMs;
  let settled = 0;
  const failedSandboxes: string[] = [];
  for (const row of sandboxRows) {
    if (!beforeDeadline()) break;
    await dependencies.settleSandboxUsage(row).then(
      () => { settled += 1; },
      () => { failedSandboxes.push(row.id); },
    );
  }
  const failedAgentUsage: string[] = [];
  for (const row of agentRows) {
    if (!beforeDeadline()) break;
    await dependencies.settleAgentUsage(row).then(
      () => { settled += 1; },
      () => { failedAgentUsage.push(row.id); },
    );
  }
  await Promise.all([
    dependencies.markSandboxUsageAttempted(failedSandboxes),
    dependencies.markAgentUsageAttempted(failedAgentUsage),
  ]);
  return {
    failed: failedSandboxes.length + failedAgentUsage.length,
    settled,
    staleSandboxes,
  };
}
