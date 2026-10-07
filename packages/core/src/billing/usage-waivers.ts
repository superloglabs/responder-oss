import {
  listUncreditedAutomationModelUsage,
  markAutomationModelUsageCredited,
  waiveAutomationRunModelUsage,
  type AutomationModelUsageRecord,
} from "../db/automation-model-usage.js";
import {
  listUncreditedSandboxUsage,
  markSandboxUsageCredited,
  waiveSandboxUsage,
  type SandboxUsageRecord,
} from "../db/sandbox-usage.js";
import {
  billingIsEnabled,
  creditMachineHours,
  creditUsageCharge,
  organizationUsesMachineHours,
} from "./autumn.js";
import { sandboxUsageChargeMicros, sandboxUsageSeconds } from "./usage-billing.js";

// Responder does not charge for a run turn that failed through its own fault.
// The turn's usage is waived: usage not yet reported is settled without a
// charge, and usage already reported is credited back.

interface CreditDependencies {
  creditCharge: typeof creditUsageCharge;
  creditMachineHours: typeof creditMachineHours;
  markModelUsageCredited: typeof markAutomationModelUsageCredited;
  markSandboxUsageCredited: typeof markSandboxUsageCredited;
  usesMachineHours: typeof organizationUsesMachineHours;
}

const defaultCreditDependencies: CreditDependencies = {
  creditCharge: creditUsageCharge,
  creditMachineHours,
  markModelUsageCredited: markAutomationModelUsageCredited,
  markSandboxUsageCredited,
  usesMachineHours: organizationUsesMachineHours,
};

async function creditModelUsage(
  row: AutomationModelUsageRecord,
  dependencies: CreditDependencies,
): Promise<void> {
  if (row.costMicros !== null && billingIsEnabled()) {
    await dependencies.creditCharge({
      chargeMicros: row.costMicros,
      idempotencyKey: `automation-usage-credit:${row.id}`,
      organizationId: row.organizationId,
      properties: { model: row.model, runId: row.runId },
    });
  }
  await dependencies.markModelUsageCredited(row.id);
}

// Credits the balance the period was reported to under the organization's
// current plan, which is the balance it was charged to unless the plan
// changed in between.
async function creditSandboxUsage(
  row: SandboxUsageRecord,
  dependencies: CreditDependencies,
): Promise<void> {
  if (billingIsEnabled()) {
    const credit = {
      idempotencyKey: `sandbox-usage-credit:${row.id}`,
      organizationId: row.organizationId,
      properties: { kind: "sandbox", workload: row.workload, workloadId: row.workloadId },
    };
    if (await dependencies.usesMachineHours(row.organizationId)) {
      await dependencies.creditMachineHours({ ...credit, hours: sandboxUsageSeconds(row) / 3_600 });
    } else {
      await dependencies.creditCharge({
        ...credit,
        chargeMicros: row.chargeMicros ?? sandboxUsageChargeMicros(row),
      });
    }
  }
  await dependencies.markSandboxUsageCredited(row.id);
}

// Waives the model requests and sandbox time an automation run used since
// its turn started. Usage already reported is credited by the next credit
// pass.
export async function waiveAutomationRunUsage(
  input: { runId: string; since: Date },
  dependencies: {
    waiveModelUsage: typeof waiveAutomationRunModelUsage;
    waiveSandboxUsage: typeof waiveSandboxUsage;
  } = {
    waiveModelUsage: waiveAutomationRunModelUsage,
    waiveSandboxUsage,
  },
): Promise<void> {
  await Promise.all([
    dependencies.waiveModelUsage(input.runId, input.since),
    dependencies.waiveSandboxUsage({
      since: input.since,
      workload: "automation",
      workloadId: input.runId,
    }),
  ]);
}

// Autumn keeps idempotency keys for 24 hours, so only retry credits younger
// than that. Older ones are left rather than risk crediting twice.
const retryWindowMs = 23 * 60 * 60_000;
// A pass stops crediting after this long, so no row it listed can age past
// the retry window before it is credited.
const passDeadlineMs = 10 * 60_000;

// Credits waived usage that was already reported to billing, including
// charges a concurrent settlement reported after the usage was waived.
export async function creditWaivedUsage(
  dependencies: CreditDependencies & {
    listModelUsage: typeof listUncreditedAutomationModelUsage;
    listSandboxUsage: typeof listUncreditedSandboxUsage;
    now: () => number;
  } = {
    ...defaultCreditDependencies,
    listModelUsage: listUncreditedAutomationModelUsage,
    listSandboxUsage: listUncreditedSandboxUsage,
    now: Date.now,
  },
): Promise<{ credited: number; failed: number }> {
  const now = dependencies.now();
  const waivedAfter = new Date(now - retryWindowMs);
  const [modelRows, sandboxRows] = await Promise.all([
    dependencies.listModelUsage({ limit: 200, waivedAfter }),
    dependencies.listSandboxUsage({ limit: 200, waivedAfter }),
  ]);
  const credits = [
    ...modelRows.map((row) => () => creditModelUsage(row, dependencies)),
    ...sandboxRows.map((row) => () => creditSandboxUsage(row, dependencies)),
  ];
  let credited = 0;
  let failed = 0;
  for (const credit of credits) {
    if (dependencies.now() >= now + passDeadlineMs) break;
    await credit().then(
      () => { credited += 1; },
      () => { failed += 1; },
    );
  }
  return { credited, failed };
}
