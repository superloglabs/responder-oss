import { Usage } from "@openai/agents";
import { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";
import { describe, expect, it, vi } from "vitest";
import {
  modelProviderFailedOnResponderSide,
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
      requestUsage: null,
      requests: 3,
      workload: "investigation",
      workloadId: "investigation-1",
    });
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

  it("stops pull request work before it starts when machine time is used up", async () => {
    const exhausted = vi.fn().mockResolvedValue({
      allowed: false,
      exhausted: "machine_hours",
      machinesUseCredit: false,
      nextResetAt: null,
    });
    await expect(requireUsageAllowance("organization-1", exhausted))
      .rejects.toThrow("machine hours");
    // The work calls no model, so only machine time is required.
    expect(exhausted).toHaveBeenCalledWith("organization-1", { responderModels: false });
    await expect(requireUsageAllowance(
      "organization-1",
      vi.fn().mockResolvedValue({
        allowed: false,
        exhausted: "usage_credit",
        machinesUseCredit: true,
        nextResetAt: null,
      }),
    )).rejects.toBeInstanceOf(UsageAllowanceExhaustedError);
    await expect(requireUsageAllowance(
      "organization-1",
      vi.fn().mockResolvedValue({
        allowed: true,
        exhausted: null,
        machinesUseCredit: false,
        nextResetAt: null,
      }),
    )).resolves.toBeUndefined();
  });
});

describe("failed agent run waivers", () => {
  const headers = new Headers();

  it("waives a run whose model provider failed or could not be reached", () => {
    expect(modelProviderFailedOnResponderSide(
      APIError.generate(500, { message: "server error" }, "server error", headers),
    )).toBe(true);
    expect(modelProviderFailedOnResponderSide(new APIConnectionError({ message: "Connection error." }))).toBe(true);
    expect(modelProviderFailedOnResponderSide(new APIConnectionTimeoutError())).toBe(true);
  });

  it("waives a run whose provider refused Responder's own credentials", () => {
    expect(modelProviderFailedOnResponderSide(
      APIError.generate(401, { message: "invalid key" }, "invalid key", headers),
    )).toBe(true);
  });

  it("finds the provider failure behind a wrapping error", () => {
    const providerFailure = APIError.generate(503, { message: "overloaded" }, "overloaded", headers);
    expect(modelProviderFailedOnResponderSide(
      new Error("Investigation failed", { cause: providerFailure }),
    )).toBe(true);
    expect(modelProviderFailedOnResponderSide(
      new AggregateError([new Error("cleanup failed"), providerFailure]),
    )).toBe(true);
  });

  it("charges a run that failed for any other reason", () => {
    expect(modelProviderFailedOnResponderSide(new Error("Sandbox command failed"))).toBe(false);
    expect(modelProviderFailedOnResponderSide(
      APIError.generate(400, { message: "context too long" }, "context too long", headers),
    )).toBe(false);
    expect(modelProviderFailedOnResponderSide(
      APIError.generate(429, { message: "rate limited" }, "rate limited", headers),
    )).toBe(false);
    expect(modelProviderFailedOnResponderSide(
      Object.assign(new Error("looks like a provider failure"), { status: 500 }),
    )).toBe(false);
    expect(modelProviderFailedOnResponderSide("failed")).toBe(false);
  });
});
