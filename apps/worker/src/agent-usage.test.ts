import { Usage } from "@openai/agents";
import { describe, expect, it, vi } from "vitest";
import {
  recordAgentRunUsage,
  requireUsageAllowance,
  UsageAllowanceExhaustedError,
} from "./agent-usage.js";

describe("agent run usage", () => {
  it("records uncached input separately from cached input", async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const usage = new Usage({
      input_tokens: 5_000,
      input_tokens_details: { cached_tokens: 3_000 },
      output_tokens: 400,
      requests: 3,
    });

    await recordAgentRunUsage({
      billable: true,
      model: "gpt-5.4",
      organizationId: "organization-1",
      usage,
      workload: "investigation",
      workloadId: "investigation-1",
    }, record);

    expect(record).toHaveBeenCalledWith({
      billable: true,
      cachedInputTokens: 3_000,
      inputTokens: 2_000,
      model: "gpt-5.4",
      organizationId: "organization-1",
      outputTokens: 400,
      requests: 3,
      workload: "investigation",
      workloadId: "investigation-1",
    }, expect.any(Array));
  });

  it("never fails the run when recording fails", async () => {
    const record = vi.fn().mockRejectedValue(new Error("database unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(recordAgentRunUsage({
      billable: false,
      model: "gpt-5.4",
      organizationId: "organization-1",
      usage: new Usage({ input_tokens: 10, output_tokens: 1, requests: 1 }),
      workload: "pull_request_review",
      workloadId: "request-1",
    }, record)).resolves.toBeUndefined();
  });

  it("stops billable work before it starts when the allowance is used", async () => {
    await expect(requireUsageAllowance(
      "organization-1",
      vi.fn().mockResolvedValue({ allowed: false, nextResetAt: null }),
    )).rejects.toBeInstanceOf(UsageAllowanceExhaustedError);
    await expect(requireUsageAllowance(
      "organization-1",
      vi.fn().mockResolvedValue({ allowed: true, nextResetAt: null }),
    )).resolves.toBeUndefined();
  });
});
