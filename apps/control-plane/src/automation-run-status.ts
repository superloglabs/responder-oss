import type { AutomationRunStatus } from "./automations-api";

// A run the usage allowance stopped is stored as failed, but it is shown
// apart so it does not read as a broken automation.
export type AutomationRunDisplayStatus = AutomationRunStatus | "usage_limit";

export const automationRunStatusLabels: Record<AutomationRunDisplayStatus, string> = {
  cancelled: "Cancelled",
  failed: "Failed",
  pending: "Queued",
  running: "Running",
  succeeded: "Completed",
  usage_limit: "Usage limit",
};

export function automationRunDisplayStatus(run: {
  failureCategory: string | null;
  status: AutomationRunStatus;
}): AutomationRunDisplayStatus {
  return run.status === "failed" && run.failureCategory === "usage_limit_reached"
    ? "usage_limit"
    : run.status;
}
