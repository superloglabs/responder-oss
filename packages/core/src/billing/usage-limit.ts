import type { WorkAllowance } from "./autumn.js";

// The usage balance that ran out and the work it stops.
export interface UsageLimit {
  balance: "machine_hours" | "usage_credit" | null;
  // New investigations stop; on investigation credits they do not.
  investigations: boolean;
  // Only automation runs on Superlog's models stop. Runs with the
  // workspace's own model key keep going while machine time lasts.
  modelRunsOnly: boolean;
}

export function usageLimitFromAllowance(
  allowance: Pick<WorkAllowance, "exhausted" | "machinesUseCredit">,
  investigations: boolean,
): UsageLimit {
  return {
    balance: allowance.exhausted,
    investigations,
    modelRunsOnly: allowance.exhausted === "usage_credit" && !allowance.machinesUseCredit,
  };
}
