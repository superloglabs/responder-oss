import {
  listUncreditedUsage,
  markUsageCreditAttempted,
  markUsageCredited,
  usageClockNow,
  waiveAutomationRunUsage as waiveAutomationRunUsageRows,
  waiveJobUsage as waiveJobUsageRows,
  type UncreditedUsage,
  type WaivedUsageKind,
} from "../db/usage-waivers.js";
import { billingIsEnabled, creditMachineHours, creditUsageCharge } from "./autumn.js";

// Responder does not charge for work that failed through its own fault. The
// work's usage is waived: it is settled as usual, and each charge reported for
// it is then credited back to the balance it was reported to.

// A failed waiver leaves the work charged, so it is retried through short
// database outages.
const waiverRetryDelaysMs = [1_000, 5_000, 15_000];

async function withRetry<T>(attempt: () => Promise<T>, delaysMs: number[]): Promise<T> {
  for (const delayMs of delaysMs) {
    try {
      return await attempt();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return attempt();
}

// The start time for a later waiver of work starting now, from the database
// clock that usage times use. Falls back to this process's clock when the
// database cannot answer.
export async function usageWaiverStart(
  clock: typeof usageClockNow = usageClockNow,
): Promise<Date> {
  return clock().catch(() => new Date());
}

// Waives the usage of an automation run turn that started at `since`. Does
// nothing when the caller no longer holds the run's lease.
export async function waiveAutomationRunUsage(
  input: { leaseId: string; runId: string; since: Date },
  dependencies: { retryDelaysMs?: number[]; waive: typeof waiveAutomationRunUsageRows } = {
    waive: waiveAutomationRunUsageRows,
  },
): Promise<boolean> {
  return withRetry(
    () => dependencies.waive(input),
    dependencies.retryDelaysMs ?? waiverRetryDelaysMs,
  );
}

// Waives the usage of an investigation or pull request job attempt that
// started at `since`.
export async function waiveJobUsage(
  input: { since: Date; workload: "investigation" | "remediation"; workloadId: string },
  dependencies: { retryDelaysMs?: number[]; waive: typeof waiveJobUsageRows } = {
    waive: waiveJobUsageRows,
  },
): Promise<void> {
  await withRetry(
    () => dependencies.waive(input),
    dependencies.retryDelaysMs ?? waiverRetryDelaysMs,
  );
}

const creditKeyPrefixes: Record<WaivedUsageKind, string> = {
  agent_model: "agent-model-usage-credit",
  automation_model: "automation-usage-credit",
  sandbox: "sandbox-usage-credit",
};

interface CreditDependencies {
  creditCharge: typeof creditUsageCharge;
  creditMachineHours: typeof creditMachineHours;
  markCredited: typeof markUsageCredited;
}

async function creditUsage(usage: UncreditedUsage, dependencies: CreditDependencies): Promise<void> {
  if (billingIsEnabled() && usage.balance !== null) {
    const credit = {
      idempotencyKey: `${creditKeyPrefixes[usage.kind]}:${usage.id}`,
      organizationId: usage.organizationId,
      properties: usage.properties,
    };
    if (usage.balance === "machine_hours") {
      await dependencies.creditMachineHours({ ...credit, hours: usage.hours });
    } else if (usage.chargeMicros !== null) {
      await dependencies.creditCharge({ ...credit, chargeMicros: usage.chargeMicros });
    }
  }
  await dependencies.markCredited(usage.kind, usage.id);
}

// Autumn keeps idempotency keys for 24 hours, so only retry credits younger
// than that. Older ones are left rather than risk crediting twice.
const retryWindowMs = 23 * 60 * 60_000;
// A pass stops crediting after this long, so no row it listed can age past
// the retry window before it is credited.
const passDeadlineMs = 10 * 60_000;

// Credits waived usage that has been settled. Failed credits are retried by
// the next pass.
export async function creditWaivedUsage(
  dependencies: CreditDependencies & {
    list: typeof listUncreditedUsage;
    markAttempted: typeof markUsageCreditAttempted;
    now: () => number;
  } = {
    creditCharge: creditUsageCharge,
    creditMachineHours,
    list: listUncreditedUsage,
    markAttempted: markUsageCreditAttempted,
    markCredited: markUsageCredited,
    now: Date.now,
  },
): Promise<{ credited: number; failed: number }> {
  const now = dependencies.now();
  const usage = await dependencies.list({
    limit: 200,
    waivedAfter: new Date(now - retryWindowMs),
  });
  let credited = 0;
  const failed: UncreditedUsage[] = [];
  for (const row of usage) {
    if (dependencies.now() >= now + passDeadlineMs) break;
    await creditUsage(row, dependencies).then(
      () => { credited += 1; },
      () => { failed.push(row); },
    );
  }
  if (failed.length > 0) await dependencies.markAttempted(failed);
  return { credited, failed: failed.length };
}
