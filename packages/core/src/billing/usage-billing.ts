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
import type { AgentRequestUsage } from "../db/schema.js";
import {
  closeStaleSandboxUsage,
  listUnbilledSandboxUsage,
  markSandboxUsageBilled,
  markSandboxUsageBillingAttempted,
  markWaivedSandboxUsageSettled,
  setSandboxUsageCharge,
  stopSandboxUsage,
  type SandboxUsageRecord,
} from "../db/sandbox-usage.js";
import {
  billingIsEnabled,
  organizationUsesMachineHours,
  trackMachineHours,
  trackUsageCharge,
} from "./autumn.js";
import { inferenceCharge, sandboxCharge } from "./usage-charges.js";

// Organizations with simplified navigation pay for investigations, pull
// request work, and automations from one usage allowance instead of
// investigation credits.
export function organizationUsesUsageBilling(organizationId: string): Promise<boolean> {
  return organizationHasCapability(organizationId, "simplified_navigation");
}

interface SandboxSettlementDependencies {
  markBilled: typeof markSandboxUsageBilled;
  markWaivedSettled: typeof markWaivedSandboxUsageSettled;
  setCharge: typeof setSandboxUsageCharge;
  track: typeof trackUsageCharge;
  trackMachineHours: typeof trackMachineHours;
  usesMachineHours: typeof organizationUsesMachineHours;
}

const defaultSandboxDependencies: SandboxSettlementDependencies = {
  markBilled: markSandboxUsageBilled,
  markWaivedSettled: markWaivedSandboxUsageSettled,
  setCharge: setSandboxUsageCharge,
  track: trackUsageCharge,
  trackMachineHours,
  usesMachineHours: organizationUsesMachineHours,
};

export function sandboxUsageSeconds(row: SandboxUsageRecord): number {
  return Math.max(0, (row.stoppedAt.getTime() - row.startedAt.getTime()) / 1_000);
}

export function sandboxUsageChargeMicros(row: SandboxUsageRecord): number {
  return sandboxCharge(
    { cpu: row.cpu, diskGiB: row.diskGiB, memoryGiB: row.memoryGiB },
    sandboxUsageSeconds(row),
  );
}

// Prices a stopped sandbox period and reports billable periods that were not
// waived: as machine hours on plans that include them, otherwise as a charge
// to the usage credit. Both use the same idempotency key, and Autumn's keys apply across
// features, so a retry after a plan change cannot report the period to both.
// Failures leave the row unsettled for the worker to retry.
export async function settleSandboxUsage(
  row: SandboxUsageRecord,
  dependencies: SandboxSettlementDependencies = defaultSandboxDependencies,
): Promise<void> {
  const chargeMicros = row.chargeMicros ?? sandboxUsageChargeMicros(row);
  if (row.chargeMicros === null) await dependencies.setCharge(row.id, chargeMicros);
  if (row.waived) {
    await dependencies.markWaivedSettled(row.id);
    return;
  }
  if (row.billable && billingIsEnabled()) {
    const report = {
      idempotencyKey: `sandbox-usage:${row.id}`,
      organizationId: row.organizationId,
      properties: { kind: "sandbox", workload: row.workload, workloadId: row.workloadId },
    };
    if (await dependencies.usesMachineHours(row.organizationId)) {
      await dependencies.trackMachineHours({ ...report, hours: sandboxUsageSeconds(row) / 3_600 });
    } else {
      await dependencies.track({ ...report, chargeMicros });
    }
  }
  await dependencies.markBilled(row.id);
}

// Closes a sandbox period and settles it. A period another process already
// closed is settled by the retry pass instead.
export async function finishSandboxUsage(
  id: string,
  options: { waived?: boolean } = {},
  dependencies: SandboxSettlementDependencies & { stop: typeof stopSandboxUsage } = {
    ...defaultSandboxDependencies,
    stop: stopSandboxUsage,
  },
): Promise<void> {
  const row = await dependencies.stop(id, options);
  if (row) await settleSandboxUsage(row, dependencies);
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
// request. A row without per-request usage is priced as that many equal
// requests.
async function agentUsageChargeMicros(
  usage: Pick<
    AgentModelUsageRecord,
    "cachedInputTokens" | "inputTokens" | "model" | "outputTokens" | "requestUsage" | "requests"
  >,
  dependencies: AgentSettlementDependencies,
): Promise<number | null> {
  const pricing = await dependencies.getPricing(aiGatewayModelId("openai", usage.model));
  if (!pricing) return null;
  const count = Math.max(1, usage.requests);
  const requests: AgentRequestUsage[] = usage.requestUsage?.length
    ? usage.requestUsage
    : Array.from({ length: count }, () => ({
        cachedInputTokens: usage.cachedInputTokens / count,
        inputTokens: usage.inputTokens / count,
        outputTokens: usage.outputTokens / count,
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
    chargeMicros = await agentUsageChargeMicros(row, dependencies);
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
  dependencies: AgentSettlementDependencies & { insert: typeof insertAgentModelUsage } = {
    ...defaultAgentDependencies,
    insert: insertAgentModelUsage,
  },
): Promise<void> {
  if (input.requests === 0) return;
  const chargeMicros = await agentUsageChargeMicros(input, dependencies).catch(() => null);
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

// The start of the usage period a summary describes. Free plans may have no
// billing period, so the period is taken to be the month before the next
// reset, or the calendar month when there is no reset date.
export function usagePeriodStart(
  summary: { nextResetAt: number | null; periodStart: number | null },
  now = new Date(),
): Date {
  if (summary.periodStart !== null) return new Date(summary.periodStart);
  if (summary.nextResetAt !== null) {
    const reset = new Date(summary.nextResetAt);
    // The same day of the previous month, or its last day when shorter.
    const lastDayOfPreviousMonth = new Date(Date.UTC(
      reset.getUTCFullYear(),
      reset.getUTCMonth(),
      0,
    )).getUTCDate();
    const start = new Date(reset);
    start.setUTCDate(1);
    start.setUTCMonth(reset.getUTCMonth() - 1);
    start.setUTCDate(Math.min(reset.getUTCDate(), lastDayOfPreviousMonth));
    return start;
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
