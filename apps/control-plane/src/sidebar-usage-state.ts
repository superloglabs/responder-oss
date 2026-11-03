interface UsageBalance {
  granted: number;
  remaining: number;
  unlimited?: boolean;
  usage: number;
}

export interface SidebarUsageSummary {
  automations?: {
    allowance: number;
    configured: boolean;
    creditUnlimited?: boolean;
    machineHours?: UsageBalance | null;
    paid: boolean;
    planName: string;
    usage: number;
  } | null;
  enabled: boolean;
}

export interface SidebarUsageMeter {
  kind: "credit" | "machine_hours";
  // Share of the allowance used, from 0 to 100.
  percent: number;
  total: number;
  used: number;
}

export interface SidebarUsage {
  meters: SidebarUsageMeter[];
  planName: string;
}

function meter(kind: SidebarUsageMeter["kind"], used: number, total: number): SidebarUsageMeter {
  return {
    kind,
    percent: total > 0 ? Math.min(100, (Math.max(0, used) / total) * 100) : 0,
    total,
    used: Math.max(0, used),
  };
}

// Shown only to workspaces on a paid plan, one meter per limited balance.
export function sidebarUsage(summary: SidebarUsageSummary): SidebarUsage | null {
  const plan = summary.automations;
  if (!summary.enabled || !plan?.configured || !plan.paid) return null;
  const meters: SidebarUsageMeter[] = [];
  if (!plan.creditUnlimited && plan.allowance > 0) {
    meters.push(meter("credit", plan.usage, plan.allowance));
  }
  const hours = plan.machineHours;
  if (hours && !hours.unlimited && hours.granted > 0) {
    meters.push(meter("machine_hours", hours.usage, hours.granted));
  }
  return meters.length ? { meters, planName: plan.planName } : null;
}
