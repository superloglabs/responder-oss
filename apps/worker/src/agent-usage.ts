import type { Usage } from "@openai/agents";
import { checkWorkAllowance } from "@responder/core/billing/autumn";
import {
  organizationUsesUsageBilling,
  recordAgentModelUsage,
} from "@responder/core/billing/usage-billing";
import type {
  AgentModelUsageWorkload,
  AgentRequestUsage,
} from "@responder/core/db/schema";

// Whether an investigation or pull request run of this organization is billed
// from the usage allowance. It was admitted before it was queued, so a failed
// lookup records its usage without billing it rather than failing the run.
export async function agentUsageIsBillable(organizationId: string): Promise<boolean> {
  try {
    return await organizationUsesUsageBilling(organizationId);
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      event: "usage_billing_lookup_failed",
      organizationId,
    }));
    return false;
  }
}

export class UsageAllowanceExhaustedError extends Error {
  constructor(exhausted: "machine_hours" | "usage_credit" | null = "usage_credit") {
    super(
      exhausted === "machine_hours"
        ? "The machine hours for this billing period are used up. Upgrade the plan in billing settings to continue."
        : "The usage allowance for this billing period is used up. Upgrade the plan in billing settings to continue.",
    );
    this.name = "UsageAllowanceExhaustedError";
  }
}

// Stops billable pull request work before its sandbox starts when the usage
// credit or machine time is used up. Work that has started finishes.
export async function requireUsageAllowance(
  organizationId: string,
  check: typeof checkWorkAllowance = checkWorkAllowance,
): Promise<void> {
  const access = await check(organizationId, { responderModels: true });
  if (!access.allowed) throw new UsageAllowanceExhaustedError(access.exhausted);
}

function splitInputTokens(
  inputTokens: number,
  details: Record<string, number> | undefined,
): { cachedInputTokens: number; inputTokens: number } {
  const cached = Math.min(details?.cached_tokens ?? 0, inputTokens);
  return { cachedInputTokens: cached, inputTokens: inputTokens - cached };
}

function combinedUsage(usage: Usage) {
  const cached = usage.inputTokensDetails.reduce(
    (total, details) => total + (details.cached_tokens ?? 0),
    0,
  );
  return {
    ...splitInputTokens(usage.inputTokens, { cached_tokens: cached }),
    outputTokens: usage.outputTokens,
    requests: usage.requests,
  };
}

function requestUsage(usage: Usage): AgentRequestUsage[] | null {
  const requests = (usage.requestUsageEntries ?? []).map((request) => ({
    ...splitInputTokens(request.inputTokens, request.inputTokensDetails),
    outputTokens: request.outputTokens,
  }));
  return requests.length > 0 ? requests : null;
}

// Records the model usage of one agent run. Failures are logged and never
// fail the run.
export async function recordAgentRunUsage(input: {
  billable: boolean;
  model: string;
  organizationId: string;
  usage: Usage | undefined;
  workload: AgentModelUsageWorkload;
  workloadId: string;
}, record: typeof recordAgentModelUsage = recordAgentModelUsage): Promise<void> {
  if (!input.usage) return;
  try {
    await record({
      ...combinedUsage(input.usage),
      billable: input.billable,
      model: input.model,
      organizationId: input.organizationId,
      requestUsage: requestUsage(input.usage),
      workload: input.workload,
      workloadId: input.workloadId,
    });
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      event: "agent_model_usage_record_failed",
      workload: input.workload,
      workloadId: input.workloadId,
    }));
  }
}
