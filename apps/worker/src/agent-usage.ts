import type { Usage } from "@openai/agents";
import { checkUsageAllowance } from "@responder/core/billing/autumn";
import {
  organizationUsesUsageBilling,
  recordAgentModelUsage,
  type AgentModelUsage,
} from "@responder/core/billing/usage-billing";
import type { AgentModelUsageWorkload } from "@responder/core/db/schema";

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
  constructor() {
    super(
      "The usage allowance for this billing period is used up. Upgrade the plan in billing settings to continue.",
    );
    this.name = "UsageAllowanceExhaustedError";
  }
}

// Stops billable pull request work before its sandbox starts when the usage
// allowance is used up. Work that has started finishes.
export async function requireUsageAllowance(
  organizationId: string,
  check: typeof checkUsageAllowance = checkUsageAllowance,
): Promise<void> {
  if (!(await check(organizationId)).allowed) throw new UsageAllowanceExhaustedError();
}

function splitInputTokens(
  inputTokens: number,
  details: Record<string, number> | undefined,
): { cachedInputTokens: number; inputTokens: number } {
  const cached = Math.min(details?.cached_tokens ?? 0, inputTokens);
  return { cachedInputTokens: cached, inputTokens: inputTokens - cached };
}

function combinedUsage(usage: Usage): AgentModelUsage {
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

function requestUsage(usage: Usage): AgentModelUsage[] {
  return (usage.requestUsageEntries ?? []).map((request) => ({
    ...splitInputTokens(request.inputTokens, request.inputTokensDetails),
    outputTokens: request.outputTokens,
    requests: 1,
  }));
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
      workload: input.workload,
      workloadId: input.workloadId,
    }, requestUsage(input.usage));
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      event: "agent_model_usage_record_failed",
      workload: input.workload,
      workloadId: input.workloadId,
    }));
  }
}
