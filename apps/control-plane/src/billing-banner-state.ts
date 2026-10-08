interface UsageBalance {
  overageAllowed: boolean;
  remaining: number;
  unlimited?: boolean;
}

export interface BillingBannerSummary {
  automations?: {
    configured: boolean;
    creditOverageAllowed?: boolean;
    creditUnlimited?: boolean;
    machineHours?: UsageBalance | null;
    remaining: number;
  } | null;
  configured: boolean;
  enabled: boolean;
  payAsYouGo: boolean;
  remaining: number;
  usageBased?: boolean;
}

// Shown only while new work is paused. Usage past an allowance that the plan
// bills for is expected and shows nothing.
export type BillingBannerKind = "investigations" | "machine_hours" | "usage";

// New work needs at least one cent of credit and a minute of machine time,
// unless the plan bills usage past them.
const minimumCreditDollars = 0.01;
const minimumMachineHours = 1 / 60;

export function billingBanner(summary: BillingBannerSummary): BillingBannerKind | null {
  if (!summary.enabled) return null;
  if (!summary.usageBased) {
    return summary.configured && !summary.payAsYouGo && summary.remaining === 0
      ? "investigations"
      : null;
  }
  const usage = summary.automations;
  if (!usage?.configured) return null;
  // Machine hours first, as in the work allowance check.
  const machineHours = usage.machineHours;
  if (
    machineHours &&
    !machineHours.overageAllowed &&
    !machineHours.unlimited &&
    machineHours.remaining < minimumMachineHours
  ) {
    return "machine_hours";
  }
  return !usage.creditOverageAllowed && !usage.creditUnlimited && usage.remaining < minimumCreditDollars
    ? "usage"
    : null;
}
